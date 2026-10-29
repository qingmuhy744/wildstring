package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun PodcastProgressDialog(vm: MusicViewModel) {
    val prompt by vm.podcastProgress.prompt.collectAsStateWithLifecycle()
    val message by vm.podcastProgress.message.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    var dismissed by remember { mutableStateOf<String?>(null) }
    fun time(ms: Long): String {
        val seconds = ms / 1000
        return if (seconds >= 3600) "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
            else "%d:%02d".format(seconds / 60, seconds % 60)
    }
    prompt?.let { value ->
        AlertDialog(onDismissRequest = { vm.podcastProgress.answer(null) },
            title = { Text(if (value.conflict) "选择本集接续位置" else "继续收听这集？") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(value.title)
                Text(if (value.conflict) "另一台设备已更新进度，本机位置也已保留。选择后将以这次收听为准。" else "这集上次听到 ${time(value.remoteMs)}，可以继续收听或从头开始。")
                if (value.conflict) Text("服务器：${time(value.remoteMs)}\n本机：${time(value.localMs)}")
            } },
            confirmButton = { TextButton({ vm.podcastProgress.answer(true) }) { Text("继续 ${time(value.remoteMs)}") } },
            dismissButton = { Column {
                TextButton({ vm.podcastProgress.answer(false) }) { Text(if (value.conflict) "继续本机 ${time(value.localMs)}" else "从头播放") }
                TextButton({ vm.podcastProgress.answer(null) }) { Text("取消") }
            } })
    }
    if (prompt == null && message != null && message != dismissed && state.current?.podcastEpisodeId != null) {
        AlertDialog(onDismissRequest = { dismissed = message }, title = { Text("播客进度") },
            text = { Text(message.orEmpty()) }, confirmButton = { TextButton({ dismissed = message }) { Text("知道了") } })
    }
}
