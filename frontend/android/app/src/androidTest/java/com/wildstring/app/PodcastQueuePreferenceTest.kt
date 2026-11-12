package com.wildstring.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.v2.createComposeRule
import com.wildstring.app.data.PodcastShowQueuePreference
import com.wildstring.app.ui.PodcastFollowedMenu
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class PodcastQueuePreferenceTest {
    @get:Rule val compose = createComposeRule()

    @Test fun followMenuShowsCurrentRuleOnButtonAndSavesChoice() {
        var selectedAction: String? = null
        val preference = mutableStateOf(PodcastShowQueuePreference(action = "queue_last", autoLimit = 3))
        compose.setContent {
            MaterialTheme {
                PodcastFollowedMenu(
                    preference = preference.value, loading = false, error = null,
                    onChange = { action, _ -> selectedAction = action; preference.value = preference.value.copy(action = action) },
                    onRetry = {}, onAutoDownload = {}, onUnfollow = {},
                )
            }
        }

        compose.onNodeWithTag("podcast-follow-menu").assertIsDisplayed()
        compose.onNodeWithText("${uiString(R.string.pod_exp_followed)} · ${uiString(R.string.podcast_action_queue_last_short)}").assertIsDisplayed()
        compose.onNodeWithTag("podcast-follow-options").assertDoesNotExist()
        compose.onNodeWithTag("podcast-follow-menu").performClick()
        compose.onNodeWithTag("podcast-follow-options").assertIsDisplayed()
        compose.onNodeWithTag("podcast-follow-option-queue_next").performClick()
        compose.runOnIdle { assertEquals("queue_next", selectedAction) }
        compose.onNodeWithTag("podcast-follow-options").assertDoesNotExist()
        compose.onNodeWithText("${uiString(R.string.pod_exp_followed)} · ${uiString(R.string.podcast_action_queue_next_short)}").assertIsDisplayed()
    }
}
