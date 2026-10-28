port module Main exposing (Draft, Model, Msg(..), acknowledge, draftDecoder, initModel, keyDown, main, update)

import Autosave
import Browser
import Browser.Navigation as Nav
import Composer
import Dict exposing (Dict)
import File exposing (File)
import File.Select
import Html exposing (Html, a, button, div, footer, form, h1, header, input, main_, p, section, span, text, textarea)
import Html.Attributes as A exposing (attribute, class, hidden, href, id, value)
import Html.Events exposing (on, onClick, onInput, onSubmit, preventDefaultOn)
import Html.Lazy
import Http
import Icon
import Json.Decode as D
import Json.Encode as E
import Panel
import Protocol exposing (State)
import Task
import Transcript
import Url exposing (Url)
import Url.Parser as Parser
import Url.Parser.Query as Query


port stream : { path : String, epoch : Int, pane : String } -> Cmd msg


port incoming : (D.Value -> msg) -> Sub msg


port persist : E.Value -> Cmd msg


port browser : E.Value -> Cmd msg


type alias Attachment =
    { id : String, file : File, url : String }


type Status
    = Waiting
    | Failed String


type alias Pending =
    { identity : String, revision : String, text : String, files : List Attachment, mode : String, command : String, argument : String, clear : Bool, status : Status, missingFiles : Bool }


type alias Draft =
    { text : String, revision : String, files : List Attachment, pending : Maybe Pending, missingFiles : Bool }


type Connection
    = Connecting
    | Connected
    | Disconnected
    | Broken String


type alias Completion =
    { label : String, value : String, description : Maybe String }


type alias Completions =
    { start : Int, end : Int, items : List Completion }


type Pane
    = Conversation
    | Preferences
    | Context
    | Branches
    | Tree


route : String -> ( String, Pane )
route path =
    let
        parts =
            String.split "/" path

        pane =
            case List.drop 5 parts |> List.head of
                Just "settings" ->
                    Preferences

                Just "context" ->
                    Context

                Just "branches" ->
                    Branches

                Just "tree" ->
                    Tree

                _ ->
                    Conversation
    in
    ( String.join "/" (List.take 5 parts), pane )


connect : Model -> Cmd Msg
connect model =
    stream
        { path = model.path
        , epoch = model.epoch
        , pane =
            case model.pane of
                Context ->
                    "context"

                Preferences ->
                    "settings"

                Branches ->
                    "branches"

                Tree ->
                    "tree"

                Conversation ->
                    ""
        }


loadPanel : Model -> Cmd Msg
loadPanel model =
    case model.pane of
        Preferences ->
            Http.get { url = model.path ++ "/panel?view=settings", expect = Http.expectJson (SettingsLoaded model.epoch) Panel.settingsDecoder }

        _ ->
            Cmd.none


saveSettings : ( Autosave.State Panel.Settings, Maybe Panel.Settings ) -> Model -> ( Model, Cmd Msg )
saveSettings ( settings, pending ) model =
    let
        updated =
            { model | settings = Just settings }
    in
    case pending of
        Just values ->
            ( { updated | error = "" }, Http.post { url = model.path ++ "/settings", body = Panel.settingsBody values, expect = Http.expectJson (SettingsSaved model.epoch) (D.field "saved" D.bool) } )

        Nothing ->
            ( updated, Cmd.none )


navigate : String -> Model -> ( Model, Cmd Msg )
navigate path model =
    ( model, Maybe.map (\key -> Nav.pushUrl key path) model.key |> Maybe.withDefault Cmd.none )


type ContextAction
    = Reset
    | Compact


type alias Confirmation =
    { action : ContextAction, argument : String }


contextCommand : ContextAction -> String
contextCommand action =
    case action of
        Reset ->
            "reset"

        Compact ->
            "compact"


confirmationFor : String -> Maybe Confirmation
confirmationFor path =
    if String.endsWith "/reset" path then
        Just { action = Reset, argument = "" }

    else if String.endsWith "/compact" path then
        Just { action = Compact, argument = "" }

    else
        Nothing


confirmationFromUrl : Url -> Maybe Confirmation
confirmationFromUrl url =
    confirmationFor url.path
        |> Maybe.map (\confirmation -> { confirmation | argument = Parser.parse (Parser.query (Query.string "argument")) { url | path = "/" } |> Maybe.andThen identity |> Maybe.withDefault "" })


type alias Model =
    { key : Maybe Nav.Key
    , path : String
    , epoch : Int
    , nonce : String
    , counter : Int
    , drafts : Dict String Draft
    , state : State
    , connection : Connection
    , error : String
    , opened : Dict String (Dict String Bool)
    , composing : Bool
    , completions : Maybe Completions
    , completionIndex : Int
    , completionRequest : Int
    , search : Maybe String
    , searchIndex : Int
    , confirmation : Maybe Confirmation
    , pane : Pane
    , settings : Maybe (Autosave.State Panel.Settings)
    , nextNavigation : Maybe Browser.UrlRequest
    , directories : List String
    , directoryRequest : Int
    , composerExpanded : Bool
    , latest : Bool
    }


type Msg
    = UrlRequested Browser.UrlRequest
    | UrlChanged Url
    | Incoming D.Value
    | Edit String
    | Send String
    | Command String String
    | Acknowledged String Pending (Result Http.Error ( String, String ))
    | Retry
    | Receipt String Pending (Result Http.Error Bool)
    | PickFiles
    | AddedFiles File (List File)
    | Preview String String String
    | RemoveFile String
    | DiscardMissingFiles
    | Toggle String Bool
    | Composition Bool
    | Caret Int
    | Completed Int String (Result Http.Error Completions)
    | CompletionMove Int
    | ChooseCompletion Int
    | Dismiss
    | Search String
    | SearchMove Int
    | OpenSessions
    | EditConfirmation String
    | ConfirmContext
    | Response String Pending (Result Http.Error ( String, String, Maybe String ))
    | SettingsLoaded Int (Result Http.Error Panel.Settings)
    | EditSetting Panel.Field String
    | SaveSettings
    | SettingsSaved Int (Result Http.Error Bool)
    | Directories Int Int (Result Http.Error (List String))
    | Collapse
    | Latest
    | NoOp


emptyDraft : Draft
emptyDraft =
    { text = "", revision = "", files = [], pending = Nothing, missingFiles = False }


