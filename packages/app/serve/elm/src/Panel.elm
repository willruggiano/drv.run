module Panel exposing (Branch, Context, Field(..), Settings, branchesDecoder, contextDecoder, contextView, edit, settingsBody, settingsDecoder, settingsView)

import Dict
import Html exposing (Html, div, form, input, label, li, ol, option, section, select, span, text, ul)
import Html.Attributes as A exposing (attribute, class, id, value)
import Html.Events exposing (onBlur, onInput, onSubmit)
import Http
import Json.Decode as D exposing (Decoder)


type Field
    = Name
    | Model
    | Target
    | Thinking
    | Directory


type alias Settings =
    { name : String
    , model : String
    , target : String
    , thinking : String
    , directory : String
    , models : List ModelOption
    , targets : List TargetOption
    }


type alias ModelOption =
    { key : String, label : String, levels : List String, default : String }


type alias TargetOption =
    { key : String, label : String, disabled : Bool, root : String }


settingsDecoder : Decoder Settings
settingsDecoder =
    D.map7 Settings
        (D.field "name" D.string)
        (D.field "model" D.string)
        (D.field "target" D.string)
        (D.field "thinking" D.string)
        (D.field "directory" D.string)
        (D.field "models" (D.list (D.map4 ModelOption (D.field "key" D.string) (D.field "label" D.string) (D.field "levels" (D.list D.string)) (D.field "default" D.string))))
        (D.field "targets" (D.list (D.map4 TargetOption (D.field "key" D.string) (D.field "label" D.string) (D.field "disabled" D.bool) (D.field "root" D.string))))


edit : Field -> String -> Settings -> Settings
edit field str settings =
    case field of
        Name ->
            { settings | name = str }

        Model ->
            { settings | model = str, thinking = "" }

        Target ->
            { settings | target = str, directory = "" }

        Thinking ->
            { settings | thinking = str }

        Directory ->
            { settings | directory = str }


settingsBody : Settings -> Http.Body
settingsBody settings =
    Http.multipartBody (List.map (\( key, str ) -> Http.stringPart key str) [ ( "name", settings.name ), ( "model", settings.model ), ( "target", settings.target ), ( "thinkingLevel", settings.thinking ), ( "baseDirectory", settings.directory ) ])


settingsView : (Field -> String -> msg) -> msg -> List String -> Settings -> Html msg
settingsView change save directories settings =
    let
        model =
            List.filter (.key >> (==) settings.model) settings.models |> List.head

        root =
            List.filter (.key >> (==) settings.target) settings.targets |> List.head |> Maybe.map .root |> Maybe.withDefault ""

        levels =
            Maybe.map .levels model |> Maybe.withDefault []

        choice selected key title disabled =
            option [ value key, A.selected (key == selected), A.disabled disabled ] [ text title ]

        field title control =
            label [] [ span [] [ text title ], control ]
    in
    form [ id "session-settings", onSubmit save ]
        [ field "Session" (input [ A.name "name", A.maxlength 120, A.placeholder "Untitled session", value settings.name, onInput (change Name), onBlur save ] [])
        , div [ id "options" ]
            [ field "Environment" (select [ id "targets", A.name "target", value settings.target, onInput (change Target) ] (List.map (\item -> choice settings.target item.key item.label item.disabled) settings.targets))
            , field "Model" (select [ id "models", A.name "model", value settings.model, onInput (change Model) ] (List.map (\item -> choice settings.model item.key item.label False) settings.models))
            , field "Thinking"
                (select [ id "thinking", A.name "thinkingLevel", value settings.thinking, onInput (change Thinking) ]
                    (choice settings.thinking "" ("Default (" ++ (Maybe.map .default model |> Maybe.withDefault "off") ++ ")") False
                        :: List.map (\level -> choice settings.thinking level level False) levels
                        ++ (if settings.thinking /= "" && not (List.member settings.thinking levels) then
                                [ choice settings.thinking settings.thinking (settings.thinking ++ " (clamped by model)") False ]

                            else
                                []
                           )
                    )
                )
            , label [ A.hidden (root == "") ] [ span [] [ text "Base directory" ], input [ id "base-directory", A.name "baseDirectory", A.maxlength 4096, A.placeholder (root ++ " (default)"), A.list "directories", value settings.directory, onInput (change Directory), onBlur save ] [] ]
            , Html.datalist [ id "directories" ] (List.map (\path -> option [ value path ] []) directories)
            ]
        ]


type alias Branch =
    { path : String, title : String, parent : Maybe Int }


branchesDecoder : Decoder (List Branch)
branchesDecoder =
    D.list (D.map3 Branch (D.field "path" D.string) (D.field "title" D.string) (D.field "parent" (D.nullable D.int)))


type Context
    = Unavailable
    | Available Usage


