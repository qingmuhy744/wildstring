package com.wildstring.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Album-tinted capsule with independent playback and queue targets. No per-frame artwork work. */
@Composable internal fun MiniPlayer(vm: MusicViewModel, state: MusicState, onQueue: () -> Unit, expand: () -> Unit) {
    val track = state.current ?: return
    val feedback = LocalTactileFeedback.current
    val art = artworkAtmosphere(vm, track)
    val colors = MaterialTheme.colorScheme
    val dark = LocalDarkAppearance.current || LocalRedCloth.current
    val tint = art?.tint ?: colors.secondary
    val currentQueueIndex = remember(state.entryId, state.queue) {
        state.queue.indexOfFirst { it.entryId == state.entryId }
    }
    var lastQueueIndex by remember { mutableIntStateOf(currentQueueIndex) }
    var slideDirection by remember { mutableIntStateOf(1) }
    if (currentQueueIndex != lastQueueIndex && currentQueueIndex >= 0 && lastQueueIndex >= 0) {
        slideDirection = if (currentQueueIndex < lastQueueIndex) -1 else 1
        lastQueueIndex = currentQueueIndex
    } else if (currentQueueIndex >= 0) {
        lastQueueIndex = currentQueueIndex
    }
    var rawDragX by remember { mutableFloatStateOf(0f) }
    var draggingX by remember { mutableStateOf(false) }
    val animatedDragX = animateFloatAsState(
        targetValue = if (draggingX) rawDragX * 0.35f else 0f,
        animationSpec = if (draggingX) snap() else spring(stiffness = Spring.StiffnessMediumLow),
        label = "mini-player-drag-x",
    )
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp), contentAlignment = Alignment.Center) {
        Surface(Modifier.widthIn(max = 640.dp).fillMaxWidth().testTag("mini-player")
            .trackSwipeGestures(
                enabled = true,
                onPrevious = {
                    slideDirection = -1
                    feedback(TactileKind.Tap)
                    vm.previous()
                },
                onNext = {
                    slideDirection = 1
                    feedback(TactileKind.Tap)
                    vm.next()
                },
                onDragOffset = { offset, active ->
                    rawDragX = offset
                    draggingX = active
                },
            ), shape = RoundedCornerShape(36.dp),
            color = colors.surfaceContainerHigh, shadowElevation = 8.dp) {
            Box {
                art?.let { Image(it.image, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop,
                    alpha = if (LocalRedCloth.current) .10f else if (dark) .18f else .20f, filterQuality = FilterQuality.Medium) }
            Row(Modifier.background(Brush.horizontalGradient(listOf(tint.copy(alpha = if (dark) .28f else .15f), Color.Transparent)))
                .padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                AnimatedContent(
                    targetState = track,
                    modifier = Modifier.weight(1f).testTag("mini-player-open")
                        .drawWithContent {
                            withTransform({ translate(left = animatedDragX.value) }) {
                                this@drawWithContent.drawContent()
                            }
                        }
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = tactile(expand)),
                    transitionSpec = {
                        val dir = slideDirection
                        (fadeIn(tween(220)) + slideInHorizontally(tween(240, easing = FastOutSlowInEasing)) { fullWidth -> dir * (fullWidth / 4) })
                            .togetherWith(fadeOut(tween(150)) + slideOutHorizontally(tween(220, easing = FastOutSlowInEasing)) { fullWidth -> -dir * (fullWidth / 4) })
                    },
                    contentKey = { it.id },
                    label = "mini-player-track",
                ) { currentTrack ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(Modifier.clip(CircleShape)) { Cover(vm, currentTrack.id.takeIf { currentTrack.hasCover }, currentTrack.title, Modifier.size(44.dp)) }
                        Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                            Text(currentTrack.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(currentTrack.artist, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                IconButton(tactile(vm::toggle)) { Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "暂停" else "播放") }
                IconButton(tactile(onQueue), Modifier.testTag("mini-player-queue")) { Icon(Icons.AutoMirrored.Filled.QueueMusic, "播放队列") }
            }
                MiniPlayerProgress(vm, state.duration, colors.primary, Modifier.align(Alignment.BottomCenter))
            }
        }
    }
}

@Composable private fun MiniPlayerProgress(vm: MusicViewModel, duration: Long, color: Color, modifier: Modifier = Modifier) {
    val position by vm.position.collectAsStateWithLifecycle()
    val fraction = if (duration > 0L) (position.toFloat() / duration.toFloat()).coerceIn(0f, 1f) else 0f
    if (fraction > 0f) {
        Box(modifier.fillMaxWidth().padding(horizontal = 24.dp).height(2.dp).clip(RoundedCornerShape(1.dp)).background(color.copy(alpha = 0.14f))) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(color.copy(alpha = 0.68f)))
        }
    }
}
