module Watch exposing (apply)

import Array
import Dict
import Json.Decode as D exposing (Decoder)
import Json.Encode as E
import Set



-- Decoded Chord operations, as emitted by api/watch. Every batch is atomic.
-- See the pinned chord/delta apply() implementation (t drops a UTF-16 prefix).


type Segment
    = Key String
    | Index Int


type Op
    = Replace E.Value
    | Set (List Segment) E.Value
    | Delete (List Segment)
    | Append (List Segment) String
    | Trim (List Segment) Int
    | Splice (List Segment) Int Int (List E.Value)
    | Move (List Segment) (List Int)


apply : Maybe E.Value -> E.Value -> Result String E.Value
apply previous batch =
    D.decodeValue (D.list operation) batch
        |> Result.mapError (always "Invalid watch operation batch.")
        |> Result.andThen
            (\ops ->
                case ( previous, ops ) of
                    ( Nothing, (Replace value) :: rest ) ->
                        List.foldl (\op state -> Result.andThen (applyOp op) state) (Ok value) rest

                    ( Just value, _ ) ->
                        List.foldl (\op state -> Result.andThen (applyOp op) state) (Ok value) ops

                    _ ->
                        Err "A fresh watch baseline is required."
            )


natural : Decoder Int
natural =
    D.int
        |> D.andThen
            (\n ->
                if n >= 0 && n <= 9007199254740991 then
                    D.succeed n

                else
                    D.fail "Invalid index"
            )


segment : Decoder Segment
segment =
    D.oneOf
        [ D.map Index natural
        , D.string
            |> D.andThen
                (\key ->
                    if List.member key [ "__proto__", "prototype", "constructor" ] then
                        D.fail "Unsafe path"

                    else
                        D.succeed (Key key)
                )
        ]


operation : Decoder Op
operation =
    D.list D.value
        |> D.andThen
            (\parts ->
                let
                    decode decoder value =
                        D.decodeValue decoder value |> Result.mapError D.errorToString

                    path value =
                        decode (D.list segment) value

                    result =
                        case parts of
                            [ verb, value ] ->
                                case D.decodeValue D.string verb of
                                    Ok "r" ->
                                        Ok (Replace value)

                                    Ok "d" ->
                                        path value |> Result.map Delete

                                    _ ->
                                        Err "Invalid operation"

                            [ verb, address, value ] ->
                                case D.decodeValue D.string verb of
                                    Ok "s" ->
                                        Result.map (\p -> Set p value) (path address)

                                    Ok "a" ->
                                        Result.map2 Append (path address) (decode D.string value)

                                    Ok "t" ->
                                        Result.map2 Trim (path address) (decode natural value)

                                    Ok "m" ->
                                        Result.map2 Move (path address) (decode (D.list natural) value)

                                    _ ->
                                        Err "Invalid operation"

                            [ verb, address, index, count, values ] ->
                                if D.decodeValue D.string verb == Ok "p" then
                                    Result.map4 Splice (path address) (decode natural index) (decode natural count) (decode (D.list D.value) values)

                                else
                                    Err "Invalid operation"

                            _ ->
                                Err "Invalid operation"
                in
                case result of
                    Ok op ->
                        D.succeed op

                    Err error ->
                        D.fail error
            )


applyOp : Op -> E.Value -> Result String E.Value
applyOp op value =
    case op of
        Replace replacement ->
            Ok replacement

        Set path replacement ->
            changeLeaf path (always (Ok (Just replacement))) value

        Delete path ->
            changeLeaf path (always (Ok Nothing)) value

        Append path suffix ->
            changeLeaf path (stringChange (\source -> source ++ suffix)) value

        Trim path count ->
            changeLeaf path (stringChange (String.dropLeft count)) value

        Splice path index count items ->
            changeAt path
                (\current ->
                    D.decodeValue (D.list D.value) current
                        |> Result.mapError (always "Splice target is not an array.")
                        |> Result.map (\values -> E.list identity (List.take index values ++ items ++ List.drop (index + count) values))
                )
                value

        Move path order ->
            changeAt path
                (\current ->
                    D.decodeValue (D.array D.value) current
                        |> Result.mapError (always "Move target is not an array.")
                        |> Result.andThen
                            (\values ->
                                if Array.length values == List.length order && Set.size (Set.fromList order) == List.length order && List.all (\index -> index < Array.length values) order then
                                    Ok (E.list identity (List.filterMap (\index -> Array.get index values) order))

                                else
                                    Err "Invalid permutation."
                            )
                )
                value


stringChange : (String -> String) -> Maybe E.Value -> Result String (Maybe E.Value)
stringChange fn value =
    value |> Result.fromMaybe "Missing string target." |> Result.andThen (D.decodeValue D.string >> Result.mapError (always "Target is not a string.")) |> Result.map (fn >> E.string >> Just)


changeAt : List Segment -> (E.Value -> Result String E.Value) -> E.Value -> Result String E.Value
changeAt path fn value =
    case path of
        [] ->
            fn value

        part :: rest ->
            child part (\current -> current |> Result.fromMaybe "Missing path." |> Result.andThen (changeAt rest fn) |> Result.map Just) value


changeLeaf : List Segment -> (Maybe E.Value -> Result String (Maybe E.Value)) -> E.Value -> Result String E.Value
changeLeaf path fn value =
    case path of
        [] ->
            Err "Operation cannot target the root."

        [ part ] ->
            child part fn value

        part :: rest ->
            child part (\current -> current |> Result.fromMaybe "Missing path." |> Result.andThen (changeLeaf rest fn) |> Result.map Just) value


child : Segment -> (Maybe E.Value -> Result String (Maybe E.Value)) -> E.Value -> Result String E.Value
child part fn value =
    case part of
        Key key ->
            D.decodeValue (D.dict D.value) value
                |> Result.mapError (always "Path target is not an object.")
                |> Result.andThen
                    (\fields ->
                        fn (Dict.get key fields)
                            |> Result.map
                                (\replacement ->
                                    E.object
                                        (Dict.toList
                                            (case replacement of
                                                Nothing ->
                                                    Dict.remove key fields

                                                Just item ->
                                                    Dict.insert key item fields
                                            )
                                        )
                                )
                    )

        Index index ->
            D.decodeValue (D.list D.value) value
                |> Result.mapError (always "Path target is not an array.")
                |> Result.andThen
                    (\values ->
                        if index > List.length values then
                            Err "Array index is out of range."

                        else
                            fn (List.drop index values |> List.head)
                                |> Result.andThen
                                    (\replacement ->
                                        if replacement == Nothing && index == List.length values then
                                            Err "Missing array element."

                                        else
                                            Ok (E.list identity (List.take index values ++ (Maybe.map List.singleton replacement |> Maybe.withDefault []) ++ List.drop (index + 1) values))
                                    )
                    )
