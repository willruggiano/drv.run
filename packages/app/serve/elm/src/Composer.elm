module Composer exposing (box, dot, metadata, modelDetails, shell)

import Html exposing (Html, div, span)
import Html.Attributes exposing (attribute, class, id)


box : List (Html msg) -> Html msg -> Html msg
box content controls =
    div [ class "compose-box" ] (content ++ [ controls ])


shell : List (Html msg) -> Html msg
shell content =
    div [ id "composer-shell", class "composer-shell" ] content


dot : Html msg
dot =
    span [ class "footer-dot", attribute "aria-hidden" "true" ] []


modelDetails : Html msg -> Html msg -> List (Html msg)
modelDetails model thinking =
    [ span [ class "model-name" ] [ model ], dot, span [ class "model-effort" ] [ thinking ] ]


metadata : { label : String, before : List (Html msg), instance : Html msg, statistics : List (Html msg), model : Html msg, context : Maybe (Html msg), after : List (Html msg) } -> Html msg
metadata content =
    div [ id "bottom-line", attribute "aria-label" content.label ]
        [ div [ class "footer-row" ]
            (content.before
                ++ [ content.instance ]
                ++ content.statistics
                ++ [ div [ class "footer-model-context" ]
                        (content.model :: (content.context |> Maybe.map (\context -> [ dot, context ]) |> Maybe.withDefault []))
                   ]
                ++ content.after
            )
        ]
