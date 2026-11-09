package com.wildstring.app.ui

import androidx.compose.ui.res.stringResource
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import android.animation.ValueAnimator
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.data.Track
import kotlinx.coroutines.delay

internal val playbackStyles: List<Pair<String, String>>
    get() = listOf(
        "cover" to AppLanguage.string(R.string.pb_vis_style_cover),
        "vinyl" to AppLanguage.string(R.string.pb_vis_style_vinyl),
        "cassette" to AppLanguage.string(R.string.pb_vis_style_cassette)
    )

/** Saved separately from the audio session; the angle is read only during drawing. */
@Stable internal class PlaybackRotation(initial: Float = 0f) {
    var angle by mutableFloatStateOf(initial)
    companion object { val Saver = Saver<PlaybackRotation, Float>({ it.angle }, { PlaybackRotation(it) }) }
}

@Composable internal fun playbackMotionAllowed(): Boolean {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var enabled by remember { mutableStateOf(ValueAnimator.areAnimatorsEnabled()) }
    DisposableEffect(lifecycle, context) {
        val observer = LifecycleEventObserver { _, _ ->
            foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            enabled = ValueAnimator.areAnimatorsEnabled()
        }
        val settings = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { enabled = ValueAnimator.areAnimatorsEnabled() }
        }
        lifecycle.addObserver(observer)
        context.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, settings)
        onDispose { lifecycle.removeObserver(observer); context.contentResolver.unregisterContentObserver(settings) }
    }
    return foreground && enabled
}

