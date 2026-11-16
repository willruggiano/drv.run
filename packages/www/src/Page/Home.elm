module Page.Home exposing (Model, Msg, init, subscriptions, update, view)

import Api
import Api.Enum.ModelThinkingLevel as Thinking exposing (ModelThinkingLevel)
import Api.Home as Home exposing (Environment, EnvironmentPage, ModelChoice, Session)
import Api.Scalars as Scalars
import Browser
import Bytes exposing (Bytes)
import Bytes.Decode as ByteDecode
import Bytes.Encode as ByteEncode
import File exposing (File)
import File.Select
import Graphql.Http as Http
import Graphql.Http.GraphqlError exposing (PossiblyParsedData(..))
import Html exposing (Html, a, button, div, fieldset, footer, form, h2, input, label, main_, option, p, section, select, span, text, textarea)
import Html.Attributes as Attr exposing (attribute, class, id)
import Html.Events as Events exposing (onClick, onInput, onSubmit)
import Json.Decode as Decode
import Json.Encode as Encode
import Route
import Svg
import Svg.Attributes as SvgAttr
import Task



-- MODEL


type Read data
    = Loading (Maybe data)
    | Loaded data
    | Partial data (Api.Failure data)
    | Failed (Maybe data) (Api.Failure data)


type alias Model =
    { sessions : Read (List Session)
    , models : Read (List ModelChoice)
    , environments : Read (Maybe EnvironmentPage)
    , selectedModel : Maybe ModelChoice
    , thinking : Maybe ModelThinkingLevel
    , environment : Maybe Environment
    , directory : String
    , prompt : String
    , attachments : List Attachment
    , nextAttachment : Int
    }


type alias Attachment =
    { id : AttachmentId, file : File, state : AttachmentState }


type AttachmentId
    = AttachmentId Int


type AttachmentContent
    = Image String
    | Text String


type Pagination
    = Replace
    | Append


type AttachmentState
    = Reading
    | Ready AttachmentContent
    | Rejected String



-- INIT


init : () -> ( Model, Cmd Msg )
init _ =
    ( { sessions = Loading Nothing
      , models = Loading Nothing
      , environments = Loading Nothing
      , selectedModel = Nothing
      , thinking = Nothing
      , environment = Nothing
      , directory = ""
      , prompt = ""
      , attachments = []
      , nextAttachment = 0
      }
    , Cmd.batch
        [ Api.query SessionsReceived Home.sessions
        , Api.query ModelsReceived Home.models
        , Api.query (EnvironmentsReceived Replace) (Home.environments Nothing)
        ]
    )



-- UPDATE


