package com.wildstring.app.ui

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

@Composable internal fun AccountAvatar(vm: MusicViewModel, modifier: Modifier = Modifier) {
    val profiles by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val owner = remember(profiles) { vm.repository.session.cacheScope() }
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
        if (version != null && !failed) AsyncImage(
            model = ImageRequest.Builder(LocalContext.current).data(vm.repository.url("api", "v1", "auth", "avatar") + "?v=$version").memoryCacheKey("$owner:avatar:$version").build(),
            imageLoader = vm.imageLoader, contentDescription = "用户头像", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(), onError = { failed = true })
        else Icon(Icons.Default.Person, null, Modifier.padding(12.dp).fillMaxSize(), tint = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

private data class AvatarDraft(val owner: String, val bytes: ByteArray)

@Composable internal fun AvatarSettings(vm: MusicViewModel) {
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
            require(captured == vm.repository.session.cacheScope()) { "账号已变化，请重新选择头像。" }
            val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= 5 * 1024 * 1024) { "头像图片超过 5 MiB，请压缩后重试。" }; output.write(buffer, 0, n) }
                output.toByteArray()
            } }
            require(captured == vm.repository.session.cacheScope()) { "账号已变化，请重新选择头像。" }
            pending = AvatarDraft(captured, bytes); action.message = "请预览后上传头像。"
        } }
    }
    Column(Modifier.padding(horizontal = 16.dp).testTag("avatar-settings")) {
        ListItem(headlineContent = { Text("自定义头像") }, supportingContent = { Text("JPG / PNG / WebP，最多 5 MiB；居中裁成方形并移除附带信息。") }, leadingContent = { AccountAvatar(vm, Modifier.size(48.dp)) })
        Row {
            TextButton({ pickerOwner = owner; chooser.launch(arrayOf("image/jpeg", "image/png", "image/webp")) }, enabled = !action.busy && owner != null) { Text("选择头像") }
            TextButton({ scope.launch { action.run {
                vm.repository.feature("auth/avatar", "DELETE"); vm.settings.avatarChanged(); action.message = "已恢复默认头像。"
            } } }, enabled = !action.busy) { Text("恢复默认头像") }
        }
        ActionStatus(action)
    }
    pending?.let { draft -> AlertDialog(onDismissRequest = { if (!action.busy) pending = null }, title = { Text("头像预览") }, text = {
        Column {
            AsyncImage(draft.bytes, "头像预览", Modifier.size(160.dp).clip(CircleShape), contentScale = ContentScale.Crop)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.repository.saveAvatar(draft.bytes, draft.owner); vm.settings.avatarChanged(); pending = null; action.message = "头像已保存。"
    } } }, enabled = !action.busy) { Text("上传头像") } }, dismissButton = { TextButton({ pending = null }, enabled = !action.busy) { Text("取消") } }) }
}
