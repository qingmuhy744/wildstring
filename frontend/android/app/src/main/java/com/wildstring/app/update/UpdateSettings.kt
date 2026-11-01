package com.wildstring.app.update

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
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
import com.wildstring.app.ui.AssistantMarkdown
import java.io.File
import kotlinx.coroutines.launch

object UpdateInstaller {
    fun launch(context: Context, apk: File): String {
        if (!context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return context.getString(R.string.update_permission)
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .apply { clipData = ClipData.newRawUri("WildString update", uri); addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION) })
        return context.getString(R.string.update_system_confirm)
    }
}

@Composable fun UpdateSettings() {
    val resources = androidx.compose.ui.platform.LocalResources.current
    val context = LocalContext.current
    val updater = remember { AppUpdater.get(context) }
    val state by updater.state.collectAsStateWithLifecycle()
    var details by remember { mutableStateOf(false) }
    var installation by remember { mutableStateOf<String?>(null) }
    var installing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    UpdateSettingsContent(state, check = { updater.check() }, details = { details = true }, cancel = updater::cancelDownload,
        install = { if (!installing) { installing = true; scope.launch { try { installation = UpdateInstaller.launch(context, updater.installationFile()) } catch (error: Exception) { installation = updateMessage(error) } finally { installing = false } } } },
        repository = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(UpdatePolicy.REPOSITORY))) }.onFailure { installation = resources.getString(R.string.update_browser_failed) } })
    installation?.let { Text(it, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall) }
    if (details && state.release != null) ReleaseDialog(state.release!!, confirm = { details = false; updater.requestDownload() }, dismiss = { details = false })
}

@Composable internal fun UpdateSettingsContent(state: UpdateState, check: () -> Unit, details: () -> Unit, cancel: () -> Unit, install: () -> Unit, repository: () -> Unit) {
    val active = state.phase in setOf(UpdatePhase.Downloading, UpdatePhase.Verifying)
    ListItem(headlineContent = { Text(if (state.phase == UpdatePhase.Checking) stringResource(R.string.update_checking) else stringResource(R.string.update_check)) },
        supportingContent = { Text(state.release?.let { stringResource(R.string.update_available_version, it.version, BuildConfig.VERSION_NAME) } ?: stringResource(R.string.update_current_version, BuildConfig.VERSION_NAME)) },
        leadingContent = { Icon(Icons.Default.Update, null) }, modifier = Modifier.testTag("app-check-update").clickable(enabled = !active && state.phase != UpdatePhase.Checking, onClick = check))
    state.message?.let { Text(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall) }
    if (active) Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (state.phase == UpdatePhase.Verifying) stringResource(R.string.update_verifying) else stringResource(R.string.update_progress, state.downloaded / 1024, state.total / 1024))
        LinearProgressIndicator(progress = { if (state.total > 0) state.downloaded.toFloat() / state.total else 0f }, modifier = Modifier.fillMaxWidth())
        TextButton(cancel, Modifier.testTag("app-cancel-update")) { Text(stringResource(R.string.update_cancel_download)) }
    }
    if (state.release != null && !active && state.phase != UpdatePhase.Checking) {
        TextButton(if (state.phase == UpdatePhase.Ready) install else details, Modifier.padding(horizontal = 8.dp).testTag("app-update-action")) {
            Icon(Icons.Default.CloudDownload, null); Spacer(Modifier.width(8.dp)); Text(if (state.phase == UpdatePhase.Ready) stringResource(R.string.update_install) else stringResource(R.string.update_view_release))
        }
    }
    ListItem(headlineContent = { Text(stringResource(R.string.update_repository)) }, supportingContent = { Text("github.com/qingmuhy744/wildstring") }, leadingContent = { Icon(Icons.Default.Code, null) },
        modifier = Modifier.testTag("app-repository").clickable(onClick = repository))
    Text(stringResource(R.string.update_auto_hint), Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable fun UpdatePrompt() {
    val context = LocalContext.current; val updater = remember { AppUpdater.get(context) }; val state by updater.state.collectAsStateWithLifecycle()
    if (state.prompt && state.release != null) ReleaseDialog(state.release!!,
        confirm = { updater.dismissPrompt(); updater.requestDownload() }, dismiss = updater::dismissPrompt)
}
@Composable private fun ReleaseDialog(release: AppRelease, confirm: () -> Unit, dismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(R.string.update_release_title, release.version)) },
        text = {
            Column(
                Modifier
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AssistantMarkdown(release.notes)
                Text(
                    stringResource(R.string.update_download_hint, "%.1f".format(release.apk.size / 1048576.0)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (BuildConfig.DEBUG) {
                    Text(
                        stringResource(R.string.update_debug_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = { TextButton(confirm, enabled = !BuildConfig.DEBUG) { Text(stringResource(R.string.update_confirm_download)) } },
        dismissButton = { TextButton(dismiss) { Text(stringResource(R.string.later)) } },
    )
}