type Msg
    = SessionsReceived (Api.Response (List Session))
    | ModelsReceived (Api.Response (List ModelChoice))
    | EnvironmentsReceived Pagination (Api.Response (Maybe EnvironmentPage))
    | RefreshSessions
    | RefreshModels
    | RefreshEnvironments
    | MoreEnvironments
    | ModelSelected String
    | ThinkingSelected String
    | EnvironmentSelected String
    | DirectoryEdited String
    | PromptEdited String
    | PickFiles
    | FilesSelected (List File)
    | AttachmentRead AttachmentId (Result String AttachmentContent)
    | AttachmentRemoved AttachmentId
    | NoOp


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        SessionsReceived response ->
            ( { model | sessions = receive response model.sessions }, Cmd.none )

        ModelsReceived response ->
            ( { model | models = receive response model.models }, Cmd.none )

        EnvironmentsReceived pagination response ->
            ( { model | environments = receiveEnvironments pagination response model.environments }, Cmd.none )

        RefreshSessions ->
            if pending model.sessions then
                ( model, Cmd.none )

            else
                ( { model | sessions = Loading (observed model.sessions) }, Api.query SessionsReceived Home.sessions )

        RefreshModels ->
            if pending model.models then
                ( model, Cmd.none )

            else
                ( { model | models = Loading (observed model.models) }, Api.query ModelsReceived Home.models )

        RefreshEnvironments ->
            if pending model.environments then
                ( model, Cmd.none )

            else
                ( { model | environments = Loading (observed model.environments) }, Api.query (EnvironmentsReceived Replace) (Home.environments Nothing) )

        MoreEnvironments ->
            case observed model.environments |> Maybe.andThen identity |> Maybe.andThen .next of
                Just cursor ->
                    if pending model.environments then
                        ( model, Cmd.none )

                    else
                        ( { model | environments = Loading (observed model.environments) }, Api.query (EnvironmentsReceived Append) (Home.environments (Just cursor)) )

                Nothing ->
                    ( model, Cmd.none )

        ModelSelected key ->
            let
                selected =
                    observed model.models
                        |> Maybe.withDefault []
                        |> List.filter (\choice -> modelKey choice == key)
                        |> List.head

                levels =
                    selected |> Maybe.map .thinkingLevels |> Maybe.withDefault []
            in
            ( { model | selectedModel = selected, thinking = supportedThinking levels model.thinking }, Cmd.none )

        ThinkingSelected value ->
            let
                levels =
                    currentModel model.selectedModel (observed model.models |> Maybe.withDefault [])
                        |> Maybe.map .thinkingLevels
                        |> Maybe.withDefault []
            in
            ( { model | thinking = supportedThinking levels (Thinking.fromString value) }, Cmd.none )

        EnvironmentSelected key ->
            ( { model | environment = selectedEnvironment key (environmentChoices model.environments) }, Cmd.none )

        DirectoryEdited value ->
            ( { model | directory = value }, Cmd.none )

        PromptEdited value ->
            ( { model | prompt = value }, Cmd.none )

        PickFiles ->
            ( model, File.Select.files [] (\first rest -> FilesSelected (first :: rest)) )

        FilesSelected files ->
            let
                added =
                    List.indexedMap (\index file -> { id = AttachmentId (model.nextAttachment + index), file = file, state = Reading }) files
            in
            ( { model | attachments = model.attachments ++ added, nextAttachment = model.nextAttachment + List.length files }
            , Cmd.batch (List.map readAttachment added)
            )

        AttachmentRead key result ->
            ( { model | attachments = List.map (receiveAttachment key result) model.attachments }, Cmd.none )

        AttachmentRemoved key ->
            ( { model | attachments = List.filter (.id >> (/=) key) model.attachments }, Cmd.none )

        NoOp ->
            ( model, Cmd.none )



-- READS
-- Each catalog is single-flight. Refresh never changes the page-local draft.


observed : Read data -> Maybe data
observed read =
    case read of
        Loading previous ->
            previous

        Loaded value ->
            Just value

        Partial value _ ->
            Just value

        Failed previous _ ->
            previous


pending : Read data -> Bool
pending read =
    case read of
        Loading _ ->
            True

        Loaded _ ->
            False

        Partial _ _ ->
            False

        Failed _ _ ->
            False


receive : Api.Response data -> Read data -> Read data
receive response previous =
    case response of
        Ok value ->
            Loaded value

        Err failure ->
            case failure.detail of
                Http.GraphqlError (ParsedData value) _ ->
                    Partial value failure

                _ ->
                    Failed (observed previous) failure



-- ENVIRONMENT PAGES


receiveEnvironments : Pagination -> Api.Response (Maybe EnvironmentPage) -> Read (Maybe EnvironmentPage) -> Read (Maybe EnvironmentPage)
receiveEnvironments pagination response previous =
    let
        combine page =
            case pagination of
                Replace ->
                    page

                Append ->
                    Maybe.map (appendEnvironmentPage (observed previous |> Maybe.andThen identity)) page
    in
    case response of
        Ok page ->
            Loaded (combine page)

        Err failure ->
            case failure.detail of
                Http.GraphqlError (ParsedData Nothing) _ ->
                    Failed (observed previous) failure

                Http.GraphqlError (ParsedData page) _ ->
                    Partial (combine page) failure

                _ ->
                    Failed (observed previous) failure


