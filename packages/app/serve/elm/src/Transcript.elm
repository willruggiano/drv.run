module Transcript exposing (Context, blockView, codeSources, commandLabel, entrySearch, toolStatus, transcript, viewMessage)

import Dict exposing (Dict)
import Html exposing (Html, a, article, button, code, details, div, header, p, pre, span, strong, summary, text)
import Html.Attributes as A exposing (attribute, class, hidden, id, style)
import Html.Events exposing (onClick, preventDefaultOn)
import Html.Keyed
import Html.Lazy
import Json.Decode as D
import Json.Encode as E
import Protocol exposing (Block(..), Boundary(..), Entry, Message, State, Tool)
import Regex
import Syntax
import Url


type alias Context =
    { path : String, hideImages : Bool, syntax : Syntax.Model }


fences : String -> List Regex.Match
fences =
    Regex.find (regex "(?:^|\\n)```([^\\n]*)\\n([\\s\\S]*?)(?:\\n```[ \\t]*(?=\\n|$)|(?![\\s\\S]))")


fenceSource : Regex.Match -> ( String, String )
fenceSource match =
    ( List.head match.submatches |> Maybe.andThen identity |> Maybe.withDefault "" |> String.words |> List.head |> Maybe.withDefault ""
    , (List.drop 1 match.submatches |> List.head |> Maybe.andThen identity |> Maybe.withDefault "") ++ "\n"
    )


codeSources : State -> List ( String, String )
codeSources state =
    let
        blocks items =
            List.concatMap
                (\block ->
                    case block of
                        Text source ->
                            List.map fenceSource (fences source)

                        _ ->
                            []
                )
                items
    in
    (Dict.values state.entries |> List.concatMap .messages |> List.append state.live.messages |> List.concatMap (.blocks >> blocks))
        ++ List.concatMap (.blocks >> blocks) state.queue
        ++ (Dict.values state.tools
                |> List.concatMap
                    (\tool ->
                        blocks tool.blocks
                            ++ [ ( if tool.patch then
                                    "diff"

                                   else
                                    "json"
                                 , tool.details
                                 )
                               , ( Syntax.fromPath tool.path, tool.written )
                               ]
                    )
           )


commandLabel : String -> Html msg
commandLabel source =
    Html.node "elm-command" [ class "tool-command", attribute "source" source ] []


toolStatus : String -> Html msg
toolStatus state =
    span [ class "tool-status", attribute "data-state" state, attribute "role" "img", attribute "aria-label" state ]
        (if state == "running" then
            List.map (\index -> span [ style "animation-delay" ("-" ++ String.fromInt (index * 225) ++ "ms") ] []) (List.range 0 3)

         else
            [ text
                (case state of
                    "completed" ->
                        "✓"

                    "failed" ->
                        "✕"

                    "pending" ->
                        "◷"

                    "cancelled" ->
                        "⊘"

                    _ ->
                        "?"
                )
            ]
        )


regex : String -> Regex.Regex
regex source =
    Regex.fromString source |> Maybe.withDefault Regex.never


inline : Context -> String -> List (Html msg)
inline context source =
    let
        matches =
            Regex.find (regex "(`[^`]+`|\\*\\*[^*]+\\*\\*|!?\\[[^\\]\\n]*\\]\\([^\\s)]+\\))") source

        part match =
            if String.startsWith "`" match then
                code [] [ text (String.slice 1 -1 match) ]

            else if String.startsWith "**" match then
                strong [] [ text (String.slice 2 -2 match) ]

            else
                let
                    index =
                        String.indexes "](" match |> List.head |> Maybe.withDefault 0

                    image =
                        String.startsWith "!" match

                    label =
                        String.slice
                            (if image then
                                2

                             else
                                1
                            )
                            index
                            match

                    destination =
                        String.slice (index + 2) -1 match

                    link href title =
                        a [ A.href href, A.title title, A.target "_blank", A.rel "noopener noreferrer" ] [ text label ]

                    parts =
                        String.split "#" destination

                    fragment =
                        case List.drop 1 parts of
                            [ line ] ->
                                if Regex.contains (regex "^L[1-9][0-9]*$") line then
                                    "#" ++ line

                                else
                                    ""

                            _ ->
                                ""
                in
                if Url.fromString destination /= Nothing then
                    if image then
                        text match

                    else
                        link destination destination

                else if String.startsWith "//" destination || Regex.contains (regex "^[A-Za-z][A-Za-z0-9+.-]*:") destination then
                    text match

                else
                    case List.head parts |> Maybe.andThen Url.percentDecode of
                        Just path ->
                            if path == "" then
                                text match

                            else if image then
                                imageView context.hideImages label (context.path ++ "/file?path=" ++ Url.percentEncode path)

                            else
                                link (context.path ++ "/file?path=" ++ Url.percentEncode path ++ fragment) path

                        Nothing ->
                            text match

        step match ( offset, parts ) =
            ( match.index + String.length match.match, parts ++ [ text (String.slice offset match.index source), part match.match ] )

        ( end, nodes ) =
            List.foldl step ( 0, [] ) matches
    in
    nodes ++ [ text (String.dropLeft end source) ]


