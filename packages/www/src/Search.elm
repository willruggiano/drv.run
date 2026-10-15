module Search exposing (view)

import Dict
import Html exposing (Html, mark, text)
import Html.Attributes exposing (class)


view : String -> String -> List (Html msg)
view query source =
    if query == "" || not (String.contains (String.toLower query) (String.toLower source)) then
        [ text source ]

    else
        let
            -- Case folding can expand a character (İ -> i + combining dot).
            -- Map folded UTF-16 offsets back to the original text.
            character char ( offset, spans ) =
                let
                    original =
                        String.fromChar char

                    lower =
                        String.toLower original

                    end =
                        offset + String.length original
                in
                ( end, List.repeat (String.length lower) ( offset, end ) :: spans )

            ( _, offsets ) =
                List.foldl character ( 0, [] ) (String.toList source)

            positions =
                offsets |> List.reverse |> List.concat |> List.indexedMap Tuple.pair |> Dict.fromList

            needle =
                String.toLower query

            add index ( end, nodes ) =
                case ( Dict.get index positions, Dict.get (index + String.length needle - 1) positions ) of
                    ( Just ( start, _ ), Just ( _, finish ) ) ->
                        if start < end then
                            ( end, nodes )

                        else
                            ( finish, mark [ class "search-match" ] [ text (String.slice start finish source) ] :: text (String.slice end start source) :: nodes )

                    _ ->
                        ( end, nodes )

            ( last, rendered ) =
                String.indexes needle (String.toLower source) |> List.foldl add ( 0, [] )
        in
        List.reverse (text (String.dropLeft last source) :: rendered)