appendEnvironmentPage : Maybe EnvironmentPage -> EnvironmentPage -> EnvironmentPage
appendEnvironmentPage previous incoming =
    case previous of
        Nothing ->
            incoming

        Just before ->
            let
                replace old =
                    List.filter (\item -> item.id == old.id) incoming.nodes
                        |> List.head
                        |> Maybe.withDefault old

                isNew item =
                    not (List.any (\old -> old.id == item.id) before.nodes)
            in
            { incoming | nodes = List.map replace before.nodes ++ List.filter isNew incoming.nodes }



-- SELECTION


modelKey : ModelChoice -> String
modelKey choice =
    Encode.encode 0 (Encode.list Encode.string [ choice.provider, choice.id ])


environmentKey : Environment -> String
environmentKey environment =
    Encode.encode 0 (Scalars.id.encoder environment.id)


currentModel : Maybe ModelChoice -> List ModelChoice -> Maybe ModelChoice
currentModel selected choices =
    selected
        |> Maybe.andThen
            (\choice ->
                choices
                    |> List.filter (\item -> item.provider == choice.provider && item.id == choice.id)
                    |> List.head
            )


environmentChoices : Read (Maybe EnvironmentPage) -> List Environment
environmentChoices environments =
    observed environments |> Maybe.andThen identity |> Maybe.map .nodes |> Maybe.withDefault []


supportedThinking : List ModelThinkingLevel -> Maybe ModelThinkingLevel -> Maybe ModelThinkingLevel
supportedThinking levels selected =
    selected
        |> Maybe.andThen
            (\level ->
                if List.member level levels then
                    Just level

                else
                    Nothing
            )


selectedEnvironment : String -> List Environment -> Maybe Environment
selectedEnvironment key choices =
    choices
        |> List.filter (\item -> environmentKey item == key && item.host /= Nothing)
        |> List.head



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none



-- VIEW


view : Model -> Browser.Document Msg
view model =
    { title = "Sessions"
    , body =
        [ viewSessions model.sessions
        , viewComposer
            { prompt = model.prompt, attachments = model.attachments }
            (viewCreationOptions model)
        ]
    }



-- VIEW SESSIONS


viewSessions : Read (List Session) -> Html Msg
viewSessions sessions =
    let
        empty =
            case sessions of
                Loaded [] ->
                    True

                _ ->
                    False
    in
    main_ [ id "main-area" ]
        [ section [ id "landing", class "pane", attribute "aria-label" "Sessions" ]
            [ div []
                [ div [ class "catalog-heading" ]
                    [ h2 [ id "recent-title", Attr.hidden empty ] [ text "Recent sessions" ]
                    , viewRefresh "sessions" (pending sessions) RefreshSessions
                    ]
                , viewReadStatus "sessions" RefreshSessions sessions
                , div [ id "session-list" ] (observed sessions |> Maybe.withDefault [] |> List.map (viewSession NoOp))
                , if empty then
                    p [ id "sessions-empty" ] [ text "No sessions" ]

                  else
                    text ""
                ]
            ]
        ]


viewSession : msg -> Session -> Html msg
viewSession archive session =
    div [ class "session-row" ]
        [ a [ class "session", Attr.href (Route.href (Route.Session session.externalId)) ]
            [ span [ class "session-heading" ] [ Html.strong [] [ text session.externalId ] ]
            , span [ class "session-detail" ]
                [ span [ class "session-environment" ] [ text (sessionEnvironment session) ]
                , span [ class "model-summary" ]
                    [ span [ class "model-name" ] [ text (session.root |> Maybe.andThen .model |> Maybe.withDefault "") ] ]
                ]
            ]
        , button [ class "icon session-archive", Attr.type_ "button", attribute "aria-label" "Archive session", Attr.title "Archive session (read-only preview)", onClick archive ]
            [ glyph [ Svg.path [ SvgAttr.d "m6 6 12 12M18 6 6 18" ] [] ] ]
        ]


sessionEnvironment : Session -> String
sessionEnvironment session =
    case session.root of
        Nothing ->
            "Root details unavailable"

        Just root ->
            String.join ":" (List.filterMap identity [ root.host, root.cwd ])



-- VIEW COMPOSER


