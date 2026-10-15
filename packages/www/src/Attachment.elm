module Attachment exposing (Attachment, AttachmentContent(..), AttachmentId(..), AttachmentState(..), fileEvent, readAttachment, receiveAttachment, viewAttachment)

import Bytes exposing (Bytes)
import Bytes.Decode as ByteDecode
import Bytes.Encode as ByteEncode
import File exposing (File)
import Html exposing (Html, button, div, span, text)
import Html.Attributes as Attr exposing (attribute, class)
import Html.Events as Events exposing (onClick)
import Json.Decode as Decode
import Task


type alias Attachment =
    { id : AttachmentId, file : File, state : AttachmentState }


type AttachmentId
    = AttachmentId Int


type AttachmentContent
    = Image String
    | Text String


type AttachmentState
    = Reading
    | Ready AttachmentContent
    | Rejected String


fileEvent : (List File -> msg) -> { event : String, field : String } -> Html.Attribute msg
fileEvent selected config =
    Events.preventDefaultOn config.event
        (Decode.at [ config.field, "files" ] (Decode.list File.decoder)
            |> Decode.andThen
                (\files ->
                    if List.isEmpty files then
                        Decode.fail "Not a file event"

                    else
                        Decode.succeed ( selected files, True )
                )
        )


receiveAttachment : AttachmentId -> Result String AttachmentContent -> Attachment -> Attachment
receiveAttachment key result attachment =
    if attachment.id == key then
        { attachment
            | state =
                case result of
                    Ok content ->
                        Ready content

                    Err problem ->
                        Rejected problem
        }

    else
        attachment


readAttachment : (AttachmentId -> Result String AttachmentContent -> msg) -> Attachment -> Cmd msg
readAttachment received item =
    (if List.member (File.mime item.file) [ "image/png", "image/jpeg", "image/gif", "image/webp" ] then
        File.toUrl item.file |> Task.map (Image >> Ok)

     else
        File.toBytes item.file |> Task.map readTextAttachment
    )
        |> Task.perform (received item.id)


readTextAttachment : Bytes -> Result String AttachmentContent
readTextAttachment bytes =
    case ByteDecode.decode (ByteDecode.string (Bytes.width bytes)) bytes of
        Just content ->
            if byteList bytes == byteList (ByteEncode.encode (ByteEncode.string content)) && not (String.any unsupportedControl content) then
                Ok (Text content)

            else
                Err "Not a supported image or UTF-8 text file"

        Nothing ->
            Err "Could not decode this file"


byteList : Bytes -> Maybe (List Int)
byteList bytes =
    ByteDecode.decode
        (ByteDecode.loop ( Bytes.width bytes, [] )
            (\( remaining, values ) ->
                if remaining == 0 then
                    ByteDecode.succeed (ByteDecode.Done values)

                else
                    ByteDecode.map (\value -> ByteDecode.Loop ( remaining - 1, value :: values )) ByteDecode.unsignedInt8
            )
        )
        bytes


unsupportedControl : Char -> Bool
unsupportedControl character =
    let
        code =
            Char.toCode character
    in
    (code < 32 && not (List.member code [ 9, 10, 13 ])) || (code >= 127 && code <= 159) || (code >= 55296 && code <= 57343)



-- VIEW ATTACHMENT


viewAttachment : Bool -> (AttachmentId -> msg) -> Attachment -> Html msg
viewAttachment disabled remove item =
    let
        name =
            File.name item.file

        description =
            name ++ " (" ++ String.fromInt (File.size item.file) ++ " bytes)"
    in
    div [ class "attachment" ]
        [ button [ class "attachment-thumbnail", Attr.type_ "button", Attr.disabled disabled, Attr.title ("Remove " ++ description), attribute "aria-label" ("Remove " ++ name), onClick (remove item.id) ]
            [ case item.state of
                Reading ->
                    span [ class "attachment-pending", attribute "role" "status", attribute "aria-label" ("Reading " ++ name) ] [ text "…" ]

                Ready (Text content) ->
                    span [ class "attachment-document", attribute "aria-hidden" "true" ]
                        [ span [ class "attachment-text" ] [ text (String.left 500 content) ] ]

                Ready (Image url) ->
                    Html.img [ Attr.src url, Attr.alt name ] []

                Rejected _ ->
                    span [ class "attachment-rejected", attribute "aria-hidden" "true" ] [ text "!" ]
            ]
        , case item.state of
            Rejected problem ->
                span [ class "error", attribute "role" "alert" ] [ text (name ++ ": " ++ problem) ]

            Reading ->
                text ""

            Ready _ ->
                text ""
        ]
