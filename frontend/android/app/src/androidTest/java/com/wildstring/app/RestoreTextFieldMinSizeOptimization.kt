package com.wildstring.app

import androidx.compose.foundation.ComposeFoundationFlags
import androidx.compose.foundation.ExperimentalFoundationApi
import org.junit.runner.Description
import org.junit.runner.notification.RunListener

/**
 * Opt-in run listener that turns Compose Foundation's optimized BasicTextField min-size path back
 * on after WildStringApplication disabled it, so CI can measure the teardown crash without the
 * workaround on the same build:
 *
 *   -e listener com.wildstring.app.RestoreTextFieldMinSizeOptimization
 *
 * Normal runs never load it.
 */
class RestoreTextFieldMinSizeOptimization : RunListener() {
    @OptIn(ExperimentalFoundationApi::class)
    override fun testRunStarted(description: Description?) {
        ComposeFoundationFlags.isBasicTextFieldMinSizeOptimizationEnabled = true
        android.util.Log.w("WildStringTest", "BasicTextField min-size optimization re-enabled for this run")
    }
}