viewComposer : { prompt : String, attachments : List Attachment } -> Html Msg -> Html Msg
viewComposer draft options =
    footer [ id "app-footer", class "composer-area" ]
        [ form [ id "composer", class "new-composer", onSubmit NoOp ]
            [ fieldset [ id "new-options", attribute "aria-label" "New session options" ] [ options ]
            , div [ id "composer-shell", class "composer-shell" ]
                [ div [ class "compose-box", Events.preventDefaultOn "dragover" (Decode.succeed ( NoOp, True )), fileEvent { event = "drop", field = "dataTransfer" } ]
                    [ viewPrompt draft.prompt
                    , div [ id "previews", attribute "aria-label" "Attached files" ] (List.map (viewAttachment AttachmentRemoved) draft.attachments)
                    , viewComposerActions
                    ]
                ]
            ]
        ]


viewPrompt : String -> Html Msg
viewPrompt prompt =
    textarea
        [ id "prompt"
        , Attr.name "content"
        , Attr.rows 2
        , Attr.maxlength 100000
        , Attr.placeholder "Ask Pi…"
        , attribute "aria-label" "Message"
        , Attr.value prompt
        , onInput PromptEdited
        , fileEvent { event = "paste", field = "clipboardData" }
        , Events.preventDefaultOn "keydown" submitKey
        ]
        []


viewComposerActions : Html Msg
viewComposerActions =
    div [ id "controls", class "actions" ]
        [ button [ id "input-toggle", class "icon", Attr.type_ "button", attribute "aria-label" "Upload attachments", onClick PickFiles ] [ text "+" ]
        , span [ class "spacer" ] []
        , button [ id "create", class "icon", Attr.type_ "submit", attribute "aria-label" "Create session", Attr.title "Create session (Ctrl/Cmd+Enter)" ]
            [ glyph [ Svg.path [ SvgAttr.d "M12 20V4m-7 7 7-7 7 7" ] [] ] ]
        ]



-- VIEW CREATION OPTIONS


viewCreationOptions : Model -> Html Msg
viewCreationOptions model =
    div [ id "options" ]
        [ viewEnvironment
            { selected = model.environment, directory = model.directory }
            model.environments
        , viewModels
            { selected = model.selectedModel, thinking = model.thinking }
            model.models
        ]



-- VIEW ENVIRONMENT


viewEnvironment : { selected : Maybe Environment, directory : String } -> Read (Maybe EnvironmentPage) -> Html Msg
viewEnvironment selection environments =
    div [ id "footer-instance", class "selector-summary" ]
        [ viewEnvironmentPicker selection.selected (environmentChoices environments)
        , viewDirectory DirectoryEdited selection.directory
        , viewEnvironmentStatus environments
        ]


viewEnvironmentPicker : Maybe Environment -> List Environment -> Html Msg
viewEnvironmentPicker selected choices =
    let
        selectedKey =
            selected |> Maybe.map environmentKey |> Maybe.withDefault ""

        unavailable =
            selected |> Maybe.andThen (unavailableEnvironment choices)

        summary =
            case unavailable of
                Just environment ->
                    environment.unit ++ " (unavailable)"

                Nothing ->
                    selected |> Maybe.map .unit |> Maybe.withDefault "No execution environment"
    in
    viewPicker "Environment"
        summary
        (select [ id "targets", attribute "aria-label" "Environment", Attr.name "target", Attr.value selectedKey, onInput EnvironmentSelected ]
            (viewChoice selectedKey { key = "", caption = "No execution environment", disabled = False }
                :: List.map (viewEnvironmentChoice selectedKey) choices
                ++ viewMissingEnvironment choices unavailable
            )
        )


unavailableEnvironment : List Environment -> Environment -> Maybe Environment
unavailableEnvironment choices selected =
    if List.any (\item -> item.id == selected.id && item.host /= Nothing) choices then
        Nothing

    else
        Just selected


viewEnvironmentChoice : String -> Environment -> Html msg
viewEnvironmentChoice selected item =
    viewChoice selected
        { key = environmentKey item
        , caption =
            if item.host == Nothing then
                item.unit ++ " (unavailable)"

            else
                item.unit
        , disabled = item.host == Nothing
        }


