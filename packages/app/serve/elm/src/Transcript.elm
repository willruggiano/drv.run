module Transcript exposing (blockView, entrySearch, icon, transcript, viewMessage)

import Dict exposing (Dict)
import Html exposing (Html, a, article, button, code, details, div, header, img, p, pre, span, strong, summary, text)
import Html.Attributes as A exposing (attribute, class, hidden, id, style)
import Html.Events exposing (onClick, preventDefaultOn)
import Html.Keyed
import Html.Lazy
import Json.Decode as D
import Json.Encode as E
import Protocol exposing (Block(..), Boundary(..), Entry, Message, State, Tool)
import Regex
import Svg
import Svg.Attributes as S


icon : String -> Html msg
icon name =
    Svg.svg [ S.class "glyph", S.viewBox "0 0 24 24", attribute "aria-hidden" "true" ]
        (case name of
            "send" ->
                [ Svg.path [ S.d "M12 20V4m-7 7 7-7 7 7" ] [] ]

            "close" ->
                [ Svg.path [ S.d "m6 6 12 12M18 6 6 18" ] [] ]

            _ ->
                [ Svg.path [ S.d "m9 3-.6 2.4-1.5.9-2.4-.7-3 5.2L3.3 12l.1 1.8-1.7 1.8 3 5.2 2.3-.7 1.6.9.5 2.4h6l.6-2.4 1.5-.9 2.4.7 3-5.2-1.8-1.2-.1-1.8 1.7-1.8-3-5.2-2.3.7-1.6-.9L15 3Z", S.transform "translate(1 -1) scale(.92)" ] [], Svg.circle [ S.cx "12", S.cy "12", S.r "3.2" ] [] ]
        )


regex : String -> Regex.Regex
regex source =
    Regex.fromString source |> Maybe.withDefault Regex.never


inline : String -> List (Html msg)
inline source =
    let
        matches =
            Regex.find (regex "(`[^`]+`|\\*\\*[^*]+\\*\\*|\\[[^\\]]+\\]\\(https?://[^\\s)]+\\))") source

        part match =
            if String.startsWith "`" match then
                code [] [ text (String.slice 1 -1 match) ]

            else if String.startsWith "**" match then
                strong [] [ text (String.slice 2 -2 match) ]

            else
                let
                    index =
                        String.indexes "](" match |> List.head |> Maybe.withDefault 0
                in
                a [ A.href (String.slice (index + 2) -1 match), A.target "_blank", A.rel "noopener noreferrer" ] [ text (String.slice 1 index match) ]

        step match ( offset, parts ) =
            ( match.index + String.length match.match, parts ++ [ text (String.slice offset match.index source), part match.match ] )

        ( end, nodes ) =
            List.foldl step ( 0, [] ) matches
    in
    nodes ++ [ text (String.dropLeft end source) ]


codeView : String -> String -> Html msg
codeView language source =
    Html.node "elm-code" [ class "code-container", attribute "language" language, attribute "source" source ] []


markdown : String -> Html msg
markdown source =
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
                                Html.node ("h" ++ String.fromInt (String.length hashes + 1)) [] (inline content)

                            Nothing ->
                                p [] (inline paragraph)
                    )

        fences =
            Regex.find (regex "(?:^|\\n)```([^\\n]*)\\n([\\s\\S]*?)(?:\\n```[ \\t]*(?=\\n|$)|(?![\\s\\S]))") source

        step match ( offset, acc ) =
            let
                language =
                    List.head match.submatches |> Maybe.andThen identity |> Maybe.withDefault "" |> String.words |> List.head |> Maybe.withDefault ""

                content =
                    List.drop 1 match.submatches |> List.head |> Maybe.andThen identity |> Maybe.withDefault ""
            in
            ( match.index + String.length match.match, acc ++ paragraphs (String.slice offset match.index source) ++ [ codeView language (content ++ "\n") ] )

        ( end, nodes ) =
            List.foldl step ( 0, [] ) fences
    in
    div [ class "text" ] (nodes ++ paragraphs (String.dropLeft end source))


toolView : (String -> Bool -> msg) -> Dict String Bool -> Dict String Tool -> String -> Html msg
toolView toggle opened tools key =
    case Dict.get key tools of
        Nothing ->
            text ""

        Just tool ->
            let
                isOpen =
                    Dict.get key opened |> Maybe.withDefault (tool.state == "failed")

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
                    [ span [ class "tool-status", attribute "data-state" tool.state, attribute "role" "img", attribute "aria-label" tool.state ]
                        (if tool.state == "running" then
                            List.map (\index -> span [ style "animation-delay" ("-" ++ String.fromInt (index * 225) ++ "ms") ] []) (List.range 0 3)

                         else
                            [ text
                                (case tool.state of
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
                    , span [ class "tool-command" ] [ text tool.command ]
                    , if tool.duration == "" then
                        text ""

                      else
                        span [ class "tool-duration" ] [ text tool.duration ]
                    ]
                , div [ class "tool-result" ]
                    (List.map (blockView toggle opened tools) tool.blocks
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
                                    (codeView
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
                                disclosure "written" "Written content" (codeView "" tool.written) False
                           ]
                    )
                ]


blockView : (String -> Bool -> msg) -> Dict String Bool -> Dict String Tool -> Block -> Html msg
blockView toggle opened tools block =
    case block of
        Text str ->
            Html.Lazy.lazy markdown str

        Thinking str ->
            div [ class "thinking" ] [ text str ]

        Code str ->
            Html.Lazy.lazy2 codeView "" str

        Image mime data ->
            img [ class "transcript-image", A.alt "Attachment", A.src ("data:" ++ mime ++ ";base64," ++ data) ] []

        ToolRef key ->
            toolView toggle opened tools key


viewMessage : (String -> Bool -> msg) -> Dict String Bool -> Dict String Tool -> Bool -> Message -> List (Html msg)
viewMessage toggle opened tools showHeader message =
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
        ++ List.map (blockView toggle opened tools) message.blocks
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
transcript : (String -> Bool -> msg) -> Dict String Bool -> String -> Maybe Int -> Dict Int Entry -> Dict String Tool -> Dict String Int -> Html msg
transcript toggle opened query selected entriesById tools durations =
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

        previousEntries =
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
                rows
                |> Tuple.second

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
                    previous |> Maybe.andThen (.messages >> List.head) |> Maybe.map .role |> Maybe.withDefault ""

                same =
                    role /= "" && role == previousRole

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
                    , A.classList [ ( "same-speaker", same ), ( "search-current", selected == Just entry.id ) ]
                    ]

                content =
                    List.concatMap (viewMessage toggle opened tools True) entry.messages

                contextOpen =
                    isExpanded entry.id

                boundaryHead =
                    details [ class "tool-call context-event", attribute "aria-owns" (rows |> List.filter (\( _, parents ) -> List.head parents == Just entry.id) |> List.map (\( child, _ ) -> "entry-" ++ String.fromInt child.id) |> String.join " "), A.property "open" (E.bool contextOpen) ]
                        [ summary [ preventDefaultOn "click" (D.succeed ( toggle ("context-" ++ key) (not contextOpen), True )) ]
                            [ span [ class "tool-status", attribute "data-state" "completed" ] [ text "✓" ]
                            , span [ class "tool-command" ]
                                [ text
                                    (if entry.boundary == Reset then
                                        "Context reset"

                                     else
                                        "Context compacted"
                                    )
                                ]
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
                            div [ class "compaction-summary" ] (List.concatMap (viewMessage toggle opened tools False) entry.messages)

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
