module Conversation exposing (Content(..), Entry, Message, Slot, Snapshot, Usage, emptyMessage, entryDecoder, messageDecoder, project, snapshotDecoder, tokens, usageDecoder)

import Dict exposing (Dict)
import Json.Decode as D exposing (Decoder)
import Json.Encode as E
import Transcript.Model as Display exposing (Block(..), Boundary(..))


type Content
    = TextContent String
    | ThinkingContent String
    | ImageContent String String
    | Call { id : String, name : String, arguments : E.Value }


type alias Usage =
    { input : Float, output : Float, cacheRead : Float, cacheWrite : Float, totalTokens : Float, cost : Float }


type alias Message =
    { role : String
    , timestamp : Float
    , content : List Content
    , error : String
    , callId : Maybe String
    , isError : Bool
    , duration : Maybe Float
    , details : Maybe E.Value
    , usage : Maybe Usage
    , model : Maybe ( String, String )
    , stopReason : Maybe String
    }


type alias Entry =
    { id : Int, kind : String, messages : List Message, data : Maybe E.Value, head : Maybe Int }


type alias Slot =
    { id : String, name : String, arguments : E.Value, status : String, output : String, details : Maybe E.Value, droppedBytes : Int, droppedLines : Int, summary : Maybe { isError : Bool, duration : Maybe Float, error : String } }


type alias Snapshot =
    { conversation : Int
    , entries : List Entry
    , before : Maybe Int
    , head : Maybe Entry
    , busy : Bool
    , partial : Maybe Message
    , slots : List Slot
    , queue : List Display.QueueItem
    , notices : List String
    , compactions : List { id : String, title : String, detail : String }
    , usage : Maybe Usage
    }


emptyMessage : String -> List Content -> Float -> Message
emptyMessage role content timestamp =
    { role = role, timestamp = timestamp, content = content, error = "", callId = Nothing, isError = False, duration = Nothing, details = Nothing, usage = Nothing, model = Nothing, stopReason = Nothing }


andMap : Decoder a -> Decoder (a -> b) -> Decoder b
andMap =
    D.map2 (|>)


optional : String -> Decoder a -> Decoder (Maybe a)
optional name decoder =
    D.dict D.value
        |> D.andThen
            (\fields ->
                case Dict.get name fields of
                    Nothing ->
                        D.succeed Nothing

                    Just value ->
                        case D.decodeValue decoder value of
                            Ok result ->
                                D.succeed (Just result)

                            Err error ->
                                D.fail (D.errorToString error)
            )


default : a -> String -> Decoder a -> Decoder a
default fallback name decoder =
    optional name decoder |> D.map (Maybe.withDefault fallback)


nativeId : Decoder Int
nativeId =
    D.int
        |> D.andThen
            (\value ->
                if value >= 0 && value <= 9007199254740991 then
                    D.succeed value

                else
                    D.fail "Invalid native identity"
            )


contentDecoder : Decoder Content
contentDecoder =
    D.field "type" D.string
        |> D.andThen
            (\kind ->
                case kind of
                    "text" ->
                        D.map TextContent (D.field "text" D.string)

                    "thinking" ->
                        D.map ThinkingContent (D.field "thinking" D.string)

                    "image" ->
                        D.map2 ImageContent (D.field "mimeType" D.string) (D.field "data" D.string)

                    "toolCall" ->
                        D.map3 (\id name arguments -> Call { id = id, name = name, arguments = arguments }) (D.field "id" D.string) (D.field "name" D.string) (D.field "arguments" D.value)

                    _ ->
                        D.fail "Unknown message content"
            )


contents : Decoder (List Content)
contents =
    D.oneOf [ D.map (TextContent >> List.singleton) D.string, D.list contentDecoder ]


usageDecoder : Decoder Usage
usageDecoder =
    D.map6 Usage (D.field "input" D.float) (D.field "output" D.float) (D.field "cacheRead" D.float) (D.field "cacheWrite" D.float) (D.field "totalTokens" D.float) (D.at [ "cost", "total" ] D.float)


