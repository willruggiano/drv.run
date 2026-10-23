module StateTest exposing (tests)

import Dict
import Expect
import Http
import Json.Decode as D
import Main
import Protocol
import Test exposing (describe, test)
import Url


tests : Test.Test
tests =
    describe "Conversation state boundaries"
        [ test "acknowledgement clears only its captured revision" <|
            \_ ->
                let
                    model =
                        Main.initModel "/elm/sessions/test/conversations/1" "nonce"

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
                        Main.initModel "/elm/sessions/test/conversations/1" "nonce"

                    ( edited, _ ) =
                        Main.update (Main.Edit "original") model

                    ( submitted, _ ) =
                        Main.update (Main.Send "reject") edited

                    other =
                        { submitted | path = "/elm/sessions/other/conversations/1" }

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
                        { subscription = "a", sequence = 1, snapshot = True, conversation = 1, entries = [], tools = [], live = Just initial.live, queue = Just [], metadata = Just initial.metadata }
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
                        { subscription = "a", sequence = 1, snapshot = True, conversation = 1, entries = [], tools = [], live = Just initial.live, queue = Just [], metadata = Just initial.metadata }
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
                        { subscription = "a", sequence = 1, snapshot = True, conversation = 1, entries = [ { id = 1, boundary = Protocol.Normal, messages = [] } ], tools = [], live = Just initial.live, queue = Just [], metadata = Just initial.metadata }
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
                        Main.initModel "/elm/sessions/test/conversations/1" "nonce"

                    submitted =
                        Main.update (Main.Edit "first") base |> Tuple.first |> Main.update (Main.Send "reject") |> Tuple.first
                in
                case Dict.get base.path submitted.drafts |> Maybe.andThen .pending of
                    Nothing ->
                        Expect.fail "Missing pending request"

                    Just pending ->
                        let
                            newer =
                                Main.update Main.DismissPending submitted |> Tuple.first |> Main.update (Main.Edit "second") |> Tuple.first |> Main.update (Main.Send "reject") |> Tuple.first

                            failed =
                                { newer | error = "New operation error", reset = Just "new reset" }
                        in
                        Expect.all [ \_ -> Expect.equal failed (Main.update (Main.Acknowledged base.path pending (Ok ( pending.identity, pending.revision ))) failed |> Tuple.first), \_ -> Expect.equal failed (Main.update (Main.Acknowledged base.path pending (Err Http.NetworkError)) failed |> Tuple.first) ] ()
        , test "dismissed and old-route catalog callbacks cannot reopen navigation" <|
            \_ ->
                let
                    base =
                        Main.initModel "/elm/sessions/test/conversations/1" "nonce"
                in
                Expect.all [ \_ -> Expect.equal Nothing (Main.update (Main.Catalog base.epoch (Ok [])) base |> Tuple.first).catalog, \_ -> Expect.equal (Just []) (Main.update (Main.Catalog (base.epoch - 1) (Ok [ ( "stale", "stale" ) ])) { base | catalog = Just [] } |> Tuple.first).catalog ] ()
        , test "navigation ends composition and invalidates completion callbacks" <|
            \_ ->
                let
                    base =
                        Main.initModel "/elm/sessions/test/conversations/1" "nonce"
                in
                case Url.fromString "http://localhost/elm/sessions/other/conversations/1" of
                    Nothing ->
                        Expect.fail "Invalid fixture URL"

                    Just url ->
                        let
                            next =
                                Main.update (Main.UrlChanged url) { base | composing = True } |> Tuple.first

                            late =
                                Main.update (Main.Completed base.completionRequest base.path (Ok { start = 0, end = 1, items = [ { label = "stale", value = "stale" } ] })) next |> Tuple.first
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
                        { subscription = "current", sequence = 6, snapshot = False, conversation = 1, entries = [], tools = [], live = Nothing, queue = Nothing, metadata = Nothing }
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
                        Main.initModel "/elm/sessions/test/conversations/1" "nonce"

                    requested =
                        Main.update (Main.Caret 0) base |> Tuple.first

                    dismissed =
                        Main.update Main.Dismiss requested |> Tuple.first

                    completed =
                        Main.update (Main.Completed requested.completionRequest requested.path (Ok { start = 0, end = 0, items = [ { label = "late", value = "late" } ] })) dismissed |> Tuple.first
                in
                Expect.equal dismissed completed
        , test "previously persisted text submissions retain their retry identity" <|
            \_ ->
                case D.decodeString Main.draftDecoder "{\"text\":\"original\",\"revision\":\"r1\",\"missingFiles\":false,\"pending\":{\"identity\":\"r1:submit\",\"revision\":\"r1\",\"text\":\"original\",\"mode\":\"reject\",\"command\":\"submit\",\"argument\":\"\",\"clear\":true}}" of
                    Err error ->
                        Expect.fail (D.errorToString error)

                    Ok draft ->
                        Expect.equal (Just ( "r1:submit", False )) (Maybe.map (\pending -> ( pending.identity, pending.missingFiles )) draft.pending)
        ]