@Composable internal fun PlaybackVisual(vm: MusicViewModel, track: Track, style: String, playing: Boolean,
    visible: Boolean, duration: Long, phase: PlaybackRotation, modifier: Modifier, onArtwork: () -> Unit, onLyrics: () -> Unit) {
    val motionAllowed = playbackMotionAllowed()
    val moving = playing && visible && style != "cover" && motionAllowed
    LaunchedEffect(moving) {
        if (!moving) return@LaunchedEffect
        var previous = 0L
        while (true) withInfiniteAnimationFrameNanos { now ->
            if (previous != 0L) phase.angle = (phase.angle + ((now - previous) / 1_000_000f).coerceAtMost(64f) * .018f) % 360f
            previous = now
        }
    }
    var settled by remember(track.id) { mutableStateOf(false) }
    LaunchedEffect(track.id) { delay(180); settled = true }
    val arm by animateFloatAsState(if (playing && settled) 26f else 8f, tween(if (motionAllowed) 350 else 0), label = "tonearm")
    val stateDesc = if (moving) stringResource(R.string.pb_vis_state_spinning) else stringResource(R.string.pb_vis_state_still)
    Crossfade(style, modifier.testTag("playback-visual-$style").semantics {
        stateDescription = stateDesc
    }.combinedClickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        onClickLabel = stringResource(R.string.pb_vis_view_lyrics),
        onLongClickLabel = stringResource(R.string.pb_vis_view_artwork),
        onLongClick = onArtwork,
        hapticFeedbackEnabled = false,
        onClick = onLyrics,
    ), tween(if (motionAllowed) 200 else 0), label = "playback-style") { selection ->
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val side = minOf(maxWidth, maxHeight)
            when (selection) {
                "vinyl" -> {
                    Canvas(Modifier.offset(side * .05f, side * .08f).size(side * .88f)) {
                        val radius = size.minDimension / 2
                        val shadowCenter = center + Offset(radius * .035f, radius * .05f)
                        drawCircle(Brush.radialGradient(.90f to Color.Black.copy(alpha = .42f), 1.04f to Color.Transparent, center = shadowCenter, radius = radius * 1.05f),
                            radius * 1.05f, shadowCenter)
                    }
                    Box(Modifier.offset(side * .05f, side * .08f).size(side * .88f).graphicsLayer { rotationZ = phase.angle }) {
                        Canvas(Modifier.fillMaxSize()) {
                            val radius = size.minDimension / 2
                            drawCircle(Brush.radialGradient(listOf(Color(0xFF2E2A25), Color(0xFF0F0D0B), Color(0xFF221E1A))))
                            // Irregular hairline grooves: alpha and spacing drift so the disc reads as pressed, not printed.
                            repeat(64) { groove ->
                                val fine = ((groove * 37) % 11) / 10f
                                drawCircle(Color(0xFFC8BFB2).copy(alpha = .028f + fine * .05f), radius * (.455f + groove * .0082f + fine * .0012f), style = Stroke(.5.dp.toPx()))
                            }
                            listOf(.50f, .67f, .84f).forEach { ring -> drawCircle(Color(0xFF060905).copy(alpha = .22f), radius * ring, style = Stroke(radius * .04f)) }
                            drawCircle(Color(0xFF0A0D08).copy(alpha = .65f), radius * .44f + 1.dp.toPx(), style = Stroke(2.dp.toPx()))
                            drawCircle(Color(0xFFDCE2CD).copy(alpha = .10f), radius * .44f + 2.5.dp.toPx(), style = Stroke(1.dp.toPx()))
                            drawCircle(Color(0xFF0A0D08).copy(alpha = .55f), radius - 1.5.dp.toPx(), style = Stroke(3.dp.toPx()))
                            drawCircle(Color(0xFFC8BFB2).copy(alpha = .10f), radius - .5.dp.toPx(), style = Stroke(.75.dp.toPx()))
                        }
                        Cover(vm, track.coverId, track.title,
                            Modifier.align(Alignment.Center).fillMaxSize(.44f).clip(CircleShape))
                        Box(Modifier.align(Alignment.Center).size(side * .023f).clip(CircleShape).background(Color(0xFF191C15)))
                    }
                    // Fixed room light: two point-symmetric soft wedges (DESIGN.md §6.7), never rotated with the platter.
                    Canvas(Modifier.offset(side * .05f, side * .08f).size(side * .88f).graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
                        val radius = size.minDimension / 2
                        drawCircle(Brush.sweepGradient(colorStops = vinylSheenStops))
                        drawCircle(Brush.radialGradient(
                            0f to Color.Transparent, .46f to Color.Transparent, .55f to Color.Black, .85f to Color.Black, .99f to Color.Transparent,
                            center = center, radius = radius,
                        ), blendMode = BlendMode.DstIn)
                    }
                    Canvas(Modifier.offset(side * .84f, side * .06f).width(side * .022f).height(side * .48f)
                        .graphicsLayer { rotationZ = arm; transformOrigin = TransformOrigin(.5f, .04f) }) {
                        val pivot = Offset(size.width / 2, size.height * .04f)
                        drawCircle(Color(0xFF0C0A09).copy(alpha = 0.45f), radius = size.width * 2.6f, center = pivot + Offset(size.width * .35f, size.width * .5f))
                        drawCircle(Color(0xFF26221F), radius = size.width * 2.4f, center = pivot)
                        drawCircle(Color(0xFF6B635A).copy(alpha = .8f), radius = size.width * 2.0f, center = pivot, style = Stroke(.75.dp.toPx()))
                        drawRoundRect(
                            Brush.horizontalGradient(listOf(Color(0xFF4A443D), Color(0xFFB4AA9C), Color(0xFF5A534A))),
                            topLeft = Offset(size.width * .2f, -size.height * .04f),
                            size = Size(size.width * .6f, size.height * .90f),
                            cornerRadius = CornerRadius(2.dp.toPx()),
                        )
                        drawCircle(Brush.radialGradient(listOf(Color(0xFFA89F92), Color(0xFF3E3832))), radius = size.width * 1.4f, center = pivot)
                        drawRoundRect(Brush.horizontalGradient(listOf(Color(0xFF2B2723), Color(0xFF5A524A), Color(0xFF231F1C))),
                            topLeft = Offset(-size.width * .75f, size.height * .82f), size = Size(size.width * 2.5f, size.height * .19f), cornerRadius = CornerRadius(3.dp.toPx()))
                        drawLine(Color(0xFFE98A6D), Offset(-size.width * .65f, size.height * 1.0f), Offset(size.width * 1.65f, size.height * 1.0f), 2.dp.toPx())
                    }
                }
                "cassette" -> {
                    CassetteCase(Modifier.offset(y = side * .19f).width(side).height(side * .62f))
                    Box(Modifier.offset(side * .07f, side * .246f).width(side * .86f).height(side * .223f)
                        .clip(RoundedCornerShape(3.dp)).background(Color(0xFFE9DDC4))) {
                        Box(Modifier.fillMaxWidth().height(side * .012f).background(Color(0xFFE98A6D)))
                        Column(Modifier.padding(start = side * .18f, end = side * .025f, top = side * .018f)) {
                            val brandSize = (side.value * .023f).coerceIn(6f, 9f).sp
                            val titleSize = (side.value * .043f).coerceIn(9f, 17f).sp
                            val artistSize = (side.value * .028f).coerceIn(7f, 11f).sp
                            if (side >= 180.dp) Text("野弦 / WILDSTRING", fontSize = brandSize, lineHeight = brandSize * 1.3f, color = Color(0xFF77705C), maxLines = 1)
                            Text(track.title, fontSize = titleSize, lineHeight = titleSize * 1.25f, color = Color(0xFF34372C),
                                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (side >= 130.dp) Text(track.artist, fontSize = artistSize, lineHeight = artistSize * 1.3f, color = Color(0xFF605C4C), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    Cover(vm, track.coverId, track.title, Modifier.offset(side * .09f, side * .28f).size(side * .13f))
                    TapeWindow(vm, phase, duration.takeIf { it > 0 } ?: track.durationMs, Modifier.offset(side * .15f, side * .488f).width(side * .7f).height(side * .198f))
                }
                else -> Cover(vm, track.coverId, track.title, Modifier.size(side))
            }
        }
    }
}

@Composable private fun CassetteCase(modifier: Modifier) {
    Canvas(modifier) {
        val w = size.width; val h = size.height
        drawRoundRect(Color.Black.copy(alpha = .28f), topLeft = Offset(0f, h * .035f), cornerRadius = CornerRadius(w * .06f, h * .10f))
        drawRoundRect(Brush.linearGradient(listOf(Color(0xFF6A735B), Color(0xFF343D2C), Color(0xFF1C2418)), end = Offset(w, h)),
            cornerRadius = CornerRadius(w * .06f, h * .10f))
        drawRoundRect(Color(0xFF8D977B), topLeft = Offset(1.dp.toPx(), 1.dp.toPx()), size = Size(w - 2.dp.toPx(), h - 2.dp.toPx()),
            cornerRadius = CornerRadius(w * .06f, h * .10f), style = Stroke(1.dp.toPx()))
        val apron = Path().apply { moveTo(w * .28f, h * .83f); lineTo(w * .72f, h * .83f); lineTo(w * .79f, h); lineTo(w * .21f, h); close() }
        drawPath(apron, Brush.verticalGradient(listOf(Color(0xFF131C0E), Color(0xFF4D5B3E))))
        listOf(.05f to .07f, .95f to .07f, .05f to .92f, .95f to .92f).forEach { (x, y) ->
            val center = Offset(w * x, h * y); val radius = w * .013f
            drawCircle(Color(0xFFB6BCA7), radius, center)
            drawLine(Color(0xFF303C24), center - Offset(radius * .6f, radius * .6f), center + Offset(radius * .6f, radius * .6f), 1.dp.toPx())
        }
        listOf(.37f, .63f).forEach { x -> drawCircle(Color(0xFF10180B), w * .012f, Offset(w * x, h * .94f)) }
    }
}

@Composable private fun TapeWindow(vm: MusicViewModel, phase: PlaybackRotation, duration: Long, modifier: Modifier) {
    val position by vm.position.collectAsStateWithLifecycle()
    val progress = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
    Canvas(modifier.clip(RoundedCornerShape(14.dp))) {
        val w = size.width; val h = size.height
        drawRect(Color(0xFF0D1409))
        listOf(.25f to (1f - progress), .75f to progress).forEachIndexed { index, (x, portion) ->
            val center = Offset(w * x, h / 2); val pack = w * (.125f + portion * .065f)
            drawCircle(Color(0xFF453728), pack, center)
            repeat(14) { ring -> drawCircle(Color(0xFF211D13), pack * (.62f + ring * .025f), center, style = Stroke(.65.dp.toPx())) }
            rotate(phase.angle * if (index == 0) 3f else 2.5f, center) {
                val hub = w * .09f
                drawCircle(Color(0xFFCDCDB5), hub, center)
                repeat(6) { spoke -> rotate(spoke * 60f, center) {
                    drawLine(Color(0xFF737E61), center + Offset(hub * .38f, 0f), center + Offset(hub * .94f, 0f), hub * .26f)
                } }
                drawCircle(Color(0xFF15200D), hub * .32f, center)
            }
        }
        drawLine(Color(0xFF756044), Offset(w * .22f, h * .91f), Offset(w * .78f, h * .91f), 1.dp.toPx())
    }
}

/** Sweep stops start at 3 o'clock and run clockwise; wedges sit at 45° (lower right) and 225° (upper left). */
private val vinylSheenStops: Array<Pair<Float, Color>> = run {
    val warm = Color(0xFFFFF4E0)
    val clear = warm.copy(alpha = 0f)
    val wedge = listOf(-23f to 0f, -17f to .02f, -9f to .06f, 0f to .12f, 9f to .06f, 17f to .02f, 23f to 0f)
    val stops = mutableListOf(0f to clear)
    listOf(45f, 225f).forEach { centre ->
        wedge.forEach { (offset, alpha) -> stops += ((centre + offset) / 360f) to warm.copy(alpha = alpha) }
    }
    stops += 1f to clear
    stops.toTypedArray()
}
