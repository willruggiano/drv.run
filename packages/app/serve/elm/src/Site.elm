port module Site exposing (main)

import Browser
import Browser.Navigation as Nav
import Dict exposing (Dict)
import File exposing (File)
import File.Select
import Html exposing (Html, a, button, div, footer, form, h1, h2, header, input, label, main_, option, p, section, select, span, text, textarea)
import Html.Attributes as A exposing (attribute, class, hidden, href, id, value)
import Html.Events exposing (onClick, onInput, onSubmit, preventDefaultOn)
import Http
import Json.Decode as D
import Json.Encode as E
import Panel
import Process
import Protocol
import Task
import Transcript
import Url


port siteBrowser : E.Value -> Cmd msg


port siteIncoming : (D.Value -> msg) -> Sub msg


type alias Row =
    { path : String, title : String, date : String, environment : String, model : String, thinking : String, usage : String }


type alias Field =
    { key : String, label : String, group : String, readonly : Bool, value : String, choices : List String }


type alias Catalog =
    { options : Panel.Settings, rows : List Row, activity : Bool, fields : List Field, configured : Bool, defaultModel : String, overrides : Dict String String, levels : List String }


type alias Auth =
    { state : String, userId : Maybe Int, expires : Maybe String, error : Bool, device : Maybe { code : String, uri : String, expires : String } }


type Page
    = Loading
    | Landing Catalog
    | Defaults Catalog
    | Authorization Auth
    | Activity
    | Offline
    | Repository String String String
    | History String String Protocol.State
    | Compact String String


type alias Item =
    { id : Int, label : String, source : String, body : String, path : String, unavailable : String, read : Bool }


type alias Model =
    { path : String
    , page : Page
    , error : String
    , text : String
    , creation : String
    , files : List { file : File, url : String }
    , creationOptions : Dict String String
    , missingFiles : Bool
    , values : Dict String String
    , saved : Dict String String
    , saving : Maybe (Dict String String)
    , next : Maybe String
    , pending : Maybe (List Http.Part)
    , busy : Bool
    , directories : List String
    , directoryRequest : Int
    , items : List Item
    , sources : List { title : String, lines : List String }
    , connected : Bool
    , opened : Dict String Bool
    , completions : Bool
    , completionIndex : Int
    }


type Msg
    = Loaded (Result Http.Error Page)
    | Refresh
    | Navigate Browser.UrlRequest
    | Edit String
    | EditOption Panel.Field String
    | Directories Int (Result Http.Error (List String))
    | EditDefault String String
    | Save
    | Saved (Result Http.Error ())
    | Create
    | Created (Result Http.Error String)
    | PickFiles
    | Files File (List File)
    | Preview File String
    | Remove Int
    | DiscardFiles
    | Action String
    | Acted (Result Http.Error ())
    | Incoming D.Value
    | Read Int
    | Push Bool
    | Toggle String Bool
    | CompletionMove Int
    | Complete
    | ChooseCompletion Int
    | Dismiss
    | NoOp


andMap : D.Decoder a -> D.Decoder (a -> b) -> D.Decoder b
andMap =
    D.map2 (|>)


catalogDecoder : D.Decoder Catalog
catalogDecoder =
    D.succeed Catalog
        |> andMap
            (D.map4 (\model target models targets -> { name = "", model = model, target = target, thinking = "", directory = "", models = models, targets = targets })
                (D.field "model" D.string)
                (D.field "target" D.string)
                (D.field "models" (D.list (D.map4 (\key label levels default -> { key = key, label = label, levels = levels, default = default }) (D.field "key" D.string) (D.field "label" D.string) (D.field "levels" (D.list D.string)) (D.field "default" D.string))))
                (D.field "targets" (D.list (D.map4 (\key label disabled root -> { key = key, label = label, disabled = disabled, root = root }) (D.field "key" D.string) (D.field "label" D.string) (D.field "disabled" D.bool) (D.field "root" D.string))))
            )
        |> andMap (D.field "sessions" (D.list (D.map7 Row (D.field "path" D.string) (D.field "title" D.string) (D.field "date" D.string) (D.field "environment" D.string) (D.field "model" D.string) (D.field "thinking" D.string) (D.field "usage" D.string))))
        |> andMap (D.field "activity" D.bool)
        |> andMap (D.field "fields" (D.list (D.map6 Field (D.field "key" D.string) (D.field "label" D.string) (D.field "group" D.string) (D.field "readonly" D.bool) (D.field "value" D.string) (D.field "choices" (D.list D.string)))))
        |> andMap (D.field "configured" D.bool)
        |> andMap (D.field "defaultModel" D.string)
        |> andMap (D.field "overrides" (D.dict D.string))
        |> andMap (D.field "levels" (D.list D.string))


