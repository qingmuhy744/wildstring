package com.wildstring.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp

@Suppress("DEPRECATION")
@Composable internal fun PlaybackDiagnosticsDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    fun capture() = runCatching { vm.playbackHealth.diagnostics?.invoke()?.render() ?: "播放器尚未连接。" }.getOrDefault("暂时无法读取，请稍后刷新。")
    var snapshot by remember { mutableStateOf(capture()) }
    var copied by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    AlertDialog(onDismissRequest = dismiss, title = { Text("播放诊断") }, text = {
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
            Text("用于核对系统通知与播放器的进度状态，不含歌名、账号或访问地址。", style = MaterialTheme.typography.bodySmall)
            SelectionContainer { Text(snapshot, Modifier.testTag("playback-diagnostics"), style = MaterialTheme.typography.bodySmall) }
        }
    }, confirmButton = { TextButton({ clipboard.setText(AnnotatedString(snapshot)); copied = true }, Modifier.testTag("copy-playback-diagnostics")) { Text(if (copied) "已复制" else "复制诊断") } },
        dismissButton = { androidx.compose.foundation.layout.Row {
            TextButton({ snapshot = capture(); copied = false }) { Text("刷新") }
            TextButton(dismiss) { Text("关闭") }
        } })
}
