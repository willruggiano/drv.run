module Page.Home exposing (Model, Msg, init, subscriptions, update, view)

import Api
import Api.Enum.ModelThinkingLevel as Thinking exposing (ModelThinkingLevel)
import Api.Home as Home exposing (Environment, EnvironmentPage, ModelChoice, Session)
import Api.Scalars as Scalars
import Browser
import Bytes exposing (Bytes)
import Bytes.Decode as ByteDecode
import Bytes.Encode as ByteEncode
import Dict
import File exposing (File)
import File.Select
import Graphql.Http as Http
import Graphql.Http.GraphqlError exposing (GraphqlError, PossiblyParsedData(..))
import Html exposing (Html, a, button, div, fieldset, footer, form, h2, input, label, main_, option, p, section, select, span, text, textarea)
import Html.Attributes as A exposing (attribute, class, id)
import Html.Events as Events exposing (onClick, onInput, onSubmit)
import Json.Decode as Decode
import Json.Encode as Encode
import Route
import Svg
import Svg.Attributes as S
import Task



-- MODEL


type Read data
    = Loading (Maybe data)
    | Loaded data
    | Partial data (List GraphqlError)
    | Failed (Maybe data) (Http.Error data)


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
    { id : Int, file : File, state : AttachmentState }


type AttachmentState
    = Reading
    | Ready String
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
        , Api.query (EnvironmentsReceived False) (Home.environments Nothing)
        ]
    )



-- UPDATE


type Msg
    = SessionsReceived (Api.Response (List Session))
    | ModelsReceived (Api.Response (List ModelChoice))
    | EnvironmentsReceived Bool (Api.Response (Maybe EnvironmentPage))
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
    | AttachmentRead Int AttachmentState
    | AttachmentRemoved Int
    | NoOp


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        SessionsReceived response ->
            ( { model | sessions = receive model.sessions response }, Cmd.none )

        ModelsReceived response ->
            ( { model | models = receive model.models response }, Cmd.none )

        EnvironmentsReceived append response ->
            let
                previous =
                    observed model.environments |> Maybe.andThen identity

                combine page =
                    case ( append, previous, page ) of
                        ( True, Just before, Just after ) ->
                            Just
                                { after
                                    | nodes =
                                        List.map (\old -> List.filter (\item -> item.id == old.id) after.nodes |> List.head |> Maybe.withDefault old) before.nodes
                                            ++ List.filter (\item -> not (List.any (\old -> old.id == item.id) before.nodes)) after.nodes
                                }

                        _ ->
                            page

                combined =
                    case response of
                        Ok page ->
                            Ok (combine page)

                        Err (Http.GraphqlError (ParsedData page) errors) ->
                            Err (Http.GraphqlError (ParsedData (combine page)) errors)

                        Err error ->
                            Err error
            in
            ( { model
                | environments =
                    case response of
                        Err ((Http.GraphqlError (ParsedData Nothing) _) as error) ->
                            Failed (observed model.environments) error

                        _ ->
                            receive model.environments combined
              }
            , Cmd.none
            )

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
                ( { model | environments = Loading (observed model.environments) }, Api.query (EnvironmentsReceived False) (Home.environments Nothing) )

        MoreEnvironments ->
            case observed model.environments |> Maybe.andThen identity |> Maybe.andThen .next of
                Just cursor ->
                    if pending model.environments then
                        ( model, Cmd.none )

                    else
                        ( { model | environments = Loading (observed model.environments) }, Api.query (EnvironmentsReceived True) (Home.environments (Just cursor)) )

                Nothing ->
                    ( model, Cmd.none )

        ModelSelected key ->
            let
                selected =
                    observed model.models |> Maybe.withDefault [] |> List.filter (modelKey >> (==) key) |> List.head

                thinking =
                    model.thinking
                        |> Maybe.andThen
                            (\level ->
                                selected
                                    |> Maybe.andThen
                                        (\choice ->
                                            if List.member level choice.thinkingLevels then
                                                Just level

                                            else
                                                Nothing
                                        )
                            )
            in
            ( { model | selectedModel = selected, thinking = thinking }, Cmd.none )

        ThinkingSelected value ->
            let
                supported =
                    currentModel model |> Maybe.map .thinkingLevels |> Maybe.withDefault []
            in
            ( { model
                | thinking =
                    Thinking.fromString value
                        |> Maybe.andThen
                            (\level ->
                                if List.member level supported then
                                    Just level

                                else
                                    Nothing
                            )
              }
            , Cmd.none
            )

        EnvironmentSelected key ->
            ( { model | environment = environmentChoices model |> List.filter (\item -> environmentKey item == key && item.host /= Nothing) |> List.head }, Cmd.none )

        DirectoryEdited value ->
            ( { model | directory = value }, Cmd.none )

        PromptEdited value ->
            ( { model | prompt = value }, Cmd.none )

        PickFiles ->
            ( model, File.Select.files [] (\first rest -> FilesSelected (first :: rest)) )

        FilesSelected files ->
            let
                added =
                    List.indexedMap (\index file -> { id = model.nextAttachment + index, file = file, state = Reading }) files
            in
            ( { model | attachments = model.attachments ++ added, nextAttachment = model.nextAttachment + List.length files }
            , Cmd.batch (List.map readAttachment added)
            )

        AttachmentRead key state ->
            ( { model
                | attachments =
                    List.map
                        (\item ->
                            if item.id == key then
                                { item | state = state }

                            else
                                item
                        )
                        model.attachments
              }
            , Cmd.none
            )

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

        _ ->
            False


