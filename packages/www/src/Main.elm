module Main exposing (main)

import Browser
import Browser.Navigation as Nav
import Html exposing (Html, a, div, h1, header, main_, p, text)
import Html.Attributes as Attr
import Page.Home as Home
import Route exposing (Route)
import Svg
import Svg.Attributes as SvgAttr
import Url exposing (Url)



-- MAIN


main : Program () Model Msg
main =
    Browser.application
        { init = init
        , update = update
        , view = view
        , subscriptions = subscriptions
        , onUrlRequest = LinkClicked
        , onUrlChange = UrlChanged
        }



-- MODEL


type alias Model =
    { key : Nav.Key
    , page : Page
    , generation : Int
    }


type Page
    = Home Home.Model
    | Unavailable Route
    | NotFound



-- INIT


init : () -> Url -> Nav.Key -> ( Model, Cmd Msg )
init _ url key =
    changePage url { key = key, page = NotFound, generation = 0 }



-- UPDATE


type Msg
    = LinkClicked Browser.UrlRequest
    | UrlChanged Url
    | HomeMsg Int Home.Msg


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        LinkClicked request ->
            case request of
                Browser.Internal url ->
                    ( model, Nav.pushUrl model.key (Url.toString url) )

                Browser.External href ->
                    ( model, Nav.load href )

        UrlChanged url ->
            changePage url model

        HomeMsg generation message ->
            case model.page of
                Home home ->
                    if generation == model.generation then
                        stepHome model (Home.update message home)

                    else
                        ( model, Cmd.none )

                Unavailable _ ->
                    ( model, Cmd.none )

                NotFound ->
                    ( model, Cmd.none )


stepHome : Model -> ( Home.Model, Cmd Home.Msg ) -> ( Model, Cmd Msg )
stepHome model ( home, command ) =
    ( { model | page = Home home }
    , Cmd.map (HomeMsg model.generation) command
    )



-- ROUTING


changePage : Url -> Model -> ( Model, Cmd Msg )
changePage url model =
    case ( Route.fromUrl url, model.page ) of
        ( Just Route.Home, Home _ ) ->
            ( model, Cmd.none )

        ( route, _ ) ->
            let
                next =
                    { model | generation = model.generation + 1 }
            in
            case route of
                Just Route.Home ->
                    stepHome next (Home.init ())

                Just destination ->
                    ( { next | page = Unavailable destination }, Cmd.none )

                Nothing ->
                    ( { next | page = NotFound }, Cmd.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    case model.page of
        Home home ->
            Sub.map (HomeMsg model.generation) (Home.subscriptions home)

        Unavailable _ ->
            Sub.none

        NotFound ->
            Sub.none



-- VIEW


view : Model -> Browser.Document Msg
view model =
    case model.page of
        Home home ->
            viewDocument (HomeMsg model.generation) (Home.view home)

        Unavailable route ->
            viewDocument never (viewUnavailable route)

        NotFound ->
            viewDocument never (viewProblem "Not found" "This address does not identify a page.")


viewDocument : (msg -> Msg) -> Browser.Document msg -> Browser.Document Msg
viewDocument toMsg document =
    { title = document.title
    , body =
        [ div [ Attr.id "page" ]
            (viewHeader :: List.map (Html.map toMsg) document.body)
        ]
    }


viewHeader : Html msg
viewHeader =
    header [ Attr.id "app-header" ]
        [ Html.nav [ Attr.class "landing-navigation", Attr.attribute "aria-label" "Global" ]
            [ a
                [ Attr.class "icon"
                , Attr.href (Route.href Route.Settings)
                , Attr.attribute "aria-label" "Global settings"
                , Attr.title "Global settings"
                ]
                [ settingsIcon ]
            ]
        ]


viewUnavailable : Route -> Browser.Document msg
viewUnavailable route =
    case route of
        Route.Home ->
            viewProblem "Unavailable" "The session catalog is unavailable."

        Route.Settings ->
            viewProblem "Settings unavailable" "The settings page is not implemented yet."

        Route.Session externalId ->
            viewProblem "Session unavailable" ("The session page for " ++ externalId ++ " is not implemented yet.")


viewProblem : String -> String -> Browser.Document msg
viewProblem title description =
    { title = title
    , body =
        [ main_ [ Attr.id "main-area" ]
            [ h1 [] [ text title ]
            , p [ Attr.attribute "role" "alert" ] [ text description ]
            , a [ Attr.href (Route.href Route.Home) ] [ text "Home" ]
            ]
        ]
    }



-- ICONS


settingsIcon : Html msg
settingsIcon =
    Svg.svg [ SvgAttr.class "glyph", SvgAttr.viewBox "0 0 24 24", Attr.attribute "aria-hidden" "true" ]
        [ Svg.path [ SvgAttr.d "m9 3-.6 2.4-1.5.9-2.4-.7-3 5.2L3.3 12l.1 1.8-1.7 1.8 3 5.2 2.3-.7 1.6.9.5 2.4h6l.6-2.4 1.5-.9 2.4.7 3-5.2-1.8-1.2-.1-1.8 1.7-1.8-3-5.2-2.3.7-1.6-.9L15 3Z", SvgAttr.transform "translate(1 -1) scale(.92)" ] []
        , Svg.circle [ SvgAttr.cx "12", SvgAttr.cy "12", SvgAttr.r "3.2" ] []
        ]
