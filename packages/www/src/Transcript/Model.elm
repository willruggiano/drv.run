module Transcript.Model exposing (Block(..), Boundary(..), Entry, Live, Message, QueueItem, State, Tool, empty)

import Dict exposing (Dict)


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
    { id : String, name : String, command : String, state : String, duration : String, blocks : List Block, details : String, patch : Bool, path : String, written : String, notice : String }


type alias Live =
    { busy : Bool, messages : List Message, tools : List String, notices : List String, compactions : List { id : String, title : String, detail : String } }


type alias QueueItem =
    { id : Int, mode : String, blocks : List Block }


type alias State =
    { entries : Dict Int Entry, tools : Dict String Tool, live : Live, queue : List QueueItem }


empty : State
empty =
    { entries = Dict.empty
    , tools = Dict.empty
    , live = { busy = False, messages = [], tools = [], notices = [], compactions = [] }
    , queue = []
    }
