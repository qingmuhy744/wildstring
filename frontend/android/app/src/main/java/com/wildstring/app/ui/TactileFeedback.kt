package com.wildstring.app.ui

import android.view.HapticFeedbackConstants
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalView
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** One light tick for a deliberate control action; Android honors system touch-feedback settings. */
@Composable internal fun tactile(vm: MusicViewModel, action: () -> Unit): () -> Unit {
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val view = LocalView.current
    val currentAction by rememberUpdatedState(action)
    return remember(view, preferences.haptics) {
        {
            if (preferences.haptics) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
            currentAction()
        }
    }
}
