module Icon exposing (view)

import Html exposing (Html)
import Html.Attributes exposing (attribute)
import Svg
import Svg.Attributes as S


view : String -> Html msg
view name =
    Svg.svg [ S.class "glyph", S.viewBox "0 0 24 24", attribute "aria-hidden" "true" ]
        (case name of
            "trash" ->
                [ Svg.path [ S.d "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" ] [] ]

            "bell" ->
                [ Svg.path [ S.d "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" ] [] ]

            "fork" ->
                [ Svg.circle [ S.cx "6", S.cy "5", S.r "2" ] [], Svg.circle [ S.cx "18", S.cy "5", S.r "2" ] [], Svg.circle [ S.cx "6", S.cy "19", S.r "2" ] [], Svg.path [ S.d "M6 7v10M18 7v2c0 5-12 1-12 8" ] [] ]

            "send" ->
                [ Svg.path [ S.d "M12 20V4m-7 7 7-7 7 7" ] [] ]

            "check" ->
                [ Svg.path [ S.d "m5 12 4 4L19 6" ] [] ]

            "chevron-left" ->
                [ Svg.path [ S.d "m15 6-6 6 6 6" ] [] ]

            "chevron-down" ->
                [ Svg.path [ S.d "m6 9 6 6 6-6" ] [] ]

            "close" ->
                [ Svg.path [ S.d "m6 6 12 12M18 6 6 18" ] [] ]

            _ ->
                [ Svg.path [ S.d "m9 3-.6 2.4-1.5.9-2.4-.7-3 5.2L3.3 12l.1 1.8-1.7 1.8 3 5.2 2.3-.7 1.6.9.5 2.4h6l.6-2.4 1.5-.9 2.4.7 3-5.2-1.8-1.2-.1-1.8 1.7-1.8-3-5.2-2.3.7-1.6-.9L15 3Z", S.transform "translate(1 -1) scale(.92)" ] [], Svg.circle [ S.cx "12", S.cy "12", S.r "3.2" ] [] ]
        )
