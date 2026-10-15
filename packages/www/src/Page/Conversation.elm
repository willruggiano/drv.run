port module Page.Conversation exposing (Model, Msg, Outcome(..), applyUrl, configurationDirty, created, discard, documentVisibility, events, init, leave, subscriptions, update, view)

import Api
import Api.Actions as Actions
import Api.Conversation as Query exposing (Branch, BranchPage, Info, Overview, Preferences)
import Api.Enum.HarnessAbortSubmissionResult as WithdrawalResult
import Api.Enum.InputSubmissionDraftWhenBusy as Delivery exposing (InputSubmissionDraftWhenBusy)
import Api.Enum.ModelThinkingLevel as Thinking
import Api.InputObject as Input
import Api.Mutation as Mutation
import Api.Object.AbortSubmissionPayload as Withdrawal
import Api.Scalars as Scalars
import Attachment exposing (Attachment, AttachmentContent, AttachmentId(..), AttachmentState(..))
import Browser
import Browser.Dom as Dom
import Browser.Events
import Composer
import Configuration
import Conversation as Data
import Dict exposing (Dict)
import File exposing (File)
import File.Select
import Graphql.Operation
import Graphql.OptionalArgument exposing (OptionalArgument(..))
import Graphql.SelectionSet
import Html exposing (Html, a, button, div, footer, form, h1, header, input, main_, p, section, span, text, textarea)
import Html.Attributes as A exposing (attribute, class, hidden, href, id)
import Html.Events as Events exposing (onClick, onInput, onSubmit)
import Html.Lazy
import Icon
import Json.Decode as D
import Json.Encode as E
import Read exposing (Read(..))
import Route
import Syntax
import Task
import Transcript
import Transcript.Model as Display
import Url exposing (Url)
import Url.Builder
import Url.Parser as Parser
import Url.Parser.Query as QueryString
import Watch


port conversationBrowser : E.Value -> Cmd msg


port conversationEvents : (D.Value -> msg) -> Sub msg


documentVisibility : Bool -> Msg
documentVisibility =
    DocumentVisibility



-- An opaque native resource, never inspected or serialized in Elm.


type WatchHandle
    = WatchHandle D.Value


type BrowserEvent
    = WatchOpened WatchHandle
    | WatchMessage String
    | WatchConnection Int
    | ImageReady Int (Maybe String)
    | SyntaxReady D.Value
    | SyntaxFailed


type alias BrowserReply =
    { epoch : Int, attempt : Int, event : BrowserEvent }


type Connection
    = Connecting
    | Current
    | Stale
    | Broken String


type Outcome
    = Stay
    | Navigate String
    | RootResolved String


type alias Model =
    { seed : String
    , revision : Int
    , nextRequest : Int
    , submission : Submission
    , compactionRevision : Maybe Int
    , operation : Operation
    , configuration : Configuration.Model
    , directoryDraft : Maybe String
    , directoryRevision : Maybe Int
    , baseline : Maybe Settings
    , configurationSave : ConfigurationSave
    , externalId : String
    , url : Url
    , address : Maybe Scalars.ConversationId
    , epoch : Int
    , attempt : Int
    , overviewGeneration : Int
    , overview : Read (Maybe Overview)
    , branches : Read (Maybe BranchPage)
    , preferences : Read (Maybe Preferences)
    , capacities : Read (List ( ( String, String ), Float ))
    , snapshot : Maybe Data.Snapshot
    , replica : Maybe D.Value
    , watching : Bool
    , connection : Connection
    , records : Dict Int Data.Entry
    , display : Display.State
    , rendering : Transcript.Context Msg
    , timings : Read (Maybe Query.TimingPage)
    , placements : Read (Maybe (List ( Int, Int )))
    , durations : Dict String Int
    , history : Read (Maybe Query.EntryPage)
    , historyBefore : Maybe Scalars.EntryId
    , historyCursor : Maybe Scalars.Cursor
    , historyGeneration : Int
    , historyComplete : Bool
    , opened : Dict String Bool
    , prompt : String
    , composing : Bool
    , attachments : List Attachment
    , nextAttachment : Int
    , completionIndex : Int
    , completionDismissed : Bool
    , caret : Int
    , confirmation : Maybe { instructions : String, revision : Maybe Int }
    , preview : String
    , search : Maybe String
    , searchIndex : Int
    , anchor : Maybe Int
    , latest : Bool
    , expanded : Bool
    , source : Maybe WatchHandle
    , suspended : Bool
    , images : Dict String Int
    , nextImage : Int
    , branchesOpen : Bool
    , scrollTop : Float
    , scrollGeneration : Int
    , scrollTarget : Maybe Int
    , lastSearch : Maybe ( String, Int )
    }


type alias Capture =
    { revision : Int, requestId : String, input : Input.SubmissionDraft }


type Submission
    = Unsent
    | Sending Capture
    | Uncertain Capture String
    | Checking Capture
    | RejectedInput String
    | Admitted Scalars.Id


type Operation
    = NoOperation
    | Operating String
    | OperationNotice String


type ConfigurationSave
    = NotSaving
    | Saving Settings (Maybe Int)
    | SaveUncertain Settings (Maybe Int)


type alias Settings =
    { agent : Input.AgentChange, env : Maybe Input.SshTargetInput }


type Msg
    = OverviewReceived Int (Api.Response (Maybe Overview))
    | BranchesReceived Bool (Api.Response (Maybe BranchPage))
    | PreferencesReceived (Api.Response (Maybe Preferences))
    | CapacitiesReceived (Api.Response (List ( ( String, String ), Float )))
    | TimingsReceived (Api.Response (Maybe Query.TimingPage))
    | PlacementsReceived (Api.Response (Maybe (List ( Int, Int ))))
    | CreateRoot
    | RootCreated (Api.Response (Maybe Info))
    | MoreTimings
    | RetryPlacements
    | HistoryReceived Int (Api.Response (Maybe Query.EntryPage))
    | Refresh
    | RefreshBranches
    | MoreBranches
    | MoreHistory
    | Retry
    | Incoming (Result D.Error BrowserReply)
    | Visibility Bool
    | DocumentVisibility Bool
    | Measure
    | ViewportReceived Int (Result Dom.Error Dom.Viewport)
    | EntryPosition Int (Result Dom.Error Float)
    | ScrollWritten Int Float (Result Dom.Error ())
    | Scrolled Float Bool
    | Caret Int
    | SelectionReady String Int (Result Dom.Error ())
    | BranchesOpen Bool
    | Home
    | Toggle String Bool
    | Edit String Int
    | Composition Bool
    | PickFiles
    | FilesSelected (List File)
    | AttachmentRead AttachmentId (Result String AttachmentContent)
    | RemoveFile AttachmentId
    | Send
    | SendMode InputSubmissionDraftWhenBusy
    | SubmissionReceived (Api.Response (Maybe Scalars.Id))
    | CheckReceipt
    | ReceiptReceived (Api.Response (Maybe Scalars.Id))
    | RetrySubmission
    | Compacted (Api.Response (Maybe Scalars.Id))
    | Stop
    | Withdraw Int
    | OperationReceived (Api.Response (Maybe Bool))
    | Withdrawn (Api.Response (Maybe WithdrawalResult.HarnessAbortSubmissionResult))
    | EditDirectory String
    | CommitDirectory
    | CancelDirectory
    | ConfigurationMsg Configuration.Msg
    | RetryConfiguration
    | Configured (Api.Response (Maybe Bool))
    | Preview String
    | EditConfirmation String
    | Confirm
    | Dismiss
    | Search String
    | SearchMove Int
    | ScrollTo Int
    | Latest
    | Collapse
    | CompletionMove Int
    | ChooseCompletion Int
    | NoOp


init : Int -> String -> String -> Maybe Scalars.ConversationId -> Url -> ( Model, Cmd Msg )
init epoch seed externalId address url =
    let
        ( configuration, catalogs ) =
            Configuration.init ()

        base =
            { seed = seed
            , revision = 0
            , nextRequest = 0
            , submission = Unsent
            , compactionRevision = Nothing
            , operation = NoOperation
            , configuration = configuration
            , directoryDraft = Nothing
            , directoryRevision = Nothing
            , baseline = Nothing
            , configurationSave = NotSaving
            , externalId = externalId
            , url = url
            , address = address
            , epoch = epoch
            , attempt = 0
            , overviewGeneration = 0
            , overview = Loading Nothing
            , branches = Loading Nothing
            , preferences = Loading Nothing
            , capacities = Loading Nothing
            , snapshot = Nothing
            , replica = Nothing
            , connection = Connecting
            , watching = False
            , records = Dict.empty
            , display = Display.empty
            , rendering = { hideImages = False, syntax = Syntax.empty, query = "", images = Dict.empty, imageLoaded = Measure }
            , timings = Loading Nothing
            , placements = Loaded Nothing
            , durations = Dict.empty
            , history = Loaded Nothing
            , historyBefore = Nothing
            , historyCursor = Nothing
            , historyGeneration = 0
            , historyComplete = False
            , opened = Dict.empty
            , prompt = ""
            , composing = False
            , attachments = []
            , nextAttachment = 0
            , completionIndex = 0
            , completionDismissed = False
            , caret = 0
            , confirmation = Nothing
            , preview = ""
            , search = Nothing
            , searchIndex = 0
            , anchor = Nothing
            , latest = False
            , expanded = True
            , source = Nothing
            , suspended = False
            , images = Dict.empty
            , nextImage = 0
            , branchesOpen = address == Nothing
            , scrollTop = 0
            , scrollGeneration = 0
            , scrollTarget = Nothing
            , lastSearch = Nothing
            }

        ( model, location ) =
            applyUrl url base
    in
    ( model
    , Cmd.batch
        [ Api.query (OverviewReceived 0) (Query.lookup externalId address)
        , Api.query (BranchesReceived False) (Query.branches externalId Nothing)
        , Api.query TimingsReceived (Query.timings externalId Nothing)
        , Api.query PreferencesReceived Query.preferences
        , Api.query CapacitiesReceived Query.capacities
        , location
        , Cmd.map ConfigurationMsg catalogs
        ]
    )


