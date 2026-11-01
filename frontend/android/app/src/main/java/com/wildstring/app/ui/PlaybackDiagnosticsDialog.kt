package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
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
    val resources = androidx.compose.ui.platform.LocalResources.current
    fun capture() = runCatching { vm.playbackHealth.diagnostics?.invoke()?.render() ?: resources.getString(R.string.diagnostics_disconnected) }.getOrDefault(resources.getString(R.string.diagnostics_unavailable))
    var snapshot by remember { mutableStateOf(capture()) }
    var copied by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    AlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.settings_diagnostics)) }, text = {
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
            Text(stringResource(R.string.diagnostics_hint), style = MaterialTheme.typography.bodySmall)
            SelectionContainer { Text(snapshot, Modifier.testTag("playback-diagnostics"), style = MaterialTheme.typography.bodySmall) }
        }
    }, confirmButton = { TextButton({ clipboard.setText(AnnotatedString(snapshot)); copied = true }, Modifier.testTag("copy-playback-diagnostics")) { Text(if (copied) stringResource(R.string.copied) else stringResource(R.string.diagnostics_copy)) } },
        dismissButton = { androidx.compose.foundation.layout.Row {
            TextButton({ snapshot = capture(); copied = false }) { Text(stringResource(R.string.refresh)) }
            TextButton(dismiss) { Text(stringResource(R.string.close)) }
        } })
}
