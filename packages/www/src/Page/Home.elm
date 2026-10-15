module Page.Home exposing (Model, Msg, Outcome(..), clear, init, subscriptions, update, view)

import Api
import Api.Actions as Actions
import Api.Conversation
import Api.Home as Home exposing (Session)
import Api.InputObject as Input
import Api.Scalars as Scalars
import Attachment exposing (Attachment, AttachmentContent, AttachmentId(..), AttachmentState(..), fileEvent, readAttachment, receiveAttachment, viewAttachment)
import Browser
import Configuration
import File exposing (File)
import File.Select
import Graphql.OptionalArgument exposing (OptionalArgument(..))
import Html exposing (Html, a, button, div, fieldset, footer, form, h2, main_, p, section, span, text, textarea)
import Html.Attributes as Attr exposing (attribute, class, id)
import Html.Events as Events exposing (onClick, onInput, onSubmit)
import Json.Decode as Decode
import Read exposing (Read(..), observed, pending, receive, viewReadStatus)
import Route
import Svg
import Svg.Attributes as SvgAttr



-- MODEL


type alias Model =
    { sessions : Read (List Session)
    , configuration : Configuration.Model
    , prompt : String
    , attachments : List Attachment
    , nextAttachment : Int
    , externalId : String
    , creation : Creation
    , notice : String
    }


type Creation
    = Draft
    | Opening Input.RootOptionsInput
    | OpenUncertain Input.RootOptionsInput
    | CreatingRoot Scalars.Id Input.RootOptionsInput
    | RootUncertain Scalars.Id Input.RootOptionsInput


type Outcome
    = Stay
    | Created String Scalars.Id Api.Conversation.Info



-- INIT


init : String -> ( Model, Cmd Msg )
init externalId =
    let
        ( configuration, command ) =
            Configuration.init ()
    in
    ( { sessions = Loading Nothing, configuration = configuration, prompt = "", attachments = [], nextAttachment = 0, externalId = externalId, creation = Draft, notice = "" }
    , Cmd.batch [ Api.query SessionsReceived Home.sessions, Cmd.map ConfigurationMsg command ]
    )



-- UPDATE


type Msg
    = SessionsReceived (Api.Response (List Session))
    | ConfigurationMsg Configuration.Msg
    | RefreshSessions
    | PromptEdited String
    | PickFiles
    | FilesSelected (List File)
    | AttachmentRead AttachmentId (Result String AttachmentContent)
    | AttachmentRemoved AttachmentId
    | Create
    | Opened (Api.Response (Maybe Scalars.Id))
    | RootCreated (Api.Response (Maybe Api.Conversation.Info))
    | NoOp


update : Msg -> Model -> ( Model, Cmd Msg, Outcome )
update msg model =
    case ( msg, model.creation ) of
        ( RootCreated (Ok (Just info)), CreatingRoot harnessId _ ) ->
            ( model, Cmd.none, Created model.externalId harnessId info )

        _ ->
            let
                ( next, command ) =
                    updateLocal msg model
            in
            ( next, command, Stay )


