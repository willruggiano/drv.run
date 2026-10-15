module Configuration exposing (Model, Msg(..), agent, init, update, view, viewDirectory, viewEnvironmentPicker, viewModelControls)

import Api
import Api.Enum.ModelThinkingLevel as Thinking exposing (ModelThinkingLevel)
import Api.Home as Home exposing (Environment, EnvironmentPage, ModelChoice)
import Api.InputObject as Input
import Api.Scalars as Scalars
import Graphql.Http as Http
import Graphql.Http.GraphqlError exposing (PossiblyParsedData(..))
import Graphql.OptionalArgument
import Html exposing (Html, button, div, input, label, option, select, span, text)
import Html.Attributes as Attr exposing (attribute, class, id)
import Html.Events exposing (onClick, onInput)
import Json.Encode as Encode
import Read exposing (Read(..), observed, pending, receive, viewReadStatus)
import Svg
import Svg.Attributes as SvgAttr


type alias Model =
    { models : Read (List ModelChoice)
    , environments : Read (Maybe EnvironmentPage)
    , selectedModel : Maybe ModelChoice
    , thinking : Maybe ModelThinkingLevel
    , environment : Maybe Environment
    , directory : String
    }


type Pagination
    = Replace
    | Append


init : () -> ( Model, Cmd Msg )
init _ =
    ( { models = Loading Nothing, environments = Loading Nothing, selectedModel = Nothing, thinking = Nothing, environment = Nothing, directory = "" }
    , Cmd.batch [ Api.query ModelsReceived Home.models, Api.query (EnvironmentsReceived Replace) (Home.environments Nothing) ]
    )


type Msg
    = ModelsReceived (Api.Response (List ModelChoice))
    | EnvironmentsReceived Pagination (Api.Response (Maybe EnvironmentPage))
    | RefreshModels
    | RefreshEnvironments
    | MoreEnvironments
    | ModelSelected String
    | ThinkingSelected String
    | EnvironmentSelected String
    | DirectoryEdited String


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        ModelsReceived response ->
            ( { model | models = receive response model.models }, Cmd.none )

        EnvironmentsReceived pagination response ->
            let
                environments =
                    receiveEnvironments pagination response model.environments

                environment =
                    model.environment |> Maybe.map (\selected -> environmentChoices environments |> List.filter (\item -> item.target == selected.target) |> List.head |> Maybe.withDefault selected)
            in
            ( { model | environments = environments, environment = environment }, Cmd.none )

        RefreshModels ->
            if pending model.models then
                ( model, Cmd.none )

            else
                ( { model | models = Loading (observed model.models) }, Api.query ModelsReceived Home.models )

        RefreshEnvironments ->
            if pending model.environments then
                ( model, Cmd.none )

            else
                ( { model | environments = Loading (observed model.environments) }, Api.query (EnvironmentsReceived Replace) (Home.environments Nothing) )

        MoreEnvironments ->
            case observed model.environments |> Maybe.andThen identity |> Maybe.andThen .next of
                Just cursor ->
                    if pending model.environments then
                        ( model, Cmd.none )

                    else
                        ( { model | environments = Loading (observed model.environments) }, Api.query (EnvironmentsReceived Append) (Home.environments (Just cursor)) )

                Nothing ->
                    ( model, Cmd.none )

        ModelSelected key ->
            let
                selected =
                    observed model.models
                        |> Maybe.withDefault []
                        |> List.filter (\choice -> modelKey choice == key)
                        |> List.head

                levels =
                    selected |> Maybe.map .thinkingLevels |> Maybe.withDefault []
            in
            ( { model | selectedModel = selected, thinking = supportedThinking levels model.thinking }, Cmd.none )

        ThinkingSelected value ->
            let
                levels =
                    currentModel model.selectedModel (observed model.models |> Maybe.withDefault [])
                        |> Maybe.map .thinkingLevels
                        |> Maybe.withDefault []
            in
            ( { model | thinking = supportedThinking levels (Thinking.fromString value) }, Cmd.none )

        EnvironmentSelected key ->
            ( { model | environment = selectedEnvironment key (environmentChoices model.environments) }, Cmd.none )

        DirectoryEdited value ->
            ( { model | directory = value }, Cmd.none )


