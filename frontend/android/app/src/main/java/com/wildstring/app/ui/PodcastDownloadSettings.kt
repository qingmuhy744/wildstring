package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.PodcastDownloadSettings
import com.wildstring.app.data.PodcastSummary
import com.wildstring.app.data.friendlyError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Personal consumption preference; server storage administration stays on the Web. */
@Composable
fun PodcastDownloadSettingsDialog(vm: MusicViewModel, podcast: PodcastSummary, onDismiss: () -> Unit, onSaved: () -> Unit) {
    val owner = vm.repository.session.cacheScope()
    var value by remember(owner, podcast.id) { mutableStateOf<PodcastDownloadSettings?>(null) }
    var error by remember(owner, podcast.id) { mutableStateOf<String?>(null) }
    var busy by remember(owner, podcast.id) { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(owner, podcast.id, reload) {
        value = null; error = null
        try {
            val loaded = vm.repository.podcastDownloadSettings(podcast.id)
            if (owner == vm.repository.session.cacheScope()) value = loaded
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (owner == vm.repository.session.cacheScope()) error = friendlyError(e) }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text("自动下载设置") },
        text = {
            Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState())) {
                Text(podcast.title, style = MaterialTheme.typography.titleSmall)
                Text("仅对当前账号关注的这个节目生效。服务器音频共享，个人保存记录独立。", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(12.dp))
                val current = value
                if (current == null && error == null) CircularProgressIndicator(Modifier.size(24.dp))
                if (current != null) {
                    if (!current.active) Text("已取消关注，自动下载暂停。重新关注后恢复此设置。")
                    listOf("none" to "关闭自动下载", "latest_3" to "最新 3 集", "latest_5" to "最新 5 集",
                        "latest_10" to "最新 10 集", "unplayed" to "所有未听完单集", "all" to "全部历史单集").forEach { (key, label) ->
                        Row(Modifier.fillMaxWidth().clickable(enabled = !busy && current.active) { value = current.copy(downloadPolicy = key) }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(current.downloadPolicy == key, onClick = { value = current.copy(downloadPolicy = key) }, enabled = !busy && current.active)
                            Text(label)
                        }
                    }
                    Text("最新 N 集只保留固定范围的自动引用，已有音频直接复用。", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(12.dp))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(current.retentionPolicy == "delete_after_played", enabled = !busy && current.active,
                            onCheckedChange = { value = current.copy(retentionPolicy = if (it) "delete_after_played" else "keep") })
                        Text("听完后释放我的自动保存")
                    }
                    Text("关闭、取消关注或移出范围会释放自动引用，手动保存继续保留。无人引用的音频按服务器规则清理。", style = MaterialTheme.typography.bodySmall)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { reload++ }, enabled = !busy) { Text("重新读取设置") } }
            }
        },
        confirmButton = { TextButton(enabled = !busy && value?.active == true, onClick = {
            val current = value ?: return@TextButton
            scope.launch {
                busy = true; error = null
                try {
                    vm.repository.updatePodcastDownloadSettings(podcast.id, current, owner)
                    if (owner == vm.repository.session.cacheScope()) { onSaved(); onDismiss() }
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { if (owner == vm.repository.session.cacheScope()) error = friendlyError(e) }
                finally { busy = false }
            }
        }) { Text(if (busy) "保存中…" else "保存设置") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("取消") } })
}
