module AutosaveTest exposing (tests)

import Autosave
import Expect
import Test exposing (describe, test)


inFlight : Autosave.State String
inFlight =
    Autosave.init "initial"
        |> Autosave.edit (always "first")
        |> Autosave.start
        |> Tuple.first


tests : Test.Test
tests =
    describe "Single-flight autosave"
        ([ test "clean state neither saves nor blocks navigation" <|
            \_ ->
                let
                    state =
                        Autosave.init "initial"
                in
                Expect.equal ( ( state, Nothing ), True ) ( Autosave.start state, Autosave.canLeave state )
         , test "edits do not overwrite the captured request or start another" <|
            \_ ->
                let
                    edited =
                        Autosave.edit (always "newer") inFlight
                in
                Expect.equal
                    ( "newer", Just "first", ( edited, Nothing ) )
                    ( Autosave.current edited, Autosave.pending edited, Autosave.start edited )
         , test "acknowledgement drains the latest edits before allowing navigation" <|
            \_ ->
                let
                    ( draining, request ) =
                        inFlight |> Autosave.edit (always "newer") |> Autosave.succeed

                    ( settled, extra ) =
                        Autosave.succeed draining
                in
                Expect.equal
                    ( ( Just "newer", Just "newer", False ), ( "newer", Nothing, True ) )
                    ( ( request, Autosave.pending draining, Autosave.canLeave draining ), ( Autosave.current settled, extra, Autosave.canLeave settled ) )
         , test "reverting during a save still waits and then writes the reverted values" <|
            \_ ->
                let
                    reverted =
                        Autosave.edit (always "initial") inFlight

                    ( compensating, request ) =
                        Autosave.succeed reverted
                in
                Expect.equal
                    ( ( False, False ), ( Just "initial", Just "initial" ) )
                    ( ( Autosave.dirty reverted, Autosave.canLeave reverted ), ( request, Autosave.pending compensating ) )
         , test "loading a baseline does not discard an in-flight request" <|
            \_ ->
                let
                    loaded =
                        Autosave.load "loaded" inFlight
                in
                Expect.equal
                    ( "loaded", Just "first", Just "loaded" )
                    ( Autosave.current loaded, Autosave.pending loaded, Tuple.second (Autosave.succeed loaded) )
         , test "idle acknowledgements and failures cannot mutate the baseline" <|
            \_ ->
                let
                    state =
                        Autosave.init "initial"
                in
                Expect.equal
                    ( ( state, Nothing ), state )
                    ( Autosave.succeed state, Autosave.fail Autosave.ForgetBaseline state )
         ]
            ++ List.map
                (\( label, policy, retry ) ->
                    describe label
                        [ test "failure retains edits and requires an explicit retry" <|
                            \_ ->
                                let
                                    failed =
                                        inFlight |> Autosave.edit (always "newer") |> Autosave.fail policy
                                in
                                Expect.equal
                                    ( ( "newer", Nothing, False ), Just "newer" )
                                    ( ( Autosave.current failed, Autosave.pending failed, Autosave.canLeave failed ), Tuple.second (Autosave.start failed) )
                        , test "reverting after failure uses the owner's baseline policy" <|
                            \_ ->
                                let
                                    failed =
                                        inFlight |> Autosave.fail policy |> Autosave.edit (always "initial")
                                in
                                Expect.equal
                                    ( retry, retry == Nothing )
                                    ( Tuple.second (Autosave.start failed), Autosave.canLeave failed )
                        ]
                )
                [ ( "Keep acknowledged baseline", Autosave.KeepBaseline, Nothing )
                , ( "Forget uncertain baseline", Autosave.ForgetBaseline, Just "initial" )
                ]
        )
