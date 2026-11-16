module Route exposing (Route(..), fromUrl, href)

import Url exposing (Url)
import Url.Builder as Builder
import Url.Parser as Parser exposing ((</>), Parser, s)



-- ROUTES


type Route
    = Home
    | Settings
    | Session String



-- PARSING


fromUrl : Url -> Maybe Route
fromUrl =
    Parser.parse parser


parser : Parser (Route -> a) a
parser =
    Parser.oneOf
        [ Parser.map Home Parser.top
        , Parser.map Settings (s "settings")
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

        Session externalId ->
            Builder.absolute [ "sessions", externalId ] []