initModel : String -> String -> Model
initModel path nonce =
    { key = Nothing
    , path = Tuple.first (route path)
    , epoch = 1
    , nonce = nonce
    , counter = 0
    , drafts = Dict.empty
    , state = Protocol.empty
    , connection = Connecting
    , error = ""
    , opened = Dict.empty
    , composing = False
    , completions = Nothing
    , completionIndex = 0
    , completionRequest = 0
    , search = Nothing
    , searchIndex = 0
    , confirmation = confirmationFor path
    , pane = Tuple.second (route path)
    , settings = Nothing
    , nextNavigation = Nothing
    , directories = []
    , directoryRequest = 0
    , composerExpanded = True
    , latest = False
    }


main : Program D.Value Model Msg
main =
    Browser.application
        { init =
            \flags url key ->
                let
                    nonce =
                        D.decodeValue (D.field "nonce" D.string) flags |> Result.withDefault ""

                    base =
                        initModel url.path nonce

                    drafts =
                        D.decodeValue (D.field "drafts" (D.dict draftDecoder)) flags |> Result.withDefault Dict.empty

                    model =
                        { base | key = Just key, confirmation = confirmationFromUrl url, drafts = drafts, opened = D.decodeValue (D.field "opened" (D.dict (D.dict D.bool))) flags |> Result.withDefault Dict.empty }
                in
                ( model, Cmd.batch [ connect model, loadPanel model ] )
        , view = view
        , update = update
        , subscriptions = \_ -> incoming Incoming
        , onUrlRequest = UrlRequested
        , onUrlChange = UrlChanged
        }


draftDecoder : D.Decoder Draft
draftDecoder =
    D.map4 (\str revision pending missing -> { text = str, revision = revision, files = [], pending = pending, missingFiles = missing })
        (D.field "text" D.string)
        (D.field "revision" D.string)
        (D.field "pending"
            (D.nullable
                (D.map8
                    (\identity revision str mode command argument clear missing ->
                        { identity = identity, revision = revision, text = str, files = [], mode = mode, command = command, argument = argument, clear = clear, status = Failed "Previous acknowledgement was not received. Check the original operation before sending another.", missingFiles = missing }
                    )
                    (D.field "identity" D.string)
                    (D.field "revision" D.string)
                    (D.field "text" D.string)
                    (D.field "mode" D.string)
                    (D.field "command" D.string)
                    (D.field "argument" D.string)
                    (D.field "clear" D.bool)
                    (Protocol.optional "missingFiles" D.bool |> D.map (Maybe.withDefault False))
                )
            )
        )
        (D.field "missingFiles" D.bool)


storage : Model -> Cmd Msg
storage model =
    let
        encodePending pending =
            E.object [ ( "identity", E.string pending.identity ), ( "revision", E.string pending.revision ), ( "text", E.string pending.text ), ( "mode", E.string pending.mode ), ( "command", E.string pending.command ), ( "argument", E.string pending.argument ), ( "clear", E.bool pending.clear ), ( "missingFiles", E.bool (pending.missingFiles || not (List.isEmpty pending.files)) ) ]

        encode draft =
            E.object [ ( "text", E.string draft.text ), ( "revision", E.string draft.revision ), ( "pending", Maybe.map encodePending draft.pending |> Maybe.withDefault E.null ), ( "missingFiles", E.bool (draft.missingFiles || not (List.isEmpty draft.files) || (Maybe.map (.files >> List.isEmpty >> not) draft.pending |> Maybe.withDefault False)) ) ]
    in
    persist (E.dict identity encode model.drafts)


draftFor : Model -> Draft
draftFor model =
    Dict.get model.path model.drafts |> Maybe.withDefault emptyDraft


putDraft : Draft -> Model -> Model
putDraft draft model =
    { model | drafts = Dict.insert model.path draft model.drafts }


changeDraft : (Draft -> Draft) -> Model -> ( Model, Cmd Msg )
changeDraft change model =
    let
        draft =
            change (draftFor model)

        updated =
            putDraft { draft | revision = model.nonce ++ "." ++ String.fromInt (model.counter + 1) } { model | counter = model.counter + 1, completions = Nothing, completionRequest = model.completionRequest + 1 }
    in
    ( updated, Cmd.batch [ storage updated, browser (E.object [ ( "kind", E.string "resize" ) ]) ] )


acknowledge : Pending -> Draft -> Draft
acknowledge pending draft =
    if Maybe.map .identity draft.pending /= Just pending.identity then
        draft

    else if pending.clear && draft.revision == pending.revision then
        emptyDraft

    else
        { draft | pending = Nothing }


request : String -> Pending -> Cmd Msg
request path pending =
    let
        fields =
            [ ( "command", pending.command ), ( "requestId", pending.identity ), ( "revision", pending.revision ), ( "content", pending.text ), ( "whenBusy", pending.mode ), ( "argument", pending.argument ) ]

        body =
            if pending.command == "submit" then
                Http.multipartBody (List.map (\( k, v ) -> Http.stringPart k v) fields ++ List.map (\attachment -> Http.filePart "files" attachment.file) pending.files)

            else
                Http.jsonBody (E.object (List.map (\( k, v ) -> ( k, E.string v )) fields))
    in
    Http.post { url = path ++ "/command", body = body, expect = Http.expectJson (Response path pending) (D.map3 (\identity revision next -> ( identity, revision, next )) (D.field "requestId" D.string) (D.field "revision" D.string) (Protocol.optional "path" D.string)) }


waiting : Draft -> Bool
waiting draft =
    Maybe.map .status draft.pending == Just Waiting


retryInput : Draft -> Maybe Pending
retryInput draft =
    case draft.pending of
        Just pending ->
            if pending.command == "submit" && pending.revision == draft.revision && not (waiting draft) then
                Just pending

            else
                Nothing

        Nothing ->
            Nothing


submit : String -> String -> String -> Bool -> Model -> ( Model, Cmd Msg )
submit command argument mode clear model =
    let
        draft =
            draftFor model

        revision =
            if draft.revision == "" then
                model.nonce ++ "." ++ String.fromInt (model.counter + 1)

            else
                draft.revision

        pending =
            case ( command, retryInput draft ) of
                ( "submit", Just original ) ->
                    { original | status = Waiting }

                _ ->
                    { identity = revision ++ ":" ++ command
                    , revision = revision
                    , text = draft.text
                    , files =
                        if command == "submit" then
                            draft.files

                        else
                            []
                    , mode = mode
                    , command = command
                    , argument = argument
                    , clear = clear
                    , status = Waiting
                    , missingFiles = False
                    }

        updated =
            putDraft { draft | revision = revision, pending = Just pending } { model | error = "", counter = model.counter + 1, completions = Nothing }
    in
    if waiting draft then
        ( model, Cmd.none )

    else
        ( updated
        , Cmd.batch
            [ storage updated
            , if pending.missingFiles then
                Http.get { url = model.path ++ "/receipt?requestId=" ++ Url.percentEncode pending.identity, expect = Http.expectJson (Receipt model.path pending) (D.field "accepted" D.bool) }

              else
                request model.path pending
            ]
        )