pageDecoder : D.Decoder Page
pageDecoder =
    D.field "kind" D.string
        |> D.andThen
            (\kind ->
                case kind of
                    "landing" ->
                        D.map Landing catalogDecoder

                    "settings" ->
                        D.map Defaults catalogDecoder

                    "auth" ->
                        D.map Authorization (D.map5 Auth (D.field "state" D.string) (D.field "userId" (D.nullable D.int)) (D.field "expires" (D.nullable D.string)) (D.field "failed" D.bool) (D.field "device" (D.nullable (D.map3 (\code uri expires -> { code = code, uri = uri, expires = expires }) (D.field "code" D.string) (D.field "uri" D.string) (D.field "expires" D.string)))))

                    "activity" ->
                        D.succeed Activity

                    "offline" ->
                        D.succeed Offline

                    "repository" ->
                        D.map3 Repository (D.field "back" D.string) (D.field "environment" D.string) (D.field "title" D.string)

                    "history" ->
                        D.map3 History
                            (D.field "back" D.string)
                            (D.field "next" D.string)
                            (D.field "frame" Protocol.frameDecoder
                                |> D.andThen
                                    (\frame ->
                                        case Protocol.apply frame.conversation frame Protocol.empty of
                                            Ok state ->
                                                D.succeed state

                                            Err reason ->
                                                D.fail reason
                                    )
                            )

                    "compact" ->
                        D.map2 Compact (D.field "back" D.string) (D.field "argument" D.string)

                    _ ->
                        D.fail "Unknown page"
            )


main : Program D.Value Model Msg
main =
    Browser.application
        { init =
            \flags url _ ->
                let
                    field name decoder fallback =
                        D.decodeValue (D.field name decoder) flags |> Result.withDefault fallback

                    model =
                        { path = url.path ++ (Maybe.map ((++) "?") url.query |> Maybe.withDefault "")
                        , page =
                            if field "offline" D.bool False then
                                Offline

                            else
                                Loading
                        , error = ""
                        , text =
                            if List.member url.path [ "/elm", "/elm/" ] then
                                field "text" D.string ""

                            else
                                ""
                        , creation = field "creation" D.string ""
                        , creationOptions = field "options" (D.dict D.string) Dict.empty
                        , files = []
                        , missingFiles = List.member url.path [ "/elm", "/elm/" ] && field "missingFiles" D.bool False
                        , values = Dict.empty
                        , saved = Dict.empty
                        , saving = Nothing
                        , next = Nothing
                        , pending = Nothing
                        , busy = False
                        , directories = []
                        , directoryRequest = 0
                        , items = []
                        , sources = []
                        , connected = False
                        , opened = Dict.empty
                        , completions = False
                        , completionIndex = 0
                        }
                in
                ( model
                , if model.page == Offline then
                    Cmd.none

                  else
                    load model
                )
        , update = update
        , view = view
        , subscriptions = \_ -> siteIncoming Incoming
        , onUrlRequest = Navigate
        , onUrlChange = \_ -> NoOp
        }


load : Model -> Cmd Msg
load model =
    Http.get
        { url =
            model.path
                ++ (if String.contains "?" model.path then
                        "&data=1"

                    else
                        "?data=1"
                   )
        , expect = Http.expectJson Loaded pageDecoder
        }


optionValues : Panel.Settings -> Dict String String
optionValues options =
    Dict.fromList [ ( "model", options.model ), ( "target", options.target ), ( "thinking", options.thinking ), ( "directory", options.directory ) ]


persist : Model -> Cmd Msg
persist model =
    case model.page of
        Landing catalog ->
            siteBrowser
                (E.object
                    [ ( "kind", E.string "draft" )
                    , ( "text", E.string model.text )
                    , ( "creation", E.string model.creation )
                    , ( "options", E.dict identity E.string (optionValues catalog.options) )
                    , ( "missingFiles", E.bool (model.missingFiles || not (List.isEmpty model.files)) )
                    ]
                )

        _ ->
            Cmd.none


parts : Dict String String -> List Http.Part
parts values =
    Dict.toList values |> List.map (\( key, str ) -> Http.stringPart key str)


message : Http.Error -> String
message error =
    case error of
        Http.BadStatus code ->
            "Request failed (" ++ String.fromInt code ++ "). Your changes are retained."

        _ ->
            "Connection lost. Your changes are retained; retry the request."


