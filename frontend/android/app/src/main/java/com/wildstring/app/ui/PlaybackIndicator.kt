package com.wildstring.app.ui

import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.sin

/** Decorative playback status. Frame state is read only while drawing this small canvas. */
@Composable internal fun PlaybackIndicator(playing: Boolean, buffering: Boolean,
    modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.primary) {
    val allowed = playbackMotionAllowed()
    val moving = playing && !buffering && allowed
    val status = if (buffering) "缓冲中" else if (playing) "正在播放" else "已暂停"
    var phase by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(moving) {
        if (!moving) return@LaunchedEffect
        var start = 0L
        while (true) withInfiniteAnimationFrameNanos { now ->
            if (start == 0L) start = now
            phase = ((now - start) % 1_200_000_000L) / 1_200_000_000f
        }
    }
    Canvas(modifier.size(18.dp).testTag("playback-indicator").semantics {
        contentDescription = "当前歌曲"; stateDescription = status
    }) {
        val bar = size.width / 6f
        val gap = bar * .7f
        val left = (size.width - bar * 3 - gap * 2) / 2
        repeat(3) { index ->
            val level = if (moving) .28f + .72f * ((sin((phase + index * .32f) * 2 * PI) + 1) / 2).toFloat()
                else if (playing && !buffering) listOf(.55f, .95f, .7f)[index] else .35f
            val height = size.height * .9f * level
            drawRoundRect(color, Offset(left + index * (bar + gap), size.height - height),
                Size(bar, height), CornerRadius(bar / 2))
        }
    }
}
