module Composer exposing (Config, Submission(..), metadata, modelDetails, shell, view)

import Attachment exposing (Attachment, AttachmentId)
import Html exposing (Attribute, Html, button, div, form, span, text, textarea)
import Html.Attributes as A exposing (attribute, class, id)
import Html.Events exposing (on, onClick, onSubmit)
import Icon
import Json.Decode as D


type Submission msg
    = Ready msg
    | Working { submit : msg, label : String, alternate : msg, alternateLabel : String, stop : msg }


type alias Config msg =
    { text : String
    , edit : String -> Int -> msg
    , events : List (Attribute msg)
    , editingDisabled : Bool
    , attachments : List Attachment
    , removeAttachment : AttachmentId -> msg
    , feedback : Html msg
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
                Ready action ->
                    { action = action, id = "send", label = "Send", attributes = [ A.type_ "button", onClick action ] }

                Working actions ->
                    { action = actions.submit
                    , id = "send"
                    , label = actions.label
                    , attributes = [ A.type_ "button", onClick actions.submit ]
                    }

        content =
            [ textarea
                ([ id "prompt", A.name "content", A.rows 2, A.maxlength 100000, A.tabindex 1, A.placeholder "Ask Pi…", attribute "aria-label" "Message", attribute "aria-autocomplete" "list", attribute "aria-controls" "completions", A.value config.text, on "input" (D.map2 config.edit (D.at [ "target", "value" ] D.string) (D.at [ "target", "selectionStart" ] D.int)), A.disabled config.editingDisabled ] ++ config.events)
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
            , div [ id "previews", attribute "aria-label" "Attached files" ]
                (List.map (Attachment.viewAttachment config.editingDisabled config.removeAttachment) config.attachments)
            , config.feedback
            ]

        working =
            case config.submission of
                Working actions ->
                    [ button [ class "submission-mode", A.type_ "button", A.disabled config.submitDisabled, A.title (actions.alternateLabel ++ " (Alt+Enter)"), onClick actions.alternate ] [ text actions.alternateLabel ]
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
                    ++ [ button ([ id submit.id, class "icon", A.disabled config.submitDisabled, attribute "aria-label" submit.label, A.title (submit.label ++ " (Ctrl/Cmd+Enter)") ] ++ submit.attributes) [ Icon.view "send" ] ]
                )

        box children =
            div [ class "compose-box" ] (children ++ [ controls ])
    in
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