viewMissingEnvironment : List Environment -> Maybe Environment -> List (Html msg)
viewMissingEnvironment choices unavailable =
    case unavailable of
        Nothing ->
            []

        Just selected ->
            if List.any (\item -> item.id == selected.id) choices then
                []

            else
                [ viewChoice (environmentKey selected)
                    { key = environmentKey selected, caption = selected.unit ++ " (unavailable)", disabled = True }
                ]


viewDirectory : (String -> msg) -> String -> Html msg
viewDirectory edited directory =
    label []
        [ span [ class "selector-label" ] [ text "Working directory" ]
        , input [ id "base-directory", Attr.name "cwd", Attr.placeholder "/workspace", Attr.maxlength 4096, Attr.value directory, onInput edited, Attr.title "Literal path in the selected environment; not validated and ~ is not expanded." ] []
        ]


viewEnvironmentStatus : Read (Maybe EnvironmentPage) -> Html Msg
viewEnvironmentStatus environments =
    div [ class "catalog-tools" ]
        [ viewReadStatus "environments" RefreshEnvironments environments
        , case environments of
            Loaded Nothing ->
                span [ attribute "role" "status" ] [ text "Environments unavailable" ]

            Loaded (Just { nodes }) ->
                if List.isEmpty nodes then
                    span [ attribute "role" "status" ] [ text "No environments" ]

                else
                    text ""

            _ ->
                text ""
        , viewRefresh "environments" (pending environments) RefreshEnvironments
        , if (observed environments |> Maybe.andThen identity |> Maybe.andThen .next) /= Nothing then
            button [ Attr.type_ "button", Attr.disabled (pending environments), onClick MoreEnvironments ] [ text "More environments" ]

          else
            text ""
        ]



-- VIEW MODELS


viewModels : { selected : Maybe ModelChoice, thinking : Maybe ModelThinkingLevel } -> Read (List ModelChoice) -> Html Msg
viewModels selection models =
    let
        choices =
            observed models |> Maybe.withDefault []
    in
    div [ id "bottom-line", attribute "aria-label" "New session settings" ]
        [ div [ class "footer-row" ]
            [ div [ class "footer-model-context" ]
                [ div [ id "footer-model", class "model-summary selector-summary" ]
                    [ span [ class "model-name" ] [ viewModelPicker selection.selected choices ]
                    , span [ class "footer-dot", attribute "aria-hidden" "true" ] []
                    , span [ class "model-effort" ] [ viewThinkingPicker selection.thinking (currentModel selection.selected choices) ]
                    ]
                , viewModelsStatus models
                ]
            ]
        ]


viewModelPicker : Maybe ModelChoice -> List ModelChoice -> Html Msg
viewModelPicker selected choices =
    let
        selectedKey =
            selected |> Maybe.map modelKey |> Maybe.withDefault ""

        unavailable =
            selected /= Nothing && currentModel selected choices == Nothing

        summary =
            (selected |> Maybe.map .name |> Maybe.withDefault "No model")
                ++ (if unavailable then
                        " (unavailable)"

                    else
                        ""
                   )

        missing =
            if unavailable then
                [ viewChoice selectedKey { key = selectedKey, caption = summary, disabled = True } ]

            else
                []
    in
    viewPicker "Model"
        summary
        (select [ id "models", attribute "aria-label" "Model", Attr.name "model", Attr.value selectedKey, onInput ModelSelected ]
            (viewChoice selectedKey { key = "", caption = "No model", disabled = False }
                :: List.map (viewModelChoice selectedKey) choices
                ++ missing
            )
        )


viewModelChoice : String -> ModelChoice -> Html msg
viewModelChoice selected item =
    viewChoice selected { key = modelKey item, caption = item.provider ++ " / " ++ item.name, disabled = False }


