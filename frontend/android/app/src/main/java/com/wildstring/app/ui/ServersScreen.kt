@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
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
    var showRoutes by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<ServerConfiguration?>(null) }
    Dialog(dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = androidx.compose.ui.platform.LocalView.current
        val darkBars = LocalDarkAppearance.current
        LaunchedEffect(view, darkBars) {
            (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window?.let { window ->
                androidx.core.view.WindowCompat.enableEdgeToEdge(window)
                if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
                androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !darkBars
                    isAppearanceLightNavigationBars = !darkBars
                }
            }
        }
        Surface(Modifier.fillMaxSize().testTag("server-manager")) {
            Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.servers)) }, navigationIcon = { IconButton(dismiss, Modifier.testTag("servers-back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                actions = { IconButton({ adding = true }, Modifier.testTag("server-add")) { Icon(Icons.Default.Add, stringResource(R.string.server_add)) } }) }) { padding ->
                LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
                    item { Text(stringResource(R.string.server_switch_hint), style = MaterialTheme.typography.bodySmall) }
                    if (servers.isEmpty()) item { Text(stringResource(R.string.servers_empty), Modifier.padding(vertical = 24.dp)) }
                    items(servers, key = { it.id }) { server ->
                        val active = server.id == vm.repository.session.activeServerId
                        ElevatedCard(Modifier.fillMaxWidth().testTag("server-${server.id}")) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(server.label, style = MaterialTheme.typography.titleMedium)
                                if (server.name.isNotBlank()) Text(server.url, style = MaterialTheme.typography.bodySmall)
                                Text((if (active) stringResource(R.string.server_current_prefix) else "") + (if (vm.repository.session.hasSession(server.id)) stringResource(R.string.server_saved_signin) + vm.repository.session.accountFor(server.id)?.username?.let { " · $it" }.orEmpty() else stringResource(R.string.server_not_signed_in)) + (if (active && state.serverVersion != null) stringResource(R.string.about_server_version, state.serverVersion.orEmpty()) else ""), style = MaterialTheme.typography.bodySmall)
                                if (active && state.connected) TextButton({ showRoutes = true }) { Text(stringResource(R.string.srv_scr_routes_and_failover)) }
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Row { IconButton({ editing = server }, Modifier.testTag("server-edit-${server.id}")) { Icon(Icons.Default.Edit, stringResource(R.string.edit_named, server.label)) }
                                        IconButton({ deleting = server }, Modifier.testTag("server-delete-${server.id}")) { Icon(Icons.Default.DeleteOutline, stringResource(R.string.delete_named, server.label)) } }
                                    TextButton({ vm.switchServer(server.id); dismiss() }, enabled = !active || !state.connected, modifier = Modifier.testTag("server-select-${server.id}")) { Text(if (active && state.connected) stringResource(R.string.settings_connected) else stringResource(R.string.server_select)) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (showRoutes) ServerRoutesDialog(vm) { showRoutes = false }
    if (adding || editing != null) ServerEditor(vm, editing, { adding = false; editing = null })
    deleting?.let { server -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text(stringResource(R.string.server_delete_title)) }, text = { Text(stringResource(R.string.server_delete_message, server.label)) },
        confirmButton = { TextButton({ vm.deleteServer(server.id); deleting = null }) { Text(stringResource(R.string.delete)) } }, dismissButton = { TextButton({ deleting = null }) { Text(stringResource(R.string.cancel)) } }) }
}

@Composable private fun ServerEditor(vm: MusicViewModel, server: ServerConfiguration?, dismiss: () -> Unit) {
    var name by remember(server?.id) { mutableStateOf(server?.name.orEmpty()) }
    var url by remember(server?.id) { mutableStateOf(server?.url.orEmpty()) }
    var local by remember(server?.id) { mutableStateOf(server?.allowLocalHttp ?: false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text(if (server == null) stringResource(R.string.server_add) else stringResource(R.string.server_edit)) }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(name, { name = it.take(80) }, Modifier.fillMaxWidth().testTag("server-name"), label = { Text(stringResource(R.string.server_name_optional)) }, singleLine = true, enabled = !busy)
            OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth().testTag("server-url"), label = { Text(stringResource(R.string.server_address)) }, placeholder = { Text("music.your-domain.com") }, singleLine = true, enabled = !busy)
            Row { Checkbox(local, { local = it }, enabled = !busy, modifier = Modifier.testTag("server-local-http")); Text(stringResource(R.string.server_allow_http)) }
            if (server != null) Text(stringResource(R.string.server_address_change_hint), style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton({ busy = true; error = null; scope.launch {
        try { vm.saveServer(server?.id, url, name, local); dismiss() }
        catch (cancel: kotlinx.coroutines.CancellationException) { throw cancel }
        catch (failure: Exception) { error = friendlyError(failure) }
        finally { busy = false }
    } }, enabled = !busy && url.isNotBlank(), modifier = Modifier.testTag("server-save")) { Text(if (busy) stringResource(R.string.saving) else stringResource(R.string.save)) } }, dismissButton = { TextButton(dismiss, enabled = !busy) { Text(stringResource(R.string.cancel)) } })
}

@Composable private fun ServerRoutesDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    val session = vm.repository.session
    val manager = vm.repository.connectionRoutes
    val routes by session.routes.collectAsStateWithLifecycle()
    val message by manager.message.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var username by remember { mutableStateOf(session.account?.username.orEmpty()) }
    var password by remember { mutableStateOf("") }
    var http by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf(session.manualRoute) }
    Dialog(dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = androidx.compose.ui.platform.LocalView.current
        val darkBars = LocalDarkAppearance.current
        LaunchedEffect(view, darkBars) {
            (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window?.let { window ->
                androidx.core.view.WindowCompat.enableEdgeToEdge(window)
                if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
                androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !darkBars
                    isAppearanceLightNavigationBars = !darkBars
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.srv_scr_server_routes_title)) }, navigationIcon = { IconButton(dismiss) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.srv_scr_back)) } }) }) { padding ->
                Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.srv_scr_routes_hint), style = MaterialTheme.typography.bodySmall)
                    Row { RadioButton(selected == null, { scope.launch { manager.select(null); selected = session.manualRoute } }, enabled = !busy); Text(stringResource(R.string.srv_scr_fallback_label)) }
                    Text(stringResource(R.string.srv_scr_fallback_hint), style = MaterialTheme.typography.bodySmall)
                    routes.forEachIndexed { index, route ->
                        ElevatedCard(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp)) {
                                Row { RadioButton(selected == route.url, { scope.launch { manager.select(route.url); selected = session.manualRoute } }, enabled = !busy); Text(stringResource(R.string.srv_scr_manual_prefix, route.name) + if (session.activeRouteUrl == route.url) stringResource(R.string.srv_scr_current_suffix) else "") }
                                Text(route.url, style = MaterialTheme.typography.bodySmall)
                                Row {
                                    TextButton({ session.editRoutes(routes.toMutableList().apply { add(index - 1, removeAt(index)) }) }, enabled = index > 0 && !busy) { Text(stringResource(R.string.srv_scr_move_up)) }
                                    TextButton({ session.editRoutes(routes.toMutableList().apply { add(index + 1, removeAt(index)) }) }, enabled = index < routes.lastIndex && !busy) { Text(stringResource(R.string.srv_scr_move_down)) }
                                    TextButton({ name = route.name; url = route.url; http = route.allowHttp }) { Text(stringResource(R.string.srv_scr_rename_relogin)) }
                                    TextButton({ session.editRoutes(routes.filterNot { it.url == route.url }) }, enabled = session.activeRouteUrl != route.url && !busy) { Text(stringResource(R.string.srv_scr_delete)) }
                                }
                            }
                        }
                    }
                    HorizontalDivider()
                    Text(stringResource(R.string.srv_scr_add_or_update_route), style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(name, { name = it.take(80) }, label = { Text(stringResource(R.string.srv_scr_route_name_label)) }, modifier = Modifier.fillMaxWidth(), enabled = !busy)
                    OutlinedTextField(url, { url = it; http = false }, label = { Text(stringResource(R.string.srv_scr_server_url_label)) }, modifier = Modifier.fillMaxWidth(), enabled = !busy)
                    Row { Checkbox(http, { http = it }, enabled = !busy); Text(stringResource(R.string.srv_scr_allow_http_label)) }
                    OutlinedTextField(username, { username = it }, label = { Text(stringResource(R.string.srv_scr_account_label)) }, modifier = Modifier.fillMaxWidth(), enabled = !busy)
                    OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.srv_scr_password_label)) }, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), enabled = !busy)
                    Button({ busy = true; error = null; scope.launch {
                        try { manager.add(name, url, http, username, password); name = ""; url = "" }
                        catch (cancel: kotlinx.coroutines.CancellationException) { throw cancel }
                        catch (failure: Exception) { error = failure.message ?: AppLanguage.string(R.string.srv_scr_save_failed) }
                        finally { busy = false; password = "" }
                    } }, enabled = !busy && name.isNotBlank() && url.isNotBlank() && password.isNotBlank()) { Text(if (busy) stringResource(R.string.srv_scr_verifying) else stringResource(R.string.srv_scr_verify_and_save)) }
                    (error ?: message)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}