path : Model -> String
path model =
    case model.address of
        Nothing ->
            Route.href (Route.Session model.externalId)

        Just id ->
            Route.href (Route.Conversation model.externalId id)


applyUrl : Url -> Model -> ( Model, Cmd Msg )
applyUrl url model =
    let
        search =
            Parser.parse (Parser.query (QueryString.string "q")) { url | path = "/" } |> Maybe.andThen identity

        anchor =
            url.fragment
                |> Maybe.andThen
                    (\fragment ->
                        if String.startsWith "entry-" fragment then
                            String.dropLeft 6 fragment |> String.toInt

                        else
                            Nothing
                    )

        ( next, revealCommand ) =
            revealAnchor { model | url = url, search = search, anchor = anchor, searchIndex = 0 }

        ( searched, searchCommand ) =
            highlight next
    in
    ( searched, Cmd.batch [ searchCommand, revealCommand ] )


leave : Model -> Cmd msg
leave model =
    Cmd.batch
        [ close model
        , Dict.values model.rendering.images |> List.filterMap Result.toMaybe |> List.map revoke |> Cmd.batch
        ]


close : Model -> Cmd msg
close model =
    case model.source of
        Just handle ->
            closeHandle handle

        Nothing ->
            Cmd.none


closeHandle : WatchHandle -> Cmd msg
closeHandle (WatchHandle handle) =
    conversationBrowser (E.object [ ( "epoch", E.int 0 ), ( "attempt", E.int 0 ), ( "kind", E.string "close" ), ( "handle", handle ) ])


revoke : String -> Cmd msg
revoke url =
    conversationBrowser (E.object [ ( "epoch", E.int 0 ), ( "attempt", E.int 0 ), ( "kind", E.string "revoke" ), ( "url", E.string url ) ])



-- Replies can arrive after navigation or replacement. Their resources still
-- need disposal, so Main keeps the incoming port subscribed on every page.


discard : Msg -> Cmd msg
discard message =
    case message of
        Incoming (Ok { event }) ->
            case event of
                WatchOpened handle ->
                    closeHandle handle

                ImageReady _ (Just url) ->
                    revoke url

                _ ->
                    Cmd.none

        _ ->
            Cmd.none


browser : Model -> String -> List ( String, E.Value ) -> Cmd Msg
browser model kind fields =
    conversationBrowser (E.object ([ ( "epoch", E.int model.epoch ), ( "attempt", E.int model.attempt ), ( "kind", E.string kind ) ] ++ fields))


watch : Model -> Cmd Msg
watch model =
    case model.address of
        Nothing ->
            Cmd.none

        Just address ->
            browser model "watch" [ ( "url", E.string (Url.Builder.absolute [ "api", "watch" ] [ Url.Builder.string "externalId" model.externalId, Url.Builder.int "conversationId" (Scalars.conversationIdValue address) ]) ) ]


events : Sub Msg
events =
    let
        event =
            D.field "kind" D.string
                |> D.andThen
                    (\kind ->
                        (case kind of
                            "opened" ->
                                D.map (WatchHandle >> WatchOpened) D.value

                            "batch" ->
                                D.map WatchMessage D.string

                            "connection" ->
                                D.map WatchConnection D.int

                            "image" ->
                                D.map2 ImageReady (D.field "id" D.int) (D.field "url" (D.nullable D.string))

                            "syntax" ->
                                D.map SyntaxReady D.value

                            "syntaxFailed" ->
                                D.succeed SyntaxFailed

                            _ ->
                                D.fail "Unknown browser event"
                        )
                            |> D.field "payload"
                    )
    in
    conversationEvents (D.decodeValue (D.map3 BrowserReply (D.field "epoch" D.int) (D.field "attempt" D.int) event) >> Incoming)


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch
        [ Browser.Events.onVisibilityChange (\visibility -> Visibility (visibility == Browser.Events.Hidden))
        , Browser.Events.onResize (\_ _ -> Measure)
        ]


update : Msg -> Model -> ( Model, Cmd Msg, Outcome )
update msg model =
    let
        destination =
            if msg == Home then
                Just "/"

            else if
                (case msg of
                    Send ->
                        True

                    SendMode _ ->
                        True

                    _ ->
                        False
                )
                    && not model.composing
            then
                case List.head (String.words model.prompt) of
                    Just "/new" ->
                        if List.isEmpty model.attachments then
                            Just "/"

                        else
                            Nothing

                    _ ->
                        Nothing

            else
                Nothing

        ( next, effect ) =
            updateLocal msg model

        layoutChanged =
            case msg of
                NoOp ->
                    False

                Measure ->
                    False

                ViewportReceived _ _ ->
                    False

                EntryPosition _ _ ->
                    False

                ScrollWritten _ _ _ ->
                    False

                Scrolled _ _ ->
                    False

                Caret _ ->
                    False

                Visibility _ ->
                    False

                _ ->
                    True

        cmd =
            Cmd.batch
                [ effect
                , if layoutChanged && not next.latest && not next.suspended then
                    Dom.getViewportOf "conversation-scroll" |> Task.attempt (ViewportReceived next.scrollGeneration)

                  else
                    Cmd.none
                ]
    in
    case destination of
        Just url ->
            ( next, cmd, Navigate url )

        Nothing ->
            if model.address == Nothing && next.address /= Nothing then
                let
                    url =
                        next.url
                in
                ( next, cmd, RootResolved (Url.toString { url | path = path next }) )

            else
                ( next, cmd, Stay )