type alias Usage =
    { conversation : Int
    , tail : Maybe Int
    , window : Maybe Int
    , tokens : Int
    , remaining : Maybe Int
    , fraction : Maybe Float
    , policy : Policy
    , blockingAt : Maybe Int
    , backgroundAt : Maybe Int
    , roles : List Role
    , messages : List Message
    }


type alias Policy =
    { enabled : Bool, reserveTokens : Int, backgroundTokens : Int }


type alias Role =
    { role : String, tokens : Int }


type alias Message =
    { role : String, tokens : Int, source : Maybe Source, toolName : Maybe String, parts : List Part }


type alias Source =
    { entry : Int, kind : String }


type Part
    = Part { name : String, value : Maybe String, tokens : Int, children : List Part }


andMap : Decoder a -> Decoder (a -> b) -> Decoder b
andMap =
    D.map2 (|>)


optional : String -> Decoder a -> Decoder (Maybe a)
optional name decoder =
    D.dict D.value
        |> D.andThen
            (\members ->
                case Dict.get name members of
                    Nothing ->
                        D.succeed Nothing

                    Just raw ->
                        case D.decodeValue decoder raw of
                            Ok val ->
                                D.succeed (Just val)

                            Err error ->
                                D.fail (D.errorToString error)
            )


partDecoder : Decoder Part
partDecoder =
    D.map4 (\name val tokens children -> Part { name = name, value = val, tokens = tokens, children = children })
        (D.field "name" D.string)
        (optional "value" D.string)
        (D.field "tokens" D.int)
        (optional "children" (D.list (D.lazy (\_ -> partDecoder))) |> D.map (Maybe.withDefault []))


contextDecoder : Decoder Context
contextDecoder =
    D.field "state" D.string
        |> D.andThen
            (\state ->
                case state of
                    "unavailable" ->
                        D.succeed Unavailable

                    "available" ->
                        D.succeed Usage
                            |> andMap (D.field "conversation" D.int)
                            |> andMap (D.field "tail" (D.nullable D.int))
                            |> andMap (D.field "window" (D.nullable D.int))
                            |> andMap (D.field "tokens" D.int)
                            |> andMap (D.field "remaining" (D.nullable D.int))
                            |> andMap (D.field "fraction" (D.nullable D.float))
                            |> andMap (D.field "policy" (D.map3 Policy (D.field "enabled" D.bool) (D.field "reserveTokens" D.int) (D.field "backgroundTokens" D.int)))
                            |> andMap (D.field "blockingAt" (D.nullable D.int))
                            |> andMap (D.field "backgroundAt" (D.nullable D.int))
                            |> andMap (D.field "roles" (D.list (D.map2 Role (D.field "role" D.string) (D.field "tokens" D.int))))
                            |> andMap
                                (D.field "messages"
                                    (D.list
                                        (D.map5 Message
                                            (D.field "role" D.string)
                                            (D.field "tokens" D.int)
                                            (optional "source" (D.map2 Source (D.field "entry" D.int) (D.field "kind" D.string)))
                                            (optional "toolName" D.string)
                                            (D.field "parts" (D.list partDecoder))
                                        )
                                    )
                                )
                            |> D.map Available

                    _ ->
                        D.fail "Unknown context state"
            )


count : Int -> String
count n =
    if n < 1000 then
        String.fromInt n

    else
        String.fromFloat (toFloat (round (toFloat n / 100)) / 10) ++ "k"


