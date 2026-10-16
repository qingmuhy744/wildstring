package com.wildstring.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.LastfmPreferences
import com.wildstring.app.data.LastfmStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable internal fun LastfmSettings(vm: MusicViewModel) {
    var status by remember { mutableStateOf<LastfmStatus?>(null) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    fun refresh() { scope.launch {
        busy = true
        try { status = vm.repository.api().lastfm(); message = null }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { message = "暂时无法读取 Last.fm，请检查服务器版本与连接。" }
        finally { busy = false }
    } }
    LaunchedEffect(Unit) { refresh() }
    fun update(scrobble: Boolean, playing: Boolean) {
        val before = status ?: return
        if (busy) return
        status = before.copy(scrobble = scrobble, nowPlaying = playing)
        busy = true
        scope.launch {
            try { status = vm.repository.api().updateLastfm(LastfmPreferences(before.version, scrobble, playing)); message = null }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { status = before; message = "同步设置未保存，已恢复。请刷新后重试。" }
            finally { busy = false }
        }
    }
    Column(Modifier.padding(16.dp)) {
        val current = status
        Text(if (current?.connected == true) "已连接：${current.username}" else "连接后可同步正在播放与已听记录。")
        if (current?.connected == true) {
            ListItem(headlineContent = { Text("同步已听记录") }, trailingContent = { Switch(current.scrobble, { update(it, current.nowPlaying) }, enabled = !busy) })
            ListItem(headlineContent = { Text("同步正在播放") }, trailingContent = { Switch(current.nowPlaying, { update(current.scrobble, it) }, enabled = !busy) })
            TextButton(enabled = !busy, onClick = { busy = true; scope.launch {
                try { vm.repository.api().disconnectLastfm().close(); status = vm.repository.api().lastfm() }
                catch (e: CancellationException) { throw e }
                catch (_: Exception) { message = "断开失败，请重试。" }
                finally { busy = false }
            } }) { Text("断开 Last.fm") }
        }
        if (current?.connected != true || current.needsAuth) TextButton(enabled = !busy, onClick = { busy = true; scope.launch {
            try {
                val target = Uri.parse(vm.repository.api().authorizeLastfm().url)
                require(target.scheme == "https" && target.host == "www.last.fm")
                context.startActivity(Intent(Intent.ACTION_VIEW, target))
                message = "授权完成后返回，点击刷新连接，再选择同步开关。"
            }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { message = "请由管理员配置 Last.fm 密钥和公开访问地址后再试。" }
            finally { busy = false }
        } }) { Text(if (current?.needsAuth == true) "重新授权" else "连接 Last.fm") }
        TextButton(enabled = !busy, onClick = ::refresh) { Text(if (busy) "正在连接…" else "刷新连接") }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}
