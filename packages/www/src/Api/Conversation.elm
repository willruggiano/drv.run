module Api.Conversation exposing (Branch, BranchPage, EntryPage, Info, Overview, Preferences, TimingPage, TimingTarget(..), branches, capacities, history, info, lookup, placements, preferences, timings)

import Api.Enum.App as App
import Api.Enum.ModelThinkingLevel as Thinking
import Api.Enum.ScanOrder as Order
import Api.Enum.StopReason as StopReason
import Api.Enum.TaskOutcomeStatus as Outcome
import Api.Enum.TaskStateStatus as TaskStatus
import Api.Enum.WwwDeliveryMode as Delivery
import Api.Home
import Api.InputObject as Input
import Api.Object
import Api.Object.Agent as Agent
import Api.Object.AssistantMessage as Assistant
import Api.Object.ConversationRecord as Record
import Api.Object.ConversationRecordConnection as Conversations
import Api.Object.ConversationRecordOwner as Owner
import Api.Object.ConversationRecordParent as Parent
import Api.Object.EntryRecord as Entry
import Api.Object.EntryRecordConnection as Entries
import Api.Object.Harness as Harness
import Api.Object.ImageContent as Image
import Api.Object.Model as Model
import Api.Object.ModelRef as ModelRef
import Api.Object.PageInfo as PageInfo
import Api.Object.StringContent as StringContent
import Api.Object.SubmissionRecord as Submission
import Api.Object.SystemMessage as System
import Api.Object.TaskOutcome as TaskOutcome
import Api.Object.TaskRecord as TaskRecord
import Api.Object.TaskRecordConnection as Tasks
import Api.Object.TaskState as TaskState
import Api.Object.TextContent as TextContent
import Api.Object.TextContentList as TextContentList
import Api.Object.ThinkingContent as ThinkingContent
import Api.Object.ToolCall as ToolCall
import Api.Object.ToolResultMessage as ToolResult
import Api.Object.Usage as Usage
import Api.Object.UsageCost as Cost
import Api.Object.UserContentList as UserContentList
import Api.Object.UserMessage as User
import Api.Object.WebSettings as Web
import Api.Query as Query
import Api.Scalars as Scalars
import Api.Union
import Api.Union.AssistantContent as AssistantContent
import Api.Union.Message as Message
import Api.Union.Settings as Settings
import Api.Union.SystemMessageContent as SystemContent
import Api.Union.UserContent as UserContent
import Api.Union.UserMessageContent as UserMessageContent
import Conversation as Data
import Graphql.Internal.Builder.Object as Object
import Graphql.Operation exposing (RootQuery)
import Graphql.OptionalArgument exposing (OptionalArgument(..))
import Graphql.SelectionSet as S exposing (SelectionSet(..))
import Json.Decode as D
import Json.Encode as E


type alias Branch =
    { id : Scalars.ConversationId, parent : Maybe Scalars.ConversationId, owner : Maybe Scalars.ConversationId }


type alias BranchPage =
    { nodes : List Branch, next : Maybe Scalars.Cursor }


type alias Info =
    { id : Scalars.ConversationId, globalId : Scalars.Id, env : Maybe Input.SshTargetInput, model : Maybe ( String, String ), thinking : String, cwd : Maybe String, host : Maybe String }


type alias Overview =
    { info : Maybe Info, harnessId : Scalars.Id }


type alias EntryPage =
    { nodes : List Data.Entry, next : Maybe Scalars.Cursor }


type alias Preferences =
    { wrap : Bool, bottom : Bool, hideThinking : Bool, images : Bool, steering : Bool }


lookup : String -> Maybe Scalars.ConversationId -> SelectionSet (Maybe Overview) RootQuery
lookup externalId id =
    Query.harness { externalId = externalId }
        (S.map2 Overview
            (case id of
                Nothing ->
                    Harness.root info

                Just value ->
                    Harness.conversation { id = value } info
            )
            Harness.id
        )


info : SelectionSet Info Api.Object.ConversationRecord
info =
    S.map4
        (\id agent env globalId -> { id = id, globalId = globalId, env = env, model = agent.model, thinking = agent.thinking, cwd = agent.cwd, host = Maybe.map .host env })
        Record.durableId
        (Record.agent
            (S.map3 (\model thinking cwd -> { model = model, thinking = Thinking.toString thinking, cwd = cwd })
                (Agent.model (S.map2 Tuple.pair ModelRef.provider ModelRef.modelId))
                Agent.thinkingLevel
                Agent.cwd
            )
        )
        (Record.env Api.Home.target)
        Record.id


