package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import okhttp3.HttpUrl.Companion.toHttpUrl

@Composable internal fun AccountAvatar(vm: MusicViewModel, modifier: Modifier = Modifier) {
    val profiles by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val owner = remember(profiles) { vm.repository.session.cacheScope() }
    val accountId = remember(profiles) { vm.repository.session.account?.id }
    val revision by vm.settings.avatarRevision.collectAsStateWithLifecycle()
    var version by remember(owner) { mutableStateOf<String?>(null) }
    var failed by remember(owner, version) { mutableStateOf(false) }
    LaunchedEffect(owner, revision) {
        version = null
        if (owner != null) try {
            val value = vm.repository.feature("auth/avatar/info").text("version").takeIf { it.matches(Regex("[a-f0-9]{64}")) }
            if (owner == vm.repository.session.cacheScope()) version = value
        } catch (error: CancellationException) { throw error } catch (_: Exception) { /* Older servers retain the default avatar. */ }
    }
    Surface(modifier.clip(CircleShape), shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer) {
        if (version != null && accountId != null && !failed) AsyncImage(
            model = ImageRequest.Builder(LocalContext.current).data(vm.repository.url("api", "v1", "auth", "avatar").toHttpUrl().newBuilder().addQueryParameter("v", version).addQueryParameter("account", accountId).build()).memoryCacheKey("$owner:avatar:$version").build(),
            imageLoader = vm.imageLoader, contentDescription = stringResource(R.string.user_avatar), contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(), onError = { failed = true })
        else Icon(Icons.Default.Person, null, Modifier.padding(12.dp).fillMaxSize(), tint = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

private data class AvatarDraft(val owner: String, val bytes: ByteArray)

@Composable internal fun AvatarSettings(vm: MusicViewModel) {
    val resources = androidx.compose.ui.platform.LocalResources.current
    val context = LocalContext.current
    val profiles by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val owner = remember(profiles) { vm.repository.session.cacheScope() }
    val action = remember(owner) { FeatureAction() }
    val scope = rememberCoroutineScope()
    var pickerOwner by remember { mutableStateOf<String?>(null) }
    var pending by remember(owner) { mutableStateOf<AvatarDraft?>(null) }
    val chooser = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val captured = pickerOwner
        if (uri != null && captured != null) scope.launch { action.run {
            require(captured == vm.repository.session.cacheScope()) { resources.getString(R.string.avatar_account_changed) }
            val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= 5 * 1024 * 1024) { resources.getString(R.string.avatar_too_large) }; output.write(buffer, 0, n) }
                output.toByteArray()
            } }
            require(captured == vm.repository.session.cacheScope()) { resources.getString(R.string.avatar_account_changed) }
            pending = AvatarDraft(captured, bytes); action.message = resources.getString(R.string.avatar_preview_hint)
        } }
    }
    Column(Modifier.padding(horizontal = 16.dp).testTag("avatar-settings")) {
        ListItem(headlineContent = { Text(stringResource(R.string.avatar_custom)) }, supportingContent = { Text(stringResource(R.string.avatar_format_hint)) }, leadingContent = { AccountAvatar(vm, Modifier.size(48.dp)) })
        Row {
            TextButton({ pickerOwner = owner; chooser.launch(arrayOf("image/jpeg", "image/png", "image/webp")) }, enabled = !action.busy && owner != null) { Text(stringResource(R.string.avatar_choose)) }
            TextButton({ scope.launch { action.run {
                vm.repository.feature("auth/avatar", "DELETE"); vm.settings.avatarChanged(); action.message = resources.getString(R.string.avatar_reset_done)
            } } }, enabled = !action.busy) { Text(stringResource(R.string.avatar_reset)) }
        }
        ActionStatus(action)
    }
    pending?.let { draft -> AlertDialog(onDismissRequest = { if (!action.busy) pending = null }, title = { Text(stringResource(R.string.avatar_preview)) }, text = {
        Column {
            AsyncImage(draft.bytes, stringResource(R.string.avatar_preview), Modifier.size(160.dp).clip(CircleShape), contentScale = ContentScale.Crop)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.repository.saveAvatar(draft.bytes, draft.owner); vm.settings.avatarChanged(); pending = null; action.message = resources.getString(R.string.avatar_saved)
    } } }, enabled = !action.busy) { Text(stringResource(R.string.avatar_upload)) } }, dismissButton = { TextButton({ pending = null }, enabled = !action.busy) { Text(stringResource(R.string.cancel)) } }) }
}