messageDecoder : Decoder Message
messageDecoder =
    D.succeed Message
        |> andMap
            (D.field "role" D.string
                |> D.andThen
                    (\role ->
                        if List.member role [ "user", "assistant", "toolResult", "system" ] then
                            D.succeed role

                        else
                            D.fail "Unknown message role"
                    )
            )
        |> andMap (D.field "timestamp" D.float)
        |> andMap (D.field "content" contents)
        |> andMap (default "" "errorMessage" D.string)
        |> andMap (optional "toolCallId" D.string)
        |> andMap (default False "isError" D.bool)
        |> andMap (optional "durationMs" D.float)
        |> andMap (optional "details" D.value)
        |> andMap (optional "usage" usageDecoder)
        |> andMap (D.map2 (Maybe.map2 Tuple.pair) (optional "provider" D.string) (optional "model" D.string))
        |> andMap (optional "stopReason" D.string)


entryDecoder : Decoder Entry
entryDecoder =
    D.map5 Entry
        (D.field "id" nativeId)
        (D.field "kind" D.string)
        (default [] "model" (D.list messageDecoder))
        (optional "data" D.value)
        (optional "head" nativeId)


slotDecoder : Decoder Slot
slotDecoder =
    D.succeed Slot
        |> andMap (D.field "callId" D.string)
        |> andMap (D.field "name" D.string)
        |> andMap (default (E.object []) "arguments" D.value)
        |> andMap (D.field "status" D.string)
        |> andMap (default "" "output" D.string)
        |> andMap (optional "details" D.value)
        |> andMap (default 0 "droppedBytes" D.int)
        |> andMap (default 0 "droppedLines" D.int)
        |> andMap (optional "summary" (D.map3 (\isError duration error -> { isError = isError, duration = duration, error = error }) (D.field "isError" D.bool) (optional "durationMs" D.float) (default "" "error" D.string)))


queueDecoder : Decoder Display.QueueItem
queueDecoder =
    D.field "mode" D.string
        |> D.andThen
            (\mode ->
                D.map2 (\id content -> { id = id, mode = mode, blocks = blocks "user" content })
                    (D.field "id" nativeId)
                    (if mode == "write" then
                        D.at [ "entry", "kind" ] D.string |> D.map (TextContent >> List.singleton)

                     else if List.member mode [ "steer", "followUp" ] then
                        D.field "content" contents

                     else
                        D.fail "Unknown queue mode"
                    )
            )


snapshotDecoder : Decoder Snapshot
snapshotDecoder =
    let
        doc kind decoder fallback =
            D.at [ "view", "docs" ] (default fallback kind decoder)

        live decoder fallback =
            doc "pi.live" decoder fallback

        generation decoder fallback =
            live (default fallback "generation" decoder) fallback

        notices =
            D.map4 (\retry deferred compactionError failure -> List.filter ((/=) "") [ retry, deferred, compactionError, failure ])
                (generation (default "" "retry" (D.field "error" D.string |> D.map ((++) "Retry: "))) "")
                (generation
                    (optional "deferred" (D.dict D.value)
                        |> D.map
                            (\value ->
                                if value == Nothing then
                                    ""

                                else
                                    "Waiting for provider response…"
                            )
                    )
                    ""
                )
                (live (default "" "compactionFailure" (D.field "error" D.string |> D.map ((++) "Compaction failed: "))) "")
                (live
                    (default ""
                        "runFailure"
                        (D.map2
                            (\reason detail ->
                                reason
                                    ++ (if detail == "" then
                                            ""

                                        else
                                            ": " ++ detail
                                       )
                            )
                            (D.field "reason" D.string)
                            (default "" "detail" D.string)
                        )
                    )
                    ""
                )

        compaction =
            D.map4
                (\id blocking attempt retry ->
                    { id = String.fromInt id
                    , title =
                        if blocking then
                            "Compacting context"

                        else
                            "Background compaction"
                    , detail =
                        "Attempt "
                            ++ String.fromInt attempt
                            ++ (if retry == "" then
                                    ""

                                else
                                    " · " ++ retry
                               )
                    }
                )
                (D.field "taskId" nativeId)
                (D.field "blocking" D.bool)
                (D.field "attempt" D.int)
                (default "" "retry" (D.field "error" D.string))

        ledger =
            D.map2 (\models tools -> sumUsage (Dict.values models ++ Dict.values tools))
                (D.field "models" (D.dict usageDecoder))
                (D.field "tools" (D.dict usageDecoder))
    in
    D.succeed Snapshot
        |> andMap (D.at [ "view", "conversation", "id" ] nativeId)
        |> andMap (D.at [ "view", "entries" ] (D.list entryDecoder))
        |> andMap (D.field "view" (optional "before" nativeId))
        |> andMap (D.field "head" (D.nullable entryDecoder))
        |> andMap (live (optional "run" (D.dict D.value) |> D.map ((/=) Nothing)) False)
        |> andMap (generation (optional "message" messageDecoder) Nothing)
        |> andMap (live (D.map2 (++) (default [] "tools" (D.list slotDecoder)) (default [] "nestedTools" (D.list slotDecoder))) [])
        |> andMap (doc "pi.inbox" (D.field "items" (D.list queueDecoder)) [])
        |> andMap notices
        |> andMap (live (default [] "compactions" (D.list compaction)) [])
        |> andMap (D.at [ "view", "docs" ] (optional "pi.usage" ledger))
        |> D.andThen
            (\snapshot ->
                if
                    ordered snapshot.entries
                        && (case ( snapshot.before, List.head snapshot.entries ) of
                                ( Just before, Just first ) ->
                                    before < first.id

                                _ ->
                                    True
                           )
                        && (case snapshot.head of
                                Just head ->
                                    head.head /= Nothing

                                Nothing ->
                                    True
                           )
                then
                    D.succeed snapshot

                else
                    D.fail "Invalid conversation window"
            )


