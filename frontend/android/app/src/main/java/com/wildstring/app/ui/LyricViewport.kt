package com.wildstring.app.ui

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
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
import com.wildstring.app.data.Lyrics
import com.wildstring.app.data.formatTime
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlin.math.abs
import kotlin.math.roundToInt

/** Browsing only moves the viewport. The explicit preview button is the only seek action. */
@Composable internal fun LyricViewport(lyrics: Lyrics, position: Long, onSeek: (Long) -> Unit,
    onBlank: () -> Unit, modifier: Modifier = Modifier, onArtwork: () -> Unit = {}, followDelayMs: Long = 2_000) {
    val list = rememberLazyListState()
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
    val mainStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 22.sp, lineHeight = 34.sp,
        fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
    val secondaryStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 23.sp,
        textAlign = TextAlign.Center)
    val active = if (lyrics.kind == "synced") lines.indexOfLast { (it.timeMs ?: Long.MAX_VALUE) <= position } else -1
    val candidate by remember {
        derivedStateOf {
            val layout = list.layoutInfo
            val center = (layout.viewportStartOffset + layout.viewportEndOffset) / 2
            layout.visibleItemsInfo.minByOrNull { abs(it.offset + it.size / 2 - center) }?.index
        }
    }
    BoxWithConstraints(modifier.testTag("lyrics-viewport").clipToBounds().pointerInput(onBlank, onArtwork) {
        detectTapGestures(onLongPress = { onArtwork() }, onTap = { onBlank() })
    }.semantics {
        customActions = listOf(CustomAccessibilityAction("切换歌词与播放动画") { onBlank(); true },
            CustomAccessibilityAction("查看大封面") { onArtwork(); true })
    }) {
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
        suspend fun centerLine(index: Int) {
            val layout = snapshotFlow { list.layoutInfo }.first { it.visibleItemsInfo.isNotEmpty() }
            val center = (layout.viewportStartOffset + layout.viewportEndOffset) / 2f
            val item = layout.visibleItemsInfo.firstOrNull { it.index == index }
            if (item != null) {
                val distance = item.offset + item.size / 2f - center
                if (abs(distance) > .5f) list.animateScrollBy(distance)
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
            if (follow && active >= 0) centerLine(active)
        }
        LazyColumn(state = list, contentPadding = PaddingValues(vertical = maxHeight / 2),
            modifier = Modifier.fillMaxSize().testTag("lyric-scroll")) {
            items(lines.size) { index ->
                val line = lines[index]
                val highlighted = if (follow) active == index else candidate == index
                Column(Modifier.fillMaxWidth().testTag("lyric-row-$index").padding(horizontal = 40.dp, vertical = 14.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val text = buildAnnotatedString {
                        if (line.words.isNullOrEmpty()) append(line.text.ifBlank { "♪" })
                        else line.words.forEach { word ->
                            val progress = ((position - word.startMs).toFloat() / (word.endMs - word.startMs).coerceAtLeast(1)).coerceIn(0f, 1f)
                            val color = androidx.compose.ui.graphics.lerp(MaterialTheme.colorScheme.onSurface.copy(alpha = .45f), MaterialTheme.colorScheme.primary, progress)
                            withStyle(SpanStyle(color = color)) { append(word.text) }
                        }
                    }
                    val selectLine = { follow = false; interaction++; scope.launch { centerLine(index) }; Unit }
                    val selection = if (line.timeMs != null) Modifier.combinedClickable(
                        onClickLabel = "选择歌词时间", onLongClickLabel = "查看大封面",
                        onLongClick = onArtwork, hapticFeedbackEnabled = false, onClick = selectLine) else Modifier
                    Text(text, Modifier.testTag("lyric-line-$index").then(selection), style = mainStyle,
                        color = if (lyrics.kind == "plain" || highlighted) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .65f))
                    if (showTranslation && !line.translation.isNullOrBlank())
                        Text(line.translation, Modifier.testTag("lyric-translation-$index").then(selection), style = secondaryStyle,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
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