viewThinkingPicker : Maybe ModelThinkingLevel -> Maybe ModelChoice -> Html Msg
viewThinkingPicker selected available =
    let
        levels =
            available |> Maybe.map .thinkingLevels |> Maybe.withDefault []

        thinking =
            selected |> Maybe.map Thinking.toString |> Maybe.withDefault ""

        unsupported =
            selected |> Maybe.map (\level -> not (List.member level levels)) |> Maybe.withDefault False

        summary =
            if thinking == "" then
                "Default"

            else if unsupported then
                thinking ++ " (unavailable)"

            else
                thinking

        missing =
            if unsupported then
                [ viewChoice thinking { key = thinking, caption = summary, disabled = True } ]

            else
                []
    in
    viewPicker "Thinking"
        summary
        (select [ id "thinking", attribute "aria-label" "Thinking", Attr.name "thinkingLevel", Attr.value thinking, onInput ThinkingSelected, Attr.disabled (available == Nothing) ]
            (viewChoice thinking { key = "", caption = "Default", disabled = False }
                :: List.map (viewThinkingChoice thinking) levels
                ++ missing
            )
        )


viewThinkingChoice : String -> ModelThinkingLevel -> Html msg
viewThinkingChoice selected level =
    viewChoice selected { key = Thinking.toString level, caption = Thinking.toString level, disabled = False }


viewModelsStatus : Read (List ModelChoice) -> Html Msg
viewModelsStatus models =
    div [ class "catalog-tools" ]
        [ viewReadStatus "models" RefreshModels models
        , case models of
            Loaded [] ->
                span [ attribute "role" "status" ] [ text "No available models" ]

            _ ->
                text ""
        , viewRefresh "models" (pending models) RefreshModels
        ]



-- VIEW CONTROLS


viewPicker : String -> String -> Html msg -> Html msg
viewPicker caption summary control =
    label []
        [ span [ class "selector-label" ] [ text caption ]
        , control
        , span [ class "selector-value", attribute "aria-hidden" "true" ] [ text summary ]
        ]


viewChoice : String -> { key : String, caption : String, disabled : Bool } -> Html msg
viewChoice selected choice =
    option [ Attr.value choice.key, Attr.selected (selected == choice.key), Attr.disabled choice.disabled ] [ text choice.caption ]


viewRefresh : String -> Bool -> msg -> Html msg
viewRefresh name busy msg =
    button [ class "refresh", Attr.type_ "button", Attr.disabled busy, attribute "aria-label" ("Refresh " ++ name), onClick msg ] [ glyph [ Svg.path [ SvgAttr.d "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" ] [] ] ]


viewReadStatus : String -> msg -> Read data -> Html msg
viewReadStatus name retry read =
    case read of
        Loaded _ ->
            text ""

        Loading previous ->
            p [ class "read-status", attribute "role" "status" ]
                [ text
                    (if previous == Nothing then
                        "Loading " ++ name ++ "…"

                     else
                        "Refreshing " ++ name ++ "…"
                    )
                ]

        Partial _ failure ->
            viewReadFailure name retry (errorMessage failure.problem ++ " Partial data shown.")

        Failed previous error ->
            viewReadFailure name
                retry
                (errorMessage error.problem
                    ++ (if previous /= Nothing then
                            " Previous data is stale."

                        else
                            ""
                       )
                )


viewReadFailure : String -> msg -> String -> Html msg
viewReadFailure name retry description =
    p [ class "read-status error", attribute "role" "alert" ]
        [ text (name ++ ": " ++ description)
        , button [ Attr.type_ "button", onClick retry ] [ text "Retry" ]
        ]


errorMessage : Api.Problem -> String
errorMessage problem =
    case problem of
        Api.AccessDenied ->
            "Access denied."

        Api.AuthenticationRequired ->
            "Authentication required."

        Api.ExecutionFailure ->
            "The server could not complete this read."

        Api.InvalidAddress ->
            "Invalid API address."

        Api.TimedOut ->
            "The request timed out."

        Api.NetworkFailure ->
            "Could not reach the server."

        Api.InvalidResponse ->
            "Invalid API response."

        Api.HttpFailure status ->
            "HTTP " ++ String.fromInt status ++ "."



-- EVENTS
-- Preserve ordinary Enter and IME editing; submission shortcuts are deliberately inert.


