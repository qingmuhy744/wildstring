package com.wildstring.app

import com.wildstring.app.ui.TactileFeedbackGate
import com.wildstring.app.ui.TactileKind
import org.junit.Assert.assertEquals
import org.junit.Test

class TactileFeedbackGateTest {
    @Test fun preferenceChangesApplyImmediatelyAndDisabledEventsDoNotConsumeTheInterval() {
        var enabled = false
        var now = 0L
        val effects = mutableListOf<TactileKind>()
        val feedback = TactileFeedbackGate({ enabled }, { now }, effects::add)
        feedback.emit(TactileKind.Tap)
        enabled = true
        feedback.emit(TactileKind.Tap)
        enabled = false
        now = 100
        feedback.emit(TactileKind.DragStart)
        enabled = true
        feedback.emit(TactileKind.DragEnd)
        assertEquals(listOf(TactileKind.Tap, TactileKind.DragEnd), effects)
    }

    @Test fun adjacentControlsShareTheRateLimitButDistinctGesturesRemainDetectable() {
        var now = 0L
        val effects = mutableListOf<TactileKind>()
        val feedback = TactileFeedbackGate({ true }, { now }, effects::add)
        feedback.emit(TactileKind.Tap)
        now = 59
        feedback.emit(TactileKind.Tap)
        now = 60
        feedback.emit(TactileKind.DragStart)
        now = 200
        feedback.emit(TactileKind.DragEnd)
        assertEquals(listOf(TactileKind.Tap, TactileKind.DragStart, TactileKind.DragEnd), effects)
    }

    @Test fun unavailableVendorFeedbackDoesNotPreventTheControlAction() {
        val feedback = TactileFeedbackGate({ true }, { 0L }) { throw IllegalStateException("Unavailable device feedback") }
        var actions = 0
        feedback.emit(TactileKind.Tap)
        actions++
        assertEquals(1, actions)
    }
}
