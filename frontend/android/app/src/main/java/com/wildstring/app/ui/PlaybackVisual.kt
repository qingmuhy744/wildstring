package com.wildstring.app.ui

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
import com.wildstring.app.data.Track
import kotlinx.coroutines.delay

internal val playbackStyles = listOf("cover" to "封面", "vinyl" to "黑胶", "cassette" to "磁带")

/** Saved separately from the audio session; the angle is read only during drawing. */
@Stable internal class PlaybackRotation(initial: Float = 0f) {
    var angle by mutableFloatStateOf(initial)
    companion object { val Saver = Saver<PlaybackRotation, Float>({ it.angle }, { PlaybackRotation(it) }) }
}

@Composable private fun motionAllowed(): Boolean {
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
    visible: Boolean, progress: Float, phase: PlaybackRotation, modifier: Modifier, onArtwork: () -> Unit, onLyrics: () -> Unit) {
    val moving = playing && visible && style != "cover" && motionAllowed()
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
    val arm by animateFloatAsState(if (playing && settled) 24f else -12f, tween(350), label = "tonearm")
    Crossfade(style, modifier.testTag("playback-visual-$style").semantics {
        stateDescription = if (moving) "正在转动" else "静止"
    }.combinedClickable(onClickLabel = "查看歌词", onLongClickLabel = "查看大封面", onLongClick = onArtwork,
        hapticFeedbackEnabled = false, onClick = onLyrics), tween(200), label = "playback-style") { selection ->
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val side = minOf(maxWidth, maxHeight)
            when (selection) {
                "vinyl" -> {
                    Box(Modifier.offset(side * .07f, side * .10f).size(side * .86f).graphicsLayer { rotationZ = phase.angle }) {
                        Canvas(Modifier.fillMaxSize()) {
                            val radius = size.minDimension / 2
                            drawCircle(Brush.radialGradient(listOf(Color(0xFF30352C), Color(0xFF11150F), Color(0xFF252B20))))
                            repeat(65) { groove -> drawCircle(Color(0xFFBBC1AD).copy(alpha = .14f), radius * (.46f + groove * .008f), style = Stroke(.65.dp.toPx())) }
                            drawCircle(Color(0xFF69715E), radius - 1.dp.toPx(), style = Stroke(1.dp.toPx()))
                        }
                        Cover(vm, track.id.takeIf { track.hasCover }, track.title,
                            Modifier.align(Alignment.Center).fillMaxSize(.56f).clip(CircleShape))
                        Box(Modifier.align(Alignment.Center).size(side * .023f).clip(CircleShape).background(Color(0xFF191C15)))
                    }
                    Canvas(Modifier.offset(side * .07f, side * .10f).size(side * .86f)) {
                        drawCircle(Brush.sweepGradient(listOf(Color.Transparent, Color.White.copy(alpha = .08f), Color.Transparent,
                            Color.Transparent, Color.White.copy(alpha = .08f), Color.Transparent)))
                    }
                    Canvas(Modifier.offset(side * .89f, side * .03f).width(side * .025f).height(side * .46f)
                        .graphicsLayer { rotationZ = arm; transformOrigin = TransformOrigin(.5f, .02f) }) {
                        drawRoundRect(Brush.horizontalGradient(listOf(Color(0xFF606A59), Color(0xFFE0E1D7), Color(0xFF727B67))), cornerRadius = CornerRadius(4.dp.toPx()))
                        drawCircle(Brush.radialGradient(listOf(Color(0xFFB2B9A4), Color(0xFF414C37))), radius = size.width * 1.5f, center = Offset(size.width / 2, size.height * .02f))
                        drawRoundRect(Brush.horizontalGradient(listOf(Color(0xFF303B27), Color(0xFF67765B), Color(0xFF27321F))),
                            topLeft = Offset(-size.width * .7f, size.height * .84f), size = Size(size.width * 2.4f, size.height * .19f), cornerRadius = CornerRadius(3.dp.toPx()))
                        drawLine(Color(0xFFE98A6D), Offset(-size.width * .6f, size.height * 1.02f), Offset(size.width * 1.6f, size.height * 1.02f), 2.dp.toPx())
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
                    Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.offset(side * .09f, side * .28f).size(side * .13f))
                    TapeWindow(phase, progress.coerceIn(0f, 1f), Modifier.offset(side * .15f, side * .488f).width(side * .7f).height(side * .198f))
                }
                else -> Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(side))
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

@Composable private fun TapeWindow(phase: PlaybackRotation, progress: Float, modifier: Modifier) {
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
