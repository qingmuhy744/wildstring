package com.wildstring.app.ui

import android.os.SystemClock
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Constraints
import com.wildstring.app.data.LyricSize
import com.wildstring.app.data.Lyrics
import com.wildstring.app.data.formatTime
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlin.math.abs
import kotlin.math.roundToInt

/** Browsing only moves the viewport. The explicit preview button is the only seek action. */
@Composable internal fun LyricViewport(lyrics: Lyrics, position: Long, onSeek: (Long) -> Unit,
    onBlank: () -> Unit, modifier: Modifier = Modifier, onArtwork: () -> Unit = {}, followDelayMs: Long = 2_000,
    playing: Boolean = false, lyricSize: LyricSize = LyricSize.MEDIUM) {
    val scope = rememberCoroutineScope()
    val feedback = LocalTactileFeedback.current
    var follow by remember(lyrics) { mutableStateOf(true) }
    var dragging by remember(lyrics) { mutableStateOf(false) }
    var interaction by remember(lyrics) { mutableIntStateOf(0) }
    var showTranslation by rememberSaveable { mutableStateOf(true) }
    var showRomanization by rememberSaveable { mutableStateOf(false) }
    val lines = lyrics.lines
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val smoothPosition = remember(lyrics) { mutableLongStateOf(position) }
    LaunchedEffect(lyrics, playing, position) {
        if (!playing) {
            smoothPosition.longValue = position
            return@LaunchedEffect
        }
        smoothPosition.longValue = position
        val anchor = SystemClock.elapsedRealtime()
        while (isActive) {
            smoothPosition.longValue = position + (SystemClock.elapsedRealtime() - anchor).coerceAtLeast(0)
            delay(16)
        }
    }
    val renderPosition = if (playing) smoothPosition.longValue else position
    val scale = lyricSize.scale
    val mainStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = (22 * scale).sp, lineHeight = (34 * scale).sp,
        fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
    val secondaryStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = (15 * scale).sp, lineHeight = (23 * scale).sp,
        textAlign = TextAlign.Center)
    val active = if (lyrics.kind == "synced") lines.indexOfLast { (it.timeMs ?: Long.MAX_VALUE) <= renderPosition } else -1
    BoxWithConstraints(modifier.testTag("lyrics-viewport").clipToBounds().pointerInput(onBlank, onArtwork) {
        detectTapGestures(onLongPress = { onArtwork() }, onTap = { onBlank() })
    }.semantics {
        customActions = listOf(CustomAccessibilityAction("切换歌词与播放动画") { onBlank(); true },
            CustomAccessibilityAction("查看大封面") { onArtwork(); true })
    }) {
        val hasLanguageChips = remember(lines) { lines.any { !it.translation.isNullOrBlank() || !it.romanization.isNullOrBlank() } }
        val baseTopPadding = if (hasLanguageChips) 48.dp else 24.dp
        val baseTopPaddingPx = with(density) { baseTopPadding.toPx() }
        val viewportHeightPx = with(density) { maxHeight.toPx() }
        val textWidth = with(density) { (maxWidth - 80.dp).coerceAtLeast(1.dp).roundToPx() }
        fun measuredHeight(index: Int): Int {
            val line = lines[index]
            val extra = listOfNotNull(
                line.translation?.takeIf { showTranslation && it.isNotBlank() },
                line.romanization?.takeIf { showRomanization && it.isNotBlank() })
            val original = measurer.measure(AnnotatedString(line.text.ifBlank { "♪" }), mainStyle,
                constraints = Constraints(maxWidth = textWidth)).size.height
            return original + extra.sumOf { measurer.measure(AnnotatedString(it), secondaryStyle,
                constraints = Constraints(maxWidth = textWidth)).size.height } +
                with(density) { (28.dp + 6.dp * extra.size).roundToPx() }
        }
        val totalContentHeightPx = remember(lines, showTranslation, showRomanization, textWidth, scale) {
            (0 until lines.size).sumOf { measuredHeight(it) }
        }
        val isShortLyrics = totalContentHeightPx in 1 until (viewportHeightPx - baseTopPaddingPx * 2f).roundToInt().coerceAtLeast(1)
        val topPadding = if (isShortLyrics) {
            with(density) { ((viewportHeightPx - totalContentHeightPx) / 2f).coerceAtLeast(baseTopPaddingPx).toDp() }
        } else {
            baseTopPadding
        }
        val bottomPadding = if (isShortLyrics) topPadding else maxHeight / 2
        val topPaddingPx = with(density) { topPadding.toPx() }
        val halfViewportPx = with(density) { (maxHeight / 2).toPx() } - topPaddingPx
        fun lineCenterFromTop(index: Int): Float {
            var sum = 0
            for (i in 0 until index) sum += measuredHeight(i)
            return sum + measuredHeight(index) / 2f
        }
        val list = remember(lyrics) {
            if (active > 0 && active in lines.indices && lineCenterFromTop(active) > halfViewportPx) {
                LazyListState(active, (measuredHeight(active) / 2f - halfViewportPx).roundToInt())
            } else {
                LazyListState(0, 0)
            }
        }
        val candidate by remember(list) {
            derivedStateOf {
                val layout = list.layoutInfo
                val center = (layout.viewportStartOffset + layout.viewportEndOffset) / 2
                layout.visibleItemsInfo.minByOrNull { abs(it.offset + it.size / 2 - center) }?.index
            }
        }
        var initialPlaced by remember(lyrics) { mutableStateOf(false) }
        suspend fun centerLine(index: Int, animate: Boolean = true) {
            val layout = snapshotFlow { list.layoutInfo }.first { it.visibleItemsInfo.isNotEmpty() }
            val center = (layout.viewportStartOffset + layout.viewportEndOffset) / 2f
            val shouldStayAtTop = isShortLyrics || index <= 0 || lineCenterFromTop(index) <= halfViewportPx
            if (shouldStayAtTop) {
                if (list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) return
                if (!animate) {
                    list.scrollToItem(0, 0)
                } else if (list.firstVisibleItemIndex == 0) {
                    list.animateScrollBy(-list.firstVisibleItemScrollOffset.toFloat(), tween(480, easing = FastOutSlowInEasing))
                } else {
                    list.animateScrollToItem(0, 0)
                }
                return
            }
            val item = layout.visibleItemsInfo.firstOrNull { it.index == index }
            if (!animate) {
                if (item != null) {
                    val distance = item.offset + item.size / 2f - center
                    if (abs(distance) > .5f) list.scrollBy(distance)
                } else {
                    list.scrollToItem(index, (measuredHeight(index) / 2f - center).roundToInt())
                }
                return
            }
            if (item != null) {
                val distance = item.offset + item.size / 2f - center
                if (abs(distance) > .5f)
                    list.animateScrollBy(distance, tween(480, easing = FastOutSlowInEasing))
            } else {
                // One animation, with the destination height measured before scrolling.
                list.animateScrollToItem(index, (measuredHeight(index) / 2f - center).roundToInt())
            }
        }
        LaunchedEffect(list, lyrics) { list.interactionSource.interactions.collect {
            when (it) {
                is DragInteraction.Start -> { dragging = true; follow = false; interaction++ }
                is DragInteraction.Stop, is DragInteraction.Cancel -> { dragging = false; interaction++ }
            }
        } }
        LaunchedEffect(follow, dragging, list.isScrollInProgress, interaction, lyrics, followDelayMs) {
            if (!follow && !dragging && !list.isScrollInProgress && lyrics.kind == "synced") {
                delay(followDelayMs.coerceAtLeast(1_000)); follow = true
            }
        }
        LaunchedEffect(active, follow, lyrics, showTranslation, showRomanization, textWidth, maxHeight) {
            if (follow && active >= 0) {
                centerLine(active, animate = initialPlaced)
                initialPlaced = true
            } else if (active < 0) {
                if (follow) centerLine(0, animate = false)
                initialPlaced = true
            }
        }
        val fadeEdge = with(density) { 44.dp.toPx() }
        val showTopFade = list.canScrollBackward
        LazyColumn(state = list, contentPadding = PaddingValues(top = topPadding, bottom = bottomPadding),
            modifier = Modifier.fillMaxSize().testTag("lyric-scroll")
                .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                .drawWithContent {
                    drawContent()
                    if (size.height > fadeEdge * 2) {
                        val topRatio = if (showTopFade) (fadeEdge / size.height).coerceIn(0f, 0.25f) else 0f
                        val bottomRatio = (1f - (fadeEdge / size.height).coerceIn(0f, 0.25f)).coerceIn(0.75f, 1f)
                        drawRect(
                            brush = Brush.verticalGradient(
                                0f to if (showTopFade) Color.Transparent else Color.Black,
                                topRatio to Color.Black,
                                bottomRatio to Color.Black,
                                1f to Color.Transparent,
                            ),
                            blendMode = BlendMode.DstIn,
                        )
                    }
                }) {
            items(lines.size) { index ->
                val line = lines[index]
                val effectiveActive = if (lyrics.kind == "synced") active.coerceAtLeast(0) else -1
                val highlighted = if (follow) effectiveActive == index else candidate == index
                Column(Modifier.fillMaxWidth().testTag("lyric-row-$index").padding(horizontal = 40.dp, vertical = 14.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val text = buildAnnotatedString {
                        if (line.words.isNullOrEmpty() || !highlighted) append(line.text.ifBlank { "♪" })
                        else line.words.forEach { word ->
                            val progress = ((renderPosition - word.startMs).toFloat() / (word.endMs - word.startMs).coerceAtLeast(1)).coerceIn(0f, 1f)
                            val color = androidx.compose.ui.graphics.lerp(MaterialTheme.colorScheme.onSurface.copy(alpha = .45f), MaterialTheme.colorScheme.primary, progress)
                            withStyle(SpanStyle(color = color)) { append(word.text) }
                        }
                    }
                    val selectLine = { onBlank(); Unit }
                    val selection = if (line.timeMs != null) Modifier.combinedClickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClickLabel = "选择歌词时间", onLongClickLabel = "查看大封面",
                        onLongClick = onArtwork, hapticFeedbackEnabled = false, onClick = selectLine) else Modifier
                    val translation = line.translation?.takeIf { showTranslation && it.isNotBlank() }
                    val translationFirst = translation != null && containsCjk(translation) && !containsCjk(line.text)
                    val originalColor = if (lyrics.kind == "plain" || highlighted) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .65f)
                    if (translationFirst) {
                        Text(translation, Modifier.testTag("lyric-translation-$index").then(selection), style = secondaryStyle,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(text, Modifier.testTag("lyric-line-$index").then(selection), style = mainStyle, color = originalColor)
                    } else {
                        Text(text, Modifier.testTag("lyric-line-$index").then(selection), style = mainStyle, color = originalColor)
                        if (translation != null)
                            Text(translation, Modifier.testTag("lyric-translation-$index").then(selection), style = secondaryStyle,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (showRomanization && !line.romanization.isNullOrBlank())
                        Text(line.romanization, Modifier.testTag("lyric-romanization-$index").then(selection), style = secondaryStyle,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)


                }
            }
        }
        Row(Modifier.align(Alignment.TopEnd).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (lines.any { !it.translation.isNullOrBlank() })
                FilterChip(showTranslation, { showTranslation = !showTranslation }, { Text("译文") }, modifier = Modifier.testTag("lyric-translation-toggle"))
            if (lines.any { !it.romanization.isNullOrBlank() })
                FilterChip(showRomanization, { showRomanization = !showRomanization }, { Text("音译") }, modifier = Modifier.testTag("lyric-romanization-toggle"))
        }
        if (!follow) {
            TextButton({ follow = true }, Modifier.align(Alignment.TopStart)) { Text("回到当前歌词", fontSize = 11.sp) }
            val target = candidate?.let { lines.getOrNull(it)?.timeMs }
            if (target != null) Row(Modifier.align(Alignment.Center).fillMaxWidth().testTag("lyric-seek-preview"),
                verticalAlignment = Alignment.CenterVertically) {
                Text(formatTime(target), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider(Modifier.weight(1f).padding(horizontal = 8.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = .12f))
                IconButton({ feedback(TactileKind.Tap); onSeek(target); follow = true }, Modifier.testTag("lyric-seek-confirm")) {
                    Icon(Icons.Default.PlayArrow, "跳转到 ${formatTime(target)}")
                }
            }
        }
    }
}

private fun containsCjk(value: String): Boolean = value.any {
    it in '\u3400'..'\u4DBF' || it in '\u4E00'..'\u9FFF' || it in '\uF900'..'\uFAFF'
}