branches : String -> Maybe Scalars.Cursor -> SelectionSet (Maybe BranchPage) RootQuery
branches externalId cursor =
    Query.harness { externalId = externalId } (branchPage cursor)


branchPage : Maybe Scalars.Cursor -> SelectionSet BranchPage Api.Object.Harness
branchPage cursor =
    Harness.scanConversations (\args -> { args | cursor = optional cursor })
        { limit = 100, query = Input.buildConversationQuery identity }
        (S.map2 BranchPage
            (Conversations.nodes (S.map3 Branch Record.durableId (Record.parent Parent.conversationId) (Record.owner Owner.conversationId)))
            (Conversations.pageInfo PageInfo.next)
        )


history : String -> Scalars.ConversationId -> Maybe Scalars.EntryId -> Maybe Scalars.Cursor -> SelectionSet (Maybe EntryPage) RootQuery
history externalId id before cursor =
    Query.harness { externalId = externalId }
        (Harness.conversation { id = id }
            (Record.entries (\args -> { args | cursor = optional cursor })
                { limit = 100, query = Input.buildEntryQuery (\args -> { args | maxEntryId = optional before, order = Present Order.Descending }) }
                (S.map2 EntryPage (Entries.nodes entry) (Entries.pageInfo PageInfo.next))
            )
        )
        |> S.map (Maybe.andThen identity)


entry : SelectionSet Data.Entry Api.Object.EntryRecord
entry =
    S.map5 Data.Entry
        (S.map Scalars.entryIdValue Entry.durableId)
        Entry.kind
        (S.map (Maybe.withDefault []) (Entry.model message))
        Entry.data
        (S.map (Maybe.map Scalars.entryIdValue) Entry.head)


message : SelectionSet Data.Message Api.Union.Message
message =
    Message.fragments
        { onUserMessage =
            S.map2 (Data.emptyMessage "user")
                (aliasContent "userContent"
                    User.content
                    (UserMessageContent.fragments
                        { onStringContent = S.map (Data.TextContent >> List.singleton) StringContent.text
                        , onUserContentList = UserContentList.blocks userContent
                        }
                    )
                )
                User.timestamp
        , onSystemMessage =
            S.map2 (Data.emptyMessage "system")
                (aliasContent "systemContent"
                    System.content
                    (SystemContent.fragments
                        { onStringContent = S.map (Data.TextContent >> List.singleton) StringContent.text
                        , onTextContentList = TextContentList.blocks (S.map Data.TextContent TextContent.text)
                        }
                    )
                )
                System.timestamp
        , onAssistantMessage =
            S.map8
                (\content timestamp error duration usage provider model stopReason ->
                    let
                        base =
                            Data.emptyMessage "assistant" content timestamp
                    in
                    { base | error = Maybe.withDefault "" error, duration = duration, usage = Just usage, model = Just ( provider, model ), stopReason = Just (StopReason.toString stopReason) }
                )
                (aliasContent "assistantContent"
                    Assistant.content
                    (AssistantContent.fragments
                        { onTextContent = S.map Data.TextContent TextContent.text
                        , onThinkingContent = S.map Data.ThinkingContent ThinkingContent.thinking
                        , onToolCall = S.map3 (\id name arguments -> Data.Call { id = id, name = name, arguments = Scalars.jsonObject.encoder arguments }) ToolCall.id ToolCall.name ToolCall.arguments
                        }
                    )
                )
                Assistant.timestamp
                Assistant.errorMessage
                Assistant.durationMs
                (Assistant.usage usageSelection)
                Assistant.provider
                Assistant.model
                Assistant.stopReason
        , onToolResultMessage =
            S.map6
                (\content timestamp id isError duration details ->
                    let
                        base =
                            Data.emptyMessage "toolResult" content timestamp
                    in
                    { base | callId = Just id, isError = isError, duration = duration, details = details }
                )
                (aliasContent "toolContent" ToolResult.content userContent)
                ToolResult.timestamp
                ToolResult.toolCallId
                ToolResult.isError
                ToolResult.durationMs
                ToolResult.details
        }


userContent : SelectionSet Data.Content Api.Union.UserContent
userContent =
    UserContent.fragments
        { onTextContent = S.map Data.TextContent TextContent.text
        , onImageContent = S.map2 Data.ImageContent Image.mimeType Image.data
        }