submitKey : Decode.Decoder ( Msg, Bool )
submitKey =
    Decode.map5
        (\key ctrl meta alt composing -> ( NoOp, key == "Enter" && (ctrl || meta || alt) && not composing ))
        (Decode.field "key" Decode.string)
        (Decode.field "ctrlKey" Decode.bool)
        (Decode.field "metaKey" Decode.bool)
        (Decode.field "altKey" Decode.bool)
        (Decode.field "isComposing" Decode.bool)


fileEvent : { event : String, field : String } -> Html.Attribute Msg
fileEvent config =
    Events.preventDefaultOn config.event
        (Decode.at [ config.field, "files" ] (Decode.list File.decoder)
            |> Decode.andThen
                (\files ->
                    if List.isEmpty files then
                        Decode.fail "Not a file event"

                    else
                        Decode.succeed ( FilesSelected files, True )
                )
        )



-- ATTACHMENTS


receiveAttachment : AttachmentId -> Result String AttachmentContent -> Attachment -> Attachment
receiveAttachment key result attachment =
    if attachment.id == key then
        { attachment
            | state =
                case result of
                    Ok content ->
                        Ready content

                    Err problem ->
                        Rejected problem
        }

    else
        attachment


readAttachment : Attachment -> Cmd Msg
readAttachment item =
    (if List.member (File.mime item.file) [ "image/png", "image/jpeg", "image/gif", "image/webp" ] then
        File.toUrl item.file |> Task.map (Image >> Ok)

     else
        File.toBytes item.file |> Task.map readTextAttachment
    )
        |> Task.perform (AttachmentRead item.id)


readTextAttachment : Bytes -> Result String AttachmentContent
readTextAttachment bytes =
    case ByteDecode.decode (ByteDecode.string (Bytes.width bytes)) bytes of
        Just content ->
            if byteList bytes == byteList (ByteEncode.encode (ByteEncode.string content)) && not (String.any unsupportedControl content) then
                Ok (Text content)

            else
                Err "Not a supported image or UTF-8 text file"

        Nothing ->
            Err "Could not decode this file"


byteList : Bytes -> Maybe (List Int)
byteList bytes =
    ByteDecode.decode
        (ByteDecode.loop ( Bytes.width bytes, [] )
            (\( remaining, values ) ->
                if remaining == 0 then
                    ByteDecode.succeed (ByteDecode.Done values)

                else
                    ByteDecode.map (\value -> ByteDecode.Loop ( remaining - 1, value :: values )) ByteDecode.unsignedInt8
            )
        )
        bytes


unsupportedControl : Char -> Bool
unsupportedControl character =
    let
        code =
            Char.toCode character
    in
    (code < 32 && not (List.member code [ 9, 10, 13 ])) || (code >= 127 && code <= 159) || (code >= 55296 && code <= 57343)



-- VIEW ATTACHMENT


viewAttachment : (AttachmentId -> msg) -> Attachment -> Html msg
viewAttachment remove item =
    let
        name =
            File.name item.file

        description =
            name ++ " (" ++ String.fromInt (File.size item.file) ++ " bytes)"
    in
    div [ class "attachment" ]
        [ button [ Attr.type_ "button", Attr.title ("Remove " ++ description), attribute "aria-label" ("Remove " ++ name), onClick (remove item.id) ]
            [ case item.state of
                Reading ->
                    span [ attribute "role" "status" ] [ text (name ++ " — reading…") ]

                Ready (Text _) ->
                    text name

                Ready (Image url) ->
                    Html.img [ Attr.src url, Attr.alt name ] []

                Rejected _ ->
                    text name
            ]
        , case item.state of
            Rejected problem ->
                span [ class "error", attribute "role" "alert" ] [ text (name ++ ": " ++ problem) ]

            Reading ->
                text ""

            Ready _ ->
                text ""
        ]



-- ICONS


glyph : List (Svg.Svg msg) -> Html msg
glyph children =
    Svg.svg [ SvgAttr.class "glyph", SvgAttr.viewBox "0 0 24 24", attribute "aria-hidden" "true" ] children