ordered : List Entry -> Bool
ordered entries =
    case entries of
        first :: second :: rest ->
            first.id < second.id && ordered (second :: rest)

        _ ->
            True


sumUsage : List Usage -> Usage
sumUsage =
    List.foldl (\a b -> Usage (a.input + b.input) (a.output + b.output) (a.cacheRead + b.cacheRead) (a.cacheWrite + b.cacheWrite) (a.totalTokens + b.totalTokens) (a.cost + b.cost)) (Usage 0 0 0 0 0 0)


blocks : String -> List Content -> List Display.Block
blocks role =
    List.map
        (\content ->
            case content of
                TextContent value ->
                    if role == "toolResult" then
                        Code value

                    else
                        Text value

                ThinkingContent value ->
                    Thinking
                        (if value == "" then
                            "Thinking…"

                         else
                            value
                        )

                ImageContent mime data ->
                    if List.member mime [ "image/png", "image/jpeg", "image/gif", "image/webp" ] then
                        Image mime data

                    else
                        Text "[attachment]"

                Call call ->
                    ToolRef call.id
        )


displayMessage : Message -> Display.Message
displayMessage message =
    { role = message.role, timestamp = message.timestamp, blocks = blocks message.role message.content, error = message.error }


project : Dict Int Entry -> Snapshot -> Display.State
project records snapshot =
    let
        messages =
            Dict.values records |> List.concatMap .messages

        historyCalls =
            messages
                |> List.concatMap .content
                |> List.filterMap
                    (\content ->
                        case content of
                            Call call ->
                                Just ( call.id, call )

                            _ ->
                                Nothing
                    )
                |> Dict.fromList

        calls =
            List.foldl
                (\slot acc ->
                    if Dict.member slot.id acc then
                        acc

                    else
                        Dict.insert slot.id { id = slot.id, name = slot.name, arguments = slot.arguments } acc
                )
                historyCalls
                snapshot.slots

        results =
            messages |> List.filterMap (\message -> Maybe.map (\id -> ( id, message )) message.callId) |> Dict.fromList

        entries =
            Dict.map
                (\_ entry ->
                    { id = entry.id
                    , boundary =
                        if entry.kind == "pi.reset" then
                            Reset

                        else if entry.kind == "pi.compaction" then
                            Compact

                        else
                            Normal
                    , messages =
                        if List.isEmpty entry.messages && entry.kind /= "pi.reset" then
                            [ { role = entry.kind, timestamp = -1, blocks = [ Code (entry.data |> Maybe.map (E.encode 2) |> Maybe.withDefault entry.kind) ], error = "" } ]

                        else
                            entry.messages |> List.filter (\message -> message.role /= "system" && not (message.role == "toolResult" && Maybe.map (\id -> Dict.member id calls) message.callId == Just True)) |> List.map displayMessage
                    }
                )
                records

        tools =
            Dict.map (\id call -> displayTool call (Dict.get id results) (List.filter (.id >> (==) id) snapshot.slots |> List.head) snapshot.busy) calls

        initial =
            Display.empty
    in
    { initial
        | entries = entries
        , tools = tools
        , live = { busy = snapshot.busy, messages = Maybe.map (displayMessage >> List.singleton) snapshot.partial |> Maybe.withDefault [], tools = snapshot.slots |> List.filter (\slot -> not (Dict.member slot.id historyCalls)) |> List.map .id, notices = snapshot.notices, compactions = snapshot.compactions }
        , queue = snapshot.queue
    }


