package com.wildstring.app.data

/** Pause time and eligibility are issued by the server, not inferred from a saved queue. */
internal fun SharedPlayback.pauseEvent(): String? = pausedAt?.takeIf { it.isNotBlank() && deviceId.isNotBlank() }?.let { "$deviceId:$it" }
internal fun SharedPlayback.isRecentPausedHandoff(): Boolean = handoffEligible && playbackState == "paused" && trackIds.isNotEmpty() && pauseEvent() != null
internal fun SharedPlayback.canOfferHandoff(localDevice: String, seenVersion: Int, offeredPause: String?): Boolean =
    isRecentPausedHandoff() && deviceId != localDevice && version > seenVersion && pauseEvent() != offeredPause
