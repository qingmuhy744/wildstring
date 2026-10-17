package com.wildstring.app.playback

import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject
import javax.inject.Singleton

/** Process-local counters for reproducible playback regression checks; no audio or account data. */
@Singleton
class PlaybackHealth @Inject constructor() {
    val audioUnderruns = AtomicInteger(0)
    /** Invoked only from the main thread while the service owns its single session. */
    var diagnostics: (() -> PlaybackDiagnosticSnapshot)? = null
}
