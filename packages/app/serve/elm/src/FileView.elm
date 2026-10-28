port module FileView exposing (main)

import Browser
import Browser.Dom
import Html exposing (Html, a, code, div, h1, header, main_, p, pre, span, text)
import Html.Attributes exposing (attribute, class, href, id)
import Json.Decode as D
import Json.Encode as E
import Syntax
import Task


port fileBrowser : E.Value -> Cmd msg


port fileIncoming : (D.Value -> msg) -> Sub msg


type alias Flags =
    { path : String, source : String, conversation : String, embedded : Bool, fragment : String }


type alias Model =
    { flags : Flags, syntax : Syntax.Model, error : String }


type Msg
    = Tokens D.Value
    | Scrolled (Result Browser.Dom.Error ())


main : Program Flags Model Msg
main =
    Browser.document
        { init =
            \flags ->
                let
                    ( syntax, requests ) =
                        Syntax.sync [ ( Syntax.fromPath flags.path, flags.source ) ] Syntax.empty

                    scroll =
                        if String.startsWith "#L" flags.fragment then
                            Browser.Dom.getElement (String.dropLeft 1 flags.fragment)
                                |> Task.andThen (\element -> Browser.Dom.setViewport 0 (max 0 (element.element.y - 60)))
                                |> Task.attempt Scrolled

                        else
                            Cmd.none
                in
                ( { flags = flags, syntax = syntax, error = "" }
                , Cmd.batch
                    [ if List.isEmpty requests then
                        Cmd.none

                      else
                        fileBrowser (E.list Syntax.encodeRequest requests)
                    , scroll
                    ]
                )
        , subscriptions = \_ -> fileIncoming Tokens
        , update =
            \msg model ->
                case msg of
                    Tokens value ->
                        case Syntax.receive value model.syntax of
                            Ok syntax ->
                                ( { model | syntax = syntax }, Cmd.none )

                            Err _ ->
                                ( { model | error = "Syntax highlighting failed." }, Cmd.none )

                    Scrolled _ ->
                        ( model, Cmd.none )
        , view = \model -> { title = model.flags.path, body = [ view model ] }
        }


view : Model -> Html Msg
view model =
    div []
        [ if model.flags.embedded then
            text ""

          else
            header [ class "bar" ]
                [ a [ href model.flags.conversation ] [ text "Conversation" ]
                , h1 [] [ text model.flags.path ]
                ]
        , if model.error == "" then
            text ""

          else
            p [ class "error", attribute "role" "alert" ] [ text model.error ]
        , main_ []
            [ pre [ id "file-source" ]
                [ span [ class "line-numbers" ]
                    (String.split "\n" model.flags.source
                        |> List.indexedMap
                            (\index _ ->
                                let
                                    number =
                                        String.fromInt (index + 1)
                                in
                                a [ class "line-number", id ("L" ++ number), href ("#L" ++ number), attribute "aria-label" ("Line " ++ number) ] [ text number ]
                            )
                    )
                , code [] (Syntax.view model.syntax (Syntax.fromPath model.flags.path) model.flags.source)
                ]
            ]
        ]
