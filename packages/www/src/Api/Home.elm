module Api.Home exposing (Environment, EnvironmentPage, ModelChoice, Session, environments, models, sessions)

import Api.Enum.ModelThinkingLevel exposing (ModelThinkingLevel)
import Api.Object.Agent as Agent
import Api.Object.ConversationRecord as Conversation
import Api.Object.Harness as Harness
import Api.Object.Instance as Instance
import Api.Object.InstanceConnection as InstanceConnection
import Api.Object.Model as Model
import Api.Object.ModelRef as ModelRef
import Api.Object.PageInfo as PageInfo
import Api.Object.SshTarget as SshTarget
import Api.Query as Query
import Api.Scalars as Scalars
import Graphql.Operation exposing (RootQuery)
import Graphql.OptionalArgument exposing (OptionalArgument(..))
import Graphql.SelectionSet as SelectionSet exposing (SelectionSet)



-- CATALOG TYPES


type alias Session =
    { id : Scalars.Id
    , externalId : String
    , root : Maybe { cwd : Maybe String, model : Maybe String, host : Maybe String }
    }


type alias ModelChoice =
    { provider : String
    , id : String
    , name : String
    , thinkingLevels : List ModelThinkingLevel
    }


type alias Environment =
    { id : Scalars.Id
    , unit : String
    , host : Maybe String
    }


type alias EnvironmentPage =
    { nodes : List Environment
    , next : Maybe Scalars.Cursor
    }



-- SESSIONS


sessions : SelectionSet (List Session) RootQuery
sessions =
    Query.harnesses
        (SelectionSet.map3 Session
            Harness.id
            Harness.externalId
            (Harness.root
                (SelectionSet.map2
                    (\agent host -> { cwd = agent.cwd, model = agent.model, host = host })
                    (Conversation.agent
                        (SelectionSet.map2 (\cwd model -> { cwd = cwd, model = model })
                            Agent.cwd
                            (Agent.model (SelectionSet.map2 (\provider modelId -> provider ++ "/" ++ modelId) ModelRef.provider ModelRef.modelId))
                        )
                    )
                    (Conversation.env SshTarget.host)
                )
            )
        )



-- MODELS


models : SelectionSet (List ModelChoice) RootQuery
models =
    Query.models
        (SelectionSet.map4
            (\provider modelId name levels -> { provider = provider, id = modelId, name = name, thinkingLevels = levels })
            Model.provider
            Model.id
            Model.name
            Model.thinkingLevels
        )



-- ENVIRONMENTS


environments : Maybe Scalars.Cursor -> SelectionSet (Maybe EnvironmentPage) RootQuery
environments cursor =
    Query.instances
        (\args -> { args | cursor = Maybe.map Present cursor |> Maybe.withDefault Absent })
        { limit = 50 }
        (SelectionSet.map2 EnvironmentPage
            (InstanceConnection.nodes (SelectionSet.map3 Environment Instance.id Instance.unit (Instance.connect SshTarget.host)))
            (InstanceConnection.pageInfo PageInfo.next)
        )
