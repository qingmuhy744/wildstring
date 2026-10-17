package com.wildstring.app.ui

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.math.sin

/** Three strings respond to the pull, then gently oscillate while the real request runs. */
@Composable internal fun WildRefreshIndicator(refreshing: Boolean, state: PullToRefreshState, modifier: Modifier = Modifier) {
    val pull = state.distanceFraction.coerceIn(0f, 1f)
    if (!refreshing && pull <= 0f) return
    val transition = rememberInfiniteTransition(label = "wildstring-refresh")
    val phase by transition.animateFloat(0f, (Math.PI * 2).toFloat(),
        infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "string-phase")
    val accent = MaterialTheme.colorScheme.primary
    Surface(modifier.padding(top = 12.dp).size(48.dp).graphicsLayer {
        alpha = if (refreshing) 1f else pull
        scaleX = .75f + .25f * pull; scaleY = scaleX
    }.testTag("wildstring-refresh").semantics { contentDescription = if (refreshing) "正在刷新" else "松开刷新" },
        shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh, shadowElevation = 3.dp) {
        Canvas(Modifier.fillMaxSize().padding(10.dp)) {
            for (row in 0..2) {
                val path = Path()
                for (step in 0..32) {
                    val x = size.width * step / 32
                    val y = size.height * (.28f + row * .22f) +
                        sin(step / 32f * Math.PI * 2 + if (refreshing) phase else pull * 3).toFloat() * size.height * .08f
                    if (step == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                drawPath(path, accent, style = Stroke(width = 2.3.dp.toPx(), cap = StrokeCap.Round))
            }
        }
    }
}
