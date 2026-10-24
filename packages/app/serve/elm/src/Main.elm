port module Main exposing (Draft, Model, Msg(..), acknowledge, draftDecoder, initModel, main, update)

import Browser
import Browser.Navigation as Nav
import Dict exposing (Dict)
import File exposing (File)
import File.Select
import Html exposing (Html, a, button, div, footer, form, h1, header, input, main_, p, section, span, text, textarea)
import Html.Attributes as A exposing (attribute, class, hidden, href, id, value)
import Html.Events exposing (on, onClick, onInput, onSubmit, preventDefaultOn)
import Html.Lazy
import Http
import Json.Decode as D
import Json.Encode as E
import Panel
import Protocol exposing (State)
import Task
import Transcript
import Url exposing (Url)


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
    { label : String, value : String }


type alias Completions =
    { start : Int, end : Int, items : List Completion }


type Pane
    = Conversation
    | Preferences
    | Context
    | Branches


route : String -> ( String, Pane )
route path =
    let
        parts =
            String.split "/" path

        pane =
            case List.drop 6 parts |> List.head of
                Just "settings" ->
                    Preferences

                Just "context" ->
                    Context

                Just "branches" ->
                    Branches

                _ ->
                    Conversation
    in
    ( String.join "/" (List.take 6 parts), pane )


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

                Conversation ->
                    ""
        }


loadPanel : Model -> Cmd Msg
loadPanel model =
    case model.pane of
        Preferences ->
            Http.get { url = model.path ++ "/panel?view=settings", expect = Http.expectJson (SettingsLoaded model.epoch) Panel.settingsDecoder }

        Branches ->
            Http.get { url = model.path ++ "/panel?view=branches", expect = Http.expectJson (BranchesLoaded model.epoch) Panel.branchesDecoder }

        _ ->
            Cmd.none


navigate : String -> Model -> ( Model, Cmd Msg )
navigate path model =
    ( model, Maybe.map (\key -> Nav.pushUrl key path) model.key |> Maybe.withDefault Cmd.none )


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
    , catalog : Maybe (List ( String, String ))
    , reset : Maybe String
    , pane : Pane
    , settings : Maybe Panel.Settings
    , savedSettings : Maybe Panel.Settings
    , saving : Maybe Panel.Settings
    , nextNavigation : Maybe Browser.UrlRequest
    , directories : List String
    , directoryRequest : Int
    , branches : List Panel.Branch
    , composerExpanded : Bool
    , image : Maybe String
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
    | DismissPending
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
    | Catalog Int (Result Http.Error (List ( String, String )))
    | ResetArgument String
    | ConfirmReset
    | Response String Pending (Result Http.Error ( String, String, Maybe String ))
    | SettingsLoaded Int (Result Http.Error Panel.Settings)
    | EditSetting Panel.Field String
    | SaveSettings
    | SettingsSaved Int Panel.Settings (Result Http.Error Bool)
    | Directories Int Int (Result Http.Error (List String))
    | BranchesLoaded Int (Result Http.Error (List Panel.Branch))
    | CloseImage
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
    , catalog = Nothing
    , reset = Nothing
    , pane = Tuple.second (route path)
    , settings = Nothing
    , savedSettings = Nothing
    , saving = Nothing
    , nextNavigation = Nothing
    , directories = []
    , directoryRequest = 0
    , branches = []
    , composerExpanded = True
    , image = Nothing
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
                        { base | key = Just key, drafts = drafts }
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
            putDraft { draft | revision = model.nonce ++ "." ++ String.fromInt (model.counter + 1) } { model | counter = model.counter + 1, error = "", completions = Nothing, completionRequest = model.completionRequest + 1 }
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
                Http.multipartBody (List.map (\( k, v ) -> Http.stringPart k v) fields ++ List.map (\attachment -> Http.filePart "images" attachment.file) pending.files)

            else
                Http.jsonBody (E.object (List.map (\( k, v ) -> ( k, E.string v )) fields))
    in
    Http.post { url = path ++ "/command", body = body, expect = Http.expectJson (Response path pending) (D.map3 (\identity revision next -> ( identity, revision, next )) (D.field "requestId" D.string) (D.field "revision" D.string) (Protocol.optional "path" D.string)) }


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
    if draft.pending /= Nothing then
        ( model, Cmd.none )

    else
        ( updated, Cmd.batch [ storage updated, request model.path pending ] )


