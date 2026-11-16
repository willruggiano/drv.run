module Api exposing (Response, mutation, query)

import Graphql.Http
import Graphql.Operation exposing (RootMutation, RootQuery)
import Graphql.SelectionSet exposing (SelectionSet)



-- Retain GraphqlError's ParsedData/UnparsedData and error details; do not
-- discard partial data or convert execution failures into transport failures.


type alias Response data =
    Result (Graphql.Http.Error data) data


query : (Response data -> msg) -> SelectionSet data RootQuery -> Cmd msg
query toMsg selection =
    Graphql.Http.queryRequest "/api/graphql" selection
        |> Graphql.Http.send toMsg


mutation : (Response data -> msg) -> SelectionSet data RootMutation -> Cmd msg
mutation toMsg selection =
    Graphql.Http.mutationRequest "/api/graphql" selection
        |> Graphql.Http.send toMsg
