package com.wildstring.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp

/**
 * Seek bar per DESIGN.md §5.3: 5px `--border` inactive track, `--accent` @ 28% buffered range,
 * `--accent-text` played range, 14px paper thumb with 2px `--accent` stroke.
 */
@Composable internal fun PlaybackSlider(
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    enabled: Boolean,
    bufferedValue: Float = valueRange.start,
    modifier: Modifier = Modifier,
    onValueChange: (Float) -> Unit,
    onValueChangeFinished: () -> Unit,
) {
    val accent = MaterialTheme.colorScheme.primary
    val played = MaterialTheme.colorScheme.tertiary
    val track = MaterialTheme.colorScheme.outlineVariant
    val buffer = accent.copy(alpha = 0.28f)
    val thumbFill = MaterialTheme.colorScheme.onPrimary.copy(alpha = if (enabled) 1f else 0.6f)
    val thumbStroke = if (enabled) accent else MaterialTheme.colorScheme.onSurfaceVariant
    val span = (valueRange.endInclusive - valueRange.start).coerceAtLeast(1e-6f)
    val fraction = ((value - valueRange.start) / span).coerceIn(0f, 1f)
    val bufferedFraction = ((bufferedValue - valueRange.start) / span).coerceIn(0f, 1f)
    fun valueAt(x: Float, width: Float): Float =
        valueRange.start + (x / width).coerceIn(0f, 1f) * span
    val gestureModifier = if (!enabled) Modifier
    else Modifier
        .pointerInput(valueRange, span) {
            detectTapGestures { offset ->
                onValueChange(valueAt(offset.x, size.width.toFloat()))
                onValueChangeFinished()
            }
        }
        .pointerInput(valueRange, span) {
            detectHorizontalDragGestures(
                onDragStart = { offset -> onValueChange(valueAt(offset.x, size.width.toFloat())) },
                onDragCancel = { onValueChangeFinished() },
                onDragEnd = { onValueChangeFinished() },
            ) { change, _ ->
                change.consume()
                onValueChange(valueAt(change.position.x, size.width.toFloat()))
            }
        }
    Box(modifier.height(48.dp).fillMaxWidth().then(gestureModifier)) {
        Canvas(Modifier.fillMaxWidth().height(48.dp)) {
            val trackHeight = 5.dp.toPx()
            val thumbRadius = 7.dp.toPx()
            val midY = size.height / 2f
            val left = thumbRadius
            val right = size.width - thumbRadius
            val pin = left + (right - left) * fraction
            val bufferPin = left + (right - left) * bufferedFraction
            drawRoundRect(track, Offset(left, midY - trackHeight / 2f), androidx.compose.ui.geometry.Size(right - left, trackHeight), CornerRadius(trackHeight / 2f, trackHeight / 2f))
            if (bufferPin > left) {
                drawRoundRect(buffer, Offset(left, midY - trackHeight / 2f), androidx.compose.ui.geometry.Size(bufferPin - left, trackHeight), CornerRadius(trackHeight / 2f, trackHeight / 2f))
            }
            if (pin > left) {
                drawRoundRect(played, Offset(left, midY - trackHeight / 2f), androidx.compose.ui.geometry.Size(pin - left, trackHeight), CornerRadius(trackHeight / 2f, trackHeight / 2f))
            }
            drawCircle(thumbFill, thumbRadius, Offset(pin, midY))
            drawCircle(thumbStroke, thumbRadius, Offset(pin, midY), style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
        }
    }
}