codeView : Syntax.Model -> String -> String -> Html msg
codeView syntax language source =
    pre [ attribute "data-language" (Syntax.language language) ] [ code [] (Syntax.view syntax language source) ]


markdown : Context -> String -> Html msg
markdown context source =
    let
        paragraphs str =
            Regex.split (regex "\\n\\n+") str
                |> List.filter ((/=) "")
                |> List.map
                    (\paragraph ->
                        case Regex.find (regex "^(#{1,4}) (.*)$") paragraph |> List.head of
                            Just match ->
                                let
                                    hashes =
                                        List.head match.submatches |> Maybe.andThen identity |> Maybe.withDefault ""

                                    content =
                                        List.drop 1 match.submatches |> List.head |> Maybe.andThen identity |> Maybe.withDefault ""
                                in
                                Html.node ("h" ++ String.fromInt (String.length hashes + 1)) [] (inline context content)

                            Nothing ->
                                p [] (inline context paragraph)
                    )

        step match ( offset, acc ) =
            let
                ( language, content ) =
                    fenceSource match
            in
            ( match.index + String.length match.match, acc ++ paragraphs (String.slice offset match.index source) ++ [ codeView context.syntax language content ] )

        ( end, nodes ) =
            List.foldl step ( 0, [] ) (fences source)
    in
    div [ class "text", attribute "data-source" source ] (nodes ++ paragraphs (String.dropLeft end source))


toolView : Context -> (String -> Bool -> msg) -> Dict String Bool -> Dict String Tool -> String -> Html msg
toolView context toggle opened tools key =
    case Dict.get key tools of
        Nothing ->
            text ""

        Just tool ->
            let
                isOpen =
                    Dict.get key opened |> Maybe.withDefault (tool.state == "failed")

                resultBlock block =
                    case ( String.split "." tool.name |> List.reverse |> List.head, block ) of
                        ( Just "write", Code source ) ->
                            div [ class "text" ] [ text source ]

                        _ ->
                            blockView context toggle opened tools block

                disclosure name label content default =
                    let
                        k =
                            key ++ ":" ++ name

                        expanded =
                            Dict.get k opened |> Maybe.withDefault default
                    in
                    details [ A.property "open" (E.bool expanded) ] [ summary [ preventDefaultOn "click" (D.succeed ( toggle k (not expanded), True )) ] [ text label ], content ]
            in
            details [ class "tool-call", attribute "data-call-id" key, attribute "data-state" tool.state, A.property "open" (E.bool isOpen) ]
                [ summary [ preventDefaultOn "click" (D.succeed ( toggle key (not isOpen), True )) ]
                    [ toolStatus tool.state
                    , commandLabel tool.command
                    , if tool.duration == "" then
                        text ""

                      else
                        span [ class "tool-duration" ] [ text tool.duration ]
                    ]
                , div [ class "tool-result" ]
                    (List.map resultBlock tool.blocks
                        ++ [ if tool.notice == "" then
                                text ""

                             else
                                p [ class "notice" ] [ text tool.notice ]
                           , if tool.details == "" then
                                text ""

                             else
                                disclosure "details"
                                    (if tool.patch then
                                        "Changes"

                                     else
                                        "Details"
                                    )
                                    (codeView context.syntax
                                        (if tool.patch then
                                            "diff"

                                         else
                                            "json"
                                        )
                                        tool.details
                                    )
                                    tool.patch
                           , if tool.written == "" then
                                text ""

                             else
                                codeView context.syntax (Syntax.fromPath tool.path) tool.written
                           ]
                    )
                ]


imageView : Bool -> String -> String -> Html msg
imageView hideImages label src =
    if hideImages then
        text ""

    else
        Html.node "elm-file" [ attribute "src" src, attribute "label" label, attribute "image" "" ] []


