module Protocol exposing (Block(..), Boundary(..), Entry, Frame, Live, Message, Metadata, QueueItem, State, Tool, apply, blockDecoder, empty, frameDecoder, messageText, optional)

import Dict exposing (Dict)
import Json.Decode as D exposing (Decoder)
import Panel


type Block
    = Text String
    | Thinking String
    | Code String
    | Image String String
    | ToolRef String


type Boundary
    = Normal
    | Reset
    | Compact


type alias Message =
    { role : String, timestamp : Float, blocks : List Block, error : String }


type alias Entry =
    { id : Int, boundary : Boundary, messages : List Message }


type alias Tool =
    { id : String, name : String, command : String, state : String, duration : String, blocks : List Block, details : String, patch : Bool, written : String, notice : String }


type alias Live =
    { busy : Bool, messages : List Message, tools : List String, notices : List String, compactions : List { id : String, title : String, detail : String } }


type alias QueueItem =
    { id : Int, mode : String, blocks : List Block }


type alias Metadata =
    { branches : List Panel.Branch
    , durations : Dict String Int
    , title : String
    , instance : String
    , model : String
    , thinking : String
    , input : String
    , output : String
    , read : String
    , hit : String
    , cost : String
    , context : String
    , hideThinking : Bool
    , hideImages : Bool
    , resume : Bool
    , level : String
    }


type alias State =
    { subscription : String, sequence : Int, entries : Dict Int Entry, tools : Dict String Tool, live : Live, queue : List QueueItem, metadata : Metadata, inspection : Maybe Panel.Context }


type alias Frame =
    { subscription : String, sequence : Int, snapshot : Bool, conversation : Int, entries : List Entry, tools : List Tool, live : Maybe Live, queue : Maybe (List QueueItem), metadata : Maybe Metadata, inspection : Maybe Panel.Context }


empty : State
empty =
    { subscription = ""
    , sequence = 0
    , entries = Dict.empty
    , tools = Dict.empty
    , live = { busy = False, messages = [], tools = [], notices = [], compactions = [] }
    , inspection = Nothing
    , queue = []
    , metadata = { branches = [], durations = Dict.empty, title = "Conversation", instance = "", model = "", thinking = "", input = "0", output = "0", read = "0", hit = "CH—", cost = "0.000", context = "—", level = "normal", resume = False, hideThinking = False, hideImages = False }
    }


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


blockDecoder : Decoder Block
blockDecoder =
    D.field "kind" D.string
        |> D.andThen
            (\kind ->
                case kind of
                    "text" ->
                        D.map Text (D.field "text" D.string)

                    "thinking" ->
                        D.map Thinking (D.field "text" D.string)

                    "code" ->
                        D.map Code (D.field "text" D.string)

                    "image" ->
                        D.map2 Image (D.field "mime" D.string) (D.field "data" D.string)

                    "tool" ->
                        D.map ToolRef (D.field "id" D.string)

                    _ ->
                        D.fail "Unknown block kind"
            )


messageDecoder : Decoder Message
messageDecoder =
    D.map4 Message (D.field "role" D.string) (D.field "timestamp" D.float) (D.field "blocks" (D.list blockDecoder)) (D.field "error" D.string)


entryDecoder : Decoder Entry
entryDecoder =
    D.map3 Entry
        (D.field "id" D.int)
        (D.field "boundary" D.string
            |> D.andThen
                (\value ->
                    case value of
                        "" ->
                            D.succeed Normal

                        "pi.reset" ->
                            D.succeed Reset

                        "pi.compaction" ->
                            D.succeed Compact

                        _ ->
                            D.fail "Unknown boundary"
                )
        )
        (D.field "messages" (D.list messageDecoder))


toolDecoder : Decoder Tool
toolDecoder =
    D.succeed Tool
        |> andMap (D.field "id" D.string)
        |> andMap (D.field "name" D.string)
        |> andMap (D.field "command" D.string)
        |> andMap (D.field "state" D.string)
        |> andMap (D.field "duration" D.string)
        |> andMap (D.field "blocks" (D.list blockDecoder))
        |> andMap (D.field "details" D.string)
        |> andMap (D.field "patch" D.bool)
        |> andMap (D.field "written" D.string)
        |> andMap (D.field "notice" D.string)