receiveEnvironments : Pagination -> Api.Response (Maybe EnvironmentPage) -> Read (Maybe EnvironmentPage) -> Read (Maybe EnvironmentPage)
receiveEnvironments pagination response previous =
    let
        combine page =
            case pagination of
                Replace ->
                    page

                Append ->
                    Maybe.map (appendEnvironmentPage (observed previous |> Maybe.andThen identity)) page
    in
    case response of
        Ok page ->
            Loaded (combine page)

        Err failure ->
            case failure.detail of
                Http.GraphqlError (ParsedData Nothing) _ ->
                    Failed (observed previous) failure

                Http.GraphqlError (ParsedData page) _ ->
                    Partial (combine page) failure

                _ ->
                    Failed (observed previous) failure


appendEnvironmentPage : Maybe EnvironmentPage -> EnvironmentPage -> EnvironmentPage
appendEnvironmentPage previous incoming =
    case previous of
        Nothing ->
            incoming

        Just before ->
            let
                replace old =
                    List.filter (\item -> item.id == old.id) incoming.nodes
                        |> List.head
                        |> Maybe.withDefault old

                isNew item =
                    not (List.any (\old -> old.id == item.id) before.nodes)
            in
            { incoming | nodes = List.map replace before.nodes ++ List.filter isNew incoming.nodes }



-- SELECTION


modelKey : ModelChoice -> String
modelKey choice =
    Encode.encode 0 (Encode.list Encode.string [ choice.provider, choice.id ])


environmentKey : Environment -> String
environmentKey environment =
    Encode.encode 0 (Scalars.id.encoder environment.id)


currentModel : Maybe ModelChoice -> List ModelChoice -> Maybe ModelChoice
currentModel selected choices =
    selected
        |> Maybe.andThen
            (\choice ->
                choices
                    |> List.filter (\item -> item.provider == choice.provider && item.id == choice.id)
                    |> List.head
            )


environmentChoices : Read (Maybe EnvironmentPage) -> List Environment
environmentChoices environments =
    observed environments |> Maybe.andThen identity |> Maybe.map .nodes |> Maybe.withDefault []


supportedThinking : List ModelThinkingLevel -> Maybe ModelThinkingLevel -> Maybe ModelThinkingLevel
supportedThinking levels selected =
    selected
        |> Maybe.andThen
            (\level ->
                if List.member level levels then
                    Just level

                else
                    Nothing
            )


selectedEnvironment : String -> List Environment -> Maybe Environment
selectedEnvironment key choices =
    choices
        |> List.filter (\item -> environmentKey item == key && item.host /= Nothing)
        |> List.head


view : Model -> Html Msg
view model =
    div [ id "options" ]
        [ viewEnvironment
            { selected = model.environment, directory = model.directory }
            model.environments
        , viewModels
            { selected = model.selectedModel, thinking = model.thinking }
            model.models
        ]



-- VIEW ENVIRONMENT


viewEnvironment : { selected : Maybe Environment, directory : String } -> Read (Maybe EnvironmentPage) -> Html Msg
viewEnvironment selection environments =
    div [ id "footer-instance", class "selector-summary" ]
        [ viewEnvironmentPicker selection.selected (environmentChoices environments)
        , viewDirectory [] DirectoryEdited selection.directory
        , viewEnvironmentStatus environments
        ]


viewEnvironmentPicker : Maybe Environment -> List Environment -> Html Msg
viewEnvironmentPicker selected choices =
    let
        selectedKey =
            selected |> Maybe.map environmentKey |> Maybe.withDefault ""

        unavailable =
            selected |> Maybe.andThen (unavailableEnvironment choices)

        summary =
            case unavailable of
                Just environment ->
                    environment.unit ++ " (unavailable)"

                Nothing ->
                    selected |> Maybe.map .unit |> Maybe.withDefault "No execution environment"
    in
    viewPicker "Environment"
        summary
        (select [ id "targets", attribute "aria-label" "Environment", Attr.name "target", Attr.value selectedKey, onInput EnvironmentSelected ]
            (viewChoice selectedKey { key = "", caption = "No execution environment", disabled = False }
                :: List.map (viewEnvironmentChoice selectedKey) choices
                ++ viewMissingEnvironment choices unavailable
            )
        )


