module TranscriptTest exposing (tests)

import Dict
import Expect
import Html.Attributes as A
import Protocol exposing (Block(..))
import Test exposing (Test, describe, test)
import Test.Html.Query as Query
import Test.Html.Selector as S
import Transcript
import Url


render : String -> Query.Single ()
render source =
    Transcript.blockView "/sessions/test/conversations/1" (\_ _ -> ()) Dict.empty Dict.empty (Text source)
        |> Query.fromHtml


tests : Test
tests =
    describe "Transcript file references"
        [ describe "Images resolve through the conversation endpoint"
            (List.map
                (\path ->
                    test path <|
                        \_ ->
                            render ("![Screenshot](" ++ path ++ ")")
                                |> Query.find [ S.tag "img" ]
                                |> Query.has [ S.class "transcript-image", S.attribute (A.alt "Screenshot"), S.attribute (A.src ("/sessions/test/conversations/1/file?path=" ++ Url.percentEncode (Url.percentDecode path |> Maybe.withDefault path))) ]
                )
                [ "/tmp/screenshot.png", "screenshots/result.png", "./result.png", "../result.png", "screenshots/with%20spaces%23%3F.png" ]
            )
        , test "source citations retain line anchors separately from the file path" <|
            \_ ->
                render "[Transcript.elm:217](packages/app/serve/elm/src/Transcript.elm#L217)"
                    |> Query.find [ S.tag "a" ]
                    |> Query.has [ S.attribute (A.href "/sessions/test/conversations/1/file?path=packages%2Fapp%2Fserve%2Felm%2Fsrc%2FTranscript.elm#L217"), S.attribute (A.target "_blank"), S.attribute (A.rel "noopener noreferrer") ]
        , test "absolute source links encode filename fragments" <|
            \_ ->
                render "[Source](/tmp/a%23b.ts#L2)"
                    |> Query.find [ S.tag "a" ]
                    |> Query.has [ S.attribute (A.href "/sessions/test/conversations/1/file?path=%2Ftmp%2Fa%23b.ts#L2") ]
        , test "external links retain their URL" <|
            \_ ->
                render "[Docs](https://example.com/docs#anchor)"
                    |> Query.find [ S.tag "a" ]
                    |> Query.has [ S.attribute (A.href "https://example.com/docs#anchor") ]
        , describe "Unsupported and incomplete references do not fetch resources"
            (List.indexedMap
                (\index source ->
                    test (String.fromInt index) <|
                        \_ ->
                            render source
                                |> Query.findAll [ S.tag "img" ]
                                |> Query.count (Expect.equal 0)
                )
                [ "![Screenshot](/tmp/screenshot.png"
                , "`![Screenshot](/tmp/screenshot.png)`"
                , "```markdown\n![Screenshot](/tmp/screenshot.png)\n```"
                , "![Remote](https://example.com/image.png)"
                , "![Remote](//example.com/image.png)"
                , "![Unsafe](data:image/png;base64,AA==)"
                , "![Unsafe](javascript:alert)"
                , "![Invalid](invalid%ZZ.png)"
                ]
            )
        , describe "Non-HTTP schemes cannot become links"
            (List.map
                (\destination ->
                    test destination <|
                        \_ ->
                            render ("[Unsafe](" ++ destination ++ ")")
                                |> Query.findAll [ S.tag "a" ]
                                |> Query.count (Expect.equal 0)
                )
                [ "javascript:alert", "data:text/html,hello", "file:///etc/passwd", "//example.com/path" ]
            )
        ]
