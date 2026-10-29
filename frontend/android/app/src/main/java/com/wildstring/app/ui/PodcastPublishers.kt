package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import retrofit2.HttpException

@Composable
internal fun PublisherAffiliation(vm: MusicViewModel, podcast: PodcastSummary, canEdit: Boolean,
    onOpen: (PodcastPublisher) -> Unit, onSaved: (PodcastDetail) -> Unit) {
    var editing by remember(podcast.id) { mutableStateOf(false) }
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("出品方：", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val publisher = podcast.publisher
            if (publisher == null) Text("未确认", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            else TextButton({ onOpen(publisher) }, contentPadding = PaddingValues(horizontal = 4.dp)) {
                Text(publisher.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (canEdit) TextButton({ editing = true }, contentPadding = PaddingValues(0.dp)) {
            Text(if (podcast.publisher == null) "确认出品方" else "修改出品方归属")
        }
    }
    if (editing) PublisherAssignmentDialog(vm, podcast, { editing = false }) { detail -> onSaved(detail); editing = false }
}

@Composable
internal fun PodcastPublisherPage(vm: MusicViewModel, publisher: PodcastPublisher,
    onBack: () -> Unit, onSelect: (PodcastSummary) -> Unit, personalOnly: Boolean = true) {
    var detail by remember(publisher.id) { mutableStateOf<PodcastPublisherDetail?>(null) }
    var error by remember(publisher.id) { mutableStateOf<String?>(null) }
    var loading by remember(publisher.id) { mutableStateOf(true) }
    var reload by remember(publisher.id) { mutableIntStateOf(0) }
    LaunchedEffect(publisher.id, reload) {
        loading = true; error = null
        try { detail = vm.repository.podcastPublisher(publisher.id) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = friendlyError(e) }
        finally { loading = false }
    }
    val shows = detail?.podcasts.orEmpty().filter { !personalOnly || it.followed }
    Column(Modifier.fillMaxSize().testTag("podcast-publisher-page")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回节目列表") }
            Text(detail?.publisher?.name ?: publisher.name, style = MaterialTheme.typography.titleLarge,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        Text("${if (personalOnly) "我关注的" else "本服已有"} ${shows.size} 档已确认节目", Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { message ->
            Text(message, Modifier.padding(20.dp), color = MaterialTheme.colorScheme.error)
            TextButton({ reload++ }) { Text("重试") }
        }
        if (!loading && error == null && shows.isEmpty()) Text("该出品方暂无已关联节目", Modifier.padding(20.dp))
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(shows, key = { it.id }) { podcast ->
                Surface(Modifier.fillMaxWidth().clickable { onSelect(podcast) }, shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    ListItem(headlineContent = { Text(podcast.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        supportingContent = { Text("${podcast.totalEpisodes} 集 · ${podcast.unplayedEpisodes} 未听") },
                        leadingContent = { Icon(Icons.Default.Podcasts, null) },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow))
                }
            }
        }
    }
}

@Composable
private fun PublisherAssignmentDialog(vm: MusicViewModel, podcast: PodcastSummary,
    onClose: () -> Unit, onSaved: (PodcastDetail) -> Unit) {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf(podcast) }
    var publishers by remember { mutableStateOf<List<PodcastPublisher>>(emptyList()) }
    var choice by remember { mutableStateOf(podcast.publisher?.id ?: "new") }
    var name by remember { mutableStateOf(podcast.author) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var conflict by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        try { publishers = vm.repository.podcastPublishers() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = friendlyError(e) }
    }
    AlertDialog(onDismissRequest = { if (!busy) onClose() }, title = { Text("出品方归属") },
        text = { Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(podcast.title, style = MaterialTheme.typography.titleSmall)
            Text("来源作者：${podcast.author.ifBlank { "未提供" }}。作者署名仅作参考，确认后才会加入同出品方聚合。", style = MaterialTheme.typography.bodySmall)
            Text("当前归属：${current.publisher?.name ?: "未确认"}", style = MaterialTheme.typography.bodySmall)
            val choices = buildList {
                add("new" to "输入出品方名称")
                current.publisher?.takeIf { candidate -> publishers.none { it.id == candidate.id } }?.let { add(it.id to it.name) }
                publishers.forEach { add(it.id to "${it.name} · ${it.podcastCount} 档节目") }
                add("none" to "解除出品方关联")
            }
            choices.forEach { (id, label) ->
                Row(Modifier.fillMaxWidth().clickable(enabled = !busy) { choice = id }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(choice == id, { choice = id }, enabled = !busy)
                    Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (choice == "new") OutlinedTextField(name, { name = it }, label = { Text("出品方名称") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(), enabled = !busy, isError = name.length > 120)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (conflict) TextButton({ scope.launch {
                busy = true
                try {
                    current = vm.repository.podcastDetail(podcast.id).podcast
                    choice = current.publisher?.id ?: "new"
                    name = current.publisher?.name ?: current.author
                    conflict = false; error = null
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { error = friendlyError(e) }
                finally { busy = false }
            } }, enabled = !busy) { Text("重新读取当前归属") }
        } },
        confirmButton = { TextButton({ scope.launch {
            busy = true; error = null
            try {
                val body = PodcastPublisherAssignment(current.publisherVersion.coerceAtLeast(1),
                    publisherId = choice.takeUnless { it == "new" || it == "none" },
                    name = name.trim().takeIf { choice == "new" })
                onSaved(vm.repository.assignPodcastPublisher(podcast.id, body))
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { conflict = e is HttpException && e.code() == 409; error = friendlyError(e) }
            finally { busy = false }
        } }, enabled = !busy && !conflict && (choice != "new" || name.trim().length in 1..120)) { Text(if (busy) "保存中…" else "确认并保存") } },
        dismissButton = { TextButton(onClose, enabled = !busy) { Text("取消") } })
}
