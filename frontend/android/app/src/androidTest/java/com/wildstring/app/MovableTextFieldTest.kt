package com.wildstring.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import org.junit.Rule
import org.junit.Test

/**
 * The app moves whole destinations (with their search fields) between the page and the player
 * backdrop through movableContentOf. Compose Foundation 1.12's BasicTextField min-size node reads
 * a CompositionLocal in update() even while its layout node is detached, so a style change that
 * lands while the field is being moved throws during attach, leaves half-attached modifier nodes,
 * and later crashes Activity teardown with "Must run runDetachLifecycle() once after
 * runAttachLifecycle() and before markAsDetached()".
 */
private val LocalFieldSize = compositionLocalOf { 14.sp }

class MovableTextFieldTest {
    @get:Rule val compose = createComposeRule()

    @Test fun textFieldMovedDuringAStyleChangeKeepsComposingAndDisposesCleanly() {
        var host by mutableStateOf(0)
        var large by mutableStateOf(false)
        var shown by mutableStateOf(true)
        var text by mutableStateOf("野弦")
        compose.setContent {
            val field = remember {
                movableContentOf {
                    BasicTextField(text, { text = it }, Modifier.testTag("moved-field"),
                        textStyle = TextStyle(fontSize = if (large) 20.sp else 14.sp))
                }
            }
            if (shown) {
                if (host == 0) Box { field() } else Column { field() }
            }
        }
        compose.onNodeWithTag("moved-field").assertIsDisplayed()
        repeat(4) { round ->
            compose.runOnIdle { host = 1 - host; large = !large }
            compose.onNodeWithTag("moved-field").assertIsDisplayed()
            // A broken recomposer stops applying state, so prove the field still composes.
            compose.runOnIdle { text = "野弦 $round" }
            compose.onNodeWithTag("moved-field").assertTextEquals("野弦 $round")
        }
        // Disposing runs the same detach lifecycle that crashed MainActivity's teardown.
        compose.runOnIdle { shown = false }
        compose.waitForIdle()
    }

    @Test fun textFieldMovedIntoAHostWithADifferentTextStyleKeepsComposingAndDisposesCleanly() {
        // In the app the style difference comes from where the page lands (page vs. player
        // backdrop), so the moved content recomposes at its new location while still detached.
        var host by mutableStateOf(0)
        var shown by mutableStateOf(true)
        var text by mutableStateOf("野弦")
        compose.setContent {
            val field = remember {
                movableContentOf {
                    BasicTextField(text, { text = it }, Modifier.testTag("moved-field"),
                        textStyle = TextStyle(fontSize = LocalFieldSize.current))
                }
            }
            if (shown) {
                if (host == 0) CompositionLocalProvider(LocalFieldSize provides 14.sp) { Box { field() } }
                else CompositionLocalProvider(LocalFieldSize provides 20.sp) { Column { field() } }
            }
        }
        compose.onNodeWithTag("moved-field").assertIsDisplayed()
        repeat(4) { round ->
            compose.runOnIdle { host = 1 - host }
            compose.onNodeWithTag("moved-field").assertIsDisplayed()
            compose.runOnIdle { text = "野弦 $round" }
            compose.onNodeWithTag("moved-field").assertTextEquals("野弦 $round")
        }
        compose.runOnIdle { shown = false }
        compose.waitForIdle()
    }

    @Test fun textFieldInsideASubcompositionMovedDuringAStyleChangeDisposesCleanly() {
        // The app's destinations contain a Scaffold (a SubcomposeLayout). Its slot content is a
        // separate composition, so it can recompose and set the field's modifier while the moved
        // subtree is detached and still waiting for its late insertion.
        var host by mutableStateOf(0)
        var large by mutableStateOf(false)
        var shown by mutableStateOf(true)
        var text by mutableStateOf("野弦")
        compose.setContent {
            val field = remember {
                movableContentOf {
                    BoxWithConstraints {
                        BasicTextField(text, { text = it }, Modifier.testTag("moved-field").widthIn(max = maxWidth),
                            textStyle = TextStyle(fontSize = if (large) 20.sp else 14.sp))
                    }
                }
            }
            if (shown) {
                if (host == 0) Box { field() } else Column { field() }
            }
        }
        compose.onNodeWithTag("moved-field").assertIsDisplayed()
        repeat(6) { round ->
            compose.runOnIdle { host = 1 - host; large = !large }
            compose.onNodeWithTag("moved-field").assertIsDisplayed()
            compose.runOnIdle { text = "野弦 $round" }
            compose.onNodeWithTag("moved-field").assertTextEquals("野弦 $round")
        }
        compose.runOnIdle { shown = false }
        compose.waitForIdle()
    }
}