httpError : Http.Error -> String
httpError error =
    case error of
        Http.BadStatus status ->
            "Request failed (HTTP " ++ String.fromInt status ++ ")."

        Http.BadBody _ ->
            "Invalid server response."

        _ ->
            "Request acknowledgement unavailable."


openConfirmation : ContextAction -> String -> Model -> ( Model, Cmd Msg )
openConfirmation action argument model =
    ( { model | confirmation = Just { action = action, argument = argument }, completions = Nothing }
    , Cmd.batch
        [ browser (E.object [ ( "kind", E.string "resize" ) ])
        , browser (E.object [ ( "kind", E.string "focus" ), ( "id", E.string "prompt" ) ])
        ]
    )


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        UrlRequested requestUrl ->
            if model.pane == Preferences && (Maybe.map Autosave.canLeave model.settings == Just False) then
                update SaveSettings { model | nextNavigation = Just requestUrl }

            else
                case requestUrl of
                    Browser.Internal url ->
                        if url.path == "/" then
                            update OpenSessions model

                        else if String.endsWith "/export" url.path then
                            ( model, browser (E.object [ ( "kind", E.string "download" ), ( "url", E.string url.path ) ]) )

                        else if String.startsWith "/sessions/" url.path then
                            ( model, Maybe.map (\key -> Nav.pushUrl key (url.path ++ (Maybe.map ((++) "?") url.query |> Maybe.withDefault "") ++ (Maybe.map ((++) "#") url.fragment |> Maybe.withDefault ""))) model.key |> Maybe.withDefault Cmd.none )

                        else
                            ( model, Nav.load (Url.toString url) )

                    Browser.External url ->
                        ( model, Nav.load url )

        UrlChanged url ->
            let
                ( path, pane ) =
                    route url.path

                updated =
                    { model
                        | path = path
                        , pane = pane
                        , epoch = model.epoch + 1
                        , state =
                            if path == model.path then
                                let
                                    old =
                                        model.state

                                    metadata =
                                        old.metadata
                                in
                                { old | metadata = { metadata | explorer = Nothing } }

                            else
                                Protocol.empty
                        , connection = Connecting
                        , error = ""
                        , search = Nothing
                        , confirmation = confirmationFromUrl url
                        , composing = False
                        , completions = Nothing
                        , completionRequest = model.completionRequest + 1
                        , settings = Nothing
                        , nextNavigation = Nothing
                        , directories = []
                        , directoryRequest = model.directoryRequest + 1
                    }
            in
            ( updated, Cmd.batch [ connect updated, loadPanel updated, browser (E.object [ ( "kind", E.string "resize" ) ]) ] )

        Incoming raw ->
            let
                event =
                    D.decodeValue (D.map3 (\kind epoch payload -> ( kind, epoch, payload )) (D.field "kind" D.string) (D.field "epoch" D.int) (D.field "payload" D.value)) raw
            in
            case event of
                Err _ ->
                    ( { model | error = "Invalid browser adapter message" }, Cmd.none )

                Ok ( kind, epoch, payload ) ->
                    if epoch /= model.epoch then
                        ( model, Cmd.none )

                    else
                        case kind of
                            "frame" ->
                                let
                                    conversation =
                                        String.split "/" model.path |> List.reverse |> List.head |> Maybe.andThen String.toInt |> Maybe.withDefault -1

                                    result =
                                        D.decodeValue Protocol.frameDecoder payload |> Result.mapError D.errorToString |> Result.andThen (\frame -> Protocol.apply conversation frame model.state)
                                in
                                case result of
                                    Err _ ->
                                        ( { model | connection = Broken "Protocol error; retry to resynchronize.", error = "Protocol error; retry to resynchronize." }, stream { path = "", epoch = model.epoch, pane = "" } )

                                    Ok state ->
                                        let
                                            opened =
                                                Dict.get model.path model.opened |> Maybe.withDefault Dict.empty

                                            defaults =
                                                Dict.foldl
                                                    (\key tool acc ->
                                                        if Dict.member key acc then
                                                            acc

                                                        else
                                                            Dict.insert key (tool.state == "failed") acc
                                                    )
                                                    opened
                                                    state.tools
                                        in
                                        ( { model | state = state, connection = Connected, opened = Dict.insert model.path defaults model.opened }, browser (E.object [ ( "kind", E.string "rendered" ), ( "epoch", E.int model.epoch ) ]) )

                            "restored" ->
                                let
                                    updated =
                                        { model | epoch = model.epoch + 1, connection = Connecting }
                                in
                                ( updated, connect updated )

                            "disconnected" ->
                                ( { model | connection = Disconnected }, Cmd.none )

                            "stream-failed" ->
                                ( { model | connection = Broken "Stream closed; retry to reconnect." }, Cmd.none )

                            "caret" ->
                                D.decodeValue D.int payload |> Result.map (\caret -> update (Caret caret) model) |> Result.withDefault ( model, Cmd.none )

                            "files" ->
                                case D.decodeValue (D.list File.decoder) payload of
                                    Ok (first :: rest) ->
                                        update (AddedFiles first rest) model

                                    _ ->
                                        ( model, Cmd.none )

                            "latest" ->
                                ( { model | latest = D.decodeValue D.bool payload |> Result.withDefault False }, Cmd.none )

                            "search" ->
                                update (Search "") model

                            "navigate" ->
                                case D.decodeValue D.string payload |> Result.toMaybe |> Maybe.andThen Url.fromString of
                                    Just url ->
                                        update (UrlRequested (Browser.Internal url)) model

                                    Nothing ->
                                        ( model, Cmd.none )

                            "sessions" ->
                                update OpenSessions model

                            "dismiss" ->
                                if model.pane /= Conversation then
                                    case Url.fromString ("http://localhost" ++ model.path) of
                                        Just url ->
                                            update (UrlRequested (Browser.Internal url)) model

                                        Nothing ->
                                            ( model, Cmd.none )

                                else
                                    update Dismiss model

                            _ ->
                                ( model, Cmd.none )

        Edit str ->
            changeDraft (\draft -> { draft | text = str }) model

        Send mode ->
            let
                str =
                    String.trim (draftFor model).text

                command =
                    String.words str |> List.head |> Maybe.withDefault ""

                argument =
                    String.dropLeft (String.length command) str |> String.trim
            in
            if model.composing then
                ( model, Cmd.none )

            else if (draftFor model).missingFiles && retryInput (draftFor model) == Nothing && not (waiting (draftFor model)) then
                ( { model | error = "Attachments are unavailable after reload. Reselect or remove them before submitting." }, Cmd.none )

            else if String.startsWith "/" str then
                case command of
                    "/search" ->
                        update (Search argument) model

                    "/sessions" ->
                        update OpenSessions model

                    "/new" ->
                        submit "new" "" mode True model

                    "/settings" ->
                        navigate (model.path ++ "/settings") { model | completions = Nothing }

                    "/model" ->
                        navigate (model.path ++ "/settings") { model | completions = Nothing }

                    "/fork" ->
                        navigate (model.path ++ "/branches") { model | completions = Nothing }

                    "/tree" ->
                        navigate (model.path ++ "/tree") { model | completions = Nothing }

                    "/export" ->
                        ( { model | completions = Nothing }, browser (E.object [ ( "kind", E.string "download" ), ( "url", E.string (model.path ++ "/export") ) ]) )

                    "/cd" ->
                        submit "cd" argument mode True model

                    "/rename" ->
                        submit "rename" argument mode True model

                    "/review" ->
                        submit "review" argument mode True model

                    "/endreview" ->
                        submit "endreview" "" mode True model

                    "/reset" ->
                        openConfirmation Reset argument model

                    "/compact" ->
                        openConfirmation Compact argument model

                    "/stop" ->
                        submit "abort" "" mode True model

                    "/resume" ->
                        submit "resume" "" mode True model

                    _ ->
                        ( { model | error = "Unsupported command: " ++ command }, Cmd.none )

            else if str == "" && List.isEmpty (draftFor model).files && retryInput (draftFor model) == Nothing then
                ( model, Cmd.none )

            else
                submit "submit" "" mode True model

        Command command argument ->
            submit command argument "reject" False model

        Response path pending result ->
            let
                ( updated, cmd ) =
                    update (Acknowledged path pending (Result.map (\( identity, revision, _ ) -> ( identity, revision )) result)) model

                next =
                    case result of
                        Ok ( identity, revision, destination ) ->
                            if identity == pending.identity && revision == pending.revision && path == model.path && (Maybe.map .identity (draftFor model).pending == Just pending.identity) then
                                destination

                            else
                                Nothing

                        _ ->
                            Nothing
            in
            ( updated, Cmd.batch [ cmd, Maybe.map (\destination -> Tuple.second (navigate destination updated)) next |> Maybe.withDefault Cmd.none ] )

        Acknowledged path pending result ->
            let
                draft =
                    Dict.get path model.drafts |> Maybe.withDefault emptyDraft

                valid =
                    result == Ok ( pending.identity, pending.revision )

                message =
                    case result of
                        Ok _ ->
                            "Mismatched acknowledgement"

                        Err error ->
                            httpError error

                updatedDraft =
                    if valid then
                        acknowledge pending draft

                    else if Maybe.map .identity draft.pending == Just pending.identity then
                        { draft | pending = Just { pending | status = Failed message } }

                    else
                        draft

                updated =
                    { model
                        | drafts = Dict.insert path updatedDraft model.drafts
                        , error =
                            if path == model.path then
                                ""

                            else
                                model.error
                        , confirmation =
                            if valid && path == model.path then
                                Nothing

                            else
                                model.confirmation
                    }
            in
            if Maybe.map .identity draft.pending /= Just pending.identity then
                ( model, Cmd.none )

            else
                ( updated, Cmd.batch [ storage updated, browser (E.object [ ( "kind", E.string "resize" ) ]) ] )

        Receipt path pending result ->
            case result of
                Ok True ->
                    update (Acknowledged path pending (Ok ( pending.identity, pending.revision ))) model

                _ ->
                    let
                        draft =
                            Dict.get path model.drafts |> Maybe.withDefault emptyDraft

                        reason =
                            case result of
                                Ok False ->
                                    "The original submission is not recorded yet. Attachments are unavailable after reload; reselect or remove them before submitting again."

                                _ ->
                                    "Could not check the original submission. Its outcome remains uncertain."
                    in
                    if Maybe.map .identity draft.pending /= Just pending.identity then
                        ( model, Cmd.none )

                    else
                        ( { model | drafts = Dict.insert path { draft | pending = Just { pending | status = Failed reason } } model.drafts }, Cmd.none )

        Retry ->
            case model.connection of
                Broken _ ->
                    let
                        updated =
                            { model | epoch = model.epoch + 1, connection = Connecting, error = "" }
                    in
                    ( updated, connect updated )

                _ ->
                    ( model, Cmd.none )

        PickFiles ->
            ( model, File.Select.files [] AddedFiles )

        AddedFiles first rest ->
            let
                files =
                    first :: rest

                current =
                    (draftFor model).files

                additions =
                    List.indexedMap (\index file -> { id = model.nonce ++ ".file." ++ String.fromInt (model.counter + 1) ++ "." ++ String.fromInt index, file = file, url = "" }) files

                ( updated, cmd ) =
                    changeDraft (\draft -> { draft | files = current ++ additions, missingFiles = False }) model
            in
            ( updated, Cmd.batch (cmd :: List.map (\attachment -> Task.perform (Preview model.path attachment.id) (Composer.preview attachment.file)) additions) )

        Preview path key url ->
            let
                draft =
                    Dict.get path model.drafts |> Maybe.withDefault emptyDraft
            in
            ( { model
                | drafts =
                    Dict.insert path
                        { draft
                            | files =
                                List.map
                                    (\attachment ->
                                        if attachment.id == key then
                                            { attachment | url = url }

                                        else
                                            attachment
                                    )
                                    draft.files
                        }
                        model.drafts
              }
            , Cmd.none
            )

        DiscardMissingFiles ->
            changeDraft (\draft -> { draft | missingFiles = False }) model

        RemoveFile key ->
            changeDraft (\draft -> { draft | files = List.filter (.id >> (/=) key) draft.files }) model

        Toggle key expanded ->
            let
                opened =
                    Dict.get model.path model.opened |> Maybe.withDefault Dict.empty

                updated =
                    Dict.insert model.path (Dict.insert key expanded opened) model.opened
            in
            ( { model | opened = updated }, browser (E.object [ ( "kind", E.string "opened" ), ( "value", E.dict identity (E.dict identity E.bool) updated ) ]) )

        Composition active ->
            ( { model | composing = active, completions = Nothing, completionRequest = model.completionRequest + 1 }, Cmd.none )

        Caret caret ->
            if model.composing then
                ( model, Cmd.none )

            else
                let
                    revision =
                        model.completionRequest + 1

                    url =
                        model.path ++ "/completions?text=" ++ Url.percentEncode (draftFor model).text ++ "&caret=" ++ String.fromInt caret

                    decoder =
                        D.map3 Completions (D.field "start" D.int) (D.field "end" D.int) (D.field "items" (D.list (D.map3 Completion (D.field "label" D.string) (D.field "value" D.string) (D.maybe (D.field "description" D.string)))))
                in
                ( { model | completionRequest = revision }, Http.get { url = url, expect = Http.expectJson (Completed revision model.path) decoder } )

        Completed revision path result ->
            if path /= model.path || revision /= model.completionRequest || model.composing then
                ( model, Cmd.none )

            else
                ( { model
                    | completions =
                        Result.toMaybe result
                            |> Maybe.andThen
                                (\items ->
                                    if List.isEmpty items.items then
                                        Nothing

                                    else
                                        Just items
                                )
                    , completionIndex = 0
                  }
                , Cmd.none
                )

        CompletionMove delta ->
            let
                count =
                    model.completions |> Maybe.map (.items >> List.length) |> Maybe.withDefault 0
            in
            ( { model
                | completionIndex =
                    if count == 0 then
                        0

                    else
                        modBy count (model.completionIndex + delta)
              }
            , Cmd.none
            )

        ChooseCompletion index ->
            case model.completions of
                Nothing ->
                    ( model, Cmd.none )

                Just completions ->
                    case List.drop index completions.items |> List.head of
                        Nothing ->
                            ( model, Cmd.none )

                        Just item ->
                            let
                                str =
                                    (draftFor model).text

                                ( updated, cmd ) =
                                    changeDraft (\draft -> { draft | text = String.left completions.start str ++ item.value ++ String.dropLeft completions.end str }) model
                            in
                            ( updated, Cmd.batch [ cmd, browser (E.object [ ( "kind", E.string "selection" ), ( "caret", E.int (completions.start + String.length item.value) ) ]) ] )

        Dismiss ->
            let
                updated =
                    { model | completions = Nothing, completionRequest = model.completionRequest + 1, search = Nothing, confirmation = Nothing }
            in
            ( updated, Cmd.batch [ browser (E.object [ ( "kind", E.string "cancel-completions" ) ]), browser (E.object [ ( "kind", E.string "resize" ) ]), highlight updated ] )

        Search query ->
            let
                updated =
                    { model | search = Just query, searchIndex = 0, completions = Nothing }
            in
            ( updated, Cmd.batch [ browser (E.object [ ( "kind", E.string "focus" ), ( "id", E.string "search" ) ]), highlight updated ] )

        SearchMove delta ->
            let
                matches =
                    searchMatches model

                index =
                    if List.isEmpty matches then
                        0

                    else
                        modBy (List.length matches) (model.searchIndex + delta)

                selected =
                    List.drop index matches |> List.head |> Maybe.withDefault 0
            in
            ( { model | searchIndex = index }, highlight { model | searchIndex = index } )

        OpenSessions ->
            ( model, Nav.load "/" )

        EditConfirmation str ->
            ( { model | confirmation = Maybe.map (\confirmation -> { confirmation | argument = str }) model.confirmation }, browser (E.object [ ( "kind", E.string "resize" ) ]) )

        ConfirmContext ->
            if model.composing then
                ( model, Cmd.none )

            else
                case model.confirmation of
                    Just confirmation ->
                        submit (contextCommand confirmation.action) confirmation.argument "reject" True model

                    Nothing ->
                        ( model, Cmd.none )

        SettingsLoaded epoch result ->
            if epoch /= model.epoch || model.pane /= Preferences then
                ( model, Cmd.none )

            else
                case result of
                    Ok settings ->
                        ( { model | settings = Just (Maybe.map (Autosave.load settings) model.settings |> Maybe.withDefault (Autosave.init settings)) }, Cmd.none )

                    Err error ->
                        ( { model | error = httpError error }, Cmd.none )

        EditSetting field str ->
            let
                updated =
                    { model | settings = Maybe.map (Autosave.edit (Panel.edit field str)) model.settings, error = "", directories = [], directoryRequest = model.directoryRequest + 1 }
            in
            if field == Panel.Directory then
                ( updated, Http.get { url = model.path ++ "/directories?target=" ++ Url.percentEncode (Maybe.map (Autosave.current >> .target) updated.settings |> Maybe.withDefault "") ++ "&directory=" ++ Url.percentEncode str, expect = Http.expectJson (Directories model.epoch updated.directoryRequest) (D.list D.string) } )

            else if List.member field [ Panel.Target, Panel.Model, Panel.Thinking ] then
                update SaveSettings updated

            else
                ( updated, Cmd.none )

        Directories epoch revision result ->
            if epoch /= model.epoch || revision /= model.directoryRequest then
                ( model, Cmd.none )

            else
                ( { model | directories = Result.withDefault [] result }, Cmd.none )

        SaveSettings ->
            case model.settings of
                Just settings ->
                    saveSettings (Autosave.start settings) model

                Nothing ->
                    ( model, Cmd.none )

        SettingsSaved epoch result ->
            if epoch /= model.epoch then
                ( model, Cmd.none )

            else
                case model.settings of
                    Nothing ->
                        ( model, Cmd.none )

                    Just settings ->
                        case result of
                            Ok True ->
                                let
                                    ( updated, command ) =
                                        saveSettings (Autosave.succeed settings) model
                                in
                                if Maybe.map Autosave.canLeave updated.settings == Just True then
                                    case updated.nextNavigation of
                                        Just destination ->
                                            update (UrlRequested destination) { updated | nextNavigation = Nothing }

                                        Nothing ->
                                            ( updated, command )

                                else
                                    ( updated, command )

                            _ ->
                                ( { model | settings = Just (Autosave.fail Autosave.ForgetBaseline settings), error = "Settings were not saved. Your changes are retained; retry saving." }, Cmd.none )

        Collapse ->
            ( { model | composerExpanded = not model.composerExpanded }, browser (E.object [ ( "kind", E.string "resize" ) ]) )

        Latest ->
            ( model, browser (E.object [ ( "kind", E.string "latest" ) ]) )

        NoOp ->
            ( model, Cmd.none )


