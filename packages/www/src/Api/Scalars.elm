module Api.Scalars exposing
    ( ConversationId
    , Cursor
    , EntryHead(..)
    , EntryId
    , HarnessQueueMode(..)
    , HarnessTransport(..)
    , Id
    , JsonObject
    , JsonValue
    , SubmissionId
    , TaskId
    , TelemetryCarrier
    , codecs
    , conversationId
    , cursor
    , entryHead
    , entryId
    , harnessQueueMode
    , harnessTransport
    , id
    , jsonObject
    , jsonValue
    , submissionId
    , taskId
    , telemetryCarrier
    )

import Api.Scalar
import Graphql.Codec exposing (Codec)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


type ConversationId
    = ConversationId Int


type EntryId
    = EntryId Int


type SubmissionId
    = SubmissionId Int


type TaskId
    = TaskId Int


type Id
    = Id String


type Cursor
    = Cursor Decode.Value


type EntryHead
    = Self
    | At EntryId


type HarnessQueueMode
    = OneAtATime
    | All


type HarnessTransport
    = Auto
    | Sse
    | Websocket
    | WebsocketCached


type JsonObject
    = JsonObject Decode.Value


type alias JsonValue =
    Decode.Value


type TelemetryCarrier
    = TelemetryCarrier (List ( String, String ))


codecs : Api.Scalar.Codecs ConversationId Cursor EntryHead EntryId HarnessQueueMode HarnessTransport Id JsonObject JsonValue SubmissionId TaskId TelemetryCarrier
codecs =
    Api.Scalar.defineCodecs
        { codecConversationId = conversationId
        , codecCursor = cursor
        , codecEntryHead = entryHead
        , codecEntryId = entryId
        , codecHarnessQueueMode = harnessQueueMode
        , codecHarnessTransport = harnessTransport
        , codecId = id
        , codecJsonObject = jsonObject
        , codecJsonValue = jsonValue
        , codecSubmissionId = submissionId
        , codecTaskId = taskId
        , codecTelemetryCarrier = telemetryCarrier
        }


conversationId : Codec ConversationId
conversationId =
    nativeId ConversationId (\(ConversationId value) -> value)


entryId : Codec EntryId
entryId =
    nativeId EntryId (\(EntryId value) -> value)


submissionId : Codec SubmissionId
submissionId =
    nativeId SubmissionId (\(SubmissionId value) -> value)


taskId : Codec TaskId
taskId =
    nativeId TaskId (\(TaskId value) -> value)


nativeId : (Int -> value) -> (value -> Int) -> Codec value
nativeId wrap unwrap =
    { encoder = unwrap >> Encode.int
    , decoder =
        Decode.int
            |> Decode.andThen
                (\value ->
                    if value >= 0 && value <= 9007199254740991 then
                        Decode.succeed (wrap value)

                    else
                        Decode.fail "Expected a nonnegative safe-integer Durable ID"
                )
    }


id : Codec Id
id =
    { encoder = \(Id value) -> Encode.string value
    , decoder = Decode.map Id Decode.string
    }


cursor : Codec Cursor
cursor =
    { encoder = \(Cursor value) -> value
    , decoder = Decode.map Cursor objectValue
    }


entryHead : Codec EntryHead
entryHead =
    { encoder =
        \head ->
            case head of
                Self ->
                    Encode.string "self"

                At value ->
                    entryId.encoder value
    , decoder =
        Decode.oneOf
            [ Decode.map At entryId.decoder
            , Decode.string
                |> Decode.andThen
                    (\value ->
                        if value == "self" then
                            Decode.succeed Self

                        else
                            Decode.fail "Expected an entry ID or self"
                    )
            ]
    }


harnessQueueMode : Codec HarnessQueueMode
harnessQueueMode =
    { encoder =
        \mode ->
            Encode.string
                (case mode of
                    OneAtATime ->
                        "one-at-a-time"

                    All ->
                        "all"
                )
    , decoder =
        Decode.string
            |> Decode.andThen
                (\value ->
                    case value of
                        "one-at-a-time" ->
                            Decode.succeed OneAtATime

                        "all" ->
                            Decode.succeed All

                        _ ->
                            Decode.fail "Unknown Harness queue mode"
                )
    }


harnessTransport : Codec HarnessTransport
harnessTransport =
    { encoder =
        \transport ->
            Encode.string
                (case transport of
                    Auto ->
                        "auto"

                    Sse ->
                        "sse"

                    Websocket ->
                        "websocket"

                    WebsocketCached ->
                        "websocket-cached"
                )
    , decoder =
        Decode.string
            |> Decode.andThen
                (\value ->
                    case value of
                        "auto" ->
                            Decode.succeed Auto

                        "sse" ->
                            Decode.succeed Sse

                        "websocket" ->
                            Decode.succeed Websocket

                        "websocket-cached" ->
                            Decode.succeed WebsocketCached

                        _ ->
                            Decode.fail "Unknown Harness transport"
                )
    }


jsonObject : Codec JsonObject
jsonObject =
    { encoder = \(JsonObject value) -> value
    , decoder = Decode.map JsonObject objectValue
    }


objectValue : Decoder Decode.Value
objectValue =
    Decode.keyValuePairs Decode.value |> Decode.map Encode.object


jsonValue : Codec JsonValue
jsonValue =
    { encoder = identity
    , decoder = Decode.value
    }


telemetryCarrier : Codec TelemetryCarrier
telemetryCarrier =
    { encoder = \(TelemetryCarrier fields) -> Encode.object (List.map (Tuple.mapSecond Encode.string) fields)
    , decoder = Decode.map TelemetryCarrier (Decode.keyValuePairs Decode.string)
    }
