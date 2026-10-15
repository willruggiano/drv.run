module Route exposing (Route(..), fromUrl, href)

import Api.Scalars as Scalars
import Json.Decode as Decode
import Url exposing (Url)
import Url.Builder as Builder
import Url.Parser as Parser exposing ((</>), Parser, s)



-- ROUTES


type Route
    = Home
    | Settings
    | Session String
    | Conversation String Scalars.ConversationId
    | ConversationPage String Scalars.ConversationId String



-- PARSING


fromUrl : Url -> Maybe Route
fromUrl =
    Parser.parse parser


parser : Parser (Route -> a) a
parser =
    Parser.oneOf
        [ Parser.map Home Parser.top
        , Parser.map Settings (s "settings")
        , Parser.map Conversation (s "sessions" </> Parser.custom "EXTERNAL_ID" Url.percentDecode </> s "conversations" </> conversationId)
        , Parser.map ConversationPage (s "sessions" </> Parser.custom "EXTERNAL_ID" Url.percentDecode </> s "conversations" </> conversationId </> Parser.string)
        , Parser.map Session (s "sessions" </> Parser.custom "EXTERNAL_ID" Url.percentDecode)
        ]



-- LINKS


href : Route -> String
href route =
    case route of
        Home ->
            Builder.absolute [] []

        Settings ->
            Builder.absolute [ "settings" ] []

        Conversation externalId id ->
            Builder.absolute [ "sessions", Url.percentEncode externalId, "conversations", String.fromInt (Scalars.conversationIdValue id) ] []

        ConversationPage externalId id pane ->
            href (Conversation externalId id) ++ "/" ++ Url.percentEncode pane

        Session externalId ->
            Builder.absolute [ "sessions", Url.percentEncode externalId ] []


conversationId : Parser (Scalars.ConversationId -> a) a
conversationId =
    Parser.custom "CONVERSATION_ID"
        (\value ->
            if String.all Char.isDigit value && value /= "" then
                Decode.decodeString Scalars.conversationId.decoder value |> Result.toMaybe

            else
                Nothing
        )
