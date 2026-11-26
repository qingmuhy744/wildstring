package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wildstring.app.R

@Composable
internal fun BoxScope.BookReaderPanel(
    visible: Boolean,
    wide: Boolean,
    animate: Boolean,
    title: String,
    close: () -> Unit,
    content: @Composable () -> Unit,
) {
    val closeButton: @Composable () -> Unit = {
        TextButton(onClick = close) { Text(stringResource(R.string.books_close)) }
    }
    if (!wide) {
        if (visible) BookReaderDialog(title, close, testTag = "book-reader-panel", content = content)
        return
    }
    val progress = readerRevealProgress(visible, animate, "book-reader-panel")
    if (!visible && progress <= 0.001f) return

    BackHandler(visible, close)
    val travel = with(LocalDensity.current) { 20.dp.toPx() }
    Box(Modifier.matchParentSize()) {
        Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = 0.2f * progress))
            .then(if (visible) Modifier.pointerInput(close) { detectTapGestures { close() } } else Modifier))
        Surface(
            Modifier.align(Alignment.TopEnd).padding(top = 24.dp, end = 24.dp)
                .width(360.dp).heightIn(max = 520.dp)
                .graphicsLayer { alpha = progress; translationX = (1f - progress) * travel }
                .testTag("book-reader-panel"),
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            val access = if (visible) Modifier.semantics { paneTitle = title } else Modifier.clearAndSetSemantics {}
            Column(access.then(if (visible) Modifier.pointerInput(Unit) { detectTapGestures {} } else Modifier)
                .fillMaxWidth().padding(16.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    closeButton()
                }
                Box(Modifier.weight(1f, fill = false)) { content() }
            }
        }
    }
}

@Composable
internal fun BoxScope.BookReaderDialog(
    title: String,
    close: () -> Unit,
    testTag: String? = null,
    content: @Composable () -> Unit,
) {
    BackHandler(true, close)
    Box(Modifier.matchParentSize()) {
        Box(
            Modifier.matchParentSize()
                .background(Color.Black.copy(alpha = 0.32f))
                .pointerInput(close) { detectTapGestures { close() } },
        )
        Surface(
            Modifier.align(Alignment.Center)
                .padding(16.dp)
                .widthIn(max = 360.dp)
                .heightIn(max = 480.dp)
                .let { if (testTag != null) it.testTag(testTag) else it },
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(
                Modifier.semantics { paneTitle = title }
                    .pointerInput(Unit) { detectTapGestures {} }
                    .fillMaxWidth()
                    .padding(16.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = close) { Text(stringResource(R.string.books_close)) }
                }
                Box(Modifier.weight(1f, fill = false)) { content() }
            }
        }
    }
}

@Composable
internal fun BoxScope.BookReaderToolbar(
    visible: Boolean,
    animate: Boolean,
    close: () -> Unit = {},
    contentMaxWidth: Dp = Dp.Unspecified,
    contentPadding: PaddingValues = PaddingValues(0.dp),
    content: @Composable () -> Unit,
) {
    val progress = readerRevealProgress(visible, animate, "book-reader-tools")
    if (!visible && progress <= 0.001f) return

    val travel = with(LocalDensity.current) { 20.dp.toPx() }
    val access = if (visible) Modifier else Modifier.clearAndSetSemantics {}
    Box(Modifier.matchParentSize()) {
        if (visible) {
            Box(
                Modifier
                    .matchParentSize()
                    .testTag("book-reader-tools-backdrop")
                    .pointerInput(close) { detectTapGestures { close() } },
            )
        }
        Box(
            Modifier
                .let { if (contentMaxWidth != Dp.Unspecified) it.widthIn(max = contentMaxWidth) else it }
                .fillMaxHeight()
                .fillMaxWidth()
                .align(Alignment.TopCenter)
                .padding(contentPadding),
        ) {
            Surface(
                Modifier.align(Alignment.TopEnd)
                    .graphicsLayer { alpha = progress; translationY = (progress - 1f) * travel }
                    .testTag("book-reader-tools"),
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Box(access.then(if (visible) Modifier.pointerInput(Unit) { detectTapGestures {} } else Modifier)) {
                    content()
                }
            }
        }
    }
}

@Composable
internal fun BoxScope.BookReaderChrome(
    visible: Boolean,
    animate: Boolean,
    topBar: @Composable () -> Unit,
    bottomBar: (@Composable () -> Unit)? = null,
    showBottomBar: Boolean = bottomBar != null,
    onTopBarTap: (() -> Unit)? = null,
) {
    val topProgress = readerRevealProgress(visible, animate, "book-reader-chrome")
    val bottomProgress = readerRevealProgress(visible && showBottomBar && bottomBar != null, animate, "book-reader-bottom")
    val travel = with(LocalDensity.current) { 20.dp.toPx() }
    if (visible || topProgress > 0.001f) {
        val access = if (visible) Modifier else Modifier.clearAndSetSemantics {}
        val pointer = if (visible) Modifier.pointerInput(onTopBarTap) { detectTapGestures { onTopBarTap?.invoke() } } else Modifier
        Box(
            Modifier.align(Alignment.TopCenter)
                .fillMaxWidth()
                .graphicsLayer { alpha = topProgress; translationY = (topProgress - 1f) * travel }
                .testTag("book-reader-top-bar"),
        ) {
            Box(access.then(pointer)) { topBar() }
        }
    }
    if (bottomBar != null && ((visible && showBottomBar) || bottomProgress > 0.001f)) {
        val bottomVisible = visible && showBottomBar
        val access = if (bottomVisible) Modifier else Modifier.clearAndSetSemantics {}
        val pointer = if (bottomVisible) Modifier.pointerInput(Unit) { detectTapGestures {} } else Modifier
        Box(
            Modifier.align(Alignment.BottomCenter)
                .fillMaxWidth()
                .graphicsLayer { alpha = bottomProgress; translationY = (1f - bottomProgress) * travel }
                .testTag("book-reader-bottom-bar"),
        ) {
            Box(access.then(pointer)) { bottomBar() }
        }
    }
}

@Composable
private fun readerRevealProgress(visible: Boolean, animate: Boolean, label: String): Float {
    val target = if (visible) 1f else 0f
    val animated by animateFloatAsState(target, if (animate) tween(240, easing = FastOutSlowInEasing) else snap(),
        label = label)
    return if (animate) animated else target
}
