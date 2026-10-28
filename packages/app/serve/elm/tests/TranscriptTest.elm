module TranscriptTest exposing (tests)

import Dict
import Expect
import Html
import Html.Attributes as A
import Protocol exposing (Block(..))
import Syntax
import Test exposing (Test, describe, test)
import Test.Html.Query as Query
import Test.Html.Selector as S
import Transcript
import Url


render : String -> Query.Single ()
render source =
    Transcript.blockView { path = "/sessions/test/conversations/1", hideImages = False, syntax = Syntax.empty } (\_ _ -> ()) Dict.empty Dict.empty (Text source)
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
                                |> Query.find [ S.tag "elm-file" ]
                                |> Query.has [ S.attribute (A.attribute "image" ""), S.attribute (A.attribute "label" "Screenshot"), S.attribute (A.src ("/sessions/test/conversations/1/file?path=" ++ Url.percentEncode (Url.percentDecode path |> Maybe.withDefault path))) ]
                )
                [ "/tmp/screenshot.png", "screenshots/result.png", "./result.png", "../result.png", "screenshots/with%20spaces%23%3F.png" ]
            )
        , test "hidden Markdown images and image blocks have no image element or source" <|
            \_ ->
                Expect.all
                    (List.map
                        (\block ->
                            \_ ->
                                Transcript.blockView { path = "/sessions/test/conversations/1", hideImages = True, syntax = Syntax.empty } (\_ _ -> ()) Dict.empty Dict.empty block
                                    |> List.singleton
                                    |> Html.div []
                                    |> Query.fromHtml
                                    |> Query.findAll [ S.tag "elm-file" ]
                                    |> Query.count (Expect.equal 0)
                        )
                        [ Text "![Screenshot](shot.png)", Image "image/png" "AA==" ]
                    )
                    ()
        , test "structured image blocks use the inline image preview" <|
            \_ ->
                Transcript.blockView { path = "/sessions/test/conversations/1", hideImages = False, syntax = Syntax.empty } (\_ _ -> ()) Dict.empty Dict.empty (Image "image/png" "AA==")
                    |> List.singleton
                    |> Html.div []
                    |> Query.fromHtml
                    |> Query.find [ S.tag "elm-file" ]
                    |> Query.has [ S.attribute (A.attribute "image" ""), S.attribute (A.src "data:image/png;base64,AA==") ]
        , test "source citations retain line anchors separately from the file path" <|
            \_ ->
                render "[Transcript.elm:217](packages/app/serve/elm/src/Transcript.elm#L217)"
                    |> Query.find [ S.tag "a" ]
                    |> Query.has [ S.attribute (A.href "/sessions/test/conversations/1/file?path=packages%2Fapp%2Fserve%2Felm%2Fsrc%2FTranscript.elm#L217"), S.attribute (A.target "_blank"), S.attribute (A.rel "noopener noreferrer"), S.attribute (A.title "packages/app/serve/elm/src/Transcript.elm") ]
        , test "source citations do not create inline previews" <|
            \_ ->
                render "Before ([projection](stream.ts), [renderer](Transcript.elm)) after."
                    |> Query.findAll [ S.tag "elm-file" ]
                    |> Query.count (Expect.equal 0)
        , test "absolute source links encode filename fragments" <|
            \_ ->
                render "[Source](/tmp/a%23b.ts#L2)"
                    |> Query.find [ S.tag "a" ]
                    |> Query.has [ S.attribute (A.href "/sessions/test/conversations/1/file?path=%2Ftmp%2Fa%23b.ts#L2"), S.attribute (A.title "/tmp/a#b.ts") ]
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
                                |> Query.findAll [ S.tag "elm-file" ]
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
