port module Main exposing (main)

import Browser
import Browser.Dom as Dom
import Browser.Navigation as Nav
import Html exposing (Html, a, button, div, h1, header, main_, p, text)
import Html.Attributes as Attr
import Html.Events as Events exposing (onClick)
import Json.Decode as Decode
import Page.Conversation as Conversation
import Page.Home as Home
import Route
import Svg
import Svg.Attributes as SvgAttr
import Task
import Url exposing (Url)


port warnOnExit : Bool -> Cmd msg


port pageVisibility : (Bool -> msg) -> Sub msg



-- MAIN


main : Program String Model Msg
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
    { documentHidden : Bool
    , pendingNavigation : Maybe Navigation
    , bypassNavigation : Bool
    , url : Url
    , seed : String
    , key : Nav.Key
    , page : Page
    , generation : Int
    }


type Navigation
    = Requested Browser.UrlRequest
    | Traversed Url


type Page
    = Home Home.Model
    | SettingsUnavailable
    | Conversation Conversation.Model
    | Unavailable String String
    | NotFound



-- INIT


init : String -> Url -> Nav.Key -> ( Model, Cmd Msg )
init seed url key =
    changePage url { documentHidden = False, pendingNavigation = Nothing, bypassNavigation = False, url = url, seed = seed, key = key, page = NotFound, generation = 0 }



-- UPDATE


type Msg
    = LinkClicked Browser.UrlRequest
    | UrlChanged Url
    | HomeMsg Int Home.Msg
    | ConversationMsg Int Conversation.Msg
    | PageVisibility Bool
    | GuardFocus Bool
    | FocusCompleted (Result Dom.Error ())
    | StayHere
    | DiscardAndLeave


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    let
        ( next, command ) =
            updateLocal msg model

        warning state =
            dirty state && not state.bypassNavigation
    in
    ( next
    , Cmd.batch
        [ command
        , if warning model /= warning next then
            warnOnExit (warning next)

          else
            Cmd.none
        ]
    )


dirty : Model -> Bool
dirty model =
    case model.page of
        Conversation conversation ->
            Conversation.configurationDirty conversation

        _ ->
            False


leavesConversation : Url -> Model -> Bool
leavesConversation url model =
    case ( Route.fromUrl url, model.page ) of
        ( Just (Route.Conversation externalId address), Conversation conversation ) ->
            externalId /= conversation.externalId || Just address /= conversation.address

        _ ->
            True