updateLocal : Msg -> Model -> ( Model, Cmd Msg )
updateLocal msg model =
    case msg of
        OverviewReceived generation response ->
            if generation /= model.overviewGeneration then
                ( model, Cmd.none )

            else
                let
                    overview =
                        Read.receiveOptional response model.overview

                    observed =
                        Read.observed overview |> Maybe.andThen identity

                    info =
                        observed |> Maybe.andThen .info

                    next =
                        { model | overview = overview, address = Maybe.map .id info |> orElse model.address, branchesOpen = model.branchesOpen && not (model.address == Nothing && info /= Nothing) }
                            |> observeConfiguration info
                in
                if not model.suspended && not model.watching && info /= Nothing then
                    ( { next | watching = True }, watch next )

                else
                    ( next, Cmd.none )

        CreateRoot ->
            case Read.observed model.overview |> Maybe.andThen identity of
                Just overview ->
                    if overview.info /= Nothing || operationPending model then
                        ( model, Cmd.none )

                    else
                        ( { model | operation = Operating "Creating root" }, Api.mutation RootCreated (Actions.root overview.harnessId (Input.buildRootOptionsInput identity)) )

                Nothing ->
                    ( model, Cmd.none )

        RootCreated response ->
            case ( response, Read.observed model.overview |> Maybe.andThen identity ) of
                ( Ok (Just info), Just overview ) ->
                    updateLocal (OverviewReceived (model.overviewGeneration + 1) (Ok (Just { overview | info = Just info }))) { model | operation = NoOperation, overviewGeneration = model.overviewGeneration + 1 }

                _ ->
                    ( { model | operation = OperationNotice "Root creation was not acknowledged. Refresh, or explicitly recover the reserved root with Create root." }, Cmd.none )

        Refresh ->
            if Read.pending model.overview then
                ( model, Cmd.none )

            else
                ( { model | overview = Loading (Read.observed model.overview) }, Api.query (OverviewReceived model.overviewGeneration) (Query.lookup model.externalId model.address) )

        BranchesReceived append response ->
            let
                received =
                    Read.receiveOptional response model.branches

                merge incoming =
                    if append then
                        case ( Read.observed model.branches |> Maybe.andThen identity, incoming ) of
                            ( Just previous, Just page ) ->
                                Just { page | nodes = previous.nodes ++ List.filter (\item -> not (List.any (.id >> (==) item.id) previous.nodes)) page.nodes }

                            _ ->
                                incoming

                    else
                        incoming

                next =
                    case received of
                        Loaded value ->
                            Loaded (merge value)

                        Partial value error ->
                            Partial (merge value) error

                        other ->
                            other
            in
            ( { model | branches = next }, Cmd.none )

        RefreshBranches ->
            if Read.pending model.branches then
                ( model, Cmd.none )

            else
                ( { model | branches = Loading (Read.observed model.branches) }, Api.query (BranchesReceived False) (Query.branches model.externalId Nothing) )

        MoreBranches ->
            case Read.observed model.branches |> Maybe.andThen identity |> Maybe.andThen .next of
                Just cursor ->
                    if Read.pending model.branches then
                        ( model, Cmd.none )

                    else
                        ( { model | branches = Loading (Read.observed model.branches) }, Api.query (BranchesReceived True) (Query.branches model.externalId (Just cursor)) )

                Nothing ->
                    ( model, Cmd.none )

        PreferencesReceived response ->
            let
                preferences =
                    Read.receiveOptional response model.preferences

                settings =
                    Read.observed preferences |> Maybe.andThen identity

                rendering =
                    model.rendering

                next =
                    { model | preferences = preferences, rendering = { rendering | hideImages = Maybe.map (.images >> not) settings |> Maybe.withDefault False } }
            in
            render next

        CapacitiesReceived response ->
            ( { model | capacities = Read.receive response model.capacities }, Cmd.none )

        HistoryReceived generation response ->
            let
                history =
                    Read.receiveOptional response model.history

                page =
                    case history of
                        Loaded value ->
                            value

                        Partial value _ ->
                            value

                        _ ->
                            Nothing

                advance =
                    generation
                        == model.historyGeneration
                        && (case history of
                                Loaded _ ->
                                    True

                                _ ->
                                    False
                           )

                next =
                    { model
                        | history =
                            if generation == model.historyGeneration then
                                history

                            else
                                model.history
                        , records = Maybe.map (\value -> include value.nodes model.records) page |> Maybe.withDefault model.records
                        , historyCursor =
                            if advance then
                                Maybe.map .next page |> Maybe.withDefault model.historyCursor

                            else
                                model.historyCursor
                        , historyComplete =
                            if advance then
                                Maybe.map (.next >> (==) Nothing) page |> Maybe.withDefault model.historyComplete

                            else
                                model.historyComplete
                    }

                ( rendered, command ) =
                    render next

                ( revealed, revealCommand ) =
                    revealAnchor rendered
            in
            ( revealed, Cmd.batch [ command, revealCommand ] )

        TimingsReceived response ->
            let
                received =
                    Read.receiveOptional response model.timings

                next =
                    { model | timings = received }
            in
            case received of
                Loaded (Just page) ->
                    applyTimings page next

                Partial (Just page) _ ->
                    applyTimings page next

                _ ->
                    ( next, Cmd.none )

        PlacementsReceived response ->
            let
                received =
                    Read.receiveOptional response model.placements

                durations =
                    Read.observed received |> Maybe.andThen identity |> Maybe.withDefault []
            in
            ( { model | placements = received, durations = List.foldl (\( entryId, duration ) -> Dict.insert (String.fromInt entryId) duration) model.durations durations }, Cmd.none )

        RetryPlacements ->
            if Read.pending model.placements then
                ( model, Cmd.none )

            else
                case Read.observed model.timings |> Maybe.andThen identity of
                    Just page ->
                        applyTimings page model

                    Nothing ->
                        ( model, Cmd.none )

        MoreTimings ->
            if Read.pending model.timings || Read.pending model.placements then
                ( model, Cmd.none )

            else
                ( { model | timings = Loading (Read.observed model.timings) }, Api.query TimingsReceived (Query.timings model.externalId (Read.observed model.timings |> Maybe.andThen identity |> Maybe.andThen .next)) )

        MoreHistory ->
            case model.address of
                Just address ->
                    if Read.pending model.history || model.historyComplete || model.snapshot == Nothing then
                        ( model, Cmd.none )

                    else
                        ( { model | history = Loading (Read.observed model.history) }
                        , Api.query (HistoryReceived model.historyGeneration) (Query.history model.externalId address model.historyBefore model.historyCursor)
                        )

                Nothing ->
                    ( model, Cmd.none )

        Retry ->
            let
                loading read =
                    if Read.pending read then
                        read

                    else
                        Loading (Read.observed read)

                next =
                    { model
                        | attempt = model.attempt + 1
                        , replica = Nothing
                        , source = Nothing
                        , connection = Connecting
                        , watching = model.address /= Nothing
                        , overview = loading model.overview
                        , branches = loading model.branches
                        , preferences = loading model.preferences
                        , capacities = loading model.capacities
                        , timings = loading model.timings
                    }

                request read command =
                    if Read.pending read then
                        Cmd.none

                    else
                        command
            in
            ( next
            , Cmd.batch
                [ close model
                , if model.suspended then
                    Cmd.none

                  else
                    watch next
                , request model.overview (Api.query (OverviewReceived model.overviewGeneration) (Query.lookup model.externalId model.address))
                , request model.branches (Api.query (BranchesReceived False) (Query.branches model.externalId Nothing))
                , request model.preferences (Api.query PreferencesReceived Query.preferences)
                , request model.capacities (Api.query CapacitiesReceived Query.capacities)
                , request model.timings (Api.query TimingsReceived (Query.timings model.externalId Nothing))
                ]
            )

        Incoming (Err _) ->
            ( model, Cmd.none )

        Incoming (Ok reply) ->
            let
                obsoleteWatch =
                    reply.attempt /= model.attempt || model.suspended
            in
            if reply.epoch /= model.epoch then
                ( model, discard msg )

            else
                case reply.event of
                    WatchOpened handle ->
                        if obsoleteWatch then
                            ( model, closeHandle handle )

                        else
                            ( { model | source = Just handle }, close model )

                    WatchMessage data ->
                        if obsoleteWatch then
                            ( model, Cmd.none )

                        else
                            case D.decodeString D.value data of
                                Ok batch ->
                                    receiveBatch batch model

                                Err _ ->
                                    break "Invalid watch event. Reconnect to obtain a fresh baseline." model

                    WatchConnection state ->
                        if obsoleteWatch then
                            ( model, Cmd.none )

                        else if state == 2 then
                            break "The live connection stopped. Reconnect to obtain a fresh baseline." model

                        else
                            ( { model | connection = Stale, replica = Nothing }, Cmd.none )

                    ImageReady request url ->
                        case Dict.toList model.images |> List.filter (Tuple.second >> (==) request) |> List.head of
                            Nothing ->
                                ( model, Maybe.map revoke url |> Maybe.withDefault Cmd.none )

                            Just ( src, _ ) ->
                                let
                                    rendering =
                                        model.rendering
                                in
                                ( { model | rendering = { rendering | images = Dict.insert src (Maybe.map Ok url |> Maybe.withDefault (Err "Unable to decode image.")) rendering.images } }, Cmd.none )

                    SyntaxReady tokens ->
                        case Syntax.receive tokens model.rendering.syntax of
                            Ok syntax ->
                                let
                                    rendering =
                                        model.rendering
                                in
                                ( { model | rendering = { rendering | syntax = syntax } }, Cmd.none )

                            Err _ ->
                                ( model, Cmd.none )

                    SyntaxFailed ->
                        ( model, Cmd.none )

        DocumentVisibility hidden ->
            updateLocal (Visibility hidden)
                (if hidden then
                    { model | prompt = "", attachments = [], revision = model.revision + 1, submission = Unsent, confirmation = Nothing }

                 else
                    model
                )

        Visibility hidden ->
            if hidden == model.suspended then
                ( model, Cmd.none )

            else if hidden then
                ( { model | suspended = True, source = Nothing, attempt = model.attempt + 1, connection = Stale, replica = Nothing }, close model )

            else
                updateLocal Retry { model | suspended = False }

        Measure ->
            ( model, Dom.getViewportOf "conversation-scroll" |> Task.attempt (ViewportReceived model.scrollGeneration) )

        ViewportReceived generation (Ok viewport) ->
            if generation /= model.scrollGeneration then
                ( model, Cmd.none )

            else
                case model.scrollTarget of
                    Just entry ->
                        ( model
                        , Task.map2 (\target container -> viewport.viewport.y + target.element.y - container.element.y + (target.element.height - viewport.viewport.height) / 2)
                            (Dom.getElement ("entry-" ++ String.fromInt entry))
                            (Dom.getElement "conversation-scroll")
                            |> Task.attempt (EntryPosition generation)
                        )

                    Nothing ->
                        if not model.latest && viewport.scene.height - viewport.viewport.height - viewport.viewport.y > 1 then
                            ( model, Dom.setViewportOf "conversation-scroll" 0 viewport.scene.height |> Task.attempt (ScrollWritten generation (max 0 (viewport.scene.height - viewport.viewport.height))) )

                        else
                            ( model, Cmd.none )

        ViewportReceived _ (Err _) ->
            ( model, Cmd.none )

        EntryPosition generation result ->
            if generation /= model.scrollGeneration then
                ( model, Cmd.none )

            else
                ( { model | scrollTarget = Nothing }
                , case result of
                    Ok y ->
                        Dom.setViewportOf "conversation-scroll" 0 y |> Task.attempt (always NoOp)

                    Err _ ->
                        Cmd.none
                )

        ScrollWritten generation top result ->
            if generation == model.scrollGeneration && result == Ok () then
                -- Record the write before its asynchronous scroll notification.
                -- A user can scroll back before that notification is delivered.
                ( { model | scrollTop = top }, Cmd.none )

            else
                ( model, Cmd.none )

        Scrolled top away ->
            let
                -- Scroll notifications describe the current layout, not the
                -- layout when the motion happened. A smaller viewport alone
                -- must not turn a queued bottom-scroll event into user scrollback.
                movedUp =
                    away && top < model.scrollTop

                next =
                    { model
                        | scrollTop = top
                        , latest =
                            if model.scrollTarget /= Nothing then
                                True

                            else
                                away && (model.latest || movedUp)
                        , scrollTarget =
                            if movedUp then
                                Nothing

                            else
                                model.scrollTarget
                        , scrollGeneration =
                            if movedUp then
                                model.scrollGeneration + 1

                            else
                                model.scrollGeneration
                    }
            in
            if away && not next.latest then
                updateLocal Measure next

            else
                ( next, Cmd.none )

        Caret caret ->
            ( { model | caret = caret }, Cmd.none )

        SelectionReady value caret result ->
            if model.prompt == value && result == Ok () then
                ( model, browser model "selection" [ ( "id", E.string "prompt" ), ( "caret", E.int caret ) ] )

            else
                ( model, Cmd.none )

        BranchesOpen opened ->
            ( { model | branchesOpen = opened }, Cmd.none )

        Home ->
            ( model, Cmd.none )

        Toggle key opened ->
            ( { model | opened = Dict.insert key opened model.opened }, Cmd.none )

        Edit value caret ->
            ( { model | revision = model.revision + 1, prompt = value, caret = caret, completionIndex = 0, completionDismissed = False }, Cmd.none )

        Composition active ->
            ( { model | composing = active }, Cmd.none )

        PickFiles ->
            ( model, File.Select.files [] (\first rest -> FilesSelected (first :: rest)) )

        FilesSelected files ->
            let
                added =
                    List.indexedMap (\index file -> { id = AttachmentId (model.nextAttachment + index), file = file, state = Reading }) files
            in
            ( { model | revision = model.revision + 1, attachments = model.attachments ++ added, nextAttachment = model.nextAttachment + List.length files }, Cmd.batch (List.map (Attachment.readAttachment AttachmentRead) added) )

        AttachmentRead key result ->
            ( { model | attachments = List.map (Attachment.receiveAttachment key result) model.attachments }, Cmd.none )

        RemoveFile key ->
            ( { model | revision = model.revision + 1, attachments = List.filter (.id >> (/=) key) model.attachments }, Cmd.none )

        Send ->
            if model.composing then
                ( model, Cmd.none )

            else
                let
                    command =
                        List.head (String.words model.prompt) |> Maybe.withDefault ""

                    argument =
                        String.trim model.prompt |> String.dropLeft (String.length command) |> String.trim
                in
                if String.startsWith "/" command then
                    if not (List.isEmpty model.attachments) then
                        ( { model | preview = "Commands do not consume attachments. Remove them or send a message." }, Cmd.none )

                    else
                        case command of
                            "/compact" ->
                                ( { model | confirmation = Just { instructions = argument, revision = Just model.revision }, completionDismissed = True, preview = "" }, Cmd.none )

                            "/cd" ->
                                if argument == "" then
                                    ( model, Cmd.none )

                                else
                                    let
                                        configuration =
                                            model.configuration
                                    in
                                    saveConfiguration { model | configuration = { configuration | directory = argument }, directoryDraft = Nothing, directoryRevision = Just model.revision, preview = "" }

                            "/new" ->
                                ( model, Cmd.none )

                            _ ->
                                ( { model | preview = "Unknown command." }, Cmd.none )

                else
                    send (deliveryMode model) model

        SendMode mode ->
            if String.startsWith "/" (String.trimLeft model.prompt) then
                updateLocal Send model

            else
                send mode model

        SubmissionReceived response ->
            case model.submission of
                Sending captured ->
                    case response of
                        Ok (Just id) ->
                            admitted captured id model

                        Err failure ->
                            ( { model
                                | submission =
                                    case Api.rejection failure of
                                        Just problem ->
                                            RejectedInput problem

                                        Nothing ->
                                            Uncertain captured (mutationProblem response)
                              }
                            , Cmd.none
                            )

                        Ok Nothing ->
                            ( { model | submission = Uncertain captured (mutationProblem response) }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        CheckReceipt ->
            case ( model.submission, model.address ) of
                ( Uncertain captured _, Just address ) ->
                    ( { model | submission = Checking captured }, Api.query ReceiptReceived (Actions.receipt model.externalId address captured.requestId) )

                _ ->
                    ( model, Cmd.none )

        ReceiptReceived response ->
            case model.submission of
                Checking captured ->
                    case response of
                        Ok (Just id) ->
                            admitted captured id model

                        Ok Nothing ->
                            ( { model | submission = Uncertain captured "No receipt observed. This does not prove that delivery failed." }, Cmd.none )

                        _ ->
                            ( { model | submission = Uncertain captured (mutationProblem response) }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        RetrySubmission ->
            case ( model.submission, conversationInfo model ) of
                ( Uncertain captured _, Just info ) ->
                    ( { model | submission = Sending captured }, Api.mutation SubmissionReceived (Actions.submit info.globalId captured.input) )

                _ ->
                    ( model, Cmd.none )

        Compacted response ->
            case response of
                Ok (Just _) ->
                    ( { model
                        | confirmation = Nothing
                        , compactionRevision = Nothing
                        , prompt =
                            if model.compactionRevision == Just model.revision then
                                ""

                            else
                                model.prompt
                        , operation = NoOperation
                      }
                    , Cmd.none
                    )

                _ ->
                    ( { model | confirmation = Nothing, operation = OperationNotice ("Compaction outcome uncertain. Inspect live state before requesting another compaction. " ++ mutationProblem response) }, Cmd.none )

        Stop ->
            operate "Stopping" (\info -> Mutation.abort { input = Input.buildAbortInput { conversationId = info.globalId } }) model

        Withdraw id ->
            case ( conversationInfo model, D.decodeValue Scalars.submissionId.decoder (E.int id) ) of
                ( Just info, Ok submissionId ) ->
                    if operationPending model then
                        ( model, Cmd.none )

                    else
                        ( { model | operation = Operating "Withdrawing queued input" }, Api.mutation Withdrawn (Mutation.abortSubmission { input = Input.buildAbortSubmissionInput { conversationId = info.globalId, id = submissionId } } Withdrawal.result) )

                _ ->
                    ( model, Cmd.none )

        OperationReceived response ->
            ( { model
                | operation =
                    if response == Ok (Just True) then
                        NoOperation

                    else
                        OperationNotice ("Operation outcome uncertain. " ++ mutationProblem response)
              }
            , Cmd.none
            )

        Withdrawn response ->
            ( { model
                | operation =
                    case response of
                        Ok (Just WithdrawalResult.Aborted) ->
                            NoOperation

                        Ok (Just result) ->
                            OperationNotice ("Withdrawal: " ++ WithdrawalResult.toString result)

                        _ ->
                            OperationNotice ("Withdrawal outcome uncertain. " ++ mutationProblem response)
              }
            , Cmd.none
            )

        EditDirectory value ->
            ( { model | directoryDraft = Just value }, Cmd.none )

        CancelDirectory ->
            ( { model | directoryDraft = Nothing }, Cmd.none )

        CommitDirectory ->
            case model.directoryDraft of
                Nothing ->
                    ( model, Cmd.none )

                Just value ->
                    let
                        configuration =
                            model.configuration
                    in
                    saveConfiguration { model | configuration = { configuration | directory = value }, directoryDraft = Nothing, directoryRevision = Nothing }

        ConfigurationMsg message ->
            let
                ( configuration, command ) =
                    Configuration.update message model.configuration

                updated =
                    { model | configuration = configuration }

                ( next, save ) =
                    case message of
                        Configuration.ModelSelected _ ->
                            saveConfiguration updated

                        Configuration.ThinkingSelected _ ->
                            saveConfiguration updated

                        Configuration.EnvironmentSelected _ ->
                            saveConfiguration updated

                        _ ->
                            ( updated, Cmd.none )
            in
            ( next, Cmd.batch [ Cmd.map ConfigurationMsg command, save ] )

        RetryConfiguration ->
            case model.configurationSave of
                SaveUncertain captured revision ->
                    configure captured revision model

                _ ->
                    ( model, Cmd.none )

        Configured response ->
            case model.configurationSave of
                Saving captured revision ->
                    if response == Ok (Just True) then
                        let
                            acknowledged =
                                { model | baseline = Just captured, configurationSave = NotSaving }
                                    |> clearDirectoryCommand revision

                            ( next, command ) =
                                saveConfiguration acknowledged
                        in
                        case next.configurationSave of
                            Saving _ _ ->
                                ( next, command )

                            _ ->
                                ( { next | overview = Loading (Read.observed next.overview) }
                                , Cmd.batch [ command, Api.query (OverviewReceived next.overviewGeneration) (Query.lookup next.externalId next.address) ]
                                )

                    else
                        ( { model | configurationSave = SaveUncertain captured revision }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        Preview notice ->
            ( { model | preview = notice }, Cmd.none )

        EditConfirmation value ->
            ( { model | confirmation = Maybe.map (\item -> { item | instructions = value }) model.confirmation }, Cmd.none )

        Confirm ->
            case ( model.confirmation, conversationInfo model ) of
                ( Just confirmation, Just info ) ->
                    if model.composing || operationPending model then
                        ( model, Cmd.none )

                    else
                        ( { model
                            | compactionRevision = confirmation.revision
                            , operation = Operating "Compacting"
                          }
                        , Api.mutation Compacted (Actions.compact info.globalId confirmation.instructions)
                        )

                _ ->
                    ( model, Cmd.none )

        Dismiss ->
            let
                next =
                    { model | confirmation = Nothing, search = Nothing, anchor = Nothing, completionDismissed = True, preview = "" }
            in
            if model.branchesOpen then
                ( { model | branchesOpen = False }, Cmd.none )

            else
                ( { next | lastSearch = Nothing }, Cmd.none )

        Search query ->
            let
                next =
                    { model | search = Just query, searchIndex = 0, anchor = Nothing }

                ( searched, command ) =
                    highlight next
            in
            ( searched, command )

        SearchMove delta ->
            let
                count =
                    List.length (matches model)

                next =
                    { model
                        | searchIndex =
                            if count == 0 then
                                0

                            else
                                modBy count (model.searchIndex + delta)
                    }
            in
            highlight next

        ScrollTo entry ->
            reveal entry { model | anchor = Nothing }

        Latest ->
            updateLocal Measure { model | anchor = Nothing, latest = False, scrollTarget = Nothing, scrollGeneration = model.scrollGeneration + 1 }

        Collapse ->
            ( { model | expanded = not model.expanded }, Cmd.none )

        CompletionMove delta ->
            let
                count =
                    List.length (completions model)
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
            case List.drop index (completions model) |> List.head of
                Nothing ->
                    ( model, Cmd.none )

                Just item ->
                    let
                        tail =
                            String.dropLeft model.caret model.prompt |> String.toList |> dropCommand |> String.fromList

                        value =
                            item.label ++ " "
                    in
                    ( { model | prompt = value ++ tail, caret = String.length value, completionDismissed = True }, Task.succeed () |> Task.perform (\_ -> SelectionReady (value ++ tail) (String.length value) (Ok ())) )

        NoOp ->
            ( model, Cmd.none )


dropCommand : List Char -> List Char
dropCommand chars =
    case chars of
        first :: rest ->
            if Char.isAlpha first || first == '-' then
                dropCommand rest

            else
                chars

        [] ->
            []


orElse : Maybe a -> Maybe a -> Maybe a
orElse fallback value =
    case value of
        Just _ ->
            value

        Nothing ->
            fallback


include : List Data.Entry -> Dict Int Data.Entry -> Dict Int Data.Entry
include entries previous =
    List.foldl (\entry -> Dict.insert entry.id entry) previous entries


receiveBatch : D.Value -> Model -> ( Model, Cmd Msg )
receiveBatch batch model =
    case Watch.apply model.replica batch |> Result.andThen (\value -> D.decodeValue Data.snapshotDecoder value |> Result.mapError (always "Invalid conversation snapshot.") |> Result.map (Tuple.pair value)) of
        Err problem ->
            break problem model

        Ok ( replica, snapshot ) ->
            if Maybe.map Scalars.conversationIdValue model.address /= Just snapshot.conversation then
                break "The watch addressed another conversation." model

            else
                let
                    document state =
                        state |> Maybe.andThen (D.decodeValue (D.at [ "view", "docs", "pi.agent" ] D.value) >> Result.toMaybe) |> Maybe.map (E.encode 0)

                    compacted =
                        List.any (\entry -> entry.kind == "pi.compaction" && not (Dict.member entry.id model.records)) snapshot.entries

                    refreshMetadata =
                        model.snapshot /= Nothing && document model.replica /= document (Just replica) && not (Read.pending model.overview)

                    refreshTimings =
                        compacted && not (Read.pending model.timings) && not (Read.pending model.placements)

                    before =
                        snapshot.before |> Maybe.andThen (\id -> D.decodeValue Scalars.entryId.decoder (E.int id) |> Result.toMaybe)

                    gap =
                        case snapshot.before of
                            Just entryId ->
                                not (Dict.member entryId model.records) && (Maybe.andThen .before model.snapshot /= snapshot.before || model.snapshot == Nothing)

                            Nothing ->
                                model.snapshot == Nothing || not model.historyComplete

                    next =
                        { model
                            | replica = Just replica
                            , snapshot = Just snapshot
                            , connection = Current
                            , records = include snapshot.entries model.records
                            , timings =
                                if refreshTimings then
                                    Loading (Read.observed model.timings)

                                else
                                    model.timings
                            , overview =
                                if refreshMetadata then
                                    Loading (Read.observed model.overview)

                                else
                                    model.overview
                            , historyBefore =
                                if gap then
                                    before

                                else
                                    model.historyBefore
                            , historyCursor =
                                if gap then
                                    Nothing

                                else
                                    model.historyCursor
                            , historyGeneration =
                                if gap then
                                    model.historyGeneration + 1

                                else
                                    model.historyGeneration
                            , history =
                                if gap then
                                    Loaded Nothing

                                else
                                    model.history
                            , historyComplete =
                                if gap then
                                    snapshot.before == Nothing

                                else
                                    model.historyComplete
                        }

                    ( rendered, cmd ) =
                        render next

                    ( revealed, anchor ) =
                        revealAnchor rendered
                in
                ( revealed
                , Cmd.batch
                    [ cmd
                    , anchor
                    , if refreshTimings then
                        Api.query TimingsReceived (Query.timings model.externalId Nothing)

                      else
                        Cmd.none
                    , if refreshMetadata then
                        Api.query (OverviewReceived model.overviewGeneration) (Query.lookup model.externalId model.address)

                      else
                        Cmd.none
                    ]
                )


break : String -> Model -> ( Model, Cmd Msg )
break problem model =
    ( { model | connection = Broken problem, replica = Nothing, source = Nothing, attempt = model.attempt + 1 }, close model )


render : Model -> ( Model, Cmd Msg )
render model =
    case model.snapshot of
        Nothing ->
            ( model, Cmd.none )

        Just snapshot ->
            let
                display =
                    Data.project model.records snapshot

                ( syntax, requests ) =
                    Syntax.sync (Transcript.codeSources display) model.rendering.syntax

                rendering =
                    model.rendering

                next =
                    { model | display = display, rendering = { rendering | syntax = syntax } }

                ( imaged, imagesCommand ) =
                    syncImages next

                ( searched, searchCommand ) =
                    highlight imaged
            in
            ( searched, Cmd.batch [ imagesCommand, browser next "syntax" [ ( "requests", E.list Syntax.encodeRequest requests ) ], searchCommand ] )


revealAnchor : Model -> ( Model, Cmd Msg )
revealAnchor model =
    case model.anchor of
        Just entry ->
            if Dict.member entry model.records then
                reveal entry { model | anchor = Nothing }

            else
                ( model, Cmd.none )

        Nothing ->
            ( model, Cmd.none )


reveal : Int -> Model -> ( Model, Cmd Msg )
reveal entry model =
    let
        opened =
            Dict.values model.display.entries |> List.filter (\item -> item.id >= entry && item.boundary /= Display.Normal) |> List.foldl (\item -> Dict.insert ("context-" ++ String.fromInt item.id) True) model.opened
    in
    updateLocal Measure { model | opened = opened, latest = True, scrollTarget = Just entry, scrollGeneration = model.scrollGeneration + 1 }


matches : Model -> List Int
matches model =
    let
        query =
            model.search |> Maybe.withDefault "" |> String.trim |> String.toLower
    in
    if query == "" then
        []

    else
        Dict.values model.display.entries |> List.filter (Transcript.entrySearch model.display.tools >> String.toLower >> String.contains query) |> List.map .id


highlight : Model -> ( Model, Cmd Msg )
highlight model =
    let
        selected =
            List.drop model.searchIndex (matches model) |> List.head

        selection =
            Maybe.map (Tuple.pair (Maybe.withDefault "" model.search)) selected

        next =
            { model | lastSearch = selection }
    in
    if selection /= model.lastSearch then
        case selected of
            Just entry ->
                updateLocal Measure { next | latest = True, scrollTarget = Just entry, scrollGeneration = model.scrollGeneration + 1 }

            Nothing ->
                ( next, Cmd.none )

    else
        ( next, Cmd.none )


syncImages : Model -> ( Model, Cmd Msg )
syncImages model =
    let
        sources =
            if model.rendering.hideImages then
                Dict.empty

            else
                Transcript.imageSources model.display
                    |> List.map (\( mime, data ) -> ( "data:" ++ mime ++ ";base64," ++ data, ( mime, data ) ))
                    |> Dict.fromList

        rendering =
            model.rendering

        retained =
            Dict.filter (\src _ -> Dict.member src sources) rendering.images

        removed =
            Dict.filter (\src _ -> not (Dict.member src sources)) rendering.images
                |> Dict.values
                |> List.filterMap Result.toMaybe
                |> List.map revoke

        add src ( mime, data ) ( current, commands_ ) =
            if Dict.member src current.images then
                ( current, commands_ )

            else
                let
                    context =
                        current.rendering

                    valid =
                        List.member mime [ "image/png", "image/jpeg", "image/gif", "image/webp" ]
                in
                ( { current
                    | images = Dict.insert src current.nextImage current.images
                    , nextImage = current.nextImage + 1
                    , rendering =
                        if valid then
                            context

                        else
                            { context | images = Dict.insert src (Err "Unsupported image format.") context.images }
                  }
                , if valid then
                    browser current "image" [ ( "id", E.int current.nextImage ), ( "mime", E.string mime ), ( "data", E.string data ) ] :: commands_

                  else
                    commands_
                )

        ( next, effects ) =
            Dict.foldl add ( { model | images = Dict.filter (\src _ -> Dict.member src sources) model.images, rendering = { rendering | images = retained } }, removed ) sources
    in
    ( next, Cmd.batch effects )


commands : List { label : String, description : Maybe String }
commands =
    List.map (\( name, description ) -> { label = "/" ++ name, description = Just description })
        [ ( "compact", "Compact context" ), ( "new", "New session" ), ( "cd", "Change directory" ) ]


completions : Model -> List { label : String, description : Maybe String }
completions model =
    let
        before =
            String.left model.caret model.prompt
    in
    if model.completionDismissed || not (String.startsWith "/" before) || not (String.all (\char -> Char.isAlpha char || char == '-') (String.dropLeft 1 before)) then
        []

    else
        List.filter (.label >> String.startsWith (String.toLower before)) commands


keyDown : Model -> Html.Attribute Msg
keyDown model =
    Events.custom "keydown"
        (D.map5
            (\key ctrl meta alt composing ->
                if composing || model.composing then
                    ( NoOp, False )

                else if key == "Escape" then
                    ( Dismiss, True )

                else if not (List.isEmpty (completions model)) && (key == "ArrowDown" || (ctrl && key == "j")) then
                    ( CompletionMove 1, True )

                else if not (List.isEmpty (completions model)) && (key == "ArrowUp" || (ctrl && key == "k")) then
                    ( CompletionMove -1, True )

                else if not (List.isEmpty (completions model)) && (key == "Tab" || (key == "Enter" && not (ctrl || meta || alt))) then
                    ( ChooseCompletion model.completionIndex, True )

                else if key == "Enter" && (ctrl || meta || alt) then
                    ( if model.confirmation == Nothing then
                        if alt then
                            SendMode
                                (if deliveryMode model == Delivery.Steer then
                                    Delivery.FollowUp

                                 else
                                    Delivery.Steer
                                )

                        else
                            Send

                      else
                        Confirm
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
            |> D.map (\( message, prevent ) -> { message = message, preventDefault = prevent, stopPropagation = prevent })
        )


shortcuts : Model -> Html.Attribute Msg
shortcuts model =
    Events.preventDefaultOn "keydown"
        (D.map5
            (\key ctrl meta shift composing ->
                if composing || model.composing then
                    ( NoOp, False )

                else if (ctrl || meta) && key == "f" then
                    ( Search (Maybe.withDefault "" model.search), True )

                else if (ctrl || meta) && key == "k" && not shift then
                    ( Home, True )

                else if key == "Escape" then
                    ( Dismiss, True )

                else
                    ( NoOp, False )
            )
            (D.field "key" D.string)
            (D.field "ctrlKey" D.bool)
            (D.field "metaKey" D.bool)
            (D.field "shiftKey" D.bool)
            (D.field "isComposing" D.bool)
        )


view : Model -> Browser.Document Msg
view model =
    let
        info =
            Read.observed model.overview |> Maybe.andThen identity |> Maybe.andThen .info

        title =
            model.externalId

        settings =
            Read.observed model.preferences |> Maybe.andThen identity

        opened =
            if Maybe.withDefault "" model.search == "" then
                model.opened

            else
                Dict.foldl
                    (\key tool acc ->
                        if String.contains (String.toLower (Maybe.withDefault "" model.search)) (String.toLower (Transcript.entrySearch model.display.tools { id = 0, boundary = Display.Normal, messages = [ { role = "assistant", timestamp = 0, blocks = [ Display.ToolRef key ], error = "" } ] })) then
                            Dict.insert key True acc

                        else
                            acc
                    )
                    model.opened
                    model.display.tools

        rendering =
            model.rendering

        context =
            { rendering | query = Maybe.withDefault "" model.search |> String.trim }

        message =
            Transcript.viewMessage context Toggle opened model.display.tools True

        liveMessage index item =
            let
                previous =
                    (List.take index model.display.live.messages |> List.reverse)
                        ++ (Dict.values model.display.entries |> List.reverse |> List.concatMap (.messages >> List.reverse))
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

        hasConversation =
            info /= Nothing

        problem =
            case model.overview of
                Loaded Nothing ->
                    "Session not found or unavailable."

                Loaded (Just overview) ->
                    if overview.info == Nothing && model.address /= Nothing then
                        "Conversation not found or unavailable."

                    else
                        ""

                _ ->
                    ""
    in
    { title = title
    , body =
        [ main_ [ id "page", A.tabindex -1, attribute "data-view" "conversation", shortcuts model, Events.preventDefaultOn "dragover" (D.at [ "dataTransfer", "types" ] (D.list D.string) |> D.map (\types -> ( NoOp, List.member "Files" types ))), A.classList [ ( "stacked-layout", True ), ( "wrap-code", Maybe.map .wrap settings |> Maybe.withDefault False ), ( "bottom-align", Maybe.map .bottom settings |> Maybe.withDefault True ), ( "hide-thinking", Maybe.map .hideThinking settings |> Maybe.withDefault False ), ( "hide-images", Maybe.map (.images >> not) settings |> Maybe.withDefault False ) ] ]
            [ header [ id "app-header" ]
                [ div [ class "bar" ]
                    [ h1 []
                        [ a [ id "conversation-title", class "header-title", href "/" ] [ text title ]
                        , case model.connection of
                            Broken _ ->
                                button [ id "reconnect", onClick Retry ] [ text "Reconnect" ]

                            Stale ->
                                button [ id "reconnect", onClick Retry ] [ text "Reconnect" ]

                            _ ->
                                text ""
                        ]
                    , a [ id "menu-toggle", class "icon", href "/settings", attribute "aria-label" "Global settings", A.title "Global settings" ] [ Icon.view "settings" ]
                    ]
                , branchHeader model
                , Read.viewReadStatus "conversation" Refresh model.overview
                , if problem == "" then
                    text ""

                  else
                    p [ attribute "role" "alert" ] [ text problem, a [ href "/" ] [ text "Home" ] ]
                , if hasConversation then
                    connectionView model

                  else
                    text ""
                , Read.viewReadStatus "presentation settings" Retry model.preferences
                , Read.viewReadStatus "model capacity" Retry model.capacities
                ]
            , main_ [ id "main-area" ]
                [ div [ id "conversation-scroll", Events.on "scroll" (D.map3 (\height client top -> Scrolled top (height - client - top >= 32)) (D.at [ "target", "scrollHeight" ] D.float) (D.at [ "target", "clientHeight" ] D.float) (D.at [ "target", "scrollTop" ] D.float)), class "scrollport pane", A.tabindex 0, attribute "aria-label" "Conversation" ]
                    [ div [ class "history-controls" ]
                        [ Read.viewReadStatus "history" MoreHistory model.history
                        , if hasConversation then
                            Read.viewReadStatus "compaction timings" MoreTimings model.timings

                          else
                            text ""
                        , if hasConversation then
                            Read.viewReadStatus "compaction placement" RetryPlacements model.placements

                          else
                            text ""
                        , if (Read.observed model.timings |> Maybe.andThen identity |> Maybe.andThen .next) /= Nothing then
                            button [ onClick MoreTimings, A.disabled (Read.pending model.timings) ] [ text "More compaction timings" ]

                          else
                            text ""
                        , if not model.historyComplete && model.snapshot /= Nothing then
                            button [ A.type_ "button", onClick MoreHistory, A.disabled (Read.pending model.history) ] [ text "Load older messages" ]

                          else
                            text ""
                        , case model.anchor of
                            Just entry ->
                                if Dict.member entry model.records then
                                    text ""

                                else
                                    p [ attribute "role" "status" ]
                                        [ text
                                            (if model.historyComplete then
                                                "Entry not found."

                                             else
                                                "Entry not loaded. Load older messages to find it."
                                            )
                                        ]

                            Nothing ->
                                text ""
                        , if model.address == Nothing && (Read.observed model.overview |> Maybe.andThen identity) /= Nothing then
                            p [] [ text "No root conversation. Choose an existing conversation above.", button [ onClick CreateRoot, A.disabled (operationPending model) ] [ text "Create root" ] ]

                          else
                            text ""
                        ]
                    , Html.Lazy.lazy6 (Transcript.transcript context Toggle) opened (Maybe.withDefault "" model.search) (List.drop model.searchIndex (matches model) |> List.head) model.display.entries model.display.tools model.durations
                    , section [ id "live", attribute "aria-label" "Live output" ]
                        (List.indexedMap liveMessage model.display.live.messages
                            ++ List.map (Transcript.blockView context Toggle opened model.display.tools << Display.ToolRef) model.display.live.tools
                            ++ List.map
                                (\item ->
                                    let
                                        key =
                                            "compaction-" ++ item.id
                                    in
                                    Html.details [ id key, class "tool-call context-event", attribute "data-state" "running", A.property "open" (E.bool (Dict.get key opened |> Maybe.withDefault False)) ] [ Html.summary [ Events.preventDefaultOn "click" (D.succeed ( Toggle key (not (Dict.get key opened |> Maybe.withDefault False)), True )) ] [ Transcript.toolStatus "running", Transcript.commandLabel context.query item.title ], p [ class "notice" ] [ text item.detail ] ]
                                )
                                model.display.live.compactions
                            ++ List.map (\notice -> p [ class "notice" ] [ text notice ]) model.display.live.notices
                        )
                    ]
                ]
            , section [ id "queue", attribute "aria-label" "Queued messages" ]
                (if List.isEmpty model.display.queue then
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
                                                button [ class "icon", attribute "aria-label" "Cancel queued message", A.disabled (operationPending model), onClick (Withdraw item.id) ] [ text "×" ]
                                            ]
                                        , div [] (List.map (Transcript.blockView context Toggle opened model.display.tools) item.blocks)
                                        ]
                                )
                                model.display.queue
                        )
                    ]
                )
            , footer [ id "app-footer", class "composer-area" ]
                [ div [ id "conversation-navigation", attribute "role" "group", attribute "aria-label" "Conversation navigation" ]
                    [ button [ id "latest", A.type_ "button", attribute "aria-label" "Latest", A.title "Latest", A.disabled (not model.latest), onClick Latest ] [ Icon.view "chevrons-down" ]
                    , scrollButton "last" "Last" "chevron-up" (Dict.values model.display.entries |> List.filter (\entry -> List.any (.role >> (==) "user") entry.messages) |> List.reverse |> List.head)
                    , scrollButton "top" "Top" "chevrons-up" (Dict.values model.display.entries |> List.filter (\entry -> entry.boundary == Display.Normal && not (List.isEmpty entry.messages)) |> List.head)
                    ]
                , Composer.shell
                    [ div [ Attachment.fileEvent FilesSelected { event = "drop", field = "dataTransfer" } ]
                        [ case model.confirmation of
                            Just confirmation ->
                                confirmationView model confirmation

                            Nothing ->
                                composerView model hasConversation
                        ]
                    ]
                , metadataView model info
                ]
            , searchView model
            ]
        ]
    }


