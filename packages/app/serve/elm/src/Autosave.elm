module Autosave exposing (FailurePolicy(..), State, busy, canLeave, current, dirty, edit, fail, init, load, pending, start, succeed)


type State value
    = State
        { current : value
        , acknowledged : Maybe value
        , pending : Maybe value
        }


type FailurePolicy
    = KeepBaseline
    | ForgetBaseline


init : value -> State value
init value =
    State { current = value, acknowledged = Just value, pending = Nothing }


load : value -> State value -> State value
load value (State state) =
    State { state | current = value, acknowledged = Just value }


current : State value -> value
current (State state) =
    state.current


pending : State value -> Maybe value
pending (State state) =
    state.pending


busy : State value -> Bool
busy state =
    pending state /= Nothing


dirty : State value -> Bool
dirty (State state) =
    Just state.current /= state.acknowledged


canLeave : State value -> Bool
canLeave state =
    not (busy state) && not (dirty state)


edit : (value -> value) -> State value -> State value
edit change (State state) =
    State { state | current = change state.current }


start : State value -> ( State value, Maybe value )
start ((State state) as original) =
    if busy original || not (dirty original) then
        ( original, Nothing )

    else
        ( State { state | pending = Just state.current }, Just state.current )


succeed : State value -> ( State value, Maybe value )
succeed ((State state) as original) =
    case state.pending of
        Nothing ->
            ( original, Nothing )

        Just saved ->
            start (State { state | acknowledged = Just saved, pending = Nothing })


fail : FailurePolicy -> State value -> State value
fail policy ((State state) as original) =
    if not (busy original) then
        original

    else
        State
            { state
                | pending = Nothing
                , acknowledged =
                    case policy of
                        KeepBaseline ->
                            state.acknowledged

                        ForgetBaseline ->
                            Nothing
            }
