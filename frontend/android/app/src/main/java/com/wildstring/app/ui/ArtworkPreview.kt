package com.wildstring.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.wildstring.app.data.Track
import com.wildstring.app.data.friendlyError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Separate window: dismissing artwork never changes the player or lyric viewport. */
@Composable internal fun ArtworkPreview(vm: MusicViewModel, track: Track, onClose: () -> Unit) {
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    var busy by remember { mutableStateOf(false) }; var message by remember { mutableStateOf<String?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("image/jpeg")) { uri ->
        val captured = pending; pending = null
        if (uri != null && captured != null) scope.launch {
            busy = true
            try {
                withContext(Dispatchers.IO) {
                    check(vm.repository.session.cacheScope() == captured.first) { "会话已变化，请重新下载。" }
                    checkNotNull(context.contentResolver.openOutputStream(uri, "w")).use { it.write(captured.second) }
                }
                message = "封面已保存。"
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { message = friendlyError(error) }
            finally { busy = false }
        }
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color(0xFF10110F)).safeDrawingPadding()
            .testTag("artwork-preview").pointerInput(onClose) { detectTapGestures(onTap = { onClose() }) }, contentAlignment = Alignment.Center) {
            Cover(vm, track.id.takeIf { track.hasCover }, track.title,
                Modifier.padding(20.dp).size(minOf(maxWidth, maxHeight, 900.dp))
                    .pointerInput(Unit) { detectTapGestures(onTap = {}) }, ContentScale.Fit)
            Row(Modifier.align(Alignment.TopEnd).padding(8.dp)) {
                if (track.hasCover) IconButton({ scope.launch {
                    busy = true; message = "正在准备封面…"
                    try {
                        val owner = checkNotNull(vm.repository.session.cacheScope())
                        val bytes = vm.repository.coverImage(track.id)
                        pending = owner to bytes; message = null
                        save.launch(track.title.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(100).ifBlank { "WildString" } + "-封面.jpg")
                    } catch (error: CancellationException) { throw error }
                    catch (error: Exception) { pending = null; message = friendlyError(error) }
                    finally { busy = false }
                } }, enabled = !busy && pending == null) {
                    Icon(Icons.Default.Download, "下载封面", tint = Color.White)
                }
                IconButton(onClose) { Icon(Icons.Default.Close, "关闭大封面", tint = Color.White) }
            }
            message?.let { Text(it, Modifier.align(Alignment.BottomCenter).padding(20.dp), color = Color.White, style = MaterialTheme.typography.bodyMedium) }
        }
    }
}