override : Catalog -> String -> String
override catalog key =
    D.decodeString (D.list D.string) key |> Result.map (String.join "/") |> Result.toMaybe |> Maybe.andThen (\name -> Dict.get name catalog.overrides) |> Maybe.withDefault ""


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        Loaded result ->
            case result of
                Err error ->
                    ( { model | error = message error }, Cmd.none )

                Ok page ->
                    let
                        values =
                            case page of
                                Defaults catalog ->
                                    Dict.fromList
                                        (( "model", catalog.defaultModel )
                                            :: ( "modelThinkingLevel", override catalog catalog.defaultModel )
                                            :: List.filterMap
                                                (\field ->
                                                    if field.readonly then
                                                        Nothing

                                                    else
                                                        Just ( field.key, field.value )
                                                )
                                                catalog.fields
                                        )

                                _ ->
                                    model.values

                        restored =
                            case page of
                                Landing catalog ->
                                    let
                                        options =
                                            catalog.options

                                        get key fallback =
                                            Dict.get key model.creationOptions |> Maybe.withDefault fallback
                                    in
                                    Landing { catalog | options = { options | model = get "model" options.model, target = get "target" options.target, thinking = get "thinking" options.thinking, directory = get "directory" options.directory } }

                                _ ->
                                    page

                        updated =
                            { model
                                | page = restored
                                , values = values
                                , saved = values
                                , error = ""
                                , text =
                                    case page of
                                        Compact _ argument ->
                                            argument

                                        _ ->
                                            model.text
                            }
                    in
                    ( updated
                    , Cmd.batch
                        [ siteBrowser (E.object [ ( "kind", E.string "rendered" ) ])
                        , case page of
                            Authorization auth ->
                                if auth.state == "authorizing" then
                                    Process.sleep 2000 |> Task.perform (\_ -> Refresh)

                                else
                                    Cmd.none

                            Activity ->
                                siteBrowser (E.object [ ( "kind", E.string "activity" ) ])

                            _ ->
                                Cmd.none
                        ]
                    )

        Refresh ->
            ( model, load model )

        Navigate destination ->
            let
                url =
                    case destination of
                        Browser.Internal value ->
                            Url.toString value

                        Browser.External value ->
                            value
            in
            if model.saving /= Nothing || model.values /= model.saved then
                update Save { model | next = Just url }

            else
                ( model, Nav.load url )

        Edit str ->
            let
                updated =
                    { model | text = str, completions = String.startsWith "/" str && not (String.contains " " str), completionIndex = 0 }
            in
            ( updated, Cmd.batch [ persist updated, siteBrowser (E.object [ ( "kind", E.string "resize" ) ]) ] )

        EditOption field str ->
            case model.page of
                Landing catalog ->
                    let
                        options =
                            Panel.edit field str catalog.options

                        updated =
                            { model | page = Landing { catalog | options = options }, creationOptions = optionValues options, directories = [], directoryRequest = model.directoryRequest + 1 }
                    in
                    ( updated
                    , Cmd.batch
                        [ persist updated
                        , if field == Panel.Directory then
                            Http.get { url = "/elm/directories?target=" ++ Url.percentEncode catalog.options.target ++ "&directory=" ++ Url.percentEncode str, expect = Http.expectJson (Directories updated.directoryRequest) (D.list D.string) }

                          else
                            Cmd.none
                        ]
                    )

                _ ->
                    ( model, Cmd.none )

        Directories revision result ->
            if revision /= model.directoryRequest then
                ( model, Cmd.none )

            else
                ( { model | directories = Result.withDefault [] result }, Cmd.none )

        EditDefault key str ->
            let
                values =
                    Dict.insert key str model.values

                updated =
                    { model
                        | values =
                            case model.page of
                                Defaults catalog ->
                                    if key == "model" then
                                        Dict.insert "modelThinkingLevel" (override catalog str) values

                                    else
                                        values

                                _ ->
                                    values
                    }
            in
            update Save updated

        Save ->
            if model.saving /= Nothing || model.values == model.saved then
                ( model, Cmd.none )

            else
                ( { model | saving = Just model.values, error = "" }, Http.post { url = "/elm/settings", body = Http.multipartBody (parts model.values), expect = Http.expectWhatever Saved } )

        Saved result ->
            case result of
                Err error ->
                    ( { model | saving = Nothing, error = message error }, Cmd.none )

                Ok () ->
                    let
                        updated =
                            { model | saved = Maybe.withDefault model.saved model.saving, saving = Nothing }
                    in
                    if updated.values /= updated.saved then
                        update Save updated

                    else
                        ( updated, Maybe.map Nav.load model.next |> Maybe.withDefault Cmd.none )

        Create ->
            if model.busy then
                ( model, Cmd.none )

            else if model.missingFiles then
                ( { model | error = "Reselect or discard missing attachments before creating a session." }, Cmd.none )

            else if String.startsWith "/" (String.trim model.text) && not (List.member (String.trim model.text) [ "/new", "/sessions" ]) then
                ( { model | error = "Command is not available here." }, Cmd.none )

            else if String.trim model.text == "/sessions" then
                ( model, Nav.load "/elm" )

            else
                case model.page of
                    Landing catalog ->
                        let
                            values =
                                Dict.fromList [ ( "id", model.creation ), ( "requestId", model.creation ), ( "target", catalog.options.target ), ( "model", catalog.options.model ), ( "thinkingLevel", catalog.options.thinking ), ( "baseDirectory", catalog.options.directory ), ( "content", model.text ) ]

                            body =
                                Maybe.withDefault
                                    (parts
                                        (if String.trim model.text == "/new" then
                                            Dict.insert "command" "new" values

                                         else
                                            values
                                        )
                                        ++ List.map (\item -> Http.filePart "images" item.file) model.files
                                    )
                                    model.pending
                        in
                        ( { model | busy = True, pending = Just body, completions = False, error = "" }, Cmd.batch [ persist model, Http.post { url = "/elm", body = Http.multipartBody body, expect = Http.expectJson Created (D.field "path" D.string) } ] )

                    Compact _ _ ->
                        ( { model | busy = True }, Http.post { url = model.path, body = Http.multipartBody [ Http.stringPart "argument" model.text ], expect = Http.expectJson Created (D.field "path" D.string) } )

                    _ ->
                        ( model, Cmd.none )

        Created result ->
            case result of
                Err error ->
                    ( { model
                        | busy = False
                        , error = message error
                        , pending =
                            case error of
                                Http.BadStatus code ->
                                    if code < 500 then
                                        Nothing

                                    else
                                        model.pending

                                _ ->
                                    model.pending
                      }
                    , Cmd.none
                    )

                Ok path ->
                    ( model
                    , siteBrowser
                        (E.object
                            [ ( "kind"
                              , E.string
                                    (case model.page of
                                        Landing _ ->
                                            "created"

                                        _ ->
                                            "navigate"
                                    )
                              )
                            , ( "path", E.string path )
                            ]
                        )
                    )

        PickFiles ->
            ( model, File.Select.files [ "image/png", "image/jpeg", "image/gif", "image/webp" ] Files )

        Files first rest ->
            let
                files =
                    first :: rest
            in
            if List.length files + List.length model.files > 4 || List.sum (List.map File.size files ++ List.map (.file >> File.size) model.files) > 5 * 1024 * 1024 || not (List.all (\file -> List.member (File.mime file) [ "image/png", "image/jpeg", "image/gif", "image/webp" ]) files) then
                ( { model | error = "Attach up to four PNG, JPEG, GIF or WebP images, totaling at most 5 MiB." }, Cmd.none )

            else
                let
                    updated =
                        { model | files = model.files ++ List.map (\file -> { file = file, url = "" }) files, missingFiles = False }
                in
                ( updated, Cmd.batch (persist updated :: List.map (\file -> Task.perform (Preview file) (File.toUrl file)) files) )

        Preview file url ->
            ( { model
                | files =
                    List.map
                        (\item ->
                            if item.file == file then
                                { item | url = url }

                            else
                                item
                        )
                        model.files
              }
            , Cmd.none
            )

        Remove index ->
            let
                updated =
                    { model | files = List.take index model.files ++ List.drop (index + 1) model.files }
            in
            ( updated, persist updated )

        DiscardFiles ->
            let
                updated =
                    { model | missingFiles = False }
            in
            ( updated, persist updated )

        Action path ->
            if model.busy then
                ( model, Cmd.none )

            else
                ( { model | busy = True, error = "" }, Http.post { url = path, body = Http.stringBody "application/x-www-form-urlencoded" "", expect = Http.expectWhatever Acted } )

        Acted result ->
            case result of
                Err error ->
                    ( { model | busy = False, error = message error }, Cmd.none )

                Ok () ->
                    ( { model | busy = False }, load model )

        Incoming payload ->
            case D.decodeValue (D.field "kind" D.string) payload of
                Ok "activity" ->
                    case D.decodeValue (D.field "value" activityDecoder) payload of
                        Ok ( sources, items ) ->
                            ( { model | sources = sources, items = items, connected = True }, Cmd.none )

                        Err _ ->
                            ( { model | error = "Invalid activity update." }, Cmd.none )

                Ok "home" ->
                    update (Navigate (Browser.External "/elm")) model

                Ok "files" ->
                    case D.decodeValue (D.field "value" (D.list File.decoder)) payload of
                        Ok (first :: rest) ->
                            if model.pending == Nothing then
                                update (Files first rest) model

                            else
                                ( model, Cmd.none )

                        _ ->
                            ( model, Cmd.none )

                Ok "disconnected" ->
                    ( { model | connected = False }, Cmd.none )

                Ok "status" ->
                    ( { model | error = D.decodeValue (D.field "value" D.string) payload |> Result.withDefault "" }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        Read item ->
            ( model
            , Http.post
                { url = "/elm/activity/read"
                , body = Http.jsonBody (E.object [ ( "id", E.int item ) ])
                , expect =
                    Http.expectWhatever
                        (\result ->
                            case result of
                                Ok () ->
                                    NoOp

                                Err error ->
                                    Incoming (E.object [ ( "kind", E.string "status" ), ( "value", E.string (message error) ) ])
                        )
                }
            )

        Push enabled ->
            ( model, siteBrowser (E.object [ ( "kind", E.string "push" ), ( "enabled", E.bool enabled ) ]) )

        Toggle key expanded ->
            ( { model | opened = Dict.insert key expanded model.opened }, Cmd.none )

        CompletionMove delta ->
            ( { model | completionIndex = modBy (max 1 (List.length (completions model))) (model.completionIndex + delta) }, Cmd.none )

        ChooseCompletion index ->
            update Complete { model | completionIndex = index }

        Complete ->
            case List.drop model.completionIndex (completions model) |> List.head of
                Nothing ->
                    ( model, Cmd.none )

                Just name ->
                    update (Edit ("/" ++ name ++ " ")) model

        Dismiss ->
            ( { model | completions = False }, Cmd.none )

        NoOp ->
            ( model, Cmd.none )


completions : Model -> List String
completions model =
    if model.completions then
        List.filter (String.startsWith (String.dropLeft 1 model.text)) [ "new", "sessions" ]

    else
        []


keys : Model -> Html.Attribute Msg
keys model =
    preventDefaultOn "keydown"
        (D.map4
            (\key ctrl meta composing ->
                if composing then
                    ( NoOp, False )

                else if key == "Enter" && (ctrl || meta) then
                    ( Create, True )

                else if not (List.isEmpty (completions model)) then
                    case key of
                        "Enter" ->
                            ( Complete, True )

                        "Tab" ->
                            ( Complete, True )

                        "ArrowDown" ->
                            ( CompletionMove 1, True )

                        "ArrowUp" ->
                            ( CompletionMove -1, True )

                        "Escape" ->
                            ( Dismiss, True )

                        _ ->
                            ( NoOp, False )

                else
                    ( NoOp, False )
            )
            (D.field "key" D.string)
            (D.field "ctrlKey" D.bool)
            (D.field "metaKey" D.bool)
            (D.field "isComposing" D.bool)
        )


activityDecoder : D.Decoder ( List { title : String, lines : List String }, List Item )
activityDecoder =
    D.map2 Tuple.pair
        (D.field "sources" (D.list (D.map2 (\title lines -> { title = title, lines = lines }) (D.field "title" D.string) (D.field "lines" (D.list D.string)))))
        (D.field "history" (D.list (D.map7 Item (D.field "id" D.int) (D.field "label" D.string) (D.field "source" D.string) (D.field "body" D.string) (D.field "path" D.string) (D.field "unavailable" D.string) (D.field "read" D.bool))))


view : Model -> Browser.Document Msg
view model =
    let
        link path caption =
            a [ href path ] [ text caption ]

        icon name caption path =
            a [ id "close-view", class "icon", href path, attribute "aria-label" caption, A.title caption ] [ Transcript.icon name ]

        title =
            case model.page of
                Landing _ ->
                    "Sessions"

                Defaults _ ->
                    "Global settings"

                Authorization _ ->
                    "Auth"

                Activity ->
                    "Activity"

                Offline ->
                    "Offline"

                Repository _ _ _ ->
                    "Repository"

                History _ _ _ ->
                    "History"

                Compact _ _ ->
                    "Compact context"

                Loading ->
                    "Pi"

        back =
            case model.page of
                Repository path _ _ ->
                    path

                History path _ _ ->
                    path

                Compact path _ ->
                    path

                _ ->
                    "/elm"

        dot =
            span [ class "footer-dot", attribute "aria-hidden" "true" ] []

        row item =
            div [ class "session-row" ]
                [ a [ class "session", href item.path ] [ span [ class "session-heading" ] [ Html.strong [] [ text item.title ], Html.time [ A.datetime item.date, attribute "data-date-only" "" ] [ text item.date ] ], span [ class "session-detail" ] [ span [ class "session-environment" ] [ text item.environment ], dot, span [ class "model-summary" ] [ span [ class "model-name" ] [ text item.model ], dot, span [ class "model-effort" ] [ text item.thinking ] ], dot, span [ class "context-usage" ] [ text item.usage ] ] ]
                , form [ onSubmit (Action (item.path ++ "/archive")) ] [ button [ class "icon session-archive", attribute "aria-label" "Archive session", A.title "Archive session", A.disabled model.busy ] [ Transcript.icon "close" ] ]
                ]

        prompt =
            textarea [ id "prompt", A.name "content", A.rows 2, A.tabindex 1, A.maxlength 100000, A.placeholder "Ask Pi…", attribute "aria-label" "Message", value model.text, onInput Edit, keys model, A.disabled (model.pending /= Nothing) ] []

        content =
            case model.page of
                Loading ->
                    [ p [ attribute "role" "status" ] [ text "Loading…" ] ]

                Landing catalog ->
                    [ main_ [ id "main-area" ]
                        [ section [ id "landing", class "pane" ]
                            [ Html.nav []
                                [ if catalog.activity then
                                    link "/elm/activity" "Activity inbox"

                                  else
                                    text ""
                                , link "/elm/auth" "Auth"
                                ]
                            , div []
                                [ if List.isEmpty catalog.rows then
                                    text ""

                                  else
                                    h2 [ id "recent-title" ] [ text "Recent sessions" ]
                                , div [ id "session-list" ] (List.map row catalog.rows)
                                , if List.isEmpty catalog.rows then
                                    p [ id "sessions-empty" ] [ text "No sessions" ]

                                  else
                                    text ""
                                ]
                            ]
                        ]
                    , footer [ id "app-footer", class "composer-area" ]
                        [ form [ id "composer", class "new-composer", onSubmit Create ]
                            [ Html.details [ id "new-options" ] [ Html.summary [ attribute "aria-label" "New session options", A.title "New session options" ] [ Transcript.icon "settings", span [ class "options-close", attribute "aria-hidden" "true" ] [ text "×" ] ], Html.fieldset [ A.disabled (model.pending /= Nothing), class "creation-options" ] [ Panel.optionsView EditOption NoOp model.directories catalog.options ] ]
                            , div [ class "compose-box" ]
                                [ prompt
                                , div [ id "completions", attribute "role" "listbox", hidden (List.isEmpty (completions model)) ]
                                    (List.indexedMap
                                        (\index name ->
                                            button
                                                [ A.type_ "button"
                                                , attribute "role" "option"
                                                , attribute "aria-selected"
                                                    (if index == model.completionIndex then
                                                        "true"

                                                     else
                                                        "false"
                                                    )
                                                , onClick (ChooseCompletion index)
                                                ]
                                                [ text
                                                    ("/"
                                                        ++ name
                                                        ++ (if name == "new" then
                                                                " · Create a session"

                                                            else
                                                                " · Open sessions"
                                                           )
                                                    )
                                                ]
                                        )
                                        (completions model)
                                    )
                                , div [ id "previews" ] (List.indexedMap (\index item -> button [ A.type_ "button", A.disabled (model.pending /= Nothing), onClick (Remove index), attribute "aria-label" ("Remove " ++ File.name item.file) ] [ Html.img [ A.src item.url, A.alt (File.name item.file) ] [] ]) model.files)
                                , div [ class "actions" ] [ button [ id "input-toggle", class "icon enhanced-only", A.type_ "button", attribute "aria-label" "Upload attachments", A.disabled (model.pending /= Nothing), onClick PickFiles ] [ text "+" ], span [ class "spacer" ] [], button [ id "create", class "icon", attribute "aria-label" "Create session", A.title "New session", A.disabled (model.busy || catalog.options.model == "" || catalog.options.target == "") ] [ text "+" ] ]
                                ]
                            ]
                        , if model.missingFiles then
                            p [ class "notice" ] [ text "Images cannot be restored after reload. ", button [ onClick DiscardFiles ] [ text "Discard missing attachments" ] ]

                          else
                            text ""
                        ]
                    ]

                Defaults catalog ->
                    [ main_ [ id "main-area" ] [ section [ id "global-preferences", class "pane" ] (defaultsView model catalog) ] ]

                Authorization auth ->
                    [ main_ [ id "main-area" ] [ section [ id "github-authorization", class "pane" ] (authView model.busy auth) ] ]

                Activity ->
                    [ main_ [ id "main-area" ]
                        [ section [ class "pane" ]
                            [ h1 [] [ text "Activity" ]
                            , p [ id "connection" ]
                                [ text
                                    (if model.connected then
                                        "Connected"

                                     else
                                        "Disconnected; reconnecting…"
                                    )
                                ]
                            , button [ id "enable-push", onClick (Push True) ] [ text "Enable push on this device" ]
                            , button [ id "disable-push", onClick (Push False) ] [ text "Disable push on this device" ]
                            , p [ id "push-status", attribute "role" "status" ] [ text model.error ]
                            , h2 [] [ text "Current status" ]
                            , div [ id "sources" ] (List.map (\source -> section [] (Html.h3 [] [ text source.title ] :: List.map (\line -> p [] [ text line ]) source.lines)) model.sources)
                            , h2 [] [ text "Inbox" ]
                            , div [ id "inbox" ]
                                (List.map
                                    (\item ->
                                        Html.article [ id ("activity-" ++ String.fromInt item.id) ]
                                            [ Html.h3 [] [ text item.label ]
                                            , p [] [ text item.source ]
                                            , if item.body == "" then
                                                text ""

                                              else
                                                p [ class "activity-body" ] [ text item.body ]
                                            , if item.path /= "" then
                                                link item.path "Open conversation"

                                              else
                                                p [] [ text item.unavailable ]
                                            , button [ A.disabled item.read, onClick (Read item.id) ]
                                                [ text
                                                    (if item.read then
                                                        "Read"

                                                     else
                                                        "Mark read"
                                                    )
                                                ]
                                            ]
                                    )
                                    model.items
                                )
                            ]
                        ]
                    ]

                Offline ->
                    [ h1 [] [ text "Offline" ], p [] [ text "Conversation history is not cached in this browser." ], p [] [ link "/elm" "Reconnect" ] ]

                Repository _ environment name ->
                    [ main_ [ id "main-area" ] [ section [ class "pane" ] [ h1 [] [ text "Repository" ], span [ id "footer-instance" ] [ text environment ], p [] [ text name ] ] ] ]

                History _ next state ->
                    [ main_ [ id "main-area" ]
                        [ section [ class "pane" ]
                            [ h1 [] [ text "History" ]
                            , Transcript.transcript Toggle model.opened "" Nothing state.entries state.tools state.metadata.durations
                            , if next /= "" then
                                link next "Older history"

                              else
                                text ""
                            ]
                        ]
                    ]

                Compact _ _ ->
                    [ main_ [ id "main-area" ] [ section [ class "pane" ] [ h1 [] [ text "Compact context" ], p [] [ text "History is preserved." ], form [ onSubmit Create ] [ label [] [ text "Instructions", textarea [ A.name "argument", value model.text, onInput Edit, A.maxlength 100000 ] [] ], button [ A.disabled model.busy ] [ text "Compact" ] ] ] ] ]
    in
    { title = title
    , body =
        [ main_ [ id "page", attribute "data-view" "panel" ]
            (header [ id "app-header" ]
                [ div [ class "bar" ]
                    [ h1 [] [ span [ class "header-title" ] [ text title ] ]
                    , case model.page of
                        Landing _ ->
                            a [ id "menu-toggle", class "icon", href "/elm/settings", attribute "aria-label" "Global settings", A.title "Global settings" ] [ Transcript.icon "settings" ]

                        _ ->
                            icon "close"
                                (if back == "/elm" then
                                    "Sessions"

                                 else
                                    "Conversation"
                                )
                                back
                    ]
                , p [ id "request-error", attribute "role" "alert" ]
                    [ text model.error
                    , if model.error /= "" then
                        button
                            [ onClick
                                (if model.pending /= Nothing then
                                    Create

                                 else if model.values /= model.saved then
                                    Save

                                 else
                                    Refresh
                                )
                            ]
                            [ text "Retry" ]

                      else
                        text ""
                    ]
                ]
                :: content
            )
        ]
    }


defaultsView : Model -> Catalog -> List (Html Msg)
defaultsView model catalog =
    let
        current key =
            Dict.get key model.values |> Maybe.withDefault ""

        choice selected key title =
            option [ value key, A.selected (selected == key) ] [ text title ]

        field item =
            label []
                [ span [] [ text item.label ]
                , if item.readonly then
                    input [ A.type_ "number", value item.value, A.readonly True ] []

                  else
                    select [ A.name item.key, value (current item.key), onInput (EditDefault item.key) ]
                        (List.map
                            (\str ->
                                choice (current item.key)
                                    str
                                    (if str == "true" then
                                        "On"

                                     else if str == "false" then
                                        "Off"

                                     else
                                        str
                                    )
                            )
                            item.choices
                        )
                ]

        group name children =
            section [ class "settings-group" ] (h2 [] [ text name ] :: children ++ List.map field (List.filter (.group >> (==) name) catalog.fields))

        models =
            div [ id "model-defaults" ] [ label [] [ span [] [ text "Default model" ], select [ A.name "model", value (current "model"), onInput (EditDefault "model") ] (choice (current "model") "" "Keep configured default" :: List.map (\item -> choice (current "model") item.key item.label) catalog.options.models) ], label [] [ span [] [ text "Thinking override for this model" ], select [ A.name "modelThinkingLevel", value (current "modelThinkingLevel"), onInput (EditDefault "modelThinkingLevel") ] (choice (current "modelThinkingLevel") "" "Use global default" :: List.map (\str -> choice (current "modelThinkingLevel") str str) catalog.levels) ] ]

        preference key title =
            label [] [ span [] [ text title ], select [ id key, attribute "data-preference" key ] [ option [ value "false" ] [ text "Off" ], option [ value "true" ] [ text "On" ] ] ]
    in
    [ h1 [] [ text "Global settings" ]
    , if catalog.configured then
        form
            [ id "global-settings"
            , attribute "data-autosave" ""
            , attribute "data-failed"
                (if model.error == "" then
                    "false"

                 else
                    "true"
                )
            , onSubmit Save
            ]
            (group "Model / thinking" [ models ]
                :: List.map (\name -> group name []) [ "Execution", "Compaction", "Retries", "Display" ]
                ++ [ button [] [ text "Save defaults" ]
                   , Html.output [ class "save-status", attribute "role" "status" ]
                        [ text
                            (if model.saving /= Nothing then
                                "Saving…"

                             else if model.error /= "" then
                                "Save failed"

                             else
                                "Saved"
                            )
                        ]
                   ]
            )

      else
        p [] [ text "Shared settings are not configured." ]
    , preference "wrap-code" "Wrap code"
    , preference "bottom-align" "Bottom-align messages"
    , button [ id "install", A.type_ "button", hidden True ] [ text "Install app" ]
    , button [ id "update", A.type_ "button", hidden True ] [ text "Update app" ]
    ]


authView : Bool -> Auth -> List (Html Msg)
authView busy auth =
    let
        status =
            case auth.state of
                "unconfigured" ->
                    "GitHub credentials are not configured for this host user."

                "not-enrolled" ->
                    "Not authorized"

                "usable" ->
                    "Authorized"

                "temporarily-unavailable" ->
                    "Access token expired or credentials temporarily unavailable. The proxy renews tokens when Git needs them."

                "reauthorization-required" ->
                    "Authorization required"

                _ ->
                    "Waiting for GitHub approval"

        action path title =
            form [ onSubmit (Action path) ] [ button [ A.disabled busy ] [ text title ] ]
    in
    [ Html.nav [] [ a [ href "/elm" ] [ text "Sessions" ] ]
    , h1 [] [ text "Auth" ]
    , h2 [] [ text "GitHub" ]
    , p [ attribute "role" "status", attribute "data-state" auth.state ] [ text status ]
    , Maybe.map (\user -> p [] [ text ("GitHub user ID: " ++ String.fromInt user) ]) auth.userId |> Maybe.withDefault (text "")
    , if auth.error then
        p [ attribute "role" "alert" ] [ text "Authorization did not complete. Try again and approve with the configured GitHub account." ]

      else
        text ""
    , Maybe.map (\device -> div [] [ p [] [ text "Enter ", Html.code [] [ text device.code ], text " at ", a [ href device.uri, A.target "_blank", A.rel "noopener noreferrer" ] [ text "GitHub device authorization" ], text "." ], p [] [ text "Code expires at ", Html.time [ A.datetime device.expires ] [ text device.expires ], text "." ] ]) auth.device |> Maybe.withDefault (text "")
    , Maybe.map (\expires -> p [] [ text "Access token expires at ", Html.time [ A.datetime expires ] [ text expires ], text "; renewal is automatic." ]) auth.expires |> Maybe.withDefault (text "")
    , if auth.state == "unconfigured" then
        text ""

      else
        div []
            [ p [] [ text "All guests of this host user share this GitHub Git access. Access and refresh tokens stay on the host." ]
            , div [ class "actions" ]
                [ if auth.state == "authorizing" then
                    text ""

                  else
                    action "/elm/auth/login"
                        (if auth.state == "usable" then
                            "Reauthorize"

                         else
                            "Authorize"
                        )
                , action "/elm/auth/logout" "Remove authorization"
                , a [ href "/elm/auth" ] [ text "Refresh" ]
                ]
            , p [] [ text "Removal cancels pending authorization and deletes local credentials. It does not revoke the app authorization at GitHub." ]
            ]
    ]
