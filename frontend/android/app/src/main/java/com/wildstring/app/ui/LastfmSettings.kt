package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
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
    val resources = androidx.compose.ui.platform.LocalResources.current
    var status by remember { mutableStateOf<LastfmStatus?>(null) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    fun refresh() { scope.launch {
        busy = true
        try { status = vm.repository.api().lastfm(); message = null }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { message = resources.getString(R.string.lastfm_load_failed) }
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
            catch (_: Exception) { status = before; message = resources.getString(R.string.lastfm_save_failed) }
            finally { busy = false }
        }
    }
    Column(Modifier.padding(16.dp)) {
        val current = status
        Text(if (current?.connected == true) stringResource(R.string.lastfm_connected, current.username.orEmpty()) else stringResource(R.string.lastfm_hint))
        if (current?.connected == true) {
            ListItem(headlineContent = { Text(stringResource(R.string.lastfm_scrobble)) }, trailingContent = { Switch(current.scrobble, { update(it, current.nowPlaying) }, enabled = !busy) })
            ListItem(headlineContent = { Text(stringResource(R.string.lastfm_now_playing)) }, trailingContent = { Switch(current.nowPlaying, { update(current.scrobble, it) }, enabled = !busy) })
            TextButton(enabled = !busy, onClick = { busy = true; scope.launch {
                try { vm.repository.api().disconnectLastfm().let { if (!it.isSuccessful) throw retrofit2.HttpException(it) }; status = vm.repository.api().lastfm() }
                catch (e: CancellationException) { throw e }
                catch (_: Exception) { message = resources.getString(R.string.lastfm_disconnect_failed) }
                finally { busy = false }
            } }) { Text(stringResource(R.string.lastfm_disconnect)) }
        }
        if (current?.connected != true || current.needsAuth) TextButton(enabled = !busy, onClick = { busy = true; scope.launch {
            try {
                val target = Uri.parse(vm.repository.api().authorizeLastfm().url)
                require(target.scheme == "https" && target.host == "www.last.fm")
                context.startActivity(Intent(Intent.ACTION_VIEW, target))
                message = resources.getString(R.string.lastfm_authorized_hint)
            }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { message = resources.getString(R.string.lastfm_configure_hint) }
            finally { busy = false }
        } }) { Text(if (current?.needsAuth == true) stringResource(R.string.lastfm_authorize_again) else stringResource(R.string.lastfm_connect)) }
        TextButton(enabled = !busy, onClick = ::refresh) { Text(if (busy) stringResource(R.string.connecting) else stringResource(R.string.lastfm_refresh)) }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}
