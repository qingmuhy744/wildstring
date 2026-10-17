package com.wildstring.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.wildstring.app.data.Track

/** Separate window: dismissing artwork never changes the player or lyric viewport. */
@Composable internal fun ArtworkPreview(vm: MusicViewModel, track: Track, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color(0xFF10110F)).safeDrawingPadding()
            .testTag("artwork-preview").pointerInput(onClose) { detectTapGestures(onTap = { onClose() }) }, contentAlignment = Alignment.Center) {
            Cover(vm, track.id.takeIf { track.hasCover }, track.title,
                Modifier.padding(20.dp).size(minOf(maxWidth, maxHeight, 900.dp))
                    .pointerInput(Unit) { detectTapGestures(onTap = {}) }, ContentScale.Fit)
            IconButton(onClose, Modifier.align(Alignment.TopEnd).padding(8.dp)) {
                Icon(Icons.Default.Close, "关闭大封面", tint = Color.White)
            }
        }
    }
}