httpError : Http.Error -> String
httpError error =
    case error of
        Http.BadStatus status ->
            "Request failed (HTTP " ++ String.fromInt status ++ "). Your draft is retained."

        Http.BadBody _ ->
            "Invalid server response. Your draft is retained."

        _ ->
            "Request acknowledgement unavailable. Your draft is retained."


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        UrlRequested requestUrl ->
            if model.pane == Preferences && (model.saving /= Nothing || model.settings /= model.savedSettings) then
                update SaveSettings { model | nextNavigation = Just requestUrl }

            else
                case requestUrl of
                    Browser.Internal url ->
                        if url.path == "/elm/catalog" then
                            update OpenSessions model

                        else if String.endsWith "/export" url.path then
                            ( model, browser (E.object [ ( "kind", E.string "download" ), ( "url", E.string url.path ) ]) )

                        else if String.startsWith "/elm/sessions/" url.path then
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
                                model.state

                            else
                                Protocol.empty
                        , connection = Connecting
                        , error = ""
                        , catalog = Nothing
                        , search = Nothing
                        , reset = Nothing
                        , composing = False
                        , completions = Nothing
                        , completionRequest = model.completionRequest + 1
                        , settings = Nothing
                        , savedSettings = Nothing
                        , saving = Nothing
                        , nextNavigation = Nothing
                        , directories = []
                        , directoryRequest = model.directoryRequest + 1
                        , image = Nothing
                        , branches = []
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

                            "image" ->
                                case D.decodeValue D.string payload of
                                    Ok src ->
                                        ( { model | image = Just src }, browser (E.object [ ( "kind", E.string "dialog" ), ( "id", E.string "image-dialog" ) ]) )

                                    Err _ ->
                                        ( model, Cmd.none )

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

            else if (draftFor model).missingFiles then
                ( { model | error = "Reselect or discard the missing attachments before submitting." }, Cmd.none )

            else if String.startsWith "/" str then
                case command of
                    "/search" ->
                        update (Search argument) model

                    "/sessions" ->
                        update OpenSessions model

                    "/settings" ->
                        navigate (model.path ++ "/settings") { model | completions = Nothing }

                    "/model" ->
                        navigate (model.path ++ "/settings") { model | completions = Nothing }

                    "/fork" ->
                        navigate (model.path ++ "/branches") { model | completions = Nothing }

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
                        ( { model | reset = Just argument, completions = Nothing }, browser (E.object [ ( "kind", E.string "resize" ) ]) )

                    "/compact" ->
                        submit "compact" argument mode True model

                    "/stop" ->
                        submit "abort" "" mode True model

                    "/resume" ->
                        submit "resume" "" mode True model

                    _ ->
                        ( { model | error = "Unsupported command: " ++ command }, Cmd.none )

            else if str == "" && List.isEmpty (draftFor model).files then
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
                                if valid then
                                    ""

                                else
                                    message

                            else
                                model.error
                        , reset =
                            if valid && path == model.path then
                                Nothing

                            else
                                model.reset
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
                                    "The original submission is not recorded yet. Its images are unavailable after reload; do not resend it as text. Check again, or explicitly dismiss the uncertainty before composing a new input."

                                _ ->
                                    "Could not check the original submission. Its outcome remains uncertain."
                    in
                    if Maybe.map .identity draft.pending /= Just pending.identity then
                        ( model, Cmd.none )

                    else
                        ( { model | drafts = Dict.insert path { draft | pending = Just { pending | status = Failed reason } } model.drafts }, Cmd.none )

        DismissPending ->
            let
                draft =
                    draftFor model

                updated =
                    putDraft { draft | pending = Nothing } { model | error = "" }
            in
            ( updated, storage updated )

        Retry ->
            case model.connection of
                Broken _ ->
                    let
                        updated =
                            { model | epoch = model.epoch + 1, connection = Connecting, error = "" }
                    in
                    ( updated, connect updated )

                _ ->
                    case (draftFor model).pending of
                        Nothing ->
                            ( model, Cmd.none )

                        Just pending ->
                            if pending.command /= "submit" then
                                ( { model | error = "This command is not retry-safe. Inspect current state before submitting a new command." }, Cmd.none )

                            else
                                let
                                    draft =
                                        draftFor model

                                    updated =
                                        putDraft { draft | pending = Just { pending | status = Waiting } } model
                                in
                                ( updated
                                , if pending.missingFiles then
                                    Http.get { url = model.path ++ "/receipt?requestId=" ++ Url.percentEncode pending.identity, expect = Http.expectJson (Receipt model.path pending) (D.field "accepted" D.bool) }

                                  else
                                    request model.path pending
                                )

        PickFiles ->
            ( model, File.Select.files [ "image/png", "image/jpeg", "image/gif", "image/webp" ] AddedFiles )

        AddedFiles first rest ->
            let
                files =
                    first :: rest

                current =
                    (draftFor model).files

                allowed file =
                    List.member (File.mime file) [ "image/png", "image/jpeg", "image/gif", "image/webp" ]
            in
            if List.length files + List.length current > 4 || List.sum (List.map File.size files ++ List.map (.file >> File.size) current) > 5 * 1024 * 1024 || not (List.all allowed files) then
                ( { model | error = "Attach up to four PNG, JPEG, GIF or WebP images, totaling at most 5 MiB." }, Cmd.none )

            else
                let
                    additions =
                        List.indexedMap (\index file -> { id = model.nonce ++ ".file." ++ String.fromInt (model.counter + 1) ++ "." ++ String.fromInt index, file = file, url = "" }) files

                    ( updated, cmd ) =
                        changeDraft (\draft -> { draft | files = draft.files ++ additions, missingFiles = False }) model
                in
                ( updated, Cmd.batch (cmd :: List.map (\attachment -> Task.perform (Preview model.path attachment.id) (File.toUrl attachment.file)) additions) )

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
            in
            ( { model | opened = Dict.insert model.path (Dict.insert key expanded opened) model.opened }, Cmd.none )

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
                        D.map3 Completions (D.field "start" D.int) (D.field "end" D.int) (D.field "items" (D.list (D.map2 Completion (D.field "label" D.string) (D.field "value" D.string))))
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
                    { model | completions = Nothing, completionRequest = model.completionRequest + 1, search = Nothing, catalog = Nothing, reset = Nothing }
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
            ( { model | catalog = Just [] }, Http.get { url = "/elm/catalog", expect = Http.expectJson (Catalog model.epoch) (D.list (D.map2 Tuple.pair (D.field "path" D.string) (D.field "title" D.string))) } )

        Catalog epoch result ->
            if epoch /= model.epoch || model.catalog == Nothing then
                ( model, Cmd.none )

            else
                ( { model | catalog = Just (Result.withDefault [] result) }, Cmd.none )

        ResetArgument str ->
            ( { model | reset = Just str }, browser (E.object [ ( "kind", E.string "resize" ) ]) )

        ConfirmReset ->
            if model.composing then
                ( model, Cmd.none )

            else
                submit "reset" (Maybe.withDefault "" model.reset) "reject" True model

        SettingsLoaded epoch result ->
            if epoch /= model.epoch || model.pane /= Preferences then
                ( model, Cmd.none )

            else
                case result of
                    Ok settings ->
                        ( { model | settings = Just settings, savedSettings = Just settings }, Cmd.none )

                    Err error ->
                        ( { model | error = httpError error }, Cmd.none )

        EditSetting field str ->
            let
                updated =
                    { model | settings = Maybe.map (Panel.edit field str) model.settings, error = "", directories = [], directoryRequest = model.directoryRequest + 1 }
            in
            if field == Panel.Directory then
                ( updated, Http.get { url = model.path ++ "/directories?target=" ++ Url.percentEncode (Maybe.map .target updated.settings |> Maybe.withDefault "") ++ "&directory=" ++ Url.percentEncode str, expect = Http.expectJson (Directories model.epoch updated.directoryRequest) (D.list D.string) } )

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
                    if model.saving /= Nothing || model.savedSettings == Just settings then
                        ( model, Cmd.none )

                    else
                        ( { model | saving = Just settings, error = "" }, Http.post { url = model.path ++ "/settings", body = Panel.settingsBody settings, expect = Http.expectJson (SettingsSaved model.epoch settings) (D.field "saved" D.bool) } )

                Nothing ->
                    ( model, Cmd.none )

        SettingsSaved epoch settings result ->
            if epoch /= model.epoch then
                ( model, Cmd.none )

            else
                case result of
                    Ok True ->
                        let
                            updated =
                                { model | saving = Nothing, savedSettings = Just settings }
                        in
                        if updated.settings /= updated.savedSettings then
                            update SaveSettings updated

                        else
                            case updated.nextNavigation of
                                Just destination ->
                                    update (UrlRequested destination) { updated | nextNavigation = Nothing }

                                Nothing ->
                                    ( updated, Cmd.none )

                    _ ->
                        ( { model | saving = Nothing, error = "Settings were not saved. Your changes are retained; retry saving.", savedSettings = Nothing }, Cmd.none )

        BranchesLoaded epoch result ->
            if epoch /= model.epoch || model.pane /= Branches then
                ( model, Cmd.none )

            else
                case result of
                    Ok branches ->
                        ( { model | branches = branches }, Cmd.none )

                    Err error ->
                        ( { model | error = httpError error }, Cmd.none )

        CloseImage ->
            ( { model | image = Nothing }, Cmd.none )

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


