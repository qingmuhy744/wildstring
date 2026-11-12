package com.wildstring.app

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Rule
import org.junit.Test

/**
 * Swipe-dismiss of the full-screen player used to move the catalog (a LazyColumn, often
 * mid-prefetch) from the player backdrop back to the page slot via movableContentOf, in the
 * same frame as the player's exit animation. That hits Compose 1.12's
 * "onReuse is only expected on attached node" crash. The app now keeps the catalog in one
 * slot and treats the player as an overlay; this test exercises that structure.
 */
class PlayerDismissCompositionTest {
    @get:Rule val compose = createComposeRule()

    @Test fun dismissingThePlayerOverlayLeavesTheCatalogListComposed() {
        val rows = List(40) { "row-$it" }
        var showPlayer by mutableStateOf(true)
        compose.setContent {
            @androidx.compose.runtime.Composable
            fun Catalog() {
                LazyColumn(Modifier.testTag("catalog-list").fillMaxSize()) {
                    items(rows, key = { it }) { row ->
                        Text(row, Modifier.fillMaxWidth().height(48.dp).testTag(row))
                    }
                }
            }
            Box(Modifier.fillMaxSize()) {
                Catalog()
                AnimatedVisibility(
                    visible = showPlayer,
                    modifier = Modifier.fillMaxSize().testTag("player-overlay"),
                    enter = fadeIn(tween(80)),
                    exit = fadeOut(tween(80)) + slideOutVertically(tween(120)) { it },
                    label = "player-overlay",
                ) {
                    Box(Modifier.fillMaxSize().testTag("player-chrome")) { Text("player") }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("player-chrome").assertIsDisplayed()
        repeat(6) { round ->
            compose.runOnIdle { showPlayer = false }
            compose.waitForIdle()
            compose.onNodeWithTag("catalog-list").assertIsDisplayed()
            compose.onNodeWithTag("row-0").assertIsDisplayed()
            compose.onNodeWithTag("player-chrome").assertDoesNotExist()
            compose.runOnIdle { showPlayer = true }
            compose.waitForIdle()
            compose.onNodeWithTag("player-chrome").assertIsDisplayed()
            compose.onNodeWithTag("row-$round").assertExists()
        }
        compose.runOnIdle { showPlayer = false }
        compose.waitForIdle()
        compose.onNodeWithTag("catalog-list").assertIsDisplayed()
    }

    @Test fun settingsCatalogAnimatedContentDoesNotUseThePlayerAsAHost() {
        // Settings <-> catalog may still move via movableContentOf; the player must not be a host.
        var destination by mutableStateOf("catalog")
        compose.setContent {
            AnimatedContent(destination, transitionSpec = {
                fadeIn(tween(40)) togetherWith fadeOut(tween(40))
            }, label = "app-destination") { current ->
                Box(Modifier.fillMaxSize().testTag("page-$current")) { Text(current) }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("page-catalog").assertIsDisplayed()
        compose.runOnIdle { destination = "settings" }
        compose.waitForIdle()
        compose.onNodeWithTag("page-settings").assertIsDisplayed()
        compose.runOnIdle { destination = "catalog" }
        compose.waitForIdle()
        compose.onNodeWithTag("page-catalog").assertIsDisplayed()
    }
}