scrollButton : String -> String -> String -> Maybe Display.Entry -> Html Msg
scrollButton key label icon target =
    button [ id key, A.type_ "button", attribute "aria-label" label, A.title label, A.disabled (target == Nothing), onClick (Maybe.map (.id >> ScrollTo) target |> Maybe.withDefault NoOp) ] [ Icon.view icon ]


composerView : Model -> Bool -> Html Msg
composerView model available =
    Composer.view
        { text = model.prompt
        , edit = Edit
        , editingDisabled = False
        , events = [ Events.on "select" (D.at [ "target", "selectionStart" ] D.int |> D.map Caret), Events.on "click" (D.at [ "target", "selectionStart" ] D.int |> D.map Caret), Events.on "keyup" (D.at [ "target", "selectionStart" ] D.int |> D.map Caret), keyDown model, Events.on "compositionstart" (D.succeed (Composition True)), Events.on "compositionend" (D.succeed (Composition False)), Attachment.fileEvent FilesSelected { event = "paste", field = "clipboardData" } ]
        , attachments = model.attachments
        , removeAttachment = RemoveFile
        , feedback = composerFeedback model
        , pickFiles = PickFiles
        , completions =
            if List.isEmpty (completions model) then
                Nothing

            else
                Just { items = completions model, selected = model.completionIndex, choose = ChooseCompletion }
        , submission =
            if model.display.live.busy then
                Composer.Working
                    { submit = Send
                    , label =
                        case deliveryMode model of
                            Delivery.Steer ->
                                "Steer"

                            Delivery.FollowUp ->
                                "Queue"

                            Delivery.Reject ->
                                "Send (reject when busy)"
                    , alternate =
                        SendMode
                            (if deliveryMode model == Delivery.Steer then
                                Delivery.FollowUp

                             else
                                Delivery.Steer
                            )
                    , alternateLabel =
                        if deliveryMode model == Delivery.Steer then
                            "Follow up"

                        else
                            "Steer"
                    , stop = Stop
                    }

            else
                Composer.Ready Send
        , submitDisabled =
            not available
                || submissionPending model.submission
                || (String.trim model.prompt == "" && List.isEmpty model.attachments)
                || List.any
                    (\item ->
                        case item.state of
                            Ready _ ->
                                False

                            _ ->
                                True
                    )
                    model.attachments
        }


