module Api.Actions exposing (capture, compact, configure, open, receipt, root, submit)

import Api.Conversation as Conversation
import Api.Enum.InputSubmissionDraftWhenBusy exposing (InputSubmissionDraftWhenBusy)
import Api.InputObject as Input
import Api.Mutation as Mutation
import Api.Object.CompactPayload as Compact
import Api.Object.ConversationRecord as Record
import Api.Object.Harness as Harness
import Api.Object.OpenPayload as Open
import Api.Object.RootPayload as Root
import Api.Object.SubmissionRecord as Submission
import Api.Object.SubmitPayload as Submit
import Api.Query as Query
import Api.Scalars as Scalars
import Attachment exposing (Attachment, AttachmentContent(..), AttachmentState(..))
import File
import Graphql.Operation exposing (RootMutation, RootQuery)
import Graphql.OptionalArgument exposing (OptionalArgument(..))
import Graphql.SelectionSet as S exposing (SelectionSet)
import Json.Encode as E


open : String -> SelectionSet (Maybe Scalars.Id) RootMutation
open externalId =
    Mutation.open { input = Input.buildOpenInput { externalId = externalId } } (Open.harness Harness.id)


root : Scalars.Id -> Input.RootOptionsInput -> SelectionSet (Maybe Conversation.Info) RootMutation
root harnessId options =
    Mutation.root { input = Input.buildRootInput { harnessId = harnessId } (\args -> { args | options = Present options }) } (Root.conversation Conversation.info)


configure : Scalars.Id -> Input.AgentChange -> OptionalArgument Input.SshTargetInput -> SelectionSet (Maybe Bool) RootMutation
configure conversationId change env =
    Mutation.configure { input = Input.buildConfigureInput { conversationId = conversationId, change = change } (\args -> { args | env = env }) }


compact : Scalars.Id -> String -> SelectionSet (Maybe Scalars.Id) RootMutation
compact conversationId instructions =
    Mutation.compact { input = Input.buildCompactInput { conversationId = conversationId } (\args -> { args | instructions = Present instructions }) } Compact.taskId


capture : String -> InputSubmissionDraftWhenBusy -> String -> List Attachment -> Maybe Input.SubmissionDraft
capture requestId mode prompt attachments =
    let
        textBlock value =
            Input.buildUserInputBlock (\args -> { args | text = Present (Input.buildTextContentInput { text = value } identity) })

        block attachment =
            case attachment.state of
                Ready (Text value) ->
                    Just (textBlock ("File: " ++ E.encode 0 (E.string (File.name attachment.file)) ++ "\n" ++ value))

                Ready (Image url) ->
                    String.indexes "," url
                        |> List.head
                        |> Maybe.map (\index -> Input.buildUserInputBlock (\args -> { args | image = Present (Input.buildImageContentInput { mimeType = File.mime attachment.file, data = String.dropLeft (index + 1) url }) }))

                _ ->
                    Nothing

        blocks =
            List.filterMap block attachments
    in
    if List.length blocks /= List.length attachments || (String.trim prompt == "" && List.isEmpty attachments) then
        Nothing

    else
        Just
            (Input.buildSubmissionDraft
                (\args ->
                    { args
                        | input =
                            Present
                                (Input.buildInputSubmissionDraft
                                    { content =
                                        Input.buildUserInput
                                            (\content ->
                                                { content
                                                    | blocks =
                                                        Present
                                                            ((if prompt == "" then
                                                                []

                                                              else
                                                                [ textBlock prompt ]
                                                             )
                                                                ++ blocks
                                                            )
                                                }
                                            )
                                    }
                                    (\input -> { input | requestId = Present requestId, whenBusy = Present mode })
                                )
                    }
                )
            )


submit : Scalars.Id -> Input.SubmissionDraft -> SelectionSet (Maybe Scalars.Id) RootMutation
submit conversationId submission =
    Mutation.submit { input = Input.buildSubmitInput { conversationId = conversationId, submission = submission } } Submit.submissionId


receipt : String -> Scalars.ConversationId -> String -> SelectionSet (Maybe Scalars.Id) RootQuery
receipt externalId conversationId requestId =
    Query.harness { externalId = externalId }
        (Harness.conversation { id = conversationId } (Record.submissionByRequest { requestId = requestId } Submission.id))
        |> S.map (Maybe.andThen identity >> Maybe.andThen identity)
