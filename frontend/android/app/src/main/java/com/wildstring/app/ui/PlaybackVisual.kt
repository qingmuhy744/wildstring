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
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
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
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.data.Track
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
                        .clip(RoundedCornerShape(3.dp)).background(Brush.verticalGradient(listOf(Color(0xFFECE2CB), Color(0xFFE6D9BE))))) {
                        Box(Modifier.fillMaxWidth().height(side * .012f).background(Color(0xFFE98A6D)))
                        Column(Modifier.padding(start = side * .18f, end = side * .025f, top = side * .018f)) {
                            val brandSize = (side.value * .023f).coerceIn(6f, 9f).sp
                            val titleSize = (side.value * .043f).coerceIn(9f, 17f).sp
                            val noteSize = (side.value * .036f).coerceIn(9f, 15f).sp
                            val rule = Color(0xFF605C4C).copy(alpha = .22f)
                            if (side >= 180.dp) Text("野弦 / WILDSTRING", fontSize = brandSize, lineHeight = brandSize * 1.3f, color = Color(0xFF77705C), maxLines = 1)
                            Text(track.title, fontSize = titleSize, lineHeight = titleSize * 1.25f, color = Color(0xFF34372C),
                                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (side >= 180.dp) {
                                Spacer(Modifier.height(side * .01f))
                                Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    val ink = Color(0xFF3C4A6B)
                                    Text(cassetteLabelNote(track), fontFamily = CassetteHandwriting, fontSize = noteSize, color = ink, maxLines = 1)
                                    // The note is short; the artist fills the rest of the line. A missing artist stays blank rather than reading "unknown".
                                    if (track.artist.isNotBlank()) Text(track.artist, Modifier.weight(1f).padding(start = side * .02f), fontSize = noteSize * .85f, color = ink,
                                        textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
                            }
                        }
                    }
                    Cover(vm, track.coverId, track.title, Modifier.offset(side * .09f, side * .28f).size(side * .13f), keepPrevious = true)
                    TapeWindow(vm, phase, duration.takeIf { it > 0 } ?: track.durationMs, track.id, Modifier.offset(side * .15f, side * .488f).width(side * .7f).height(side * .198f))
                }
                else -> Cover(vm, track.coverId, track.title, Modifier.size(side), keepPrevious = true)
            }
        }
    }
}

/** Disc and track as written on a label; a missing disc defaults to 1 and a missing track to "--". */
internal fun cassetteLabelNote(track: Track): String {
    val disc = track.discNumber?.takeIf { it > 0 } ?: 1
    val number = track.trackNumber?.takeIf { it > 0 }?.let { "%02d".format(it) } ?: "--"
    return "DISC $disc · TRACK $number"
}

/** Subset of Caveat (SIL OFL 1.1, see assets/licenses) covering only the cassette label notes. */
private val CassetteHandwriting = FontFamily(Font(R.font.caveat_label))