metadataDecoder : Decoder Metadata
metadataDecoder =
    D.succeed Metadata
        |> andMap (D.field "branches" Panel.branchesDecoder)
        |> andMap (D.field "durations" (D.dict D.int))
        |> andMap (D.field "title" D.string)
        |> andMap (D.field "instance" D.string)
        |> andMap (D.field "model" D.string)
        |> andMap (D.field "thinking" D.string)
        |> andMap (D.field "input" D.string)
        |> andMap (D.field "output" D.string)
        |> andMap (D.field "read" D.string)
        |> andMap (D.field "hit" D.string)
        |> andMap (D.field "cost" D.string)
        |> andMap (D.field "context" D.string)
        |> andMap (optional "hideThinking" D.bool |> D.map (Maybe.withDefault False))
        |> andMap (optional "hideImages" D.bool |> D.map (Maybe.withDefault False))
        |> andMap (optional "resume" D.bool |> D.map (Maybe.withDefault False))
        |> andMap (D.field "level" D.string)


frameDecoder : Decoder Frame
frameDecoder =
    D.field "version" D.int
        |> D.andThen
            (\version ->
                if version /= 1 then
                    D.fail "Unsupported protocol version"

                else
                    D.succeed Frame
                        |> andMap (D.field "subscription" D.string)
                        |> andMap (D.field "sequence" D.int)
                        |> andMap (D.field "snapshot" D.bool)
                        |> andMap (D.field "conversation" D.int)
                        |> andMap (D.field "entries" (D.list entryDecoder))
                        |> andMap (D.field "tools" (D.list toolDecoder))
                        |> andMap (optional "live" (D.map5 Live (D.field "busy" D.bool) (D.field "messages" (D.list messageDecoder)) (D.field "tools" (D.list D.string)) (D.field "notices" (D.list D.string)) (optional "compactions" (D.list (D.map3 (\id title detail -> { id = id, title = title, detail = detail }) (D.field "id" D.string) (D.field "title" D.string) (D.field "detail" D.string))) |> D.map (Maybe.withDefault []))))
                        |> andMap (optional "queue" (D.list (D.map3 QueueItem (D.field "id" D.int) (D.field "mode" D.string) (D.field "blocks" (D.list blockDecoder)))))
                        |> andMap (optional "metadata" metadataDecoder)
                        |> andMap (optional "inspection" Panel.contextDecoder)
            )


apply : Int -> Frame -> State -> Result String State
apply conversation frame state =
    if frame.conversation /= conversation || frame.subscription == "" then
        Err "Wrong subscription identity"

    else if frame.snapshot && (frame.sequence /= 1 || frame.subscription == state.subscription || frame.live == Nothing || frame.queue == Nothing || frame.metadata == Nothing) then
        Err "Invalid snapshot"

    else if not frame.snapshot && (frame.subscription /= state.subscription || frame.sequence /= state.sequence + 1) then
        Err "Discontinuous stream"

    else if Dict.size (Dict.fromList (List.map (\entry -> ( entry.id, () )) frame.entries)) /= List.length frame.entries then
        Err "Duplicate entry identity"

    else
        let
            retain old value =
                if old == Just value then
                    Maybe.withDefault value old

                else
                    value

            entries =
                List.foldl (\entry -> Dict.insert entry.id (retain (Dict.get entry.id state.entries) entry))
                    (if frame.snapshot then
                        Dict.empty

                     else
                        state.entries
                    )
                    frame.entries

            tools =
                List.foldl (\tool -> Dict.insert tool.id (retain (Dict.get tool.id state.tools) tool))
                    (if frame.snapshot then
                        Dict.empty

                     else
                        state.tools
                    )
                    frame.tools
        in
        Ok
            { subscription = frame.subscription
            , sequence = frame.sequence
            , entries = entries
            , tools = tools
            , live = Maybe.withDefault state.live frame.live
            , queue = Maybe.withDefault state.queue frame.queue
            , metadata = Maybe.withDefault state.metadata frame.metadata
            , inspection =
                if frame.snapshot then
                    frame.inspection

                else
                    Maybe.map Just frame.inspection |> Maybe.withDefault state.inspection
            }


messageText : Message -> String
messageText value =
    value.blocks
        |> List.map
            (\block ->
                case block of
                    Text str ->
                        str

                    Thinking str ->
                        str

                    Code str ->
                        str

                    Image _ _ ->
                        "[image]"

                    ToolRef key ->
                        key
            )
        |> String.join "\n"