unavailableEnvironment : List Environment -> Environment -> Maybe Environment
unavailableEnvironment choices selected =
    if List.any (\item -> item.id == selected.id && item.host /= Nothing) choices then
        Nothing

    else
        Just selected


viewEnvironmentChoice : String -> Environment -> Html msg
viewEnvironmentChoice selected item =
    viewChoice selected
        { key = environmentKey item
        , caption =
            if item.host == Nothing then
                item.unit ++ " (unavailable)"

            else
                item.unit
        , disabled = item.host == Nothing
        }


viewMissingEnvironment : List Environment -> Maybe Environment -> List (Html msg)
viewMissingEnvironment choices unavailable =
    case unavailable of
        Nothing ->
            []

        Just selected ->
            if List.any (\item -> item.id == selected.id) choices then
                []

            else
                [ viewChoice (environmentKey selected)
                    { key = environmentKey selected, caption = selected.unit ++ " (unavailable)", disabled = True }
                ]


viewDirectory : List (Html.Attribute msg) -> (String -> msg) -> String -> Html msg
viewDirectory attributes edited directory =
    label []
        [ span [ class "selector-label" ] [ text "Working directory" ]
        , input ([ id "base-directory", Attr.name "cwd", Attr.placeholder "/workspace", Attr.maxlength 4096, Attr.value directory, onInput edited ] ++ attributes) []
        ]


viewEnvironmentStatus : Read (Maybe EnvironmentPage) -> Html Msg
viewEnvironmentStatus environments =
    div [ class "catalog-tools" ]
        [ viewReadStatus "environments" RefreshEnvironments environments
        , case environments of
            Loaded Nothing ->
                span [ attribute "role" "status" ] [ text "Environments unavailable" ]

            Loaded (Just { nodes }) ->
                if List.isEmpty nodes then
                    span [ attribute "role" "status" ] [ text "No environments" ]

                else
                    text ""

            _ ->
                text ""
        , viewRefresh "environments" (pending environments) RefreshEnvironments
        , if (observed environments |> Maybe.andThen identity |> Maybe.andThen .next) /= Nothing then
            button [ Attr.type_ "button", Attr.disabled (pending environments), onClick MoreEnvironments ] [ text "More environments" ]

          else
            text ""
        ]



-- VIEW MODELS


viewModels : { selected : Maybe ModelChoice, thinking : Maybe ModelThinkingLevel } -> Read (List ModelChoice) -> Html Msg
viewModels selection models =
    div [ id "bottom-line", attribute "aria-label" "New session settings" ]
        [ div [ class "footer-row" ]
            [ div [ class "footer-model-context" ]
                [ viewModelControls selection models
                , viewModelsStatus models
                ]
            ]
        ]


viewModelControls : { selected : Maybe ModelChoice, thinking : Maybe ModelThinkingLevel } -> Read (List ModelChoice) -> Html Msg
viewModelControls selection models =
    let
        choices =
            observed models |> Maybe.withDefault []
    in
    div [ id "footer-model", class "model-summary selector-summary" ]
        [ span [ class "model-name" ] [ viewModelPicker selection.selected choices ]
        , span [ class "footer-dot", attribute "aria-hidden" "true" ] []
        , span [ class "model-effort" ] [ viewThinkingPicker selection.thinking (currentModel selection.selected choices) ]
        ]


viewModelPicker : Maybe ModelChoice -> List ModelChoice -> Html Msg
viewModelPicker selected choices =
    let
        selectedKey =
            selected |> Maybe.map modelKey |> Maybe.withDefault ""

        unavailable =
            selected /= Nothing && currentModel selected choices == Nothing

        summary =
            (selected |> Maybe.map .name |> Maybe.withDefault "No model")
                ++ (if unavailable then
                        " (unavailable)"

                    else
                        ""
                   )

        missing =
            if unavailable then
                [ viewChoice selectedKey { key = selectedKey, caption = summary, disabled = True } ]

            else
                []
    in
    viewPicker "Model"
        summary
        (select [ id "models", attribute "aria-label" "Model", Attr.name "model", Attr.value selectedKey, onInput ModelSelected ]
            (viewChoice selectedKey { key = "", caption = "No model", disabled = False }
                :: List.map (viewModelChoice selectedKey) choices
                ++ missing
            )
        )