@Composable private fun CassetteCase(modifier: Modifier) {
    Canvas(modifier) {
        val w = size.width; val h = size.height
        val corner = CornerRadius(w * .06f, h * .10f)
        val light = Color(0xFFFFF4E0)
        // Contact shadow falls to the lower right, matching the vinyl light direction.
        drawRoundRect(Color.Black.copy(alpha = .30f), topLeft = Offset(w * .006f, h * .04f), cornerRadius = corner)
        drawRoundRect(Brush.linearGradient(listOf(Color(0xFF6F7860), Color(0xFF39422E), Color(0xFF192015)), end = Offset(w, h)), cornerRadius = corner)
        // Raised inner panel: lit on top, shaded at the bottom.
        val inset = w * .016f
        drawRoundRect(Brush.verticalGradient(listOf(light.copy(alpha = .08f), Color.Transparent, Color.Black.copy(alpha = .20f))),
            topLeft = Offset(inset, inset), size = Size(w - inset * 2, h - inset * 2), cornerRadius = CornerRadius(w * .05f, h * .085f))
        // Soft sheen from the upper left; never a hard edge.
        drawRoundRect(Brush.linearGradient(0f to light.copy(alpha = .12f), .45f to Color.Transparent, start = Offset.Zero, end = Offset(w * .8f, h * 1.1f)), cornerRadius = corner)
        // Bevel: bright hairline top-left, dark hairline bottom-right.
        drawRoundRect(Brush.linearGradient(listOf(Color(0xFFC4CCB2), Color(0x00C4CCB2), Color(0x99000000)), end = Offset(w, h)),
            topLeft = Offset(.6.dp.toPx(), .6.dp.toPx()), size = Size(w - 1.2.dp.toPx(), h - 1.2.dp.toPx()), cornerRadius = corner, style = Stroke(1.2.dp.toPx()))
        // Bottom plate with head, pinch-roller and alignment openings.
        val plate = Path().apply { moveTo(w * .28f, h * .83f); lineTo(w * .72f, h * .83f); lineTo(w * .79f, h); lineTo(w * .21f, h); close() }
        drawPath(plate, Brush.verticalGradient(listOf(Color(0xFF10170B), Color(0xFF47553A))))
        drawLine(Color(0xFF8D977B).copy(alpha = .35f), Offset(w * .28f, h * .83f), Offset(w * .72f, h * .83f), 1.dp.toPx())
        // One slim head opening between the two alignment holes, with a lit lower lip.
        drawRoundRect(Color(0xFF0A0F07), Offset(w * .45f, h * .885f), Size(w * .10f, h * .045f), CornerRadius(1.5.dp.toPx()))
        drawLine(Color(0xFF8D977B).copy(alpha = .25f), Offset(w * .455f, h * .935f), Offset(w * .545f, h * .935f), 1.dp.toPx())
        listOf(.38f, .62f).forEach { x -> drawCircle(Color(0xFF0A0F07), w * .012f, Offset(w * x, h * .955f)) }
        // Bezel seating the window: a dark well with a lit lower lip.
        drawRoundRect(Color(0xFF0F150B), Offset(w * .142f, h * .465f), Size(w * .716f, h * .345f), CornerRadius(16.dp.toPx()))
        listOf(.05f to .08f, .95f to .08f, .05f to .92f, .95f to .92f).forEach { (x, y) -> screw(Offset(w * x, h * y), w * .017f) }
    }
}

private fun DrawScope.screw(center: Offset, radius: Float) {
    drawCircle(Color.Black.copy(alpha = .35f), radius * 1.15f, center + Offset(radius * .15f, radius * .2f))
    drawCircle(Brush.radialGradient(listOf(Color(0xFFDDE2CE), Color(0xFF7C8570)), center - Offset(radius * .35f, radius * .35f), radius * 1.6f), radius, center)
    val slot = Color(0xFF2A3420)
    drawLine(slot, center - Offset(radius * .6f, 0f), center + Offset(radius * .6f, 0f), 1.2.dp.toPx())
    drawLine(slot, center - Offset(0f, radius * .6f), center + Offset(0f, radius * .6f), 1.2.dp.toPx())
}

/** Tape pack radius as a fraction of the window height: the hub plus tape; the packs share a constant tape area. */
private const val PackMin = .30f
private const val PackMax = .46f
/** Mean pack radius, used as the reference for reel speed. */
private const val PackMean = .388f

/** Supply pack shrinks as the take-up pack grows, with the total tape area conserved (so the change is slow at first, quick at the end). */
internal fun tapePackRadii(progress: Float): Pair<Float, Float> {
    val p = progress.coerceIn(0f, 1f)
    val extra = PackMax * PackMax - PackMin * PackMin
    return kotlin.math.sqrt(PackMin * PackMin + extra * (1f - p)) to kotlin.math.sqrt(PackMin * PackMin + extra * p)
}

