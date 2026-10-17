package com.wildstring.app.update

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Update
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.BuildConfig
import java.io.File
import kotlinx.coroutines.launch

object UpdateInstaller {
    fun launch(context: Context, apk: File): String {
        if (!context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return "请允许此应用安装更新，返回后再次点击“安装更新”。"
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .apply { clipData = ClipData.newRawUri("WildString update", uri); addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION) })
        return "请在系统安装界面确认更新。"
    }
}

@Composable fun UpdateSettings() {
    val context = LocalContext.current
    val updater = remember { AppUpdater.get(context) }
    val state by updater.state.collectAsStateWithLifecycle()
    var details by remember { mutableStateOf(false) }
    var installation by remember { mutableStateOf<String?>(null) }
    var installing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    UpdateSettingsContent(state, check = { updater.check() }, details = { details = true }, cancel = updater::cancelDownload,
        install = { if (!installing) { installing = true; scope.launch { try { installation = UpdateInstaller.launch(context, updater.installationFile()) } catch (error: Exception) { installation = updateMessage(error) } finally { installing = false } } } },
        repository = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(UpdatePolicy.REPOSITORY))) }.onFailure { installation = "无法打开浏览器，请使用其他浏览器访问项目仓库。" } })
    installation?.let { Text(it, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall) }
    if (details && state.release != null) ReleaseDialog(state.release!!, confirm = { details = false; updater.requestDownload() }, dismiss = { details = false })
}

@Composable internal fun UpdateSettingsContent(state: UpdateState, check: () -> Unit, details: () -> Unit, cancel: () -> Unit, install: () -> Unit, repository: () -> Unit) {
    val active = state.phase in setOf(UpdatePhase.Downloading, UpdatePhase.Verifying)
    ListItem(headlineContent = { Text(if (state.phase == UpdatePhase.Checking) "正在检查更新…" else "检查更新") },
        supportingContent = { Text(state.release?.let { "发现 ${it.version} · 当前 ${BuildConfig.VERSION_NAME}" } ?: "当前 ${BuildConfig.VERSION_NAME} · GitHub 最新稳定版") },
        leadingContent = { Icon(Icons.Default.Update, null) }, modifier = Modifier.testTag("app-check-update").clickable(enabled = !active && state.phase != UpdatePhase.Checking, onClick = check))
    state.message?.let { Text(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall) }
    if (active) Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (state.phase == UpdatePhase.Verifying) "正在校验安装包…" else "下载更新：${state.downloaded / 1024} / ${state.total / 1024} KB")
        LinearProgressIndicator(progress = { if (state.total > 0) state.downloaded.toFloat() / state.total else 0f }, modifier = Modifier.fillMaxWidth())
        TextButton(cancel, Modifier.testTag("app-cancel-update")) { Text("取消下载") }
    }
    if (state.release != null && !active && state.phase != UpdatePhase.Checking) {
        TextButton(if (state.phase == UpdatePhase.Ready) install else details, Modifier.padding(horizontal = 8.dp).testTag("app-update-action")) {
            Icon(Icons.Default.CloudDownload, null); Spacer(Modifier.width(8.dp)); Text(if (state.phase == UpdatePhase.Ready) "安装更新" else "查看版本与下载")
        }
    }
    ListItem(headlineContent = { Text("GitHub 仓库") }, supportingContent = { Text("github.com/qingmuhy744/wildstring") }, leadingContent = { Icon(Icons.Default.Code, null) },
        modifier = Modifier.testTag("app-repository").clickable(onClick = repository))
    Text("启动时每天最多自动检查两次，不自动下载。更新与音乐服务器独立；安装仍需系统确认。", Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable fun UpdatePrompt() {
    val context = LocalContext.current; val updater = remember { AppUpdater.get(context) }; val state by updater.state.collectAsStateWithLifecycle()
    if (state.prompt && state.release != null) ReleaseDialog(state.release!!,
        confirm = { updater.dismissPrompt(); updater.requestDownload() }, dismiss = updater::dismissPrompt)
}
@Composable private fun ReleaseDialog(release: AppRelease, confirm: () -> Unit, dismiss: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text("发现新版本 ${release.version}") },
        text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(release.notes)
            Text("安装包约 ${"%.1f".format(release.apk.size / 1048576.0)} MB，下载前请留意流量。完成 SHA-256、包名、签名和版本校验后，由你确认安装。", style = MaterialTheme.typography.bodySmall)
            if (BuildConfig.DEBUG) Text("当前是调试包，不能覆盖正式包。请从项目仓库安装正式版本。", style = MaterialTheme.typography.bodySmall)
        } }, confirmButton = { TextButton(confirm, enabled = !BuildConfig.DEBUG) { Text("确认下载") } }, dismissButton = { TextButton(dismiss) { Text("稍后") } })
}
