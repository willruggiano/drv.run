module StateTest exposing (tests)

import Autosave
import Browser
import Dict
import Expect
import Html
import Http
import Json.Decode as D
import Json.Encode as E
import Main
import Panel
import Protocol
import Test exposing (describe, test)
import Test.Html.Event as Event
import Test.Html.Query as Query
import Url


tests : Test.Test
tests =
    describe "Conversation state boundaries"
        [ test "acknowledgement clears only its captured revision" <|
            \_ ->
                let
                    model =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    ( edited, _ ) =
                        Main.update (Main.Edit "original") model

                    ( submitted, _ ) =
                        Main.update (Main.Send "reject") edited

                    ( newer, _ ) =
                        Main.update (Main.Edit "newer") submitted
                in
                case Dict.get model.path submitted.drafts |> Maybe.andThen .pending of
                    Nothing ->
                        Expect.fail "Missing pending submission"

                    Just pending ->
                        let
                            ( acknowledged, _ ) =
                                Main.update (Main.Acknowledged model.path pending (Ok ( pending.identity, pending.revision ))) newer
                        in
                        Expect.equal ( Just "newer", Just Nothing ) ( Dict.get model.path acknowledged.drafts |> Maybe.map .text, Dict.get model.path acknowledged.drafts |> Maybe.map .pending )
        , test "late acknowledgement affects only the old conversation draft" <|
            \_ ->
                let
                    model =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    ( edited, _ ) =
                        Main.update (Main.Edit "original") model

                    ( submitted, _ ) =
                        Main.update (Main.Send "reject") edited

                    other =
                        { submitted | path = "/sessions/other/conversations/1" }

                    ( newer, _ ) =
                        Main.update (Main.Edit "other draft") other
                in
                case Dict.get model.path submitted.drafts |> Maybe.andThen .pending of
                    Nothing ->
                        Expect.fail "Missing pending submission"

                    Just pending ->
                        let
                            ( acknowledged, _ ) =
                                Main.update (Main.Acknowledged model.path pending (Ok ( pending.identity, pending.revision ))) newer
                        in
                        Expect.equal ( Just "", Just "other draft" ) ( Dict.get model.path acknowledged.drafts |> Maybe.map .text, Dict.get other.path acknowledged.drafts |> Maybe.map .text )
        , test "missing sequence is rejected without updating observations" <|
            \_ ->
                let
                    initial =
                        Protocol.empty

                    snapshot =
                        { subscription = "a", sequence = 1, snapshot = True, conversation = 1, entries = [], tools = [], live = Just initial.live, queue = Just [], metadata = Just initial.metadata, inspection = Nothing }
                in
                case Protocol.apply 1 snapshot initial of
                    Err reason ->
                        Expect.fail reason

                    Ok state ->
                        Expect.equal (Err "Discontinuous stream") (Protocol.apply 1 { snapshot | snapshot = False, sequence = 3 } state)
        , test "a new connection snapshot replaces observations but rejects duplicate snapshots" <|
            \_ ->
                let
                    initial =
                        Protocol.empty

                    snapshot =
                        { subscription = "a", sequence = 1, snapshot = True, conversation = 1, entries = [], tools = [], live = Just initial.live, queue = Just [], metadata = Just initial.metadata, inspection = Nothing }
                in
                case Protocol.apply 1 snapshot initial of
                    Err reason ->
                        Expect.fail reason

                    Ok state ->
                        Expect.equal (Err "Invalid snapshot") (Protocol.apply 1 snapshot state)
        , test "malformed optional regions fail decoding instead of becoming absent" <|
            \_ ->
                case D.decodeString Protocol.frameDecoder "{\"version\":1,\"subscription\":\"a\",\"sequence\":2,\"snapshot\":false,\"conversation\":1,\"entries\":[],\"tools\":[],\"live\":{\"busy\":\"invalid\"}}" of
                    Err _ ->
                        Expect.pass

                    Ok _ ->
                        Expect.fail "Accepted a malformed live region"
        , test "reconnect snapshot removes obsolete observations" <|
            \_ ->
                let
                    initial =
                        Protocol.empty

                    snapshot =
                        { subscription = "a", sequence = 1, snapshot = True, conversation = 1, entries = [ { id = 1, boundary = Protocol.Normal, messages = [] } ], tools = [], live = Just initial.live, queue = Just [], metadata = Just initial.metadata, inspection = Nothing }
                in
                case Protocol.apply 1 snapshot initial |> Result.andThen (Protocol.apply 1 { snapshot | subscription = "b", entries = [] }) of
                    Err reason ->
                        Expect.fail reason

                    Ok state ->
                        Expect.equal Dict.empty state.entries
        , test "stale acknowledgements cannot clear a newer pending operation or its error" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    submitted =
                        Main.update (Main.Edit "first") base |> Tuple.first |> Main.update (Main.Send "reject") |> Tuple.first
                in
                case Dict.get base.path submitted.drafts |> Maybe.andThen .pending of
                    Nothing ->
                        Expect.fail "Missing pending request"

                    Just pending ->
                        let
                            newer =
                                Main.update (Main.Acknowledged base.path pending (Err Http.NetworkError)) submitted |> Tuple.first |> Main.update (Main.Edit "second") |> Tuple.first |> Main.update (Main.Send "reject") |> Tuple.first

                            failed =
                                { newer | error = "New operation error", confirmation = (Main.initModel (base.path ++ "/reset") "nonce").confirmation }
                        in
                        Expect.all [ \_ -> Expect.equal failed (Main.update (Main.Acknowledged base.path pending (Ok ( pending.identity, pending.revision ))) failed |> Tuple.first), \_ -> Expect.equal failed (Main.update (Main.Acknowledged base.path pending (Err Http.NetworkError)) failed |> Tuple.first) ] ()
        , test "editing preserves an error until a new submission replaces the failed operation" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    submitted =
                        Main.update (Main.Edit "original") base |> Tuple.first |> Main.update (Main.Send "reject") |> Tuple.first
                in
                case Dict.get base.path submitted.drafts |> Maybe.andThen .pending of
                    Nothing ->
                        Expect.fail "Missing pending request"

                    Just pending ->
                        let
                            failed =
                                Main.update (Main.Acknowledged base.path pending (Err (Http.BadStatus 503))) submitted |> Tuple.first

                            edited =
                                Main.update (Main.Edit "updated") failed |> Tuple.first

                            next =
                                Main.update (Main.Send "reject") edited |> Tuple.first

                            identity model =
                                Dict.get base.path model.drafts |> Maybe.andThen .pending |> Maybe.map .identity
                        in
                        Expect.all
                            [ \_ -> Expect.equal (Dict.get base.path failed.drafts |> Maybe.andThen .pending) (Dict.get base.path edited.drafts |> Maybe.andThen .pending)
                            , \_ -> Expect.notEqual (identity failed) (identity next)
                            , \_ -> Expect.equal next (Main.update (Main.Send "reject") next |> Tuple.first)
                            , \_ -> Expect.equal "" next.error
                            ]
                            ()
        , test "Send retries unchanged failed input with its original identity and mode" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    submitted =
                        Main.update (Main.Edit "original") base |> Tuple.first |> Main.update (Main.Send "steer") |> Tuple.first
                in
                case Dict.get base.path submitted.drafts |> Maybe.andThen .pending of
                    Nothing ->
                        Expect.fail "Missing pending request"

                    Just pending ->
                        let
                            retried =
                                Main.update (Main.Acknowledged base.path pending (Err Http.NetworkError)) submitted |> Tuple.first |> Main.update (Main.Send "reject") |> Tuple.first
                        in
                        Expect.equal (Just pending) (Dict.get base.path retried.drafts |> Maybe.andThen .pending)
        , test "client errors survive editing and clear on submission" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    failed =
                        Main.update (Main.Edit "/unsupported") base |> Tuple.first |> Main.update (Main.Send "reject") |> Tuple.first

                    edited =
                        Main.update (Main.Edit "valid input") failed |> Tuple.first

                    submitted =
                        Main.update (Main.Send "reject") edited |> Tuple.first
                in
                Expect.all [ \_ -> Expect.notEqual "" failed.error, \_ -> Expect.equal failed.error edited.error, \_ -> Expect.equal "" submitted.error ] ()
        , test "Send checks an attachment-only restored request without resending it as text" <|
            \_ ->
                case D.decodeString Main.draftDecoder "{\"text\":\"\",\"revision\":\"r1\",\"missingFiles\":true,\"pending\":{\"identity\":\"r1:submit\",\"revision\":\"r1\",\"text\":\"\",\"mode\":\"reject\",\"command\":\"submit\",\"argument\":\"\",\"clear\":true,\"missingFiles\":true}}" of
                    Err error ->
                        Expect.fail (D.errorToString error)

                    Ok draft ->
                        let
                            base =
                                Main.initModel "/sessions/test/conversations/1" "nonce"

                            checking =
                                Main.update (Main.Send "reject") { base | drafts = Dict.singleton base.path draft } |> Tuple.first
                        in
                        case Dict.get base.path checking.drafts |> Maybe.andThen .pending of
                            Nothing ->
                                Expect.fail "Missing original request"

                            Just pending ->
                                let
                                    acknowledged =
                                        Main.update (Main.Receipt base.path pending (Ok True)) checking |> Tuple.first
                                in
                                Expect.equal ( ( True, "r1:submit" ), Just Nothing ) ( ( pending.missingFiles, pending.identity ), Dict.get base.path acknowledged.drafts |> Maybe.map .pending )
        , describe "delivery shortcuts"
            (List.concatMap
                (\delivery ->
                    List.map
                        (\shortcut ->
                            test (delivery.label ++ " " ++ shortcut.name) <|
                                \_ ->
                                    let
                                        base =
                                            Main.initModel "/sessions/test/conversations/1" "nonce"

                                        state =
                                            base.state

                                        metadata =
                                            state.metadata

                                        model =
                                            { base | state = { state | metadata = { metadata | defaultDeliveryMode = delivery.mode } }, completions = Just { start = 0, end = 1, items = [] } }
                                    in
                                    Html.textarea [ Main.keyDown model ] []
                                        |> Query.fromHtml
                                        |> Event.simulate (Event.custom "keydown" (E.object [ ( "key", E.string "Enter" ), ( "ctrlKey", E.bool shortcut.ctrl ), ( "metaKey", E.bool shortcut.meta ), ( "altKey", E.bool shortcut.alt ), ( "isComposing", E.bool shortcut.composing ) ]))
                                        |> Event.expect shortcut.expected
                        )
                        [ { name = "Ctrl+Enter", ctrl = True, meta = False, alt = False, composing = False, expected = Main.Send delivery.primary }
                        , { name = "Cmd+Enter", ctrl = False, meta = True, alt = False, composing = False, expected = Main.Send delivery.primary }
                        , { name = "Alt+Enter", ctrl = False, meta = False, alt = True, composing = False, expected = Main.Send delivery.alternate }
                        , { name = "IME Ctrl+Enter", ctrl = True, meta = False, alt = False, composing = True, expected = Main.NoOp }
                        , { name = "IME Alt+Enter", ctrl = False, meta = False, alt = True, composing = True, expected = Main.NoOp }
                        ]
                )
                [ { label = "steering", mode = Protocol.Steering, primary = "steer", alternate = "followUp" }, { label = "follow-up", mode = Protocol.FollowUp, primary = "followUp", alternate = "steer" } ]
            )
        , test "navigation ends composition and invalidates completion callbacks" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1" "nonce"
                in
                case Url.fromString "http://localhost/sessions/other/conversations/1" of
                    Nothing ->
                        Expect.fail "Invalid fixture URL"

                    Just url ->
                        let
                            next =
                                Main.update (Main.UrlChanged url) { base | composing = True } |> Tuple.first

                            late =
                                Main.update (Main.Completed base.completionRequest base.path (Ok { start = 0, end = 1, items = [ { label = "stale", value = "stale", description = Nothing } ] })) next |> Tuple.first
                        in
                        Expect.equal ( False, Nothing ) ( late.composing, late.completions )
        , test "duplicate, stale and out-of-order frames preserve the previous state" <|
            \_ ->
                let
                    initial =
                        Protocol.empty

                    state =
                        { initial | subscription = "current", sequence = 5 }

                    frame =
                        { subscription = "current", sequence = 6, snapshot = False, conversation = 1, entries = [], tools = [], live = Nothing, queue = Nothing, metadata = Nothing, inspection = Nothing }
                in
                Expect.all
                    (List.map
                        (\bad _ ->
                            case Protocol.apply 1 bad state of
                                Err _ ->
                                    Expect.pass

                                Ok _ ->
                                    Expect.fail "Accepted invalid frame"
                        )
                        [ { frame | sequence = 5 }, { frame | sequence = 4 }, { frame | sequence = 7 }, { frame | subscription = "old" }, { frame | conversation = 2 } ]
                    )
                    ()
        , test "dismissed completion responses cannot reopen the popup" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    requested =
                        Main.update (Main.Caret 0) base |> Tuple.first

                    dismissed =
                        Main.update Main.Dismiss requested |> Tuple.first

                    completed =
                        Main.update (Main.Completed requested.completionRequest requested.path (Ok { start = 0, end = 0, items = [ { label = "late", value = "late", description = Nothing } ] })) dismissed |> Tuple.first
                in
                Expect.equal dismissed completed
        , test "previously persisted text submissions retain their retry identity" <|
            \_ ->
                case D.decodeString Main.draftDecoder "{\"text\":\"original\",\"revision\":\"r1\",\"missingFiles\":false,\"pending\":{\"identity\":\"r1:submit\",\"revision\":\"r1\",\"text\":\"original\",\"mode\":\"reject\",\"command\":\"submit\",\"argument\":\"\",\"clear\":true}}" of
                    Err error ->
                        Expect.fail (D.errorToString error)

                    Ok draft ->
                        Expect.equal (Just ( "r1:submit", False )) (Maybe.map (\pending -> ( pending.identity, pending.missingFiles )) draft.pending)
        , test "session panel routes retain conversation identity and local state" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1" "nonce"

                    edited =
                        Main.update (Main.Edit "draft") base |> Tuple.first

                    collapsed =
                        Main.update Main.Collapse edited |> Tuple.first
                in
                case Url.fromString "http://localhost/sessions/test/conversations/1/settings" of
                    Nothing ->
                        Expect.fail "Invalid test URL"

                    Just url ->
                        let
                            panel =
                                Main.update (Main.UrlChanged url) collapsed |> Tuple.first
                        in
                        Expect.equal { path = base.path, drafts = collapsed.drafts, state = collapsed.state, expanded = False, epoch = base.epoch + 1 } { path = panel.path, drafts = panel.drafts, state = panel.state, expanded = panel.composerExpanded, epoch = panel.epoch }
        , test "settings autosave drains newer edits without overwriting them" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1/settings" "nonce"

                    initial =
                        { name = "Initial", model = "model", target = "target", thinking = "off", directory = "", models = [], targets = [] }

                    loaded =
                        Main.update (Main.SettingsLoaded base.epoch (Ok initial)) base |> Tuple.first

                    edited =
                        Main.update (Main.EditSetting Panel.Name "First") loaded |> Tuple.first

                    saving =
                        Main.update Main.SaveSettings edited |> Tuple.first

                    newer =
                        Main.update (Main.EditSetting Panel.Name "Second") saving |> Tuple.first

                    acknowledged =
                        Main.update (Main.SettingsSaved base.epoch (Ok True)) newer |> Tuple.first
                in
                Expect.equal ( Just "Second", Just "Second", Just False ) ( Maybe.map (Autosave.current >> .name) acknowledged.settings, Maybe.andThen Autosave.pending acknowledged.settings |> Maybe.map .name, Maybe.map Autosave.canLeave acknowledged.settings )
        , test "late panel loads and saves cannot replace another route's state" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/other/conversations/1/settings" "nonce"

                    current =
                        { base | epoch = 2 }

                    stale =
                        { name = "Old", model = "model", target = "target", thinking = "off", directory = "", models = [], targets = [] }
                in
                Expect.all
                    (List.map (\msg _ -> Expect.equal current (Main.update msg current |> Tuple.first))
                        [ Main.SettingsLoaded 1 (Ok stale), Main.SettingsSaved 1 (Ok True), Main.Directories 1 0 (Ok [ "old" ]) ]
                    )
                    ()
        , test "settings failure invalidates the baseline even after reverting the edit" <|
            \_ ->
                let
                    base =
                        Main.initModel "/sessions/test/conversations/1/settings" "nonce"

                    initial =
                        { name = "Initial", model = "model", target = "target", thinking = "off", directory = "", models = [], targets = [] }

                    failed =
                        Main.update (Main.SettingsLoaded base.epoch (Ok initial)) base
                            |> Tuple.first
                            |> Main.update (Main.EditSetting Panel.Name "Changed")
                            |> Tuple.first
                            |> Main.update Main.SaveSettings
                            |> Tuple.first
                            |> Main.update (Main.EditSetting Panel.Name "Initial")
                            |> Tuple.first
                            |> Main.update (Main.SettingsSaved base.epoch (Err Http.NetworkError))
                            |> Tuple.first

                    retried =
                        Main.update Main.SaveSettings failed |> Tuple.first
                in
                Expect.equal
                    ( Just False, Just False, Just "Initial" )
                    ( Maybe.map Autosave.canLeave failed.settings, Maybe.map Autosave.busy failed.settings, Maybe.andThen Autosave.pending retried.settings |> Maybe.map .name )
        , test "settings navigation waits for the last captured save" <|
            \_ ->
                case Url.fromString "http://localhost/sessions/other/conversations/1" of
                    Nothing ->
                        Expect.fail "Invalid URL"

                    Just url ->
                        let
                            base =
                                Main.initModel "/sessions/test/conversations/1/settings" "nonce"

                            initial =
                                { name = "Initial", model = "model", target = "target", thinking = "off", directory = "", models = [], targets = [] }

                            waiting =
                                Main.update (Main.SettingsLoaded base.epoch (Ok initial)) base
                                    |> Tuple.first
                                    |> Main.update (Main.EditSetting Panel.Name "First")
                                    |> Tuple.first
                                    |> Main.update Main.SaveSettings
                                    |> Tuple.first
                                    |> Main.update (Main.EditSetting Panel.Name "Second")
                                    |> Tuple.first
                                    |> Main.update (Main.UrlRequested (Browser.Internal url))
                                    |> Tuple.first

                            draining =
                                Main.update (Main.SettingsSaved base.epoch (Ok True)) waiting |> Tuple.first

                            settled =
                                Main.update (Main.SettingsSaved base.epoch (Ok True)) draining |> Tuple.first
                        in
                        Expect.equal
                            ( ( Just (Browser.Internal url), Just (Browser.Internal url) ), ( Nothing, Just True ) )
                            ( ( waiting.nextNavigation, draining.nextNavigation ), ( settled.nextNavigation, Maybe.map Autosave.canLeave settled.settings ) )
        ]