searchMatches : Model -> List Int
searchMatches model =
    case model.search of
        Just query ->
            if String.trim query == "" then
                []

            else
                Dict.values model.state.entries |> List.filter (\entry -> String.contains (String.toLower (String.trim query)) (String.toLower (Transcript.entrySearch model.state.tools entry))) |> List.map .id

        Nothing ->
            []


deliveryModes : Protocol.DeliveryMode -> { primary : String, alternate : String }
deliveryModes mode =
    case mode of
        Protocol.Steering ->
            { primary = "steer", alternate = "followUp" }

        Protocol.FollowUp ->
            { primary = "followUp", alternate = "steer" }


keyDown : Model -> Html.Attribute Msg
keyDown model =
    let
        modes =
            deliveryModes model.state.metadata.defaultDeliveryMode
    in
    preventDefaultOn "keydown"
        (D.map5
            (\key ctrl meta alt composing ->
                if composing then
                    ( NoOp, False )

                else if key == "Escape" then
                    ( Dismiss, True )

                else if model.completions /= Nothing && not (key == "Enter" && (ctrl || meta || alt)) && List.member key [ "ArrowDown", "ArrowUp", "Enter", "Tab" ] then
                    ( if key == "ArrowDown" then
                        CompletionMove 1

                      else if key == "ArrowUp" then
                        CompletionMove -1

                      else
                        ChooseCompletion model.completionIndex
                    , True
                    )

                else if key == "Enter" && (ctrl || meta || alt) && model.confirmation /= Nothing then
                    ( ConfirmContext, True )

                else if key == "Enter" && (ctrl || meta || alt) then
                    ( Send
                        (if alt then
                            modes.alternate

                         else
                            modes.primary
                        )
                    , True
                    )

                else
                    ( NoOp, False )
            )
            (D.field "key" D.string)
            (D.field "ctrlKey" D.bool)
            (D.field "metaKey" D.bool)
            (D.field "altKey" D.bool)
            (D.field "isComposing" D.bool)
        )