receive : Read data -> Api.Response data -> Read data
receive previous response =
    case response of
        Ok value ->
            Loaded value

        Err (Http.GraphqlError (ParsedData value) errors) ->
            Partial value errors

        Err error ->
            Failed (observed previous) error



-- SELECTION


modelKey : ModelChoice -> String
modelKey choice =
    Encode.encode 0 (Encode.list Encode.string [ choice.provider, choice.id ])


environmentKey : Environment -> String
environmentKey environment =
    Encode.encode 0 (Scalars.id.encoder environment.id)


currentModel : Model -> Maybe ModelChoice
currentModel model =
    model.selectedModel
        |> Maybe.andThen (\selected -> observed model.models |> Maybe.withDefault [] |> List.filter (\choice -> modelKey choice == modelKey selected) |> List.head)


environmentChoices : Model -> List Environment
environmentChoices model =
    observed model.environments |> Maybe.andThen identity |> Maybe.map .nodes |> Maybe.withDefault []



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none



-- VIEW


view : Model -> Browser.Document Msg
view model =
    { title = "Sessions"
    , body =
        [ main_ [ id "main-area" ]
            [ section [ id "landing", class "pane", attribute "aria-label" "Sessions" ]
                [ div []
                    [ div [ class "catalog-heading" ]
                        [ h2
                            [ id "recent-title"
                            , A.hidden
                                (case model.sessions of
                                    Loaded [] ->
                                        True

                                    _ ->
                                        False
                                )
                            ]
                            [ text "Recent sessions" ]
                        , refresh "sessions" (pending model.sessions) RefreshSessions
                        ]
                    , readStatus "sessions" RefreshSessions model.sessions
                    , div [ id "session-list" ] (observed model.sessions |> Maybe.withDefault [] |> List.map sessionView)
                    , case model.sessions of
                        Loaded [] ->
                            p [ id "sessions-empty" ] [ text "No sessions" ]

                        _ ->
                            text ""
                    ]
                ]
            ]
        , footer [ id "app-footer", class "composer-area" ]
            [ form [ id "composer", class "new-composer", onSubmit NoOp ]
                [ fieldset [ id "new-options", attribute "aria-label" "New session options" ]
                    [ div [ id "options" ]
                        [ environmentView model
                        , modelView model
                        ]
                    ]
                , div [ id "composer-shell", class "composer-shell" ]
                    [ div [ class "compose-box", Events.preventDefaultOn "dragover" (Decode.succeed ( NoOp, True )), fileEvent "drop" "dataTransfer" ]
                        [ textarea
                            [ id "prompt"
                            , A.name "content"
                            , A.rows 2
                            , A.maxlength 100000
                            , A.placeholder "Ask Pi…"
                            , attribute "aria-label" "Message"
                            , A.value model.prompt
                            , onInput PromptEdited
                            , fileEvent "paste" "clipboardData"
                            , Events.preventDefaultOn "keydown" submitKey
                            ]
                            []
                        , div [ id "previews", attribute "aria-label" "Attached files" ] (List.map attachmentView model.attachments)
                        , div [ id "controls", class "actions" ]
                            [ button [ id "input-toggle", class "icon", A.type_ "button", attribute "aria-label" "Upload attachments", onClick PickFiles ] [ text "+" ]
                            , span [ class "spacer" ] []
                            , button [ id "create", class "icon", A.type_ "submit", attribute "aria-label" "Create session", A.title "Create session (Ctrl/Cmd+Enter)" ]
                                [ glyph [ Svg.path [ S.d "M12 20V4m-7 7 7-7 7 7" ] [] ] ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
    }


sessionView : Session -> Html Msg
sessionView session =
    div [ class "session-row" ]
        [ a [ class "session", A.href (Route.href (Route.Session session.externalId)) ]
            [ span [ class "session-heading" ] [ Html.strong [] [ text session.externalId ] ]
            , span [ class "session-detail" ]
                [ span [ class "session-environment" ]
                    [ text (session.root |> Maybe.map (\root -> String.join ":" (List.filterMap identity [ root.host, root.cwd ])) |> Maybe.withDefault "Root details unavailable") ]
                , span [ class "model-summary" ] [ span [ class "model-name" ] [ text (session.root |> Maybe.andThen .model |> Maybe.withDefault "") ] ]
                ]
            ]
        , button [ class "icon session-archive", A.type_ "button", attribute "aria-label" "Archive session", A.title "Archive session (read-only preview)", onClick NoOp ]
            [ glyph [ Svg.path [ S.d "m6 6 12 12M18 6 6 18" ] [] ] ]
        ]


environmentView : Model -> Html Msg
environmentView model =
    let
        selectedKey =
            model.environment |> Maybe.map environmentKey |> Maybe.withDefault ""

        choices =
            environmentChoices model

        unavailable =
            model.environment
                |> Maybe.andThen
                    (\selected ->
                        if List.any (\item -> item.id == selected.id && item.host /= Nothing) choices then
                            Nothing

                        else
                            Just selected
                    )

        summary =
            case unavailable of
                Just selected ->
                    selected.unit ++ " (unavailable)"

                Nothing ->
                    model.environment |> Maybe.map .unit |> Maybe.withDefault "No execution environment"
    in
    div [ id "footer-instance", class "selector-summary" ]
        [ picker "Environment"
            summary
            (select [ id "targets", attribute "aria-label" "Environment", A.name "target", A.value selectedKey, onInput EnvironmentSelected ]
                (viewChoice selectedKey "" "No execution environment" False
                    :: List.map
                        (\item ->
                            viewChoice selectedKey
                                (environmentKey item)
                                (item.unit
                                    ++ (if item.host == Nothing then
                                            " (unavailable)"

                                        else
                                            ""
                                       )
                                )
                                (item.host == Nothing)
                        )
                        choices
                    ++ (unavailable
                            |> Maybe.map
                                (\item ->
                                    if List.any (\other -> other.id == item.id) choices then
                                        []

                                    else
                                        [ viewChoice selectedKey (environmentKey item) summary True ]
                                )
                            |> Maybe.withDefault []
                       )
                )
            )
        , label []
            [ span [ class "selector-label" ] [ text "Working directory" ]
            , input [ id "base-directory", A.name "cwd", A.placeholder "/workspace", A.maxlength 4096, A.value model.directory, onInput DirectoryEdited, A.title "Literal path in the selected environment; not validated and ~ is not expanded." ] []
            ]
        , div [ class "catalog-tools" ]
            [ readStatus "environments" RefreshEnvironments model.environments
            , case model.environments of
                Loaded Nothing ->
                    span [ attribute "role" "status" ] [ text "Environments unavailable" ]

                Loaded (Just { nodes }) ->
                    if List.isEmpty nodes then
                        span [ attribute "role" "status" ] [ text "No environments" ]

                    else
                        text ""

                _ ->
                    text ""
            , refresh "environments" (pending model.environments) RefreshEnvironments
            , if (observed model.environments |> Maybe.andThen identity |> Maybe.andThen .next) /= Nothing then
                button [ A.type_ "button", A.disabled (pending model.environments), onClick MoreEnvironments ] [ text "More environments" ]

              else
                text ""
            ]
        ]


modelView : Model -> Html Msg
modelView model =
    let
        selectedKey =
            model.selectedModel |> Maybe.map modelKey |> Maybe.withDefault ""

        available =
            currentModel model

        choices =
            observed model.models |> Maybe.withDefault []

        unavailable =
            model.selectedModel /= Nothing && available == Nothing

        summary =
            model.selectedModel |> Maybe.map .name |> Maybe.withDefault "No model"

        levels =
            available |> Maybe.map .thinkingLevels |> Maybe.withDefault []

        thinking =
            model.thinking |> Maybe.map Thinking.toString |> Maybe.withDefault ""

        unsupported =
            model.thinking |> Maybe.map (\level -> not (List.member level levels)) |> Maybe.withDefault False
    in
    div [ id "bottom-line", attribute "aria-label" "New session settings" ]
        [ div [ class "footer-row" ]
            [ div [ class "footer-model-context" ]
                [ div [ id "footer-model", class "model-summary selector-summary" ]
                    [ span [ class "model-name" ]
                        [ picker "Model"
                            (summary
                                ++ (if unavailable then
                                        " (unavailable)"

                                    else
                                        ""
                                   )
                            )
                            (select [ id "models", attribute "aria-label" "Model", A.name "model", A.value selectedKey, onInput ModelSelected ]
                                (viewChoice selectedKey "" "No model" False
                                    :: List.map (\item -> viewChoice selectedKey (modelKey item) (item.provider ++ " / " ++ item.name) False) choices
                                    ++ (if unavailable then
                                            [ viewChoice selectedKey selectedKey (summary ++ " (unavailable)") True ]

                                        else
                                            []
                                       )
                                )
                            )
                        ]
                    , span [ class "footer-dot", attribute "aria-hidden" "true" ] []
                    , span [ class "model-effort" ]
                        [ picker "Thinking"
                            (if thinking == "" then
                                "Default"

                             else
                                thinking
                                    ++ (if unsupported then
                                            " (unavailable)"

                                        else
                                            ""
                                       )
                            )
                            (select [ id "thinking", attribute "aria-label" "Thinking", A.name "thinkingLevel", A.value thinking, onInput ThinkingSelected, A.disabled (available == Nothing) ]
                                (viewChoice thinking "" "Default" False
                                    :: List.map (\level -> viewChoice thinking (Thinking.toString level) (Thinking.toString level) False) levels
                                    ++ (if unsupported then
                                            [ viewChoice thinking thinking (thinking ++ " (unavailable)") True ]

                                        else
                                            []
                                       )
                                )
                            )
                        ]
                    ]
                , div [ class "catalog-tools" ]
                    [ readStatus "models" RefreshModels model.models
                    , case model.models of
                        Loaded [] ->
                            span [ attribute "role" "status" ] [ text "No available models" ]

                        _ ->
                            text ""
                    , refresh "models" (pending model.models) RefreshModels
                    ]
                ]
            ]
        ]


picker : String -> String -> Html Msg -> Html Msg
picker caption summary control =
    label []
        [ span [ class "selector-label" ] [ text caption ]
        , control
        , span [ class "selector-value", attribute "aria-hidden" "true" ] [ text summary ]
        ]


viewChoice : String -> String -> String -> Bool -> Html Msg
viewChoice selected key caption disabled =
    option [ A.value key, A.selected (selected == key), A.disabled disabled ] [ text caption ]


refresh : String -> Bool -> Msg -> Html Msg
refresh name busy msg =
    button [ class "refresh", A.type_ "button", A.disabled busy, attribute "aria-label" ("Refresh " ++ name), onClick msg ] [ glyph [ Svg.path [ S.d "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" ] [] ] ]


readStatus : String -> Msg -> Read data -> Html Msg
readStatus name retry read =
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

        Partial value errors ->
            readFailure name retry (errorMessage (Http.GraphqlError (ParsedData value) errors) ++ " Partial data shown.")

        Failed previous error ->
            readFailure name
                retry
                (errorMessage error
                    ++ (if previous /= Nothing then
                            " Previous data is stale."

                        else
                            ""
                       )
                )


readFailure : String -> Msg -> String -> Html Msg
readFailure name retry description =
    p [ class "read-status error", attribute "role" "alert" ]
        [ text (name ++ ": " ++ description)
        , button [ A.type_ "button", onClick retry ] [ text "Retry" ]
        ]


errorMessage : Http.Error data -> String
errorMessage error =
    case error of
        Http.GraphqlError _ errors ->
            let
                codes =
                    List.filterMap (\item -> Dict.get "extensions" item.details |> Maybe.andThen (Decode.decodeValue (Decode.field "code" Decode.string) >> Result.toMaybe)) errors
            in
            if List.member "FORBIDDEN" codes then
                "Access denied."

            else if List.member "UNAUTHENTICATED" codes then
                "Authentication required."

            else
                "The server could not complete this read."

        Http.HttpError problem ->
            case problem of
                Http.BadUrl _ ->
                    "Invalid API address."

                Http.Timeout ->
                    "The request timed out."

                Http.NetworkError ->
                    "Could not reach the server."

                Http.BadPayload _ ->
                    "Invalid API response."

                Http.BadStatus metadata _ ->
                    case metadata.statusCode of
                        401 ->
                            "Authentication required."

                        403 ->
                            "Access denied."

                        status ->
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


fileEvent : String -> String -> Html.Attribute Msg
fileEvent event field =
    Events.preventDefaultOn event
        (Decode.at [ field, "files" ] (Decode.list File.decoder)
            |> Decode.andThen
                (\files ->
                    if List.isEmpty files then
                        Decode.fail "Not a file event"

                    else
                        Decode.succeed ( FilesSelected files, True )
                )
        )



-- ATTACHMENTS


readAttachment : Attachment -> Cmd Msg
readAttachment item =
    (if List.member (File.mime item.file) [ "image/png", "image/jpeg", "image/gif", "image/webp" ] then
        File.toUrl item.file |> Task.map Ready

     else
        File.toBytes item.file
            |> Task.map
                (\bytes ->
                    case ByteDecode.decode (ByteDecode.string (Bytes.width bytes)) bytes of
                        Just content ->
                            if byteList bytes == byteList (ByteEncode.encode (ByteEncode.string content)) && not (String.any unsupportedControl content) then
                                Ready ""

                            else
                                Rejected "Not a supported image or UTF-8 text file"

                        Nothing ->
                            Rejected "Could not decode this file"
                )
    )
        |> Task.perform (AttachmentRead item.id)


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


attachmentView : Attachment -> Html Msg
attachmentView item =
    let
        name =
            File.name item.file

        description =
            name ++ " (" ++ String.fromInt (File.size item.file) ++ " bytes)"
    in
    div [ class "attachment" ]
        [ button [ A.type_ "button", A.title ("Remove " ++ description), attribute "aria-label" ("Remove " ++ name), onClick (AttachmentRemoved item.id) ]
            [ case item.state of
                Reading ->
                    span [ attribute "role" "status" ] [ text (name ++ " — reading…") ]

                Ready url ->
                    if String.isEmpty url then
                        text name

                    else
                        Html.img [ A.src url, A.alt name ] []

                Rejected _ ->
                    text name
            ]
        , case item.state of
            Rejected problem ->
                span [ class "error", attribute "role" "alert" ] [ text (name ++ ": " ++ problem) ]

            _ ->
                text ""
        ]



-- ICONS


glyph : List (Svg.Svg msg) -> Html msg
glyph children =
    Svg.svg [ S.class "glyph", S.viewBox "0 0 24 24", attribute "aria-hidden" "true" ] children
