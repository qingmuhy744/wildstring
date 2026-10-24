@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.data.ServerConfiguration
import com.wildstring.app.data.friendlyError
import kotlinx.coroutines.launch

@Composable internal fun ServersScreen(vm: MusicViewModel, dismiss: () -> Unit) {
    val servers by vm.repository.session.servers.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<ServerConfiguration?>(null) }
    var adding by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<ServerConfiguration?>(null) }
    Dialog(dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().testTag("server-manager")) {
            Scaffold(topBar = { TopAppBar(title = { Text("服务器") }, navigationIcon = { IconButton(dismiss, Modifier.testTag("servers-back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                actions = { IconButton({ adding = true }, Modifier.testTag("server-add")) { Icon(Icons.Default.Add, "添加服务器") } }) }) { padding ->
                LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
                    item { Text("选择服务器会停止当前播放并暂停下载；各服务器的登录与离线音乐分别保留。", style = MaterialTheme.typography.bodySmall) }
                    if (servers.isEmpty()) item { Text("还没有保存的服务器，点击右上角添加。", Modifier.padding(vertical = 24.dp)) }
                    items(servers, key = { it.id }) { server ->
                        val active = server.id == vm.repository.session.activeServerId
                        ElevatedCard(Modifier.fillMaxWidth().testTag("server-${server.id}")) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(server.label, style = MaterialTheme.typography.titleMedium)
                                if (server.name.isNotBlank()) Text(server.url, style = MaterialTheme.typography.bodySmall)
                                Text((if (active) "当前服务器 · " else "") + (if (vm.repository.session.hasSession(server.id)) "已保存登录${vm.repository.session.accountFor(server.id)?.username?.let { " · $it" }.orEmpty()}" else "待登录") + (if (active && state.serverVersion != null) " · 服务端 v${state.serverVersion}" else ""), style = MaterialTheme.typography.bodySmall)
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Row { IconButton({ editing = server }, Modifier.testTag("server-edit-${server.id}")) { Icon(Icons.Default.Edit, "编辑${server.label}") }
                                        IconButton({ deleting = server }, Modifier.testTag("server-delete-${server.id}")) { Icon(Icons.Default.DeleteOutline, "删除${server.label}") } }
                                    TextButton({ vm.switchServer(server.id); dismiss() }, enabled = !active || !state.connected, modifier = Modifier.testTag("server-select-${server.id}")) { Text(if (active && state.connected) "已连接" else "选择服务器") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (adding || editing != null) ServerEditor(vm, editing, { adding = false; editing = null })
    deleting?.let { server -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除服务器？") }, text = { Text("将从本机删除${server.label}的配置、登录和本地缓存，服务器上的音乐与账号不受影响。") },
        confirmButton = { TextButton({ vm.deleteServer(server.id); deleting = null }) { Text("删除") } }, dismissButton = { TextButton({ deleting = null }) { Text("取消") } }) }
}

@Composable private fun ServerEditor(vm: MusicViewModel, server: ServerConfiguration?, dismiss: () -> Unit) {
    var name by remember(server?.id) { mutableStateOf(server?.name.orEmpty()) }
    var url by remember(server?.id) { mutableStateOf(server?.url.orEmpty()) }
    var local by remember(server?.id) { mutableStateOf(server?.allowLocalHttp ?: false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text(if (server == null) "添加服务器" else "编辑服务器") }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(name, { name = it.take(80) }, Modifier.fillMaxWidth().testTag("server-name"), label = { Text("名称（可选）") }, singleLine = true, enabled = !busy)
            OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth().testTag("server-url"), label = { Text("服务器地址") }, placeholder = { Text("music.your-domain.com") }, singleLine = true, enabled = !busy)
            Row { Checkbox(local, { local = it }, enabled = !busy, modifier = Modifier.testTag("server-local-http")); Text("允许此服务器使用未加密 HTTP") }
            if (server != null) Text("修改地址后需要重新登录，并清除此配置原有的本地缓存。", style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton({ busy = true; error = null; scope.launch {
        try { vm.saveServer(server?.id, url, name, local); dismiss() }
        catch (cancel: kotlinx.coroutines.CancellationException) { throw cancel }
        catch (failure: Exception) { error = friendlyError(failure) }
        finally { busy = false }
    } }, enabled = !busy && url.isNotBlank(), modifier = Modifier.testTag("server-save")) { Text(if (busy) "正在保存…" else "保存") } }, dismissButton = { TextButton(dismiss, enabled = !busy) { Text("取消") } })
}