view : Model -> Browser.Document Msg
view model =
    let
        state =
            model.state

        draft =
            draftFor model

        opened =
            let
                original =
                    Dict.get model.path model.opened |> Maybe.withDefault Dict.empty

                query =
                    Maybe.withDefault "" model.search |> String.trim |> String.toLower
            in
            if query == "" then
                original

            else
                Dict.foldl
                    (\key tool acc ->
                        if String.contains query (String.toLower (Transcript.entrySearch state.tools { id = 0, boundary = Protocol.Normal, messages = [ { role = "assistant", timestamp = 0, blocks = [ Protocol.ToolRef key ], error = "" } ] })) then
                            Dict.insert key True acc

                        else
                            acc
                    )
                    original
                    state.tools

        link path label =
            a [ href path ] [ text label ]

        dot =
            span [ class "footer-dot", attribute "aria-hidden" "true" ] []

        busy =
            state.live.busy

        disabled =
            waiting draft || (String.trim draft.text == "" && List.isEmpty draft.files && retryInput draft == Nothing)

        matches =
            searchMatches model

        active =
            List.drop model.searchIndex matches |> List.head

        connection =
            case model.connection of
                Connecting ->
                    "Connecting…"

                Connected ->
                    "Connected"

                Disconnected ->
                    "Disconnected; reconnecting…"

                Broken reason ->
                    reason

        errorMessage =
            if model.pane == Conversation && model.error /= "" then
                model.error

            else
                case draft.pending of
                    Just pending ->
                        case pending.status of
                            Failed reason ->
                                reason

                            Waiting ->
                                ""

                    Nothing ->
                        if draft.missingFiles then
                            "Attachments are unavailable after reload. Reselect or remove them before submitting."

                        else
                            ""

        iconButton name label action =
            button [ class "icon", A.type_ "button", attribute "aria-label" label, A.title label, onClick action ] [ Icon.view name ]

        message msg =
            Transcript.viewMessage state.metadata.hideImages model.path Toggle opened state.tools True msg

        live =
            section [ id "live", attribute "aria-label" "Live output" ]
                (List.indexedMap
                    (\index item ->
                        let
                            previous =
                                (List.take index state.live.messages |> List.reverse)
                                    ++ (Dict.values state.entries |> List.reverse |> List.concatMap (.messages >> List.reverse))
                                    |> List.head

                            speaker role =
                                if role == "toolResult" then
                                    "assistant"

                                else
                                    role

                            same =
                                Maybe.map (.role >> speaker) previous == Just (speaker item.role)
                        in
                        Html.article
                            [ attribute "data-role" item.role
                            , A.classList [ ( "same-speaker", same ) ]
                            , attribute "data-separator"
                                (if previous /= Nothing && not same then
                                    "true"

                                 else
                                    "false"
                                )
                            ]
                            (message item)
                    )
                    state.live.messages
                    ++ List.map (Transcript.blockView state.metadata.hideImages model.path Toggle opened state.tools << Protocol.ToolRef) state.live.tools
                    ++ List.map
                        (\item ->
                            let
                                key =
                                    "compaction-" ++ item.id

                                expanded =
                                    Dict.get key opened |> Maybe.withDefault False
                            in
                            Html.details [ id key, class "tool-call context-event", attribute "data-state" "running", A.property "open" (E.bool expanded) ]
                                [ Html.summary [ preventDefaultOn "click" (D.succeed ( Toggle key (not expanded), True )) ] [ Transcript.toolStatus "running", Transcript.commandLabel item.title ]
                                , p [ class "notice" ] [ text item.detail ]
                                ]
                        )
                        state.live.compactions
                    ++ List.map (\notice -> p [ class "notice" ] [ text notice ]) state.live.notices
                )

        queue =
            section [ id "queue", hidden (model.pane == Context), attribute "aria-label" "Queued messages" ]
                (if List.isEmpty state.queue then
                    []

                 else
                    [ div [ class "queued-messages" ]
                        (Html.h2 [] [ text "Queued messages" ]
                            :: List.map
                                (\item ->
                                    Html.article [ id ("queued-" ++ String.fromInt item.id), attribute "data-role" "user", attribute "data-mode" item.mode ]
                                        [ header []
                                            [ span [ class "speaker" ]
                                                [ text
                                                    (if item.mode == "followUp" then
                                                        "Follow up"

                                                     else if item.mode == "steer" then
                                                        "Steer"

                                                     else
                                                        "Write"
                                                    )
                                                ]
                                            , if item.mode == "write" then
                                                text ""

                                              else
                                                button [ class "icon", attribute "aria-label" "Cancel queued message", onClick (Command "cancel" (String.fromInt item.id)) ] [ text "×" ]
                                            ]
                                        , div [] (List.map (Transcript.blockView state.metadata.hideImages model.path Toggle opened state.tools) item.blocks)
                                        ]
                                )
                                state.queue
                        )
                    ]
                )

        composer =
            Composer.view
                { text = draft.text
                , edit = Edit
                , events = [ keyDown model, on "compositionstart" (D.succeed (Composition True)), on "compositionend" (D.succeed (Composition False)) ]
                , editingDisabled = False
                , attachments =
                    List.map (\attachment -> { name = File.name attachment.file, url = attachment.url, remove = RemoveFile attachment.id }) draft.files
                        ++ (if draft.missingFiles then
                                [ { name = "Unavailable attachments", url = "", remove = DiscardMissingFiles } ]

                            else
                                []
                           )
                , pickFiles = PickFiles
                , completions = Maybe.map (\completion -> { items = List.map (\item -> { label = item.label, description = item.description }) completion.items, selected = model.completionIndex, choose = ChooseCompletion }) model.completions
                , submission =
                    if busy then
                        Composer.Working { queue = Send "followUp", steer = Send "steer", stop = Command "abort" "", defaultSteering = state.metadata.defaultDeliveryMode == Protocol.Steering }

                    else
                        Composer.Ready (Send (deliveryModes state.metadata.defaultDeliveryMode).primary)
                , submitDisabled = disabled
                }

        confirmationComposer confirmation =
            let
                label =
                    if confirmation.action == Reset then
                        "reset"

                    else
                        "compaction"

                instructions =
                    if confirmation.action == Reset then
                        "and then"

                    else
                        "Compaction instructions"
            in
            form [ class "compose-box", onSubmit ConfirmContext ]
                [ textarea [ id "prompt", A.rows 2, A.placeholder (instructions ++ "…"), A.maxlength 100000, A.tabindex 1, attribute "aria-label" instructions, A.name "argument", value confirmation.argument, onInput EditConfirmation, keyDown model, on "compositionstart" (D.succeed (Composition True)), on "compositionend" (D.succeed (Composition False)) ] []
                , div [ class "actions" ] [ a [ class "icon", href model.path, attribute "aria-label" ("Cancel " ++ label), A.title ("Cancel " ++ label), preventDefaultOn "click" (D.succeed ( Dismiss, True )) ] [ Icon.view "close" ], span [ class "spacer" ] [], button [ id "send", class "icon", attribute "aria-label" ("Confirm " ++ label), A.disabled (waiting draft) ] [ Icon.view "check" ] ]
                ]

        metadata =
            section [ id "session-meta" ]
                [ Composer.metadata
                    { label = "Conversation statistics"
                    , before = [ a [ id "footer-sessions", class "icon footer-chevron", href "/", attribute "aria-label" "Sessions", A.title "Sessions" ] [ Icon.view "chevron-left" ] ]
                    , instance = span [ id "footer-instance" ] [ text state.metadata.instance ]
                    , statistics = [ a [ id "footer-stats", href (model.path ++ "/context"), attribute "aria-label" "Context" ] (List.map (\( name, str ) -> span [ id name ] [ text str ]) [ ( "footer-input", "↑" ++ state.metadata.input ), ( "footer-output", "↓" ++ state.metadata.output ), ( "footer-read", "R" ++ state.metadata.read ), ( "footer-hit", state.metadata.hit ), ( "footer-cost", "$" ++ state.metadata.cost ) ]) ]
                    , model = a [ id "footer-model", class "model-summary", href (model.path ++ "/settings"), attribute "aria-label" "Model and thinking settings" ] (Composer.modelDetails (text state.metadata.model) (text state.metadata.thinking))
                    , context = Just (a [ id "footer-context", class "context-usage", attribute "data-level" state.metadata.level, href (model.path ++ "/context"), attribute "aria-label" "Context usage details" ] [ text state.metadata.context ])
                    , after =
                        [ button
                            [ id "footer-collapse"
                            , class "icon footer-chevron"
                            , A.type_ "button"
                            , attribute "aria-controls" "composer-shell"
                            , attribute "aria-expanded"
                                (if model.composerExpanded then
                                    "true"

                                 else
                                    "false"
                                )
                            , attribute "aria-label"
                                (if model.composerExpanded then
                                    "Collapse composer"

                                 else
                                    "Expand composer"
                                )
                            , A.title
                                (if model.composerExpanded then
                                    "Collapse composer"

                                 else
                                    "Expand composer"
                                )
                            , onClick Collapse
                            ]
                            [ Icon.view "chevron-down" ]
                        ]
                    }
                ]

        panel =
            case model.pane of
                Preferences ->
                    section [ id "settings", class "pane", attribute "data-layout" "stacked", attribute "aria-label" "Session settings" ]
                        [ a [ id "close-view", class "icon", href model.path, attribute "aria-label" "Conversation", A.title "Return to conversation" ] [ Icon.view "close" ]
                        , div []
                            [ Maybe.map (\settings -> Panel.settingsView EditSetting SaveSettings (Autosave.busy settings) model.directories (Autosave.current settings)) model.settings |> Maybe.withDefault (text "")
                            , if model.error /= "" then
                                button [ onClick SaveSettings ] [ text "Retry saving settings" ]

                              else
                                text ""
                            ]
                        ]

                Context ->
                    Maybe.map Panel.contextView state.inspection |> Maybe.withDefault (text "")

                Tree ->
                    text ""

                Branches ->
                    text ""

                Conversation ->
                    text ""

        body =
            [ main_ [ id "main-area" ] [ div [ id "conversation-scroll", hidden (model.pane /= Conversation), class "scrollport pane", A.tabindex 0, attribute "aria-label" "Conversation" ] [ Html.Lazy.lazy8 viewTranscript state.metadata.hideImages model.path opened (Maybe.withDefault "" model.search) active state.entries state.tools state.metadata.durations, live ], panel ]
            , queue
            , footer [ id "app-footer", class "composer-area", hidden (model.pane == Context) ]
                [ button [ id "latest", A.type_ "button", hidden (not model.latest), onClick Latest ] [ text "↓ Latest" ]
                , Composer.shell
                    [ p [ id "composer-error", class "error", attribute "role" "alert" ]
                        [ text errorMessage
                        , case draft.pending of
                            Just pending ->
                                if pending.status == Failed errorMessage then
                                    Html.small [ id "composer-error-request-id" ] [ text ("RequestId: " ++ pending.identity) ]

                                else
                                    text ""

                            Nothing ->
                                text ""
                        ]
                    , Maybe.map confirmationComposer model.confirmation |> Maybe.withDefault composer
                    ]
                , metadata
                , p [ id "connection", class "sr-only", attribute "role" "status" ] [ text connection ]
                ]
            , div [ id "search-bar", hidden (model.search == Nothing) ]
                [ div [ class "compose-box" ]
                    [ input
                        [ id "search"
                        , A.type_ "search"
                        , attribute "aria-label" "Find in conversation"
                        , A.placeholder "Find in conversation…"
                        , value (Maybe.withDefault "" model.search)
                        , onInput Search
                        , on "keydown"
                            (D.field "key" D.string
                                |> D.map
                                    (\key ->
                                        if key == "Escape" then
                                            Dismiss

                                        else
                                            NoOp
                                    )
                            )
                        ]
                        []
                    , div [ class "actions" ]
                        [ Html.output [ id "search-count" ]
                            [ text
                                (if List.isEmpty matches then
                                    "0/0"

                                 else
                                    String.fromInt (model.searchIndex + 1) ++ "/" ++ String.fromInt (List.length matches)
                                )
                            ]
                        , span [ class "spacer" ] []
                        , button [ id "search-prev", class "icon", onClick (SearchMove -1), attribute "aria-label" "Previous match" ] [ text "↑" ]
                        , button [ id "search-next", class "icon", onClick (SearchMove 1), attribute "aria-label" "Next match" ] [ text "↓" ]
                        ]
                    ]
                ]
            ]

        exploring =
            model.pane == Tree || model.pane == Branches

        needsReconnect =
            case model.connection of
                Broken _ ->
                    True

                _ ->
                    False

        requestError =
            p [ id "request-error", attribute "role" "alert" ]
                [ text
                    (if model.pane == Conversation then
                        ""

                     else
                        model.error
                    )
                ]

        pageHeader =
            header [ id "app-header" ]
                [ div [ class "bar", hidden (model.pane == Preferences && not needsReconnect) ]
                    [ h1 []
                        [ if model.pane == Context then
                            span [ class "header-title" ] [ text "Context" ]

                          else
                            a [ id "conversation-title", class "header-title", href "/", preventDefaultOn "click" (D.succeed ( OpenSessions, True )) ]
                                [ text
                                    state.metadata.title
                                ]
                        , case model.connection of
                            Broken reason ->
                                button [ id "reconnect", A.type_ "button", A.title reason, onClick Retry ] [ text "Reconnect" ]

                            _ ->
                                text ""
                        ]
                    , if model.pane == Context then
                        a [ id "close-view", class "icon", href model.path, attribute "aria-label" "Conversation", A.title "Return to conversation" ] [ Icon.view "close" ]

                      else
                        a [ id "menu-toggle", class "icon", href "/settings", attribute "aria-label" "Global settings" ] [ Icon.view "settings" ]
                    ]
                , if model.pane == Conversation || exploring then
                    branchHeader model.path state.metadata.branches

                  else
                    text ""
                , if exploring then
                    text ""

                  else
                    requestError
                ]
    in
    { title =
        case model.pane of
            Preferences ->
                "Session settings"

            Context ->
                "Context"

            Branches ->
                "Conversation tree"

            Tree ->
                "Session tree"

            Conversation ->
                state.metadata.title
    , body =
        [ main_
            [ id "page"
            , A.classList [ ( "hide-thinking", state.metadata.hideThinking ), ( "hide-images", state.metadata.hideImages ) ]
            , attribute "data-view"
                (if model.pane == Conversation then
                    "conversation"

                 else
                    "panel"
                )
            ]
            (pageHeader
                :: (if exploring then
                        [ Html.node "pi-tree"
                            [ id "tree-explorer"
                            , attribute "value"
                                (E.encode 0
                                    (Maybe.withDefault
                                        (E.object
                                            [ ( "kind"
                                              , E.string
                                                    (if model.pane == Tree then
                                                        "entries"

                                                     else
                                                        "branches"
                                                    )
                                              )
                                            , ( "path", E.string model.path )
                                            , ( "nodes", E.list identity [] )
                                            ]
                                        )
                                        state.metadata.explorer
                                    )
                                )
                            ]
                            []
                        , requestError
                        ]

                    else
                        body
                   )
            )
        ]
    }