updateLocal : Msg -> Model -> ( Model, Cmd Msg )
updateLocal msg model =
    case msg of
        SessionsReceived response ->
            ( { model | sessions = receive response model.sessions }, Cmd.none )

        ConfigurationMsg message ->
            let
                ( configuration, command ) =
                    Configuration.update message model.configuration
            in
            ( { model | configuration = configuration }, Cmd.map ConfigurationMsg command )

        RefreshSessions ->
            if pending model.sessions then
                ( model, Cmd.none )

            else
                ( { model | sessions = Loading (observed model.sessions) }, Api.query SessionsReceived Home.sessions )

        PromptEdited value ->
            if model.creation == Draft then
                ( { model | prompt = value }, Cmd.none )

            else
                ( model, Cmd.none )

        PickFiles ->
            if model.creation == Draft then
                ( model, File.Select.files [] (\first rest -> FilesSelected (first :: rest)) )

            else
                ( model, Cmd.none )

        FilesSelected files ->
            if model.creation /= Draft then
                ( model, Cmd.none )

            else
                let
                    added =
                        List.indexedMap (\index file -> { id = AttachmentId (model.nextAttachment + index), file = file, state = Reading }) files
                in
                ( { model | attachments = model.attachments ++ added, nextAttachment = model.nextAttachment + List.length files }
                , Cmd.batch (List.map (readAttachment AttachmentRead) added)
                )

        AttachmentRead key result ->
            ( { model | attachments = List.map (receiveAttachment key result) model.attachments }, Cmd.none )

        AttachmentRemoved key ->
            if model.creation == Draft then
                ( { model | attachments = List.filter (.id >> (/=) key) model.attachments }, Cmd.none )

            else
                ( model, Cmd.none )

        Create ->
            let
                configuration =
                    model.configuration

                options =
                    Input.buildRootOptionsInput (\args -> { args | agent = Present (Configuration.agent configuration), env = configuration.environment |> Maybe.andThen .target |> Maybe.map Present |> Maybe.withDefault Absent })

                open captured =
                    ( { model | creation = Opening captured, notice = "Opening session…" }, Api.mutation Opened (Actions.open model.externalId) )
            in
            case model.creation of
                Draft ->
                    if
                        List.any
                            (\item ->
                                case item.state of
                                    Ready _ ->
                                        False

                                    _ ->
                                        True
                            )
                            model.attachments
                    then
                        ( model, Cmd.none )

                    else if String.startsWith "/" (String.trimLeft model.prompt) then
                        if String.trim model.prompt == "/new" && List.isEmpty model.attachments then
                            ( { model | prompt = "", notice = "New session draft. No session has been created." }, Cmd.none )

                        else
                            ( { model | notice = "Only /new is available before creating a conversation. Commands do not consume attachments." }, Cmd.none )

                    else
                        open options

                OpenUncertain captured ->
                    open captured

                RootUncertain harnessId captured ->
                    ( { model | creation = CreatingRoot harnessId captured, notice = "Recovering root conversation…" }, Api.mutation RootCreated (Actions.root harnessId captured) )

                _ ->
                    ( model, Cmd.none )

        Opened response ->
            case model.creation of
                Opening captured ->
                    case response of
                        Ok (Just harnessId) ->
                            ( { model | creation = CreatingRoot harnessId captured, notice = "Session opened. Creating root conversation…" }, Api.mutation RootCreated (Actions.root harnessId captured) )

                        _ ->
                            ( { model | creation = OpenUncertain captured, notice = "Session open was not acknowledged. Retry uses the same session identity." }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        RootCreated _ ->
            case model.creation of
                CreatingRoot harnessId captured ->
                    ( { model | creation = RootUncertain harnessId captured, notice = "Session opened; root creation was not acknowledged. Retry recovers the reserved root without changing existing settings." }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        NoOp ->
            ( model, Cmd.none )



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
            model
            (Html.map ConfigurationMsg (Configuration.view model.configuration))
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


viewComposer : Model -> Html Msg -> Html Msg
viewComposer draft options =
    footer [ id "app-footer", class "composer-area" ]
        [ form [ id "composer", class "new-composer", onSubmit Create ]
            [ p [ attribute "role" "status" ] [ text draft.notice ]
            , fieldset [ id "new-options", Attr.disabled (draft.creation /= Draft), attribute "aria-label" "New session options" ] [ options ]
            , div [ id "composer-shell", class "composer-shell" ]
                [ div [ class "compose-box", Events.preventDefaultOn "dragover" (Decode.succeed ( NoOp, True )), fileEvent FilesSelected { event = "drop", field = "dataTransfer" } ]
                    [ viewPrompt draft
                    , div [ id "previews", attribute "aria-label" "Attached files" ] (List.map (viewAttachment (draft.creation /= Draft) AttachmentRemoved) draft.attachments)
                    , viewComposerActions draft
                    ]
                ]
            ]
        ]


viewPrompt : Model -> Html Msg
viewPrompt model =
    textarea
        [ id "prompt"
        , Attr.name "content"
        , Attr.rows 2
        , Attr.maxlength 100000
        , Attr.placeholder "Ask Pi…"
        , attribute "aria-label" "Message"
        , Attr.value model.prompt
        , Attr.disabled (model.creation /= Draft)
        , onInput PromptEdited
        , fileEvent FilesSelected { event = "paste", field = "clipboardData" }
        , Events.preventDefaultOn "keydown" submitKey
        ]
        []


viewComposerActions : Model -> Html Msg
viewComposerActions model =
    div [ id "controls", class "actions" ]
        [ button [ id "input-toggle", class "icon", Attr.type_ "button", attribute "aria-label" "Upload attachments", Attr.disabled (model.creation /= Draft), onClick PickFiles ] [ text "+" ]
        , span [ class "spacer" ] []
        , button
            [ id "create"
            , class "icon"
            , Attr.type_ "submit"
            , attribute "aria-label" "Create session"
            , Attr.disabled
                (creating model.creation
                    || List.any
                        (\item ->
                            case item.state of
                                Ready _ ->
                                    False

                                _ ->
                                    True
                        )
                        model.attachments
                )
            , Attr.title "Create session (Ctrl/Cmd+Enter)"
            ]
            [ glyph [ Svg.path [ SvgAttr.d "M12 20V4m-7 7 7-7 7 7" ] [] ] ]
        ]


viewRefresh : String -> Bool -> msg -> Html msg
viewRefresh name busy msg =
    button [ class "refresh", Attr.type_ "button", Attr.disabled busy, attribute "aria-label" ("Refresh " ++ name), onClick msg ] [ text "↻" ]



-- EVENTS
-- Preserve ordinary Enter and IME editing.


submitKey : Decode.Decoder ( Msg, Bool )
submitKey =
    Decode.map5
        (\key ctrl meta alt composing ->
            ( if key == "Enter" && (ctrl || meta || alt) && not composing then
                Create

              else
                NoOp
            , key == "Enter" && (ctrl || meta || alt) && not composing
            )
        )
        (Decode.field "key" Decode.string)
        (Decode.field "ctrlKey" Decode.bool)
        (Decode.field "metaKey" Decode.bool)
        (Decode.field "altKey" Decode.bool)
        (Decode.field "isComposing" Decode.bool)



-- ICONS


glyph : List (Svg.Svg msg) -> Html msg
glyph children =
    Svg.svg [ SvgAttr.class "glyph", SvgAttr.viewBox "0 0 24 24", attribute "aria-hidden" "true" ] children


creating : Creation -> Bool
creating creation =
    case creation of
        Opening _ ->
            True

        CreatingRoot _ _ ->
            True

        _ ->
            False


clear : String -> Model -> Model
clear externalId model =
    { model | externalId = externalId, prompt = "", attachments = [], creation = Draft, notice = "" }
