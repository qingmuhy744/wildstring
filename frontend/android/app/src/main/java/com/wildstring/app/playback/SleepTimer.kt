package com.wildstring.app.playback

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Uses elapsed time so changing the phone clock cannot extend a sleep timer. */
data class SleepPlan(val deadline: Long? = null, val entryId: String? = null) {
    fun expired(now: Long): Boolean = deadline?.let { now >= it } ?: false
    fun endsOnTransition(previous: String?, next: String?, automatic: Boolean): Boolean =
        entryId != null && previous == entryId && automatic
}
@Singleton
class SleepTimer @Inject constructor() {
    private val mutable = MutableStateFlow(SleepPlan())
    val state = mutable.asStateFlow()
    fun minutes(value: Int) { require(value in 1..240); mutable.value = SleepPlan(android.os.SystemClock.elapsedRealtime() + value * 60_000L) }
    fun endOfTrack(id: String) { mutable.value = SleepPlan(entryId = id) }
    fun cancel() { mutable.value = SleepPlan() }
}