confirmationView : Model -> { instructions : String, revision : Maybe Int } -> Html Msg
confirmationView model confirmation =
    let
        label =
            "Compaction instructions"
    in
    form [ class "compose-box", onSubmit Confirm ]
        [ textarea [ id "prompt", A.rows 2, A.placeholder (label ++ "…"), A.maxlength 100000, A.tabindex 1, attribute "aria-label" label, A.value confirmation.instructions, onInput EditConfirmation, keyDown model, Events.on "compositionstart" (D.succeed (Composition True)), Events.on "compositionend" (D.succeed (Composition False)) ] []
        , composerFeedback model
        , div [ class "actions" ] [ button [ class "icon", A.type_ "button", attribute "aria-label" "Cancel compaction", onClick Dismiss ] [ Icon.view "close" ], span [ class "spacer" ] [], button [ id "send", class "icon", attribute "aria-label" "Confirm compaction", A.disabled (operationPending model) ] [ Icon.view "check" ] ]
        ]


metadataView : Model -> Maybe Info -> Html Msg
metadataView model info =
    let
        lastUsage =
            Dict.values model.records
                |> List.filter (\entry -> entry.id > (model.snapshot |> Maybe.andThen .head |> Maybe.map .id |> Maybe.withDefault -1))
                |> List.reverse
                |> List.concatMap (.messages >> List.reverse)
                |> List.filter (\message -> message.role == "assistant" && not (List.member message.stopReason [ Just "error", Just "aborted" ]))
                |> List.head
                |> Maybe.andThen
                    (\message ->
                        if message.model == (info |> Maybe.andThen .model) then
                            message.usage

                        else
                            Nothing
                    )
                |> Maybe.andThen
                    (\usage ->
                        if usage.totalTokens > 0 || usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 then
                            Just usage

                        else
                            Nothing
                    )

        metric get =
            Maybe.map (get >> Data.tokens) (model.snapshot |> Maybe.andThen .usage) |> Maybe.withDefault "—"

        capacity =
            info |> Maybe.andThen .model |> Maybe.andThen (\key -> Read.observed model.capacities |> Maybe.andThen (List.filter (Tuple.first >> (==) key) >> List.head) |> Maybe.map Tuple.second)

        context =
            Maybe.map2
                (\usage total ->
                    ( if usage.totalTokens > 0 then
                        usage.totalTokens

                      else
                        usage.input + usage.cacheRead + usage.cacheWrite + usage.output
                    , total
                    )
                )
                lastUsage
                capacity

        contextText =
            (context
                |> Maybe.andThen
                    (\( used, total ) ->
                        if total > 0 then
                            Just (fixed1 (used / total * 100) ++ "%")

                        else
                            Nothing
                    )
                |> Maybe.withDefault "—"
            )
                ++ "/"
                ++ (capacity |> Maybe.map Data.tokens |> Maybe.withDefault "—")

        hit =
            lastUsage
                |> Maybe.map
                    (\usage ->
                        if usage.input + usage.cacheRead + usage.cacheWrite == 0 then
                            "CH—"

                        else
                            "CH" ++ fixed1 (100 * usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite)) ++ "%"
                    )
                |> Maybe.withDefault "CH—"

        cost =
            model.snapshot |> Maybe.andThen .usage |> Maybe.map (.cost >> (\n -> fixed3 n)) |> Maybe.withDefault "—"

        level =
            case context of
                Just ( used, total ) ->
                    if total > 0 && used / total > 0.9 then
                        "critical"

                    else if total > 0 && used / total > 0.7 then
                        "warning"

                    else
                        "normal"

                Nothing ->
                    "normal"
    in
    section
        [ id "session-meta"
        , attribute "data-save-state"
            (case model.configurationSave of
                Saving _ _ ->
                    "saving"

                SaveUncertain _ _ ->
                    "uncertain"

                NotSaving ->
                    "saved"
            )
        ]
        [ Composer.metadata
            { label = "Conversation statistics"
            , before = [ a [ id "footer-sessions", class "icon footer-chevron", href "/", attribute "aria-label" "Sessions", A.title "Sessions" ] [ Icon.view "chevron-left" ] ]
            , instance =
                div [ id "footer-instance", class "selector-summary" ]
                    [ Html.map ConfigurationMsg
                        (Configuration.viewEnvironmentPicker model.configuration.environment (Read.observed model.configuration.environments |> Maybe.andThen identity |> Maybe.map .nodes |> Maybe.withDefault []))
                    , span [ attribute "aria-hidden" "true" ] [ text ":" ]
                    , Configuration.viewDirectory
                        [ Events.onBlur CommitDirectory
                        , Events.custom "keydown"
                            (D.map2 Tuple.pair (D.field "key" D.string) (D.oneOf [ D.field "isComposing" D.bool, D.succeed False ])
                                |> D.andThen
                                    (\( key, composing ) ->
                                        if composing then
                                            D.fail "Composing"

                                        else if key == "Enter" then
                                            D.succeed ( CommitDirectory, True )

                                        else if key == "Escape" then
                                            D.succeed ( CancelDirectory, True )

                                        else
                                            D.fail "Editing directory"
                                    )
                                |> D.map (\( message, prevent ) -> { message = message, preventDefault = prevent, stopPropagation = prevent })
                            )
                        ]
                        EditDirectory
                        (Maybe.withDefault model.configuration.directory model.directoryDraft)
                    ]
            , statistics = [ span [ id "footer-stats" ] (List.map (\( key, value ) -> span [ id key ] [ text value ]) [ ( "footer-input", "↑" ++ metric .input ), ( "footer-output", "↓" ++ metric .output ), ( "footer-read", "R" ++ metric .cacheRead ), ( "footer-hit", hit ), ( "footer-cost", "$" ++ cost ) ]) ]
            , model = Html.map ConfigurationMsg (Configuration.viewModelControls { selected = Maybe.map (\choice -> { choice | name = choice.id }) model.configuration.selectedModel, thinking = model.configuration.thinking } model.configuration.models)
            , context = Just (span [ id "footer-context", class "context-usage", attribute "data-level" level ] [ text contextText ])
            , after =
                [ button
                    [ id "footer-collapse"
                    , class "icon footer-chevron"
                    , A.type_ "button"
                    , attribute "aria-controls" "composer-shell"
                    , attribute "aria-expanded"
                        (if model.expanded then
                            "true"

                         else
                            "false"
                        )
                    , attribute "aria-label"
                        (if model.expanded then
                            "Collapse composer"

                         else
                            "Expand composer"
                        )
                    , A.title
                        (if model.expanded then
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


fixed3 : Float -> String
fixed3 value =
    let
        scaled =
            round (value * 1000)
    in
    String.fromInt (scaled // 1000) ++ "." ++ String.padLeft 3 '0' (String.fromInt (modBy 1000 scaled))


connectionView : Model -> Html Msg
connectionView model =
    p
        [ id "connection"
        , attribute "role" "status"
        , class
            (if model.connection == Current then
                "sr-only"

             else
                "notice"
            )
        ]
        [ text
            (case model.connection of
                Connecting ->
                    if model.snapshot == Nothing then
                        "Loading live conversation…"

                    else
                        "Previous data is stale; reconnecting…"

                Current ->
                    "Connected"

                Stale ->
                    "Disconnected; previous data is stale. Reconnecting…"

                Broken reason ->
                    reason ++ " Previous data is stale."
            )
        ]


branchHeader : Model -> Html Msg
branchHeader model =
    let
        page =
            Read.observed model.branches |> Maybe.andThen identity

        branches =
            Maybe.map .nodes page |> Maybe.withDefault []

        parent branch =
            orElse branch.owner branch.parent

        native =
            Scalars.conversationIdValue

        roots =
            List.filter
                (\branch ->
                    case parent branch of
                        Nothing ->
                            True

                        Just id ->
                            not (List.any (.id >> (==) id) branches)
                )
                branches

        row visited branch =
            let
                children =
                    List.filter (\child -> parent child == Just branch.id && not (List.member (native child.id) (native branch.id :: visited))) branches
            in
            Html.li [ id ("branch-" ++ String.fromInt (native branch.id)) ]
                [ div [ class "branch-row" ]
                    [ a
                        [ href (Route.href (Route.Conversation model.externalId branch.id))
                        , attribute "aria-current"
                            (if model.address == Just branch.id then
                                "true"

                             else
                                "false"
                            )
                        ]
                        [ span [ class "branch-name" ] [ text ("Conversation " ++ String.fromInt (native branch.id)) ]
                        , Transcript.toolStatus
                            (if model.address == Just branch.id && model.display.live.busy then
                                "running"

                             else
                                "unavailable"
                            )
                        , span [ class "branch-time", attribute "aria-label" "Activity unavailable" ] [ text "—" ]
                        ]
                    ]
                , if List.isEmpty children then
                    text ""

                  else
                    Html.ul [] (List.map (row (native branch.id :: visited)) children)
                ]
    in
    Html.details [ id "branch-disclosure", class "branch-disclosure", A.classList [ ( "root-branches", model.address == Nothing ) ], A.property "open" (E.bool model.branchesOpen) ]
        [ Html.summary [ id "branch-toggle", Events.preventDefaultOn "click" (D.succeed ( BranchesOpen (not model.branchesOpen), True )), attribute "aria-label" "Conversation branches" ] [ Icon.view "fork", span [] [ text (model.address |> Maybe.map (native >> String.fromInt >> (++) "conversation ") |> Maybe.withDefault "branches") ], span [ class "branch-chevron", attribute "aria-hidden" "true" ] [ text "›" ] ]
        , Html.nav [ class "branch-panel", attribute "aria-label" "Conversation branches" ]
            [ if List.any (\branch -> parent branch /= Nothing) roots then
                p [ attribute "role" "status" ] [ text "Branch ancestry is incomplete." ]

              else
                text ""
            , Html.ul [ id "branch-tree" ] (List.map (row []) roots)
            , if List.isEmpty branches && not (Read.pending model.branches) then
                p [] [ text "No conversations" ]

              else
                text ""
            , Read.viewReadStatus "branches" RefreshBranches model.branches
            , button [ A.type_ "button", onClick RefreshBranches, A.disabled (Read.pending model.branches) ] [ text "Refresh branches" ]
            , if Maybe.andThen .next page /= Nothing then
                button [ A.type_ "button", onClick MoreBranches, A.disabled (Read.pending model.branches) ] [ text "More branches" ]

              else
                text ""
            ]
        ]


searchView : Model -> Html Msg
searchView model =
    let
        found =
            matches model
    in
    div [ id "search-bar", hidden (model.search == Nothing) ]
        [ div [ class "compose-box" ]
            [ input
                [ id "search"
                , A.type_ "search"
                , attribute "aria-label" "Find in conversation"
                , A.placeholder "Find in conversation…"
                , A.value (Maybe.withDefault "" model.search)
                , onInput Search
                , Events.on "keydown"
                    (D.field "key" D.string
                        |> D.map
                            (\key ->
                                if key == "Enter" then
                                    SearchMove 1

                                else
                                    NoOp
                            )
                    )
                ]
                []
            , div [ class "actions" ]
                [ Html.output [ id "search-count" ]
                    [ text
                        ((if List.isEmpty found then
                            "0/0"

                          else
                            String.fromInt (model.searchIndex + 1) ++ "/" ++ String.fromInt (List.length found)
                         )
                            ++ (if model.historyComplete then
                                    ""

                                else
                                    " · loaded messages only"
                               )
                        )
                    ]
                , span [ class "spacer" ] []
                , button [ id "search-prev", class "icon", onClick (SearchMove -1), attribute "aria-label" "Previous match" ] [ text "↑" ]
                , button [ id "search-next", class "icon", onClick (SearchMove 1), attribute "aria-label" "Next match" ] [ text "↓" ]
                ]
            ]
        ]


fixed1 : Float -> String
fixed1 value =
    let
        scaled =
            round (value * 10)
    in
    String.fromInt (scaled // 10) ++ "." ++ String.fromInt (modBy 10 scaled)


applyTimings : Query.TimingPage -> Model -> ( Model, Cmd Msg )
applyTimings page model =
    let
        direct =
            List.filterMap
                (\( target, duration ) ->
                    case target of
                        Query.Placed entryId ->
                            Just ( String.fromInt entryId, duration )

                        Query.Submitted _ _ ->
                            Nothing
                )
                page.nodes

        queued =
            List.filterMap
                (\( target, duration ) ->
                    case target of
                        Query.Placed _ ->
                            Nothing

                        Query.Submitted conversation id ->
                            Just ( conversation, id, duration )
                )
                page.nodes

        next =
            { model | durations = Dict.union (Dict.fromList direct) model.durations }
    in
    if List.isEmpty queued then
        ( next, Cmd.none )

    else
        ( { next | placements = Loading (Read.observed model.placements) }, Api.query PlacementsReceived (Query.placements model.externalId queued) )


created : Int -> String -> String -> Scalars.Id -> Info -> String -> List Attachment -> Url -> ( Model, Cmd Msg )
created epoch seed externalId harnessId info prompt attachments url =
    let
        ( initial, commands_ ) =
            init epoch seed externalId (Just info.id) url

        prepared =
            { initial | overview = Loaded (Just { harnessId = harnessId, info = Just info }), prompt = prompt, attachments = attachments, nextAttachment = List.length attachments } |> observeConfiguration (Just info)

        ( sending, command ) =
            send Delivery.FollowUp prepared
    in
    ( sending, Cmd.batch [ commands_, command ] )


conversationInfo : Model -> Maybe Info
conversationInfo model =
    Read.observed model.overview |> Maybe.andThen identity |> Maybe.andThen .info


deliveryMode : Model -> InputSubmissionDraftWhenBusy
deliveryMode model =
    if Read.observed model.preferences |> Maybe.andThen identity |> Maybe.map .steering |> Maybe.withDefault False then
        Delivery.Steer

    else
        Delivery.FollowUp


submissionPending : Submission -> Bool
submissionPending submission =
    case submission of
        Sending _ ->
            True

        Checking _ ->
            True

        Uncertain _ _ ->
            True

        _ ->
            False


send : InputSubmissionDraftWhenBusy -> Model -> ( Model, Cmd Msg )
send mode model =
    let
        requestId =
            model.seed ++ "-" ++ String.fromInt model.epoch ++ "-" ++ String.fromInt model.nextRequest
    in
    if model.composing || submissionPending model.submission then
        ( model, Cmd.none )

    else
        case ( conversationInfo model, Actions.capture requestId mode model.prompt model.attachments ) of
            ( Just info, Just input_ ) ->
                let
                    captured =
                        { revision = model.revision, requestId = requestId, input = input_ }
                in
                ( { model | submission = Sending captured, nextRequest = model.nextRequest + 1, preview = "" }, Api.mutation SubmissionReceived (Actions.submit info.globalId input_) )

            _ ->
                ( model, Cmd.none )


admitted : Capture -> Scalars.Id -> Model -> ( Model, Cmd Msg )
admitted captured id model =
    ( { model
        | submission = Admitted id
        , prompt =
            if model.revision == captured.revision then
                ""

            else
                model.prompt
        , attachments =
            if model.revision == captured.revision then
                []

            else
                model.attachments
      }
    , Cmd.none
    )


mutationProblem : Api.Response a -> String
mutationProblem response =
    case response of
        Ok _ ->
            "No acknowledgement was returned."

        Err failure ->
            case failure.problem of
                Api.HttpFailure 413 ->
                    "Submission too large for the server's request-body limit."

                Api.ExecutionFailure ->
                    "The server reported an operation error."

                _ ->
                    Read.errorMessage failure.problem


operationPending : Model -> Bool
operationPending model =
    case model.operation of
        Operating _ ->
            True

        _ ->
            False


operate : String -> (Info -> Graphql.SelectionSet.SelectionSet (Maybe Bool) Graphql.Operation.RootMutation) -> Model -> ( Model, Cmd Msg )
operate label selection model =
    case conversationInfo model of
        Just info ->
            if operationPending model then
                ( model, Cmd.none )

            else
                ( { model | operation = Operating label }, Api.mutation OperationReceived (selection info) )

        Nothing ->
            ( model, Cmd.none )


configurationSettings : Configuration.Model -> Settings
configurationSettings configuration =
    { agent = Configuration.agent configuration, env = configuration.environment |> Maybe.andThen .target }


observeConfiguration : Maybe Info -> Model -> Model
observeConfiguration info model =
    case info of
        Just value ->
            if configurationDirty model then
                model

            else
                let
                    before =
                        model.configuration

                    environment =
                        Read.observed before.environments
                            |> Maybe.andThen identity
                            |> Maybe.map .nodes
                            |> Maybe.withDefault []
                            |> List.filter (\item -> item.target /= Nothing && item.target == value.env)
                            |> List.head
                            |> orElse (Maybe.map (\target -> { id = value.globalId, unit = target.host, host = Just target.host, target = Just target }) value.env)

                    configuration =
                        { before
                            | directory = Maybe.withDefault "" value.cwd
                            , selectedModel = Maybe.map (\( provider, id ) -> { provider = provider, id = id, name = id, thinkingLevels = [] }) value.model
                            , thinking = Thinking.fromString value.thinking
                            , environment = environment
                        }
                in
                { model | configuration = configuration, baseline = Just (configurationSettings configuration) }

        Nothing ->
            model


configurationDirty : Model -> Bool
configurationDirty model =
    case model.baseline of
        Just baseline ->
            configurationSettings model.configuration /= baseline || model.configurationSave /= NotSaving

        Nothing ->
            False


clearDirectoryCommand : Maybe Int -> Model -> Model
clearDirectoryCommand revision model =
    { model
        | prompt =
            if revision == Just model.revision then
                ""

            else
                model.prompt
        , directoryRevision =
            if revision == model.directoryRevision then
                Nothing

            else
                model.directoryRevision
    }


saveConfiguration : Model -> ( Model, Cmd Msg )
saveConfiguration model =
    if model.configurationSave /= NotSaving || model.baseline == Nothing then
        ( model, Cmd.none )

    else if Just (configurationSettings model.configuration) == model.baseline then
        ( clearDirectoryCommand model.directoryRevision model, Cmd.none )

    else
        configure (configurationSettings model.configuration) model.directoryRevision model


configure : Settings -> Maybe Int -> Model -> ( Model, Cmd Msg )
configure captured revision model =
    case ( model.baseline, conversationInfo model ) of
        ( Just baseline, Just info ) ->
            let
                changed before after =
                    if before == after then
                        Absent

                    else
                        after

                change =
                    Input.buildAgentChange (\args -> { args | cwd = changed baseline.agent.cwd captured.agent.cwd, model = changed baseline.agent.model captured.agent.model, thinkingLevel = changed baseline.agent.thinkingLevel captured.agent.thinkingLevel })

                env =
                    if baseline.env == captured.env then
                        Absent

                    else
                        Maybe.map Present captured.env |> Maybe.withDefault Null
            in
            ( { model | configurationSave = Saving captured revision, overviewGeneration = model.overviewGeneration + 1 }
            , Api.mutation Configured (Actions.configure info.globalId change env)
            )

        _ ->
            ( model, Cmd.none )


composerFeedback : Model -> Html Msg
composerFeedback model =
    let
        silent =
            case model.submission of
                Unsent ->
                    True

                Admitted _ ->
                    True

                _ ->
                    False
    in
    div [ class "composer-feedback", hidden (silent && model.operation == NoOperation && model.preview == "" && not (configurationUncertain model)) ]
        [ p [ id "composer-error", class "error", attribute "role" "status", hidden (model.preview == "") ] [ text model.preview ]
        , div
            [ attribute "role" "status"
            , id "delivery-status"
            , hidden silent
            , attribute "data-state"
                (case model.submission of
                    Unsent ->
                        "unsent"

                    Sending _ ->
                        "sending"

                    Checking _ ->
                        "checking"

                    Uncertain _ _ ->
                        "uncertain"

                    RejectedInput _ ->
                        "rejected"

                    Admitted _ ->
                        "admitted"
                )
            ]
            (case model.submission of
                Unsent ->
                    []

                Sending _ ->
                    [ text "Sending…" ]

                Checking _ ->
                    [ text "Checking delivery…" ]

                Admitted _ ->
                    []

                RejectedInput problem ->
                    [ text problem ]

                Uncertain _ problem ->
                    [ text ("Delivery uncertain. " ++ problem)
                    , button [ A.type_ "button", onClick CheckReceipt ] [ text "Check receipt" ]
                    , button [ A.type_ "button", onClick RetrySubmission ] [ text "Retry captured input" ]
                    ]
            )
        , if configurationUncertain model then
            button [ A.type_ "button", class "icon", attribute "aria-label" "Retry settings", A.title "Retry settings", onClick RetryConfiguration ] [ text "↻" ]

          else
            text ""
        , div [ id "operation-status", attribute "role" "status", hidden (model.operation == NoOperation) ]
            [ text
                (case model.operation of
                    NoOperation ->
                        ""

                    Operating label ->
                        label ++ "…"

                    OperationNotice notice ->
                        notice
                )
            ]
        ]


configurationUncertain : Model -> Bool
configurationUncertain model =
    case model.configurationSave of
        SaveUncertain _ _ ->
            True

        _ ->
            False
