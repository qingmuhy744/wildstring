package com.wildstring.app.ui

import android.os.Build
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalView

internal enum class TactileKind { Tap, DragStart, DragEnd }

/** One gate per app view, so adjacent controls cannot produce a burst of feedback. */
internal class TactileFeedbackGate(
    private val enabled: () -> Boolean,
    private val now: () -> Long,
    private val perform: (TactileKind) -> Unit,
) {
    private var lastFeedback: Long? = null

    fun emit(kind: TactileKind) {
        if (!enabled()) return
        val time = now()
        if (lastFeedback?.let { time - it in 0L until 60L } == true) return
        lastFeedback = time
        // A vendor feedback failure must never swallow the associated playback action.
        try { perform(kind) } catch (_: RuntimeException) { }
    }
}

internal val LocalTactileFeedback = staticCompositionLocalOf<(TactileKind) -> Unit> { {} }

/** Use Android's semantic effects, without bypassing system settings or requesting VIBRATE. */
@Composable internal fun rememberTactileFeedback(enabled: () -> Boolean): (TactileKind) -> Unit {
    val view = LocalView.current
    val currentEnabled by rememberUpdatedState(enabled)
    val gate = remember(view) {
        TactileFeedbackGate({ currentEnabled() }, SystemClock::uptimeMillis) { kind ->
            val effect = when (kind) {
                TactileKind.Tap -> HapticFeedbackConstants.CLOCK_TICK
                TactileKind.DragStart -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.GESTURE_START else HapticFeedbackConstants.LONG_PRESS
                TactileKind.DragEnd -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.GESTURE_END else HapticFeedbackConstants.CLOCK_TICK
            }
            view.performHapticFeedback(effect)
        }
    }
    return remember(gate) { gate::emit }
}

@Composable internal fun tactile(action: () -> Unit): () -> Unit {
    val feedback = LocalTactileFeedback.current
    val currentAction by rememberUpdatedState(action)
    return remember(feedback) { { feedback(TactileKind.Tap); currentAction() } }
}