blockView : Context -> (String -> Bool -> msg) -> Dict String Bool -> Dict String Tool -> Block -> Html msg
blockView context toggle opened tools block =
    case block of
        Text str ->
            Html.Lazy.lazy2 markdown context str

        Thinking str ->
            div [ class "thinking" ] [ text str ]

        Code str ->
            Html.Lazy.lazy3 codeView context.syntax "" str

        Image mime data ->
            imageView context.hideImages "Attachment" ("data:" ++ mime ++ ";base64," ++ data)

        ToolRef key ->
            toolView context toggle opened tools key


viewMessage : Context -> (String -> Bool -> msg) -> Dict String Bool -> Dict String Tool -> Bool -> Message -> List (Html msg)
viewMessage context toggle opened tools showHeader message =
    (if showHeader then
        [ header []
            [ span [ class "speaker" ]
                [ text
                    (if message.role == "assistant" then
                        "Pi"

                     else if message.role == "user" then
                        "You"

                     else
                        message.role
                    )
                ]
            , Html.node "elm-time" [ class "message-time", attribute "timestamp" (String.fromFloat message.timestamp) ] []
            ]
        ]

     else
        []
    )
        ++ List.map (blockView context toggle opened tools) message.blocks
        ++ (if message.error == "" then
                []

            else
                [ p [ class "error" ] [ text message.error ] ]
           )


entrySearch : Dict String Tool -> Entry -> String
entrySearch tools entry =
    entry.messages
        |> List.concatMap .blocks
        |> List.map
            (\block ->
                case block of
                    ToolRef key ->
                        Dict.get key tools
                            |> Maybe.map
                                (\tool ->
                                    tool.command
                                        ++ "\n"
                                        ++ tool.details
                                        ++ "\n"
                                        ++ tool.written
                                        ++ "\n"
                                        ++ String.join "\n"
                                            (List.map
                                                (\b ->
                                                    case b of
                                                        Code str ->
                                                            str

                                                        Text str ->
                                                            str

                                                        _ ->
                                                            ""
                                                )
                                                tool.blocks
                                            )
                                )
                            |> Maybe.withDefault ""

                    Text str ->
                        str

                    Code str ->
                        str

                    Thinking str ->
                        str

                    Image _ _ ->
                        ""
            )
        |> String.join "\n"


