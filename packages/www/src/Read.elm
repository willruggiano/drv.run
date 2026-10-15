module Read exposing (Read(..), errorMessage, observed, pending, receive, receiveOptional, viewReadStatus)

import Api
import Graphql.Http as Http
import Graphql.Http.GraphqlError exposing (PossiblyParsedData(..))
import Html exposing (Html, button, p, text)
import Html.Attributes as Attr exposing (attribute, class)
import Html.Events exposing (onClick)


type Read data
    = Loading (Maybe data)
    | Loaded data
    | Partial data (Api.Failure data)
    | Failed (Maybe data) (Api.Failure data)


observed : Read data -> Maybe data
observed read =
    case read of
        Loading previous ->
            previous

        Loaded value ->
            Just value

        Partial value _ ->
            Just value

        Failed previous _ ->
            previous


pending : Read data -> Bool
pending read =
    case read of
        Loading _ ->
            True

        Loaded _ ->
            False

        Partial _ _ ->
            False

        Failed _ _ ->
            False


receive : Api.Response data -> Read data -> Read data
receive response previous =
    case response of
        Ok value ->
            Loaded value

        Err failure ->
            case failure.detail of
                Http.GraphqlError (ParsedData value) _ ->
                    Partial value failure

                _ ->
                    Failed (observed previous) failure


viewReadStatus : String -> msg -> Read data -> Html msg
viewReadStatus name retry read =
    case read of
        Loaded _ ->
            text ""

        Loading previous ->
            p [ class "read-status", attribute "role" "status" ]
                [ text
                    (if previous == Nothing then
                        "Loading " ++ name ++ "…"

                     else
                        "Refreshing " ++ name ++ "…"
                    )
                ]

        Partial _ failure ->
            viewReadFailure name retry (errorMessage failure.problem ++ " Partial data shown.")

        Failed previous error ->
            viewReadFailure name
                retry
                (errorMessage error.problem
                    ++ (if previous /= Nothing then
                            " Previous data is stale."

                        else
                            ""
                       )
                )


viewReadFailure : String -> msg -> String -> Html msg
viewReadFailure name retry description =
    p [ class "read-status error", attribute "role" "alert" ]
        [ text (name ++ ": " ++ description)
        , button [ Attr.type_ "button", onClick retry ] [ text "Retry" ]
        ]


errorMessage : Api.Problem -> String
errorMessage problem =
    case problem of
        Api.AccessDenied ->
            "Access denied."

        Api.AuthenticationRequired ->
            "Authentication required."

        Api.ExecutionFailure ->
            "The server could not complete this read."

        Api.InvalidAddress ->
            "Invalid API address."

        Api.TimedOut ->
            "The request timed out."

        Api.NetworkFailure ->
            "Could not reach the server."

        Api.InvalidResponse ->
            "Invalid API response."

        Api.HttpFailure status ->
            "HTTP " ++ String.fromInt status ++ "."


receiveOptional : Api.Response (Maybe data) -> Read (Maybe data) -> Read (Maybe data)
receiveOptional response previous =
    case response of
        Err failure ->
            case failure.detail of
                Http.GraphqlError (ParsedData Nothing) _ ->
                    Failed (observed previous) failure

                _ ->
                    receive response previous

        Ok _ ->
            receive response previous