keyDown : Model -> Html.Attribute Msg
keyDown model =
    preventDefaultOn "keydown"
        (D.map4
            (\key ctrl meta composing ->
                if composing then
                    ( NoOp, False )

                else if key == "Escape" then
                    ( Dismiss, True )

                else if model.completions /= Nothing && List.member key [ "ArrowDown", "ArrowUp", "Enter", "Tab" ] then
                    ( if key == "ArrowDown" then
                        CompletionMove 1

                      else if key == "ArrowUp" then
                        CompletionMove -1

                      else
                        ChooseCompletion model.completionIndex
                    , True
                    )

                else if key == "Enter" && (ctrl || meta) && model.reset /= Nothing then
                    ( ConfirmReset, True )

                else if key == "Enter" && (ctrl || meta) then
                    ( Send
                        (if model.state.live.busy then
                            "followUp"

                         else
                            "reject"
                        )
                    , True
                    )

                else
                    ( NoOp, False )
            )
            (D.field "key" D.string)
            (D.field "ctrlKey" D.bool)
            (D.field "metaKey" D.bool)
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
            draft.pending /= Nothing || (String.trim draft.text == "" && List.isEmpty draft.files)

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

        pendingError =
            draft.pending
                |> Maybe.map
                    (\pending ->
                        case pending.status of
                            Failed reason ->
                                p [ class "error" ]
                                    [ text reason
                                    , if pending.command == "submit" then
                                        span []
                                            [ button [ onClick Retry ]
                                                [ text
                                                    (if pending.missingFiles then
                                                        "Check original submission"

                                                     else
                                                        "Retry original input"
                                                    )
                                                ]
                                            , if pending.missingFiles then
                                                button [ onClick DismissPending ] [ text "Keep draft; dismiss uncertain command" ]

                                              else
                                                text ""
                                            ]

                                      else
                                        button [ onClick DismissPending ] [ text "Keep draft; dismiss uncertain command" ]
                                    ]

                            Waiting ->
                                text ""
                    )
                |> Maybe.withDefault (text "")

        iconButton name label action =
            button [ class "icon", A.type_ "button", attribute "aria-label" label, A.title label, onClick action ] [ Transcript.icon name ]

        message msg =
            Transcript.viewMessage Toggle opened state.tools True msg

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
                    ++ List.map (Transcript.blockView Toggle opened state.tools << Protocol.ToolRef) state.live.tools
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
                                        , div [] (List.map (Transcript.blockView Toggle opened state.tools) item.blocks)
                                        ]
                                )
                                state.queue
                        )
                    ]
                )

        completions =
            div [ id "completions", attribute "role" "listbox", hidden (model.completions == Nothing) ]
                (model.completions
                    |> Maybe.map
                        (.items
                            >> List.indexedMap
                                (\index item ->
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
                                        [ text item.label ]
                                )
                        )
                    |> Maybe.withDefault []
                )

        prompt =
            textarea [ id "prompt", A.name "content", A.rows 2, A.maxlength 100000, A.tabindex 1, A.placeholder "Ask Pi…", attribute "aria-label" "Message", attribute "aria-autocomplete" "list", attribute "aria-controls" "completions", value draft.text, onInput Edit, keyDown model, on "compositionstart" (D.succeed (Composition True)), on "compositionend" (D.succeed (Composition False)) ] []

        composer =
            div [ class "compose-box" ]
                [ form
                    [ id "composer"
                    , onSubmit
                        (Send
                            (if busy then
                                "followUp"

                             else
                                "reject"
                            )
                        )
                    ]
                    [ prompt
                    , completions
                    , div [ id "previews", attribute "aria-label" "Attached images" ] (List.map (\attachment -> button [ A.type_ "button", attribute "aria-label" "Remove attachment", onClick (RemoveFile attachment.id) ] [ Html.img [ A.src attachment.url, A.alt (File.name attachment.file) ] [] ]) draft.files)
                    ]
                , div
                    [ id "controls"
                    , class "actions"
                    , attribute "data-state"
                        (if busy then
                            "working"

                         else
                            "ready"
                        )
                    ]
                    [ button [ id "input-toggle", class "icon enhanced-only", A.type_ "button", attribute "aria-label" "Upload attachments", onClick PickFiles ] [ text "+" ]
                    , span [ class "spacer" ] []
                    , if busy then
                        button [ class "submission-mode", A.type_ "button", A.disabled disabled, onClick (Send "steer") ] [ text "Steer" ]

                      else
                        text ""
                    , if busy then
                        button [ id "stop", class "icon", A.type_ "button", attribute "aria-label" "Stop", onClick (Command "abort" "") ] [ Transcript.icon "close" ]

                      else
                        text ""
                    , button
                        [ id "send"
                        , class "icon"
                        , A.type_ "button"
                        , A.disabled disabled
                        , attribute "aria-label"
                            (if busy then
                                "Queue"

                             else
                                "Send"
                            )
                        , onClick
                            (Send
                                (if busy then
                                    "followUp"

                                 else
                                    "reject"
                                )
                            )
                        ]
                        [ Transcript.icon "send" ]
                    ]
                ]

        resetComposer argument =
            form [ class "compose-box", onSubmit ConfirmReset ]
                [ textarea [ id "prompt", A.rows 2, A.placeholder "Handoff instructions…", A.maxlength 100000, A.tabindex 1, attribute "aria-label" "Handoff instructions", value argument, onInput ResetArgument, keyDown model, on "compositionstart" (D.succeed (Composition True)), on "compositionend" (D.succeed (Composition False)) ] []
                , div [ class "actions" ] [ a [ class "icon", href model.path, attribute "aria-label" "Cancel reset", A.title "Cancel reset", preventDefaultOn "click" (D.succeed ( Dismiss, True )) ] [ Transcript.icon "close" ], span [ class "spacer" ] [], button [ id "send", class "icon", attribute "aria-label" "Confirm reset", A.disabled (draft.pending /= Nothing) ] [ Transcript.icon "check" ] ]
                ]

        metadata =
            section [ id "session-meta" ]
                [ div [ id "bottom-line", attribute "aria-label" "Conversation statistics" ]
                    [ div [ class "footer-row" ]
                        [ a [ id "footer-sessions", class "icon footer-chevron", href "/elm/catalog", attribute "aria-label" "Sessions", A.title "Sessions" ] [ Transcript.icon "chevron-left" ]
                        , span [ id "footer-instance" ] [ text state.metadata.instance ]
                        , a [ id "footer-stats", href (model.path ++ "/context"), attribute "aria-label" "Context" ] (List.map (\( name, str ) -> span [ id name ] [ text str ]) [ ( "footer-input", "↑" ++ state.metadata.input ), ( "footer-output", "↓" ++ state.metadata.output ), ( "footer-read", "R" ++ state.metadata.read ), ( "footer-hit", state.metadata.hit ), ( "footer-cost", "$" ++ state.metadata.cost ) ])
                        , div [ class "footer-model-context" ]
                            [ a [ id "footer-model", class "model-summary", href (model.path ++ "/settings"), attribute "aria-label" "Model and thinking settings" ] [ span [ class "model-name" ] [ text state.metadata.model ], dot, span [ class "model-effort" ] [ text state.metadata.thinking ] ]
                            , dot
                            , a [ id "footer-context", class "context-usage", attribute "data-level" state.metadata.level, href (model.path ++ "/context"), attribute "aria-label" "Context usage details" ] [ text state.metadata.context ]
                            ]
                        , button
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
                            [ Transcript.icon "chevron-down" ]
                        ]
                    ]
                ]

        panel =
            case model.pane of
                Preferences ->
                    section [ id "preferences", class "pane", attribute "aria-label" "Session settings" ]
                        [ a [ id "close-view", class "icon", href model.path, attribute "aria-label" "Conversation", A.title "Return to conversation" ] [ Transcript.icon "close" ]
                        , div []
                            [ Maybe.map (Panel.settingsView EditSetting SaveSettings model.directories) model.settings |> Maybe.withDefault (p [ attribute "role" "status" ] [ text "Loading settings…" ])
                            , if model.error /= "" then
                                button [ onClick SaveSettings ] [ text "Retry saving settings" ]

                              else
                                text ""
                            ]
                        ]

                Context ->
                    Maybe.map Panel.contextView state.inspection |> Maybe.withDefault (section [ id "context-view", class "pane" ] [ text "Loading context…" ])

                Branches ->
                    section [ id "branch-picker", class "pane" ]
                        [ div [ id "branches" ]
                            (List.map
                                (\item ->
                                    a
                                        [ class "session"
                                        , href item.path
                                        , attribute "aria-current"
                                            (if item.path == model.path then
                                                "true"

                                             else
                                                "false"
                                            )
                                        ]
                                        [ Html.strong [] [ text item.title ], Maybe.map (\parent -> Html.small [] [ text ("From " ++ String.fromInt parent) ]) item.parent |> Maybe.withDefault (text "") ]
                                )
                                model.branches
                            )
                        ]

                Conversation ->
                    text ""

        body =
            case model.catalog of
                Just items ->
                    [ section [ class "pane", id "session-list" ] (List.map (\( path, title ) -> a [ class "session", href path ] [ span [ class "session-heading" ] [ Html.strong [] [ text title ] ] ]) items) ]

                Nothing ->
                    [ main_ [ id "main-area" ] [ div [ id "conversation-scroll", hidden (model.pane /= Conversation), class "scrollport pane", A.tabindex 0, attribute "aria-label" "Conversation" ] [ Html.Lazy.lazy6 viewTranscript opened (Maybe.withDefault "" model.search) active state.entries state.tools state.metadata.durations, live ], panel ]
                    , queue
                    , footer [ id "app-footer", class "composer-area", hidden (model.pane == Context) ]
                        [ button [ id "latest", A.type_ "button", hidden (not model.latest), onClick Latest ] [ text "↓ Latest" ]
                        , div [ id "composer-shell", class "composer-shell" ]
                            [ Maybe.map resetComposer model.reset |> Maybe.withDefault composer
                            , pendingError
                            , if draft.missingFiles then
                                p [ class "notice" ] [ text "Images cannot be restored after reload. Check history before resubmitting an uncertain image request. Reselect images or ", button [ onClick DiscardMissingFiles ] [ text "Discard missing attachments" ] ]

                              else
                                text ""
                            ]
                        , metadata
                        , if state.metadata.resume then
                            button [ onClick (Command "resume" "") ] [ text "Resume interrupted execution" ]

                          else
                            text ""
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
    in
    { title =
        if model.catalog /= Nothing then
            "Sessions"

        else
            case model.pane of
                Preferences ->
                    "Session settings"

                Context ->
                    "Context"

                Branches ->
                    "Branches"

                Conversation ->
                    state.metadata.title
    , body =
        [ main_
            [ id "page"
            , attribute "data-view"
                (if model.pane == Conversation then
                    "conversation"

                 else
                    "panel"
                )
            ]
            (header [ id "app-header" ]
                [ div [ class "bar", hidden (model.pane == Preferences) ]
                    [ h1 []
                        [ if model.pane == Context || model.pane == Branches then
                            span [ class "header-title" ]
                                [ text
                                    (if model.pane == Context then
                                        "Context"

                                     else
                                        "Branches"
                                    )
                                ]

                          else
                            a [ id "conversation-title", class "header-title", href "/elm/catalog", preventDefaultOn "click" (D.succeed ( OpenSessions, True )) ]
                                [ text
                                    (if model.catalog /= Nothing then
                                        "Sessions"

                                     else
                                        state.metadata.title
                                    )
                                ]
                        ]
                    , if model.pane == Context || model.pane == Branches then
                        a [ id "close-view", class "icon", href model.path, attribute "aria-label" "Conversation", A.title "Return to conversation" ] [ Transcript.icon "close" ]

                      else if model.catalog /= Nothing then
                        iconButton "close" "Conversation" Dismiss

                      else
                        a [ id "menu-toggle", class "icon", href "/sessions/settings", attribute "aria-label" "Global settings" ] [ Transcript.icon "settings" ]
                    ]
                , p [ id "request-error", attribute "role" "alert" ]
                    [ text model.error
                    , case model.connection of
                        Broken _ ->
                            button [ onClick Retry ] [ text "Reconnect" ]

                        _ ->
                            text ""
                    ]
                ]
                :: (body ++ [ Maybe.map (\src -> Html.node "dialog" [ id "image-dialog", preventDefaultOn "cancel" (D.succeed ( CloseImage, True )) ] [ Html.img [ A.src src, A.alt "Attachment" ] [], button [ onClick CloseImage ] [ text "Close image" ] ]) model.image |> Maybe.withDefault (text "") ])
            )
        ]
    }


viewTranscript : Dict String Bool -> String -> Maybe Int -> Dict Int Protocol.Entry -> Dict String Protocol.Tool -> Dict String Int -> Html Msg
viewTranscript =
    Transcript.transcript Toggle


highlight : Model -> Cmd Msg
highlight model =
    let
        matches =
            searchMatches model
    in
    browser (E.object [ ( "kind", E.string "highlight" ), ( "query", E.string (Maybe.withDefault "" model.search |> String.trim |> String.toLower) ), ( "entries", E.list E.int matches ), ( "current", List.drop model.searchIndex matches |> List.head |> Maybe.map E.int |> Maybe.withDefault E.null ) ])