{-| All entry elements remain siblings in insertion order. CSS order changes
presentation only: neither Elm nor a browser adapter reparents completed nodes.
A boundary contributes a header and a trailing region around its archived rows.
-}
transcript : Context -> (String -> Bool -> msg) -> Dict String Bool -> String -> Maybe Int -> Dict Int Entry -> Dict String Tool -> Dict String Int -> Html msg
transcript context toggle opened query selected entriesById tools durations =
    let
        entries =
            Dict.values entriesById

        -- Walking backwards gives each entry its enclosing reset/compaction chain.
        walk entry ( ancestors, acc ) =
            if entry.boundary == Normal then
                ( ancestors, ( entry, ancestors ) :: acc )

            else
                ( entry.id :: ancestors, ( entry, ancestors ) :: acc )

        ( _, rows ) =
            List.foldr walk ( [], [] ) entries

        expanded key =
            Dict.get ("context-" ++ String.fromInt key) opened |> Maybe.withDefault False

        matches entry =
            query /= "" && String.contains (String.toLower query) (String.toLower (entrySearch tools entry))

        searchAncestors =
            rows |> List.filter (Tuple.first >> matches) |> List.concatMap Tuple.second

        isExpanded key =
            expanded key || List.member key searchAncestors

        visible ancestors =
            List.all isExpanded ancestors

        -- A boundary surrounds every earlier sibling, matching the server archive tree.
        visualOrder =
            List.foldl
                (\entry order ->
                    if entry.boundary == Normal then
                        ( entry.id, False ) :: order

                    else
                        ( entry.id, True ) :: order ++ [ ( entry.id, False ) ]
                )
                []
                entries
                |> List.reverse

        neighbors items =
            List.foldl
                (\( entry, ancestors ) ( groups, previous ) ->
                    ( if List.isEmpty entry.messages then
                        groups

                      else
                        Dict.insert ancestors entry groups
                    , case Dict.get ancestors groups of
                        Nothing ->
                            previous

                        Just prior ->
                            Dict.insert entry.id prior previous
                    )
                )
                ( Dict.empty, Dict.empty )
                items
                |> Tuple.second

        previousEntries =
            neighbors rows

        nextEntries =
            neighbors (List.reverse rows)

        speaker entry =
            let
                role =
                    List.head entry.messages |> Maybe.map .role |> Maybe.withDefault ""
            in
            if role == "toolResult" then
                "assistant"

            else
                role

        trace block =
            case block of
                ToolRef _ ->
                    True

                Thinking _ ->
                    True

                _ ->
                    False

        continues first second =
            speaker first
                /= ""
                && speaker first
                == speaker second
                && (List.concatMap .blocks first.messages |> List.reverse |> List.head |> Maybe.map trace |> Maybe.withDefault False)
                && (List.concatMap .blocks second.messages |> List.head |> Maybe.map trace |> Maybe.withDefault False)

        positions =
            List.indexedMap
                (\index ( key, ending ) ->
                    ( ( key
                      , if ending then
                            1

                        else
                            0
                      )
                    , index
                    )
                )
                visualOrder
                |> Dict.fromList

        position key ending =
            Dict.get
                ( key
                , if ending then
                    1

                  else
                    0
                )
                positions
                |> Maybe.withDefault 0

        render ( entry, ancestors ) =
            let
                key =
                    String.fromInt entry.id

                show =
                    visible ancestors

                previous =
                    Dict.get entry.id previousEntries

                role =
                    List.head entry.messages |> Maybe.map .role |> Maybe.withDefault ""

                previousRole =
                    previous |> Maybe.map speaker |> Maybe.withDefault ""

                same =
                    speaker entry /= "" && speaker entry == previousRole

                attrs =
                    [ id ("entry-" ++ key)
                    , attribute "data-entry" key
                    , attribute "data-archives" (String.join " " (List.map String.fromInt ancestors))
                    , style "order" (String.fromInt (position entry.id False))
                    , hidden (not show || (entry.boundary == Normal && List.isEmpty entry.messages))
                    , attribute "data-role" role
                    , attribute "data-separator"
                        (if previous /= Nothing && not same then
                            "true"

                         else
                            "false"
                        )
                    , A.classList [ ( "same-speaker", same ), ( "trace-start", previous |> Maybe.map (\prior -> continues prior entry) |> Maybe.withDefault False ), ( "trace-continues", Dict.get entry.id nextEntries |> Maybe.map (continues entry) |> Maybe.withDefault False ), ( "search-current", selected == Just entry.id ) ]
                    ]

                content =
                    List.concatMap (viewMessage context toggle opened tools True) entry.messages

                contextOpen =
                    isExpanded entry.id

                boundaryHead =
                    details [ class "tool-call context-event", attribute "aria-owns" (rows |> List.filter (\( _, parents ) -> List.head parents == Just entry.id) |> List.map (\( child, _ ) -> "entry-" ++ String.fromInt child.id) |> String.join " "), A.property "open" (E.bool contextOpen) ]
                        [ summary [ preventDefaultOn "click" (D.succeed ( toggle ("context-" ++ key) (not contextOpen), True )) ]
                            [ toolStatus "completed"
                            , commandLabel
                                (if entry.boundary == Reset then
                                    "Context reset"

                                 else
                                    "Context compacted"
                                )
                            , case Dict.get key durations of
                                Nothing ->
                                    text ""

                                Just ms ->
                                    let
                                        ticks =
                                            round (toFloat ms / 100)

                                        label =
                                            if ms < 1000 then
                                                String.fromInt ms ++ "ms"

                                            else
                                                String.fromInt (ticks // 10) ++ "." ++ String.fromInt (modBy 10 ticks) ++ "s"
                                    in
                                    span [ id ("duration-" ++ key), class "tool-duration", attribute "data-duration-ms" (String.fromInt ms), A.title ("Duration: " ++ String.fromInt ms ++ "ms") ] [ text label ]
                            ]
                        , if entry.boundary == Compact then
                            div [ class "compaction-summary" ] (List.concatMap (viewMessage context toggle opened tools False) entry.messages)

                          else
                            text ""
                        ]
            in
            if entry.boundary == Normal then
                [ ( "entry-" ++ key, article attrs content ) ]

            else
                [ ( "entry-" ++ key
                  , article
                        (attrs
                            ++ [ class "context-head"
                               , attribute "data-context"
                                    (if entry.boundary == Reset then
                                        "pi.reset"

                                     else
                                        "pi.compaction"
                                    )
                               , attribute "data-expanded"
                                    (if contextOpen then
                                        "true"

                                     else
                                        "false"
                                    )
                               ]
                        )
                        [ boundaryHead ]
                  )
                , ( "end-" ++ key
                  , div [ class "context-end", style "order" (String.fromInt (position entry.id True)), hidden (not show) ]
                        (if entry.boundary == Reset then
                            content

                         else
                            []
                        )
                  )
                ]
    in
    Html.Keyed.node "div" [ id "transcript", class "ordered-transcript" ] (List.concatMap render rows)
