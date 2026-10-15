module Syntax exposing (Model, Request, empty, encodeRequest, fromPath, language, receive, sync, view)

import Dict exposing (Dict)
import Html exposing (Html, span, text)
import Html.Attributes exposing (class)
import Json.Decode as D
import Json.Encode as E


type alias Token =
    { text : String, kind : String }


type alias Item =
    { id : Int, tokens : Maybe (List Token) }


type alias Model =
    { nextId : Int, items : Dict ( String, String ) Item }


type alias Request =
    { id : Int, language : String, source : String }


empty : Model
empty =
    { nextId = 0, items = Dict.empty }


language : String -> String
language name =
    let
        aliases =
            Dict.fromList
                [ ( "javascript", "js" )
                , ( "jsx", "js" )
                , ( "mjs", "js" )
                , ( "cjs", "js" )
                , ( "typescript", "ts" )
                , ( "tsx", "ts" )
                , ( "mts", "ts" )
                , ( "cts", "ts" )
                , ( "python", "py" )
                , ( "rust", "rs" )
                , ( "shell", "bash" )
                , ( "sh", "bash" )
                , ( "zsh", "bash" )
                , ( "markdown", "md" )
                , ( "yml", "yaml" )
                , ( "svg", "xml" )
                , ( "htm", "html" )
                , ( "patch", "diff" )
                , ( "perl", "pl" )
                , ( "dockerfile", "docker" )
                , ( "makefile", "make" )
                ]

        normalized =
            String.toLower name

        canonical =
            Dict.get normalized aliases |> Maybe.withDefault normalized
    in
    if List.member canonical [ "asm", "bash", "bf", "c", "css", "csv", "diff", "docker", "git", "go", "html", "http", "ini", "java", "js", "jsdoc", "json", "log", "lua", "make", "md", "pl", "py", "regex", "rs", "sql", "todo", "toml", "ts", "uri", "xml", "yaml" ] then
        canonical

    else
        "plain"


fromPath : String -> String
fromPath path =
    path |> String.split "/" |> List.reverse |> List.head |> Maybe.withDefault "" |> String.split "." |> List.reverse |> List.head |> Maybe.withDefault "" |> language


{-| Retain only current sources. Identical sources share a result; edited sources
get a new monotonically increasing request id, including after navigation.
-}
sync : List ( String, String ) -> Model -> ( Model, List Request )
sync sources model =
    let
        keys =
            sources
                |> List.map (\( lang, source ) -> ( ( language lang, source ), () ))
                |> Dict.fromList
                |> Dict.filter (\( lang, source ) _ -> lang /= "plain" && source /= "")

        add ( lang, source ) _ ( current, requests ) =
            case Dict.get ( lang, source ) model.items of
                Just item ->
                    ( { current | items = Dict.insert ( lang, source ) item current.items }, requests )

                Nothing ->
                    ( { current | nextId = current.nextId + 1, items = Dict.insert ( lang, source ) { id = current.nextId, tokens = Nothing } current.items }
                    , { id = current.nextId, language = lang, source = source } :: requests
                    )
    in
    Dict.foldl add ( { model | items = Dict.empty }, [] ) keys


encodeRequest : Request -> E.Value
encodeRequest request =
    E.object [ ( "id", E.int request.id ), ( "language", E.string request.language ), ( "source", E.string request.source ) ]


receive : D.Value -> Model -> Result String Model
receive value model =
    let
        kind =
            D.string
                |> D.andThen
                    (\name ->
                        if List.member name [ "", "deleted", "err", "var", "section", "kwd", "class", "cmnt", "insert", "type", "func", "bool", "num", "oper", "str", "esc" ] then
                            D.succeed name

                        else
                            D.fail "Unknown syntax token"
                    )

        decoder =
            D.list (D.map2 Tuple.pair (D.field "id" D.int) (D.field "tokens" (D.list (D.map2 Token (D.field "text" D.string) (D.field "kind" kind)))))

        apply ( requestId, tokens ) result =
            result
                |> Result.andThen
                    (\current ->
                        case Dict.toList current.items |> List.filter (\( _, item ) -> item.id == requestId) |> List.head of
                            Nothing ->
                                Ok current

                            Just ( ( lang, source ), item ) ->
                                if String.concat (List.map .text tokens) == source then
                                    Ok { current | items = Dict.insert ( lang, source ) { item | tokens = Just tokens } current.items }

                                else
                                    Err "Syntax tokens changed the source text."
                    )
    in
    D.decodeValue decoder value
        |> Result.mapError D.errorToString
        |> Result.andThen (List.foldl apply (Ok model))


view : Model -> String -> String -> List (Html msg)
view model lang source =
    case Dict.get ( language lang, source ) model.items |> Maybe.andThen .tokens of
        Nothing ->
            [ text source ]

        Just tokens ->
            List.map
                (\token ->
                    if token.kind == "" then
                        text token.text

                    else
                        span [ class ("shj-syn-" ++ token.kind) ] [ text token.text ]
                )
                tokens