branchHeader : String -> List Panel.Branch -> Html Msg
branchHeader path branches =
    let
        current =
            List.filter (\branch -> branch.path == path) branches |> List.head
    in
    Html.details [ id "branch-disclosure", class "branch-disclosure" ]
        [ Html.summary [ attribute "aria-label" "Conversation branches" ]
            [ Icon.view "fork"
            , span [] [ text (Maybe.map (.title >> String.toLower) current |> Maybe.withDefault "branches") ]
            , span [ class "branch-chevron", attribute "aria-hidden" "true" ] [ text "›" ]
            ]
        , branchPanel path branches
        ]


branchPanel : String -> List Panel.Branch -> Html Msg
branchPanel path branches =
    let
        rows parent =
            branches
                |> List.filter (\branch -> branch.parent == parent)
                |> List.map
                    (\branch ->
                        let
                            children =
                                rows (Just branch.id)
                        in
                        Html.li [ id ("branch-" ++ String.fromInt branch.id) ]
                            [ div [ class "branch-row" ]
                                [ a
                                    [ href branch.path
                                    , attribute "aria-current"
                                        (if branch.path == path then
                                            "true"

                                         else
                                            "false"
                                        )
                                    ]
                                    [ span [ class "branch-name" ] [ text branch.title ]
                                    , Transcript.toolStatus branch.state
                                    , case branch.activity of
                                        Just timestamp ->
                                            Html.node "elm-time" [ class "branch-time", attribute "aria-label" "Most recent activity", attribute "timestamp" (String.fromFloat timestamp) ] []

                                        Nothing ->
                                            span [ class "branch-time", attribute "aria-label" "No activity yet" ] [ text "—" ]
                                    ]
                                ]
                            , if List.isEmpty children then
                                text ""

                              else
                                Html.ul [] children
                            ]
                    )
    in
    Html.nav [ class "branch-panel", attribute "aria-label" "Conversation branches" ]
        [ Html.ul [ id "branch-tree" ] (rows Nothing) ]


viewTranscript : Bool -> String -> Dict String Bool -> String -> Maybe Int -> Dict Int Protocol.Entry -> Dict String Protocol.Tool -> Dict String Int -> Html Msg
viewTranscript hideImages path =
    Transcript.transcript hideImages path Toggle


highlight : Model -> Cmd Msg
highlight model =
    let
        matches =
            searchMatches model
    in
    browser (E.object [ ( "kind", E.string "highlight" ), ( "query", E.string (Maybe.withDefault "" model.search |> String.trim |> String.toLower) ), ( "entries", E.list E.int matches ), ( "current", List.drop model.searchIndex matches |> List.head |> Maybe.map E.int |> Maybe.withDefault E.null ) ])