viewModelChoice : String -> ModelChoice -> Html msg
viewModelChoice selected item =
    viewChoice selected { key = modelKey item, caption = item.provider ++ " / " ++ item.name, disabled = False }


viewThinkingPicker : Maybe ModelThinkingLevel -> Maybe ModelChoice -> Html Msg
viewThinkingPicker selected available =
    let
        levels =
            available |> Maybe.map .thinkingLevels |> Maybe.withDefault []

        thinking =
            selected |> Maybe.map Thinking.toString |> Maybe.withDefault ""

        unsupported =
            selected |> Maybe.map (\level -> not (List.member level levels)) |> Maybe.withDefault False

        summary =
            if thinking == "" then
                "Default"

            else if unsupported then
                thinking ++ " (unavailable)"

            else
                thinking

        missing =
            if unsupported then
                [ viewChoice thinking { key = thinking, caption = summary, disabled = True } ]

            else
                []
    in
    viewPicker "Thinking"
        summary
        (select [ id "thinking", attribute "aria-label" "Thinking", Attr.name "thinkingLevel", Attr.value thinking, onInput ThinkingSelected, Attr.disabled (available == Nothing) ]
            (viewChoice thinking { key = "", caption = "Default", disabled = False }
                :: List.map (viewThinkingChoice thinking) levels
                ++ missing
            )
        )


viewThinkingChoice : String -> ModelThinkingLevel -> Html msg
viewThinkingChoice selected level =
    viewChoice selected { key = Thinking.toString level, caption = Thinking.toString level, disabled = False }


viewModelsStatus : Read (List ModelChoice) -> Html Msg
viewModelsStatus models =
    div [ class "catalog-tools" ]
        [ viewReadStatus "models" RefreshModels models
        , case models of
            Loaded [] ->
                span [ attribute "role" "status" ] [ text "No available models" ]

            _ ->
                text ""
        , viewRefresh "models" (pending models) RefreshModels
        ]



-- VIEW CONTROLS


viewPicker : String -> String -> Html msg -> Html msg
viewPicker caption summary control =
    label []
        [ span [ class "selector-label" ] [ text caption ]
        , control
        , span [ class "selector-value", attribute "aria-hidden" "true" ] [ text summary ]
        ]


viewChoice : String -> { key : String, caption : String, disabled : Bool } -> Html msg
viewChoice selected choice =
    option [ Attr.value choice.key, Attr.selected (selected == choice.key), Attr.disabled choice.disabled ] [ text choice.caption ]


viewRefresh : String -> Bool -> msg -> Html msg
viewRefresh name busy msg =
    button [ class "refresh", Attr.type_ "button", Attr.disabled busy, attribute "aria-label" ("Refresh " ++ name), onClick msg ] [ glyph [ Svg.path [ SvgAttr.d "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" ] [] ] ]


agent : Model -> Input.AgentChange
agent model =
    Input.buildAgentChange
        (\args ->
            { args
                | cwd =
                    nullable
                        (if model.directory == "" then
                            Nothing

                         else
                            Just model.directory
                        )
                , model = nullable (Maybe.map (\choice -> Input.buildModelRefInput { provider = choice.provider, modelId = choice.id }) model.selectedModel)
                , thinkingLevel = nullable model.thinking
            }
        )


nullable : Maybe a -> Graphql.OptionalArgument.OptionalArgument a
nullable value =
    Maybe.map Graphql.OptionalArgument.Present value |> Maybe.withDefault Graphql.OptionalArgument.Null


glyph : List (Svg.Svg msg) -> Html msg
glyph children =
    Svg.svg [ SvgAttr.class "glyph", SvgAttr.viewBox "0 0 24 24", attribute "aria-hidden" "true" ] children
