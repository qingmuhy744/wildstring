package com.wildstring.app

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.ui.LocalDarkAppearance
import com.wildstring.app.ui.MobileShortcuts
import com.wildstring.app.ui.classicDarkColors
import com.wildstring.app.ui.classicLightColors
import java.io.File
import java.util.Locale
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The discovery shortcuts share one row; every label must fit its own button on phones and tablets. */
class DiscoveryShortcutsLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test fun shortcutLabelsFitInBothLanguagesThemesAndWidths() {
        val language = mutableStateOf("zh")
        val dark = mutableStateOf(false)
        val width = mutableStateOf(390)
        var expectedPixels = 0
        compose.setContent {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                // Fit the requested dp width on the emulator screen by scaling density, never by clipping.
                val density = minOf(LocalDensity.current.density, (constraints.maxWidth - 2).coerceAtLeast(1).toFloat() / width.value)
                SideEffect { expectedPixels = (width.value * density).roundToInt() }
                val base = LocalContext.current
                val system = LocalConfiguration.current
                val configuration = remember(system, language.value) {
                    Configuration(system).apply { setLocale(Locale.forLanguageTag(language.value)) }
                }
                val localized = remember(configuration) { base.createConfigurationContext(configuration) }
                CompositionLocalProvider(
                    LocalContext provides localized,
                    LocalConfiguration provides configuration,
                    LocalResources provides localized.resources,
                    LocalDensity provides Density(density, 1f),
                    LocalDarkAppearance provides dark.value,
                ) {
                    MaterialTheme(colorScheme = if (dark.value) classicDarkColors else classicLightColors) {
                        Surface(Modifier.width(width.value.dp).testTag("shortcuts-preview")) {
                            MobileShortcuts(discovery = true) {}
                        }
                    }
                }
            }
        }
        val failures = mutableListOf<String>()
        for (viewport in listOf(390, 720)) for (code in listOf("zh", "en")) for (theme in listOf(false, true)) {
            compose.runOnIdle { width.value = viewport; language.value = code; dark.value = theme }
            compose.waitForIdle()
            val name = "discovery-shortcuts-$viewport-$code-${if (theme) "dark" else "light"}"
            assertEquals("$name: preview must not be clipped", expectedPixels, compose.onNodeWithTag("shortcuts-preview").fetchSemanticsNode().size.width)
            failures += overflowingLabels().map { "$name: $it" }
            save(name)
        }
        assertTrue("Shortcut labels overflow:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    /** Labels whose full single-line text is wider than the space they were given, or that leave the row. */
    private fun overflowingLabels(): List<String> {
        val row = compose.onNodeWithTag("discovery-shortcuts").getUnclippedBoundsInRoot()
        val labels = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true)
        return (0 until labels.fetchSemanticsNodes().size).mapNotNull { index ->
            val label = labels[index]
            val text = label.fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("")
            val layouts = mutableListOf<TextLayoutResult>()
            label.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val layout = layouts.single()
            val bounds = label.getUnclippedBoundsInRoot()
            when {
                layout.multiParagraph.intrinsics.maxIntrinsicWidth > layout.size.width + 1f ->
                    "\"$text\" needs ${layout.multiParagraph.intrinsics.maxIntrinsicWidth.toInt()}px, has ${layout.size.width}px"
                bounds.left < row.left || bounds.right > row.right -> "\"$text\" leaves the shortcut row"
                else -> null
            }
        }
    }

    private fun save(name: String) {
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        val image = compose.onNodeWithTag("shortcuts-preview").captureToImage().asAndroidBitmap()
        File(directory, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