fieldString : String -> E.Value -> String
fieldString field value =
    D.decodeValue (D.field field D.string) value |> Result.withDefault ""


displayTool : { id : String, name : String, arguments : E.Value } -> Maybe Message -> Maybe Slot -> Bool -> Display.Tool
displayTool call result slot busy =
    let
        name =
            String.split "." call.name |> List.reverse |> List.head |> Maybe.withDefault call.name

        path =
            fieldString "path" call.arguments

        label =
            if name == "bash" then
                "$ " ++ (D.decodeValue (D.field "command" D.string) call.arguments |> Result.map String.trim |> Result.withDefault "Shell command")

            else
                (Dict.get name (Dict.fromList [ ( "read", "Read" ), ( "write", "Write" ), ( "edit", "Edit" ), ( "grep", "Search" ), ( "find", "Find" ), ( "ls", "List" ) ]) |> Maybe.withDefault call.name)
                    ++ (if path == "" then
                            ""

                        else
                            " · " ++ path
                       )

        written =
            if Maybe.map .isError result == Just False && name == "write" then
                fieldString "content" call.arguments

            else
                ""

        metadata =
            case result of
                Just message ->
                    message.details

                Nothing ->
                    Maybe.andThen .details slot

        patch =
            metadata
                |> Maybe.map
                    (\value ->
                        let
                            diff =
                                fieldString "diff" value
                        in
                        if diff == "" then
                            fieldString "patch" value

                        else
                            diff
                    )
                |> Maybe.withDefault ""

        summary =
            Maybe.andThen .summary slot

        duration =
            case result of
                Just message ->
                    message.duration

                Nothing ->
                    Maybe.andThen .duration summary

        state =
            case result of
                Just message ->
                    if message.isError then
                        "failed"

                    else
                        "completed"

                Nothing ->
                    case summary of
                        Just value ->
                            if value.isError then
                                "failed"

                            else
                                "completed"

                        Nothing ->
                            case Maybe.map .status slot of
                                Just "done" ->
                                    "unavailable"

                                Just value ->
                                    value

                                Nothing ->
                                    if busy then
                                        "pending"

                                    else
                                        "unavailable"

        dropped =
            Maybe.map
                (\value ->
                    if value.droppedBytes > 0 || value.droppedLines > 0 then
                        "Output truncated: " ++ String.fromInt value.droppedBytes ++ " bytes / " ++ String.fromInt value.droppedLines ++ " lines omitted."

                    else
                        ""
                )
                slot
                |> Maybe.withDefault ""
    in
    { id = call.id
    , name = call.name
    , command =
        label
            ++ (if name == "bash" || written /= "" || E.encode 0 call.arguments == "{}" then
                    ""

                else if name == "write" && fieldString "content" call.arguments /= "" then
                    "\n" ++ fieldString "content" call.arguments

                else
                    "\n" ++ E.encode 2 call.arguments
               )
    , state = state
    , duration =
        Maybe.map
            (\ms ->
                if ms < 1000 then
                    String.fromInt (round ms) ++ "ms"

                else
                    decimal1 (ms / 1000) ++ "s"
            )
            duration
            |> Maybe.withDefault ""
    , blocks =
        case result of
            Just message ->
                blocks message.role message.content

            Nothing ->
                Maybe.map
                    (\value ->
                        if value.output == "" then
                            []

                        else
                            [ Code value.output ]
                    )
                    slot
                    |> Maybe.withDefault []
    , details =
        if patch /= "" then
            patch

        else
            Maybe.map (E.encode 2) metadata |> Maybe.withDefault ""
    , patch = patch /= ""
    , path = path
    , written = written
    , notice =
        if dropped /= "" then
            dropped

        else
            Maybe.map .error summary |> Maybe.withDefault ""
    }


tokens : Float -> String
tokens value =
    if value < 1000 then
        String.fromInt (round value)

    else if value < 10000 then
        decimal1 (value / 1000) ++ "k"

    else if value < 1000000 then
        String.fromInt (round (value / 1000)) ++ "k"

    else if value < 10000000 then
        decimal1 (value / 1000000) ++ "M"

    else
        String.fromInt (round (value / 1000000)) ++ "M"


decimal1 : Float -> String
decimal1 value =
    let
        ticks =
            round (value * 10)
    in
    String.fromInt (ticks // 10) ++ "." ++ String.fromInt (modBy 10 ticks)
