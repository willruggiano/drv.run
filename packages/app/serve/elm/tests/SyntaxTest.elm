module SyntaxTest exposing (tests)

import Dict
import Expect
import Html
import Json.Encode as E
import Syntax
import Test exposing (Test, describe, test)
import Test.Html.Query as Query
import Test.Html.Selector as S


reply : Int -> String -> String -> E.Value
reply number source kind =
    E.list identity [ E.object [ ( "id", E.int number ), ( "tokens", E.list identity [ E.object [ ( "text", E.string source ), ( "kind", E.string kind ) ] ] ) ] ]


requestId : List Syntax.Request -> Int
requestId requests =
    List.head requests |> Maybe.map .id |> Maybe.withDefault -1


tests : Test
tests =
    describe "Elm syntax highlighting"
        [ test "filename aliases and unsupported grammars are selected in Elm" <|
            \_ ->
                Expect.equal [ "ts", "js", "py", "bash", "docker", "plain", "plain", "plain" ]
                    (List.map Syntax.fromPath [ "/src/reader.d.ts", "main.mjs", "script.PY", "run.sh", "Dockerfile", "flake.nix", "Main.elm", "file.constructor" ])
        , test "plain sources do not cross the tokenization port" <|
            \_ ->
                Syntax.sync [ ( "nix", "{ x = 1; }" ), ( "elm", "main = text x" ), ( "", "output" ) ] Syntax.empty
                    |> Tuple.second
                    |> Expect.equal []
        , test "identical sources share one request and reuse the result" <|
            \_ ->
                let
                    ( pending, requests ) =
                        Syntax.sync [ ( "typescript", "const x = 1;" ), ( "ts", "const x = 1;" ) ] Syntax.empty
                in
                case Syntax.receive (reply (requestId requests) "const x = 1;" "kwd") pending of
                    Err error ->
                        Expect.fail error

                    Ok ready ->
                        Expect.all
                            [ \_ -> Expect.equal 1 (List.length requests)
                            , \_ -> Expect.equal [] (Tuple.second (Syntax.sync [ ( "ts", "const x = 1;" ) ] ready))
                            , \_ -> Syntax.view ready "typescript" "const x = 1;" |> Html.code [] |> Query.fromHtml |> Query.find [ S.class "shj-syn-kwd" ] |> Query.has [ S.text "const x = 1;" ]
                            ]
                            ()
        , test "obsolete streaming replies cannot overwrite newer source" <|
            \_ ->
                let
                    ( old, requests ) =
                        Syntax.sync [ ( "js", "const" ) ] Syntax.empty

                    ( current, _ ) =
                        Syntax.sync [ ( "js", "const x = 1;" ) ] old
                in
                Expect.equal (Ok current) (Syntax.receive (reply (requestId requests) "const" "kwd") current)
        , test "navigation prunes source bytes without reusing request identities" <|
            \_ ->
                let
                    ( old, requests ) =
                        Syntax.sync [ ( "js", "const" ) ] Syntax.empty

                    ( cleared, _ ) =
                        Syntax.sync [] old

                    ( current, newRequests ) =
                        Syntax.sync [ ( "js", "const" ) ] cleared
                in
                Expect.all
                    [ \_ -> Expect.equal 0 (Dict.size cleared.items)
                    , \_ -> Expect.notEqual (requestId requests) (requestId newRequests)
                    , \_ -> Expect.equal (Ok current) (Syntax.receive (reply (requestId requests) "const" "kwd") current)
                    ]
                    ()
        , test "invalid token payloads do not change source text" <|
            \_ ->
                let
                    ( pending, requests ) =
                        Syntax.sync [ ( "js", "const" ) ] Syntax.empty
                in
                Expect.all
                    [ \_ -> Syntax.receive (reply (requestId requests) "different" "kwd") pending |> Expect.err
                    , \_ -> Syntax.receive (reply (requestId requests) "const" "invalid") pending |> Expect.err
                    , \_ -> Syntax.receive (E.object [ ( "error", E.string "unavailable" ) ]) pending |> Expect.err
                    ]
                    ()
        , test "tokens are rendered as text, never HTML" <|
            \_ ->
                let
                    source =
                        "<script>globalThis.executed = true</script>"

                    ( pending, requests ) =
                        Syntax.sync [ ( "html", source ) ] Syntax.empty
                in
                case Syntax.receive (reply (requestId requests) source "str") pending of
                    Err error ->
                        Expect.fail error

                    Ok ready ->
                        let
                            result =
                                Syntax.view ready "html" source |> Html.code [] |> Query.fromHtml
                        in
                        Expect.all
                            [ \_ -> result |> Query.findAll [ S.tag "script" ] |> Query.count (Expect.equal 0)
                            , \_ -> result |> Query.has [ S.text source ]
                            ]
                            ()
        ]