usageSelection : SelectionSet Data.Usage Api.Object.Usage
usageSelection =
    S.map6 Data.Usage Usage.input Usage.output Usage.cacheRead Usage.cacheWrite Usage.totalTokens (Usage.cost Cost.total)


preferences : SelectionSet (Maybe Preferences) RootQuery
preferences =
    Query.settings { app = App.Web }
        (Settings.fragments
            { onHarnessSettings = S.succeed Nothing
            , onWebSettings = S.map5 (\wrap bottom hide images mode -> Just (Preferences wrap bottom hide images (mode == Delivery.Steer))) Web.wrapCode Web.bottomAlign Web.hideThinkingBlock Web.showImages Web.defaultDeliveryMode
            }
        )
        |> S.map (Maybe.andThen identity)


capacities : SelectionSet (List ( ( String, String ), Float )) RootQuery
capacities =
    Query.models (S.map3 (\provider id capacity -> ( ( provider, id ), capacity )) Model.provider Model.id Model.contextWindow)


optional : Maybe a -> OptionalArgument a
optional =
    Maybe.map Present >> Maybe.withDefault Absent



-- elm-graphql 5.0.12 only detects leaf type conflicts (Graphql.Document.Field).
-- Message.content has incompatible composite return shapes across union members.
-- Alias the generated field, retaining its generated decoder and scope type.


aliasContent : String -> (SelectionSet a child -> SelectionSet b parent) -> SelectionSet a child -> SelectionSet b parent
aliasContent alias field children =
    let
        (SelectionSet _ decoder) =
            field children

        (SelectionSet fields _) =
            Object.selectionForCompositeField (alias ++ ": content") [] children identity
    in
    SelectionSet fields
        (D.field alias D.value
            |> D.andThen
                (\value ->
                    case D.decodeValue decoder (E.object [ ( "content", value ) ]) of
                        Ok result ->
                            D.succeed result

                        Err error ->
                            D.fail (D.errorToString error)
                )
        )


type TimingTarget
    = Placed Int
    | Submitted Scalars.ConversationId Scalars.SubmissionId


type alias TimingPage =
    { nodes : List ( TimingTarget, Int ), next : Maybe Scalars.Cursor }


timings : String -> Maybe Scalars.Cursor -> SelectionSet (Maybe TimingPage) RootQuery
timings externalId cursor =
    Query.harness { externalId = externalId } (timingPage cursor)


timingPage : Maybe Scalars.Cursor -> SelectionSet TimingPage Api.Object.Harness
timingPage cursor =
    let
        target conversation =
            D.oneOf
                [ D.field "entryId" Scalars.entryId.decoder |> D.map (Scalars.entryIdValue >> Placed)
                , D.field "submissionId" Scalars.submissionId.decoder |> D.map (Submitted conversation)
                ]

        task =
            S.map4
                (\conversation start end outcome ->
                    Maybe.map3 (\a b result -> ( a, b, result )) start end outcome
                        |> Maybe.andThen
                            (\( a, b, ( status, result ) ) ->
                                if status == Outcome.Completed && b >= a then
                                    result |> Maybe.andThen (D.decodeValue (target conversation) >> Result.toMaybe) |> Maybe.map (\placement -> ( placement, round (b - a) ))

                                else
                                    Nothing
                            )
                )
                TaskRecord.conversationId
                TaskRecord.startedAt
                TaskRecord.endedAt
                (TaskRecord.state (TaskState.outcome (S.map2 Tuple.pair TaskOutcome.status TaskOutcome.result)))
    in
    Harness.scanTasks (\args -> { args | cursor = optional cursor })
        { limit = 100, query = Input.buildTaskQuery (\args -> { args | kind = Present "pi.compaction", status = Present TaskStatus.Terminal, order = Present Order.Descending }) }
        (S.map2 TimingPage (Tasks.nodes task |> S.map (List.filterMap identity)) (Tasks.pageInfo PageInfo.next))


placements : String -> List ( Scalars.ConversationId, Scalars.SubmissionId, Int ) -> SelectionSet (Maybe (List ( Int, Int ))) RootQuery
placements externalId submissions =
    Query.harness { externalId = externalId }
        (submissions
            |> List.map
                (\( conversation, id, duration ) ->
                    Harness.conversation { id = conversation } (Record.status { id = id } Submission.entry)
                        |> S.map (Maybe.andThen identity >> Maybe.andThen identity >> Maybe.map (\entryId -> ( Scalars.entryIdValue entryId, duration )))
                )
            |> S.list
            |> S.map (List.filterMap identity)
        )
