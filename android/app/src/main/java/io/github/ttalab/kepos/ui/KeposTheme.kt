package io.github.ttalab.kepos.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import io.github.ttalab.kepos.R

object KeposPalette {
  val Ink = Color(0xFF0D1209)
  val Deep = Color(0xFF11180C)
  val Panel = Color(0xFF172010)
  val PanelHigh = Color(0xFF1D2814)
  val Cream = Color(0xFFF0F1E7)
  val Muted = Color(0xFFA8AD9E)
  val Lime = Color(0xFFB7EE45)
  val LimeSoft = Color(0xFFD7F798)
  val Line = Color(0xFF405027)
  val Error = Color(0xFFFF6B6B)
}

val KeposDisplay = FontFamily(Font(R.font.newsreader, FontWeight.Normal))
val KeposBody = FontFamily(Font(R.font.ibm_plex_sans, FontWeight.Normal))
val KeposMono = FontFamily(Font(R.font.ibm_plex_mono, FontWeight.Normal))

private val colors = darkColorScheme(
  primary = KeposPalette.Lime,
  onPrimary = KeposPalette.Ink,
  secondary = KeposPalette.LimeSoft,
  onSecondary = KeposPalette.Ink,
  background = KeposPalette.Ink,
  onBackground = KeposPalette.Cream,
  surface = KeposPalette.Panel,
  onSurface = KeposPalette.Cream,
  surfaceVariant = KeposPalette.PanelHigh,
  onSurfaceVariant = KeposPalette.Muted,
  outline = KeposPalette.Line,
  error = KeposPalette.Error,
  onError = KeposPalette.Ink,
)

private val typography = Typography(
  displayLarge = TextStyle(
    fontFamily = KeposDisplay,
    fontSize = 54.sp,
    fontWeight = FontWeight.Normal,
    lineHeight = 54.sp,
  ),
  headlineLarge = TextStyle(
    fontFamily = KeposDisplay,
    fontSize = 38.sp,
    fontWeight = FontWeight.Normal,
    lineHeight = 42.sp,
  ),
  headlineMedium = TextStyle(
    fontFamily = KeposDisplay,
    fontSize = 30.sp,
    fontWeight = FontWeight.Normal,
    lineHeight = 34.sp,
  ),
  titleLarge = TextStyle(
    fontFamily = KeposBody,
    fontSize = 20.sp,
    fontWeight = FontWeight.Medium,
    lineHeight = 26.sp,
  ),
  bodyLarge = TextStyle(
    fontFamily = KeposBody,
    fontSize = 17.sp,
    lineHeight = 25.sp,
  ),
  bodyMedium = TextStyle(
    fontFamily = KeposBody,
    fontSize = 15.sp,
    lineHeight = 22.sp,
  ),
  labelLarge = TextStyle(
    fontFamily = KeposBody,
    fontSize = 14.sp,
    fontWeight = FontWeight.Medium,
  ),
  labelMedium = TextStyle(
    fontFamily = KeposMono,
    fontSize = 12.sp,
    letterSpacing = 0.8.sp,
  ),
)

@Composable
fun KeposTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = colors,
    typography = typography,
    content = content,
  )
}