compactTokens : Int -> String
compactTokens n =
    if n < 1000 then
        String.fromInt n

    else if n < 10000 then
        let
            ticks =
                round (toFloat n / 100)
        in
        String.fromInt (ticks // 10) ++ "." ++ String.fromInt (modBy 10 ticks) ++ "k"

    else if n < 1000000 then
        String.fromInt (round (toFloat n / 1000)) ++ "k"

    else if n < 10000000 then
        let
            ticks =
                round (toFloat n / 100000)
        in
        String.fromInt (ticks // 10) ++ "." ++ String.fromInt (modBy 10 ticks) ++ "M"

    else
        String.fromInt (round (toFloat n / 1000000)) ++ "M"


caption : String -> String -> Html msg
caption css str =
    span [ class css ] [ text str ]


fields : Bool -> List Part -> Html msg
fields nested parts =
    ol
        [ class
            (if nested then
                "ctx-fields ctx-files"

             else
                "ctx-fields"
            )
        ]
        (List.map
            (\(Part part) ->
                li []
                    [ div [ class "ctx-field" ]
                        [ span [ class "ctx-field-main" ]
                            [ caption
                                (if nested then
                                    "ctx-field-value"

                                 else
                                    "ctx-field-name"
                                )
                                part.name
                            , Maybe.map (caption "ctx-field-value") part.value |> Maybe.withDefault (text "")
                            ]
                        , caption "ctx-tokens" (count part.tokens)
                        ]
                    , if List.isEmpty part.children then
                        text ""

                      else
                        fields True part.children
                    ]
            )
            parts
        )


contextView : Context -> Html msg
contextView context =
    case context of
        Unavailable ->
            section [ id "context-view", class "pane" ] [ caption "ctx-state" "Context unavailable" ]

        Available data ->
            let
                position n =
                    String.fromFloat (clamp 0 100 (toFloat n / toFloat (Maybe.withDefault 1 data.window) * 100)) ++ "%"

                threshold =
                    (if data.policy.backgroundTokens > 0 then
                        data.backgroundAt

                     else
                        data.blockingAt
                    )
                        |> Maybe.withDefault 0

                message index item =
                    li
                        ([ class "ctx-message", attribute "data-order" (String.fromInt index), attribute "data-role" item.role, attribute "data-tokens" (String.fromInt item.tokens) ]
                            ++ (item.source |> Maybe.map (\source -> [ attribute "data-entry" (String.fromInt source.entry), attribute "data-kind" source.kind ]) |> Maybe.withDefault [])
                        )
                        [ div [ class "ctx-message-heading" ]
                            [ caption "ctx-swatch" ""
                            , span [ class "ctx-heading-main" ]
                                [ caption "ctx-role" item.role
                                , item.source
                                    |> Maybe.map
                                        (\source ->
                                            if List.member source.kind [ "pi.reset", "pi.compaction" ] then
                                                caption "ctx-provenance" source.kind

                                            else
                                                text ""
                                        )
                                    |> Maybe.withDefault (text "")
                                , Maybe.map (caption "ctx-tool-name") item.toolName |> Maybe.withDefault (text "")
                                ]
                            , caption "ctx-tokens" (count item.tokens)
                            ]
                        , if item.role == "toolResult" && List.map (\(Part part) -> part.name) item.parts == [ "text" ] then
                            text ""

                          else
                            fields False item.parts
                        ]
            in
            section [ id "context-view", class "pane", attribute "data-conversation" (String.fromInt data.conversation), attribute "data-tail" (Maybe.map String.fromInt data.tail |> Maybe.withDefault ""), attribute "data-tokens" (String.fromInt data.tokens) ]
                [ section [ attribute "aria-label" "Context usage" ]
                    [ div [ class "ctx-usage" ]
                        [ span [ class "ctx-big" ] [ text ("~" ++ count data.tokens ++ " "), caption "" ("/ " ++ (Maybe.map count data.window |> Maybe.withDefault "?")) ]
                        , div [ class "ctx-capacity" ]
                            [ caption "ctx-percent"
                                (Maybe.map
                                    (\fraction ->
                                        let
                                            ticks =
                                                round (fraction * 1000)
                                        in
                                        String.fromInt (ticks // 10) ++ "." ++ String.fromInt (modBy 10 ticks) ++ "%"
                                    )
                                    data.fraction
                                    |> Maybe.withDefault "-"
                                )
                            , caption "ctx-remaining" (Maybe.map (\n -> count n ++ " remaining") data.remaining |> Maybe.withDefault "")
                            ]
                        ]
                    , if data.window == Nothing then
                        text ""

                      else
                        div [ class "ctx-window", attribute "role" "img", attribute "aria-label" ("Estimated context: " ++ String.fromInt data.tokens ++ " of " ++ (Maybe.map String.fromInt data.window |> Maybe.withDefault "?") ++ " tokens.") ]
                            [ div [ class "ctx-track" ] (List.map (\role -> span [ class "ctx-segment", attribute "data-role" role.role, A.style "width" (position role.tokens) ] []) data.roles)
                            , if data.policy.enabled then
                                span [ class "ctx-threshold", A.style "left" (position threshold) ] []

                              else
                                text ""
                            , if data.policy.enabled then
                                span [ class "ctx-reserved", A.style "width" (position data.policy.reserveTokens) ] []

                              else
                                text ""
                            ]
                    , if data.window /= Nothing && data.policy.enabled then
                        div [ class "ctx-ruler", attribute "aria-hidden" "true" ] [ span [ class "ctx-auto", A.style "left" (position threshold) ] [ text ("~" ++ compactTokens threshold) ] ]

                      else
                        text ""
                    , if data.window /= Nothing && data.policy.enabled then
                        div [ class "ctx-reserve-caption" ] [ caption "ctx-reserve-key" "", text (count data.policy.reserveTokens ++ " reserved") ]

                      else
                        text ""
                    , ul [ class "ctx-legend", attribute "aria-label" "Message roles" ] (List.map (\role -> li [ attribute "data-role" role.role ] [ caption "ctx-swatch" "", caption "" role.role, caption "ctx-tokens" (count role.tokens) ]) data.roles)
                    ]
                , section [ class "ctx-inventory", attribute "aria-label" "Context messages in provider order" ]
                    [ ol [ class "ctx-messages" ] (List.indexedMap message data.messages)
                    , if List.isEmpty data.messages then
                        caption "ctx-state" "No context"

                      else
                        text ""
                    ]
                ]
