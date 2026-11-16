module Api exposing (Failure, Problem(..), Response, mutation, query)

import Dict
import Graphql.Http as Http
import Graphql.Http.GraphqlError exposing (GraphqlError)
import Graphql.Operation exposing (RootMutation, RootQuery)
import Graphql.SelectionSet exposing (SelectionSet)
import Json.Decode as Decode



-- RESPONSES


{-| Preserve partial GraphQL data and original diagnostics alongside a classified
problem. A failure does not establish whether a mutation committed.
-}
type alias Response data =
    Result (Failure data) data


type alias Failure data =
    { problem : Problem
    , detail : Http.Error data
    }


type Problem
    = AccessDenied
    | AuthenticationRequired
    | ExecutionFailure
    | InvalidAddress
    | TimedOut
    | NetworkFailure
    | InvalidResponse
    | HttpFailure Int



-- REQUESTS


query : (Response data -> msg) -> SelectionSet data RootQuery -> Cmd msg
query toMsg selection =
    Http.queryRequest "/api/graphql" selection
        |> Http.send (Result.mapError classify >> toMsg)


mutation : (Response data -> msg) -> SelectionSet data RootMutation -> Cmd msg
mutation toMsg selection =
    Http.mutationRequest "/api/graphql" selection
        |> Http.send (Result.mapError classify >> toMsg)



-- ERROR CLASSIFICATION


classify : Http.Error data -> Failure data
classify error =
    { problem = problem error, detail = error }


problem : Http.Error data -> Problem
problem error =
    case error of
        Http.GraphqlError _ errors ->
            let
                codes =
                    List.filterMap errorCode errors
            in
            if List.member "FORBIDDEN" codes then
                AccessDenied

            else if List.member "UNAUTHENTICATED" codes then
                AuthenticationRequired

            else
                ExecutionFailure

        Http.HttpError transport ->
            case transport of
                Http.BadUrl _ ->
                    InvalidAddress

                Http.Timeout ->
                    TimedOut

                Http.NetworkError ->
                    NetworkFailure

                Http.BadPayload _ ->
                    InvalidResponse

                Http.BadStatus metadata _ ->
                    case metadata.statusCode of
                        401 ->
                            AuthenticationRequired

                        403 ->
                            AccessDenied

                        status ->
                            HttpFailure status


errorCode : GraphqlError -> Maybe String
errorCode error =
    Dict.get "extensions" error.details
        |> Maybe.andThen
            (\extensions ->
                Decode.decodeValue (Decode.field "code" Decode.string) extensions
                    |> Result.toMaybe
            )