updateLocal : Msg -> Model -> ( Model, Cmd Msg )
updateLocal msg model =
    case msg of
        LinkClicked request ->
            requestNavigation request model

        UrlChanged url ->
            if dirty model && leavesConversation url model && not model.bypassNavigation then
                ( { model | pendingNavigation = Just (Traversed url) }, Cmd.none )

            else
                changePage url { model | url = url, bypassNavigation = False }

        PageVisibility hidden ->
            if hidden == model.documentHidden then
                ( model, Cmd.none )

            else
                let
                    next =
                        { model | documentHidden = hidden }
                in
                case model.page of
                    Home home ->
                        if hidden then
                            let
                                generation =
                                    model.generation + 1
                            in
                            ( { next | generation = generation, page = Home (Home.clear (model.seed ++ "-" ++ String.fromInt generation) home) }, Cmd.none )

                        else
                            stepHome next (Home.init home.externalId)

                    Conversation _ ->
                        updateLocal (ConversationMsg model.generation (Conversation.documentVisibility hidden)) next

                    _ ->
                        ( next, Cmd.none )

        GuardFocus stay ->
            ( model
            , Dom.focus
                (if stay then
                    "navigation-stay"

                 else
                    "navigation-leave"
                )
                |> Task.attempt FocusCompleted
            )

        FocusCompleted _ ->
            ( model, Cmd.none )

        StayHere ->
            ( { model | pendingNavigation = Nothing }
            , case model.pendingNavigation of
                Just (Traversed _) ->
                    Nav.pushUrl model.key (Url.toString model.url)

                _ ->
                    Cmd.none
            )

        DiscardAndLeave ->
            case model.pendingNavigation of
                Just (Requested request) ->
                    ( { model | pendingNavigation = Nothing, bypassNavigation = True }, navigate model.key request )

                Just (Traversed url) ->
                    changePage url { model | url = url, pendingNavigation = Nothing }

                Nothing ->
                    ( model, Cmd.none )

        HomeMsg generation message ->
            case model.page of
                Home home ->
                    if generation == model.generation then
                        let
                            ( next, command, outcome ) =
                                Home.update message home
                        in
                        case outcome of
                            Home.Stay ->
                                stepHome model ( next, command )

                            Home.Created externalId harnessId info ->
                                let
                                    generation_ =
                                        model.generation + 1

                                    ( conversation, effects ) =
                                        Conversation.created generation_ model.seed externalId harnessId info next.prompt next.attachments model.url

                                    destination =
                                        Route.href (Route.Conversation externalId info.id)
                                in
                                ( { model | generation = generation_, page = Conversation conversation }, Cmd.batch [ Cmd.map (ConversationMsg generation_) effects, Nav.pushUrl model.key destination ] )

                    else
                        ( model, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        ConversationMsg generation message ->
            case model.page of
                Conversation conversation ->
                    if generation == model.generation then
                        let
                            ( next, command, outcome ) =
                                Conversation.update message conversation

                            updated =
                                { model | page = Conversation next }

                            ( navigated, navigation ) =
                                case outcome of
                                    Conversation.Stay ->
                                        ( updated, Cmd.none )

                                    Conversation.Navigate path ->
                                        let
                                            url =
                                                model.url
                                        in
                                        requestNavigation (Browser.Internal { url | path = path, query = Nothing, fragment = Nothing }) updated

                                    Conversation.RootResolved url ->
                                        ( updated, Nav.replaceUrl model.key url )
                        in
                        ( navigated, Cmd.batch [ Cmd.map (ConversationMsg generation) command, navigation ] )

                    else
                        ( model, Conversation.discard message )

                _ ->
                    ( model, Conversation.discard message )


stepHome : Model -> ( Home.Model, Cmd Home.Msg ) -> ( Model, Cmd Msg )
stepHome model ( home, command ) =
    ( { model | page = Home home }
    , Cmd.map (HomeMsg model.generation) command
    )



-- ROUTING
-- Page messages capture the visit generation. Leaving discards the page and its draft.


changePage : Url -> Model -> ( Model, Cmd Msg )
changePage url model =
    case ( Route.fromUrl url, model.page ) of
        ( Just Route.Home, Home _ ) ->
            ( model, Cmd.none )

        ( Just (Route.Conversation externalId address), Conversation conversation ) ->
            if conversation.externalId == externalId && conversation.address == Just address then
                let
                    ( next, cmd ) =
                        Conversation.applyUrl url conversation
                in
                ( { model | page = Conversation next }, Cmd.map (ConversationMsg model.generation) cmd )

            else
                enterPage url model

        _ ->
            enterPage url model


enterPage : Url -> Model -> ( Model, Cmd Msg )
enterPage url model =
    let
        next =
            { model | generation = model.generation + 1 }

        enter externalId address =
            let
                ( conversation, cmd ) =
                    Conversation.init next.generation model.seed externalId address url
            in
            ( { next | page = Conversation conversation }, Cmd.map (ConversationMsg next.generation) cmd )

        ( page, command ) =
            case Route.fromUrl url of
                Just Route.Home ->
                    stepHome next (Home.init (model.seed ++ "-" ++ String.fromInt next.generation))

                Just Route.Settings ->
                    ( { next | page = SettingsUnavailable }, Cmd.none )

                Just (Route.Session externalId) ->
                    enter externalId Nothing

                Just (Route.Conversation externalId address) ->
                    enter externalId (Just address)

                Just (Route.ConversationPage externalId address pane) ->
                    ( { next | page = Unavailable pane (Route.href (Route.Conversation externalId address)) }, Cmd.none )

                Nothing ->
                    ( { next | page = NotFound }, Cmd.none )
    in
    ( page
    , Cmd.batch
        [ case model.page of
            Conversation conversation ->
                Conversation.leave conversation

            _ ->
                Cmd.none
        , command
        ]
    )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch [ pageVisibility PageVisibility, Sub.map (ConversationMsg model.generation) Conversation.events, pageSubscriptions model ]


pageSubscriptions : Model -> Sub Msg
pageSubscriptions model =
    case model.page of
        Home home ->
            Sub.map (HomeMsg model.generation) (Home.subscriptions home)

        SettingsUnavailable ->
            Sub.none

        Conversation conversation ->
            Sub.map (ConversationMsg model.generation) (Conversation.subscriptions conversation)

        Unavailable _ _ ->
            Sub.none

        NotFound ->
            Sub.none



-- VIEW


view : Model -> Browser.Document Msg
view model =
    let
        document =
            viewPage model

        guard =
            case model.pendingNavigation of
                Nothing ->
                    []

                Just _ ->
                    [ div
                        [ Attr.class "navigation-guard"
                        , Attr.attribute "role" "dialog"
                        , Attr.attribute "aria-modal" "true"
                        , Attr.attribute "aria-label" "Pending settings"
                        , Events.preventDefaultOn "keydown"
                            (Decode.field "key" Decode.string
                                |> Decode.andThen
                                    (\key ->
                                        if key == "Escape" then
                                            Decode.succeed ( StayHere, True )

                                        else if key == "Tab" then
                                            Decode.at [ "target", "id" ] Decode.string |> Decode.map (\target -> ( GuardFocus (target /= "navigation-stay"), True ))

                                        else
                                            Decode.fail "Ordinary dialog key"
                                    )
                            )
                        ]
                        [ button [ Attr.id "navigation-stay", onClick StayHere ] [ text "Stay" ]
                        , button [ Attr.id "navigation-leave", onClick DiscardAndLeave ] [ text "Leave" ]
                        ]
                    ]
    in
    { document | body = document.body ++ guard }


viewPage : Model -> Browser.Document Msg
viewPage model =
    case model.page of
        Home home ->
            viewDocument (HomeMsg model.generation) (Home.view home)

        SettingsUnavailable ->
            viewDocument never (viewProblem "Settings unavailable" "The settings page is not implemented yet.")

        Conversation conversation ->
            let
                document =
                    Conversation.view conversation
            in
            { title = document.title, body = List.map (Html.map (ConversationMsg model.generation)) document.body }

        Unavailable pane back ->
            viewDocument never
                { title = pane ++ " unavailable"
                , body = [ main_ [ Attr.id "main-area" ] [ h1 [] [ text (pane ++ " unavailable") ], p [ Attr.attribute "role" "status" ] [ text "This destination is outside the conversation preview." ], a [ Attr.href back ] [ text "Return to conversation" ] ] ]
                }

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


requestNavigation : Browser.UrlRequest -> Model -> ( Model, Cmd Msg )
requestNavigation request model =
    let
        leaves =
            case request of
                Browser.Internal url ->
                    leavesConversation url model

                Browser.External _ ->
                    True
    in
    if dirty model && leaves then
        ( { model | pendingNavigation = Just (Requested request) }, Cmd.none )

    else
        ( model, navigate model.key request )


navigate : Nav.Key -> Browser.UrlRequest -> Cmd Msg
navigate key request =
    case request of
        Browser.Internal url ->
            Nav.pushUrl key (Url.toString url)

        Browser.External href ->
            Nav.load href