@Composable private fun TapeWindow(vm: MusicViewModel, phase: PlaybackRotation, duration: Long, trackId: String, modifier: Modifier) {
    val position by vm.position.collectAsStateWithLifecycle()
    val target = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
    // Position ticks arrive in steps; easing between them keeps the pack growing smoothly, and a seek visibly winds the tape.
    val progress by animateFloatAsState(target, tween(if (playbackMotionAllowed()) 700 else 0, easing = LinearEasing), label = "tape-progress")
    val radii by rememberUpdatedState(tapePackRadii(progress))
    // Tape moves at a constant speed, so a small pack spins faster than a large one. Angles are accumulated, not derived
    // from the shared phase, so a changing radius never makes a reel jump.
    var spinSupply by remember { mutableFloatStateOf(0f) }
    var spinTakeUp by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(phase) {
        var previous = phase.angle
        snapshotFlow { phase.angle }.collect { angle ->
            val step = ((angle - previous) % 360f + 360f) % 360f
            previous = angle
            spinSupply = (spinSupply + step * 2.8f * PackMean / radii.first) % 360f
            spinTakeUp = (spinTakeUp + step * 2.8f * PackMean / radii.second) % 360f
        }
    }
    // A seek winds the reels: a burst of extra spin, forward or reversed, that eases out while the packs change size.
    val motion = playbackMotionAllowed()
    val wind = remember { Animatable(0f) }
    LaunchedEffect(trackId, motion) {
        if (!motion) return@LaunchedEffect
        val started = android.os.SystemClock.elapsedRealtime()
        var last = vm.position.value
        var job: Job? = null
        vm.position.collect { now ->
            val direction = tapeWindDirection(last, now)
            last = now
            // A new track resets the position to zero; that is not a rewind.
            if (direction == 0 || android.os.SystemClock.elapsedRealtime() - started < 800) return@collect
            job?.cancel()
            job = launch {
                wind.snapTo(direction.toFloat())
                var frame = System.nanoTime()
                wind.animateTo(0f, tween(900, easing = FastOutSlowInEasing)) {
                    val tick = System.nanoTime()
                    val extra = value * 1.1f * ((tick - frame) / 1_000_000f)
                    frame = tick
                    spinSupply = (spinSupply + extra * PackMean / radii.first) % 360f
                    spinTakeUp = (spinTakeUp + extra * PackMean / radii.second) % 360f
                }
            }
        }
    }
    Canvas(modifier.clip(RoundedCornerShape(14.dp))) {
        val w = size.width; val h = size.height
        drawRect(Brush.verticalGradient(listOf(Color(0xFF1B2415), Color(0xFF0B1007))))
        val centres = listOf(Offset(w * .27f, h * .5f), Offset(w * .73f, h * .5f))
        val packs = listOf(radii.first * h, radii.second * h)
        // Tape stretched between the packs: the outer tangents of the circles, so the angle follows the radii. The tape's centre line
        // sits half a tape width outside each pack so its inner edge meets the pack exactly, and a short fading arc hugs the pack
        // to show the outer layer peeling off into the straight run instead of butting against the rim.
        val tapeWidth = 2.6.dp.toPx()
        val half = tapeWidth / 2
        val track = packs.map { it + half }
        val span = centres[1].x - centres[0].x
        val nx = ((track[0] - track[1]) / span).coerceIn(-.95f, .95f)
        val ny = kotlin.math.sqrt(1f - nx * nx)
        listOf(-1f, 1f).forEach { side ->
            val normal = Offset(nx, side * ny)
            val from = centres[0] + normal * track[0]
            val to = centres[1] + normal * track[1]
            drawLine(Color.Black.copy(alpha = .30f), from + Offset(0f, 1.6.dp.toPx()), to + Offset(0f, 1.6.dp.toPx()), tapeWidth + .6.dp.toPx())
            drawLine(Color(0xFF5A4630), from, to, tapeWidth)
            // The sheen fades out at both ends, so it never starts abruptly where the tape leaves a pack.
            drawLine(Brush.linearGradient(0f to Color.Transparent, .18f to Color(0xFFC9A877).copy(alpha = .5f), .82f to Color(0xFFC9A877).copy(alpha = .5f), 1f to Color.Transparent,
                start = from, end = to), from + Offset(0f, -.7.dp.toPx()), to + Offset(0f, -.7.dp.toPx()), .9.dp.toPx())
            val tangentAngle = Math.toDegrees(kotlin.math.atan2(normal.y, normal.x).toDouble()).toFloat()
            centres.indices.forEach { i ->
                // Wrap on the side away from the other pack. A single sweep-gradient stroke fades continuously from solid at the
                // tangent point to clear 50 degrees on, so there are no segment seams or steps.
                val awayFirst = (i == 0 && side < 0) || (i == 1 && side > 0)
                val wrap = 50f
                val solid = 8f
                val tape = Color(0xFF5A4630)
                // Sweep-gradient positions must lie in 0..1, so use the tangent angle normalised to 0..360 (upper tangents are negative).
                val at = (tangentAngle + 360f) % 360f
                val brush = if (awayFirst) Brush.sweepGradient(
                    (at - wrap) / 360f to tape.copy(alpha = 0f),
                    (at - solid) / 360f to tape,
                    (at + 1f) / 360f to tape, center = centres[i],
                ) else Brush.sweepGradient(
                    (at - 1f) / 360f to tape,
                    (at + solid) / 360f to tape,
                    (at + wrap) / 360f to tape.copy(alpha = 0f), center = centres[i],
                )
                drawArc(brush, if (awayFirst) tangentAngle - wrap else tangentAngle, wrap, false,
                    topLeft = centres[i] - Offset(track[i], track[i]), size = Size(track[i] * 2, track[i] * 2), style = Stroke(tapeWidth))
            }
        }
        centres.forEachIndexed { index, center ->
            val pack = packs[index]
            drawCircle(Brush.radialGradient(listOf(Color(0xFF5C4733), Color(0xFF2B2015)), center - Offset(pack * .3f, pack * .3f), pack * 1.7f), pack, center)
            // Winding rings follow the pack, so a thicker pack shows more tape layers.
            repeat(8) { ring -> drawCircle(Color(0xFF1A140D).copy(alpha = .55f), pack * (.50f + ring * .06f), center, style = Stroke(.6.dp.toPx())) }
            drawCircle(Color(0xFFC49A6A).copy(alpha = .28f), pack, center, style = Stroke(1.dp.toPx()))
            val hub = h * .25f
            val plastic = Color(0xFFE8E4D4)
            rotate(if (index == 0) spinSupply else spinTakeUp, center) {
                // A real hub is a clear ring with six teeth pointing inward and an open centre.
                drawCircle(plastic, hub, center)
                drawCircle(Color(0xFF0E1409), hub * .70f, center)
                repeat(6) { tooth -> rotate(tooth * 60f, center) {
                    drawRect(plastic, center + Offset(hub * .42f, -hub * .06f), Size(hub * .32f, hub * .12f))
                } }
            }
            drawCircle(Color(0xFF8E8A78), hub, center, style = Stroke(.8.dp.toPx()))
        }
        // Recessed acetate window: inner shadow along the top, bevel dark top-left and lit bottom-right.
        drawRect(Brush.verticalGradient(listOf(Color.Black.copy(alpha = .55f), Color.Transparent), endY = h * .3f))
        drawRoundRect(Brush.linearGradient(listOf(Color.Black.copy(alpha = .7f), Color.Transparent, Color(0xFFC4CCB2).copy(alpha = .45f)), end = Offset(w, h)),
            cornerRadius = CornerRadius(14.dp.toPx()), style = Stroke(3.dp.toPx()))
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
