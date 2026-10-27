module ComposerTest exposing (tests)

import Composer
import Expect
import Html
import Html.Attributes as A
import Html.Events exposing (on)
import Json.Decode as D
import Json.Encode as E
import Test exposing (Test, describe, test)
import Test.Html.Event as Event
import Test.Html.Query as Query
import Test.Html.Selector as S


type Msg
    = Edit String
    | Create
    | Send
    | Queue
    | Steer
    | Stop
    | PickFiles
    | Remove
    | Complete Int
    | Key
    | Composition Bool


config : Composer.Config Msg
config =
    { text = "Draft"
    , edit = Edit
    , events =
        [ on "keydown" (D.succeed Key)
        , on "compositionstart" (D.succeed (Composition True))
        , on "compositionend" (D.succeed (Composition False))
        ]
    , editingDisabled = False
    , attachments = [ { name = "image.png", url = "blob:preview", remove = Remove } ]
    , pickFiles = PickFiles
    , completions = Just { items = [ { label = "/new", description = Nothing } ], selected = 0, choose = Complete }
    , submission = Composer.Ready Send
    , submitDisabled = False
    }


render : Composer.Config Msg -> Query.Single Msg
render options =
    Query.fromHtml (Html.div [] [ Composer.view options ])


tests : Test
tests =
    describe "Shared composer rendering"
        [ describe "Each workflow owns its submission message"
            (List.map
                (\scenario ->
                    test scenario.name <|
                        \_ ->
                            let
                                view =
                                    render { config | submission = scenario.submission }
                            in
                            Expect.all
                                [ \_ -> view |> Query.findAll [ S.tag "form" ] |> Query.count (Expect.equal 1)
                                , \_ -> view |> Query.find [ S.id "composer" ] |> Event.simulate Event.submit |> Event.expect scenario.message
                                ]
                                ()
                )
                [ { name = "creation", submission = Composer.Create (Html.input [ A.id "target" ] []) Create, message = Create }
                , { name = "ready conversation", submission = Composer.Ready Send, message = Send }
                , { name = "working conversation", submission = Composer.Working { queue = Queue, steer = Steer, stop = Stop }, message = Queue }
                ]
            )
        , test "input, keyboard, composition, attachments, and completion dispatch caller messages" <|
            \_ ->
                let
                    view =
                        render config

                    prompt =
                        Query.find [ S.id "prompt" ] view
                in
                Expect.all
                    [ \_ -> prompt |> Event.simulate (Event.input "Edited") |> Event.expect (Edit "Edited")
                    , \_ -> prompt |> Event.simulate (Event.custom "keydown" (E.object [])) |> Event.expect Key
                    , \_ -> prompt |> Event.simulate (Event.custom "compositionstart" (E.object [])) |> Event.expect (Composition True)
                    , \_ -> prompt |> Event.simulate (Event.custom "compositionend" (E.object [])) |> Event.expect (Composition False)
                    , \_ -> view |> Query.find [ S.id "input-toggle" ] |> Event.simulate Event.click |> Event.expect PickFiles
                    , \_ -> view |> Query.find [ S.id "previews" ] |> Query.find [ S.tag "button" ] |> Event.simulate Event.click |> Event.expect Remove
                    , \_ -> view |> Query.find [ S.id "completions" ] |> Query.find [ S.attribute (A.attribute "aria-selected" "true") ] |> Event.simulate Event.click |> Event.expect (Complete 0)
                    , \_ -> view |> Query.find [ S.id "send" ] |> Event.simulate Event.click |> Event.expect Send
                    ]
                    ()
        , test "creation can retry its frozen input while conversation drafts remain editable" <|
            \_ ->
                let
                    creation =
                        render { config | submission = Composer.Create (Html.input [ A.id "target" ] []) Create, editingDisabled = True }

                    conversation =
                        render { config | submitDisabled = True }
                in
                Expect.all
                    [ \_ -> creation |> Query.find [ S.id "prompt" ] |> Query.has [ S.disabled True ]
                    , \_ -> creation |> Query.find [ S.id "new-options" ] |> Query.has [ S.disabled True ]
                    , \_ -> creation |> Query.find [ S.id "input-toggle" ] |> Query.has [ S.disabled True ]
                    , \_ -> creation |> Query.find [ S.id "previews" ] |> Query.find [ S.tag "button" ] |> Query.has [ S.disabled True, S.attribute (A.attribute "aria-label" "Remove image.png") ]
                    , \_ -> creation |> Query.find [ S.id "create" ] |> Query.has [ S.disabled False ]
                    , \_ -> conversation |> Query.find [ S.id "prompt" ] |> Query.has [ S.disabled False ]
                    , \_ -> conversation |> Query.find [ S.id "input-toggle" ] |> Query.has [ S.disabled False ]
                    , \_ -> conversation |> Query.find [ S.id "send" ] |> Query.has [ S.disabled True ]
                    , \_ -> conversation |> Query.hasNot [ S.id "stop" ]
                    ]
                    ()
        , test "working conversations keep stop available when queue and steer are disabled" <|
            \_ ->
                let
                    view =
                        render { config | submission = Composer.Working { queue = Queue, steer = Steer, stop = Stop }, submitDisabled = True }

                    active =
                        render { config | submission = Composer.Working { queue = Queue, steer = Steer, stop = Stop } }
                in
                Expect.all
                    [ \_ -> view |> Query.find [ S.id "send" ] |> Query.has [ S.disabled True ]
                    , \_ -> view |> Query.find [ S.class "submission-mode" ] |> Query.has [ S.disabled True ]
                    , \_ -> view |> Query.find [ S.id "stop" ] |> Query.hasNot [ S.disabled True ]
                    , \_ -> active |> Query.find [ S.id "send" ] |> Event.simulate Event.click |> Event.expect Queue
                    , \_ -> active |> Query.find [ S.class "submission-mode" ] |> Event.simulate Event.click |> Event.expect Steer
                    , \_ -> active |> Query.find [ S.id "stop" ] |> Event.simulate Event.click |> Event.expect Stop
                    ]
                    ()
        ]
