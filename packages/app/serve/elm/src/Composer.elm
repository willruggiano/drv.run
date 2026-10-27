module Composer exposing (Config, Submission(..), dot, metadata, modelDetails, shell, view)

import Html exposing (Attribute, Html, button, div, fieldset, form, img, span, text, textarea)
import Html.Attributes as A exposing (attribute, class, id)
import Html.Events exposing (onClick, onInput, onSubmit)
import Icon


type Submission msg
    = Create (Html msg) msg
    | Ready msg
    | Working { queue : msg, steer : msg, stop : msg }


type alias Config msg =
    { text : String
    , edit : String -> msg
    , events : List (Attribute msg)
    , editingDisabled : Bool
    , attachments : List { name : String, url : String, remove : msg }
    , pickFiles : msg
    , completions : Maybe { items : List { label : String, description : Maybe String }, selected : Int, choose : Int -> msg }
    , submission : Submission msg
    , submitDisabled : Bool
    }


view : Config msg -> Html msg
view config =
    let
        submit =
            case config.submission of
                Create _ action ->
                    { action = action, id = "create", label = "Create session", attributes = [ A.title "New session", A.type_ "submit" ] }

                Ready action ->
                    { action = action, id = "send", label = "Send", attributes = [ A.type_ "button", onClick action ] }

                Working actions ->
                    { action = actions.queue, id = "send", label = "Queue", attributes = [ A.type_ "button", onClick actions.queue ] }

        content =
            [ textarea
                ([ id "prompt", A.name "content", A.rows 2, A.maxlength 100000, A.tabindex 1, A.placeholder "Ask Pi…", attribute "aria-label" "Message", attribute "aria-autocomplete" "list", attribute "aria-controls" "completions", A.value config.text, onInput config.edit, A.disabled config.editingDisabled ] ++ config.events)
                []
            , div [ id "completions", attribute "role" "listbox", A.hidden (config.completions == Nothing) ]
                (config.completions
                    |> Maybe.map
                        (\completion ->
                            List.indexedMap
                                (\index item ->
                                    button
                                        [ A.type_ "button"
                                        , attribute "role" "option"
                                        , attribute "aria-selected"
                                            (if index == completion.selected then
                                                "true"

                                             else
                                                "false"
                                            )
                                        , onClick (completion.choose index)
                                        ]
                                        [ span [] [ text item.label ]
                                        , item.description |> Maybe.map (\description -> span [ class "completion-description" ] [ text description ]) |> Maybe.withDefault (text "")
                                        ]
                                )
                                completion.items
                        )
                    |> Maybe.withDefault []
                )
            , div [ id "previews", attribute "aria-label" "Attached images" ]
                (List.map
                    (\attachment ->
                        button
                            [ A.type_ "button"
                            , attribute "aria-label"
                                (case config.submission of
                                    Create _ _ ->
                                        "Remove " ++ attachment.name

                                    _ ->
                                        "Remove attachment"
                                )
                            , A.disabled config.editingDisabled
                            , onClick attachment.remove
                            ]
                            [ img [ A.src attachment.url, A.alt attachment.name ] [] ]
                    )
                    config.attachments
                )
            ]

        working =
            case config.submission of
                Working actions ->
                    [ button [ class "submission-mode", A.type_ "button", A.disabled config.submitDisabled, onClick actions.steer ] [ text "Steer" ]
                    , button [ id "stop", class "icon", A.type_ "button", attribute "aria-label" "Stop", onClick actions.stop ] [ Icon.view "close" ]
                    ]

                _ ->
                    [ text "", text "" ]

        controls =
            div
                [ id "controls"
                , class "actions"
                , attribute "data-state"
                    (case config.submission of
                        Working _ ->
                            "working"

                        _ ->
                            "ready"
                    )
                ]
                ([ button [ id "input-toggle", class "icon", A.type_ "button", attribute "aria-label" "Upload attachments", A.disabled config.editingDisabled, onClick config.pickFiles ] [ text "+" ]
                 , span [ class "spacer" ] []
                 ]
                    ++ working
                    ++ [ button ([ id submit.id, class "icon", A.disabled config.submitDisabled, attribute "aria-label" submit.label ] ++ submit.attributes) [ Icon.view "send" ] ]
                )

        box children =
            div [ class "compose-box" ] (children ++ [ controls ])
    in
    case config.submission of
        Create options _ ->
            form [ id "composer", class "new-composer", onSubmit submit.action ]
                [ fieldset [ id "new-options", attribute "aria-label" "New session options", A.disabled config.editingDisabled ] [ options ]
                , shell [ box content ]
                ]

        _ ->
            box [ form [ id "composer", onSubmit submit.action ] content ]


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
