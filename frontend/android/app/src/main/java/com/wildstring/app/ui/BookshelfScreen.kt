package com.wildstring.app.ui

import android.content.ComponentName
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.disk.DiskCache
import coil.request.ImageRequest
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import com.wildstring.app.data.*
import com.wildstring.app.playback.BookPlaybackService
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import retrofit2.HttpException

@Composable
internal fun RadioPage(vm: MusicViewModel, reselections: Flow<String>) {
    val state by vm.state.collectAsStateWithLifecycle()
    val owner = vm.repository.session.cacheScope()
    var books by rememberSaveable(owner) { mutableStateOf(false) }
    LaunchedEffect(state.podcastId) { if (state.podcastId != null) books = false }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(!books, { books = false }, { Text(stringResource(R.string.books_podcasts)) })
            FilterChip(books, { books = true }, { Text(stringResource(R.string.books_title)) })
        }
        if (books) BookshelfScreen(vm)
        else PodcastChannelPage(vm, reselections, Modifier.weight(1f))
    }
}

@Composable
private fun BookshelfScreen(vm: MusicViewModel) {
    val repository = vm.repository
    val owner = repository.session.storageScope()
    val gson = remember { Gson() }
    val context = LocalContext.current
    val coverLoader = remember(repository, owner) {
        ImageLoader.Builder(context).okHttpClient(repository.client).diskCache {
            DiskCache.Builder().directory(File(context.filesDir, "book_cache/images"))
                .maxSizeBytes(32L * 1024 * 1024).build()
        }.build()
    }
    DisposableEffect(coverLoader) { onDispose { coverLoader.shutdown() } }

    var books by remember(owner) { mutableStateOf<List<BookSummary>?>(null) }
    var selectedId by rememberSaveable(owner) { mutableStateOf<String?>(null) }
    var reading by rememberSaveable(owner) { mutableStateOf(false) }
    var listening by rememberSaveable(owner) { mutableStateOf(false) }
    var error by remember(owner) { mutableStateOf(false) }
    var uploadError by remember(owner) { mutableStateOf<String?>(null) }
    var filter by rememberSaveable(owner) { mutableStateOf("") }
    var reload by remember(owner) { mutableIntStateOf(0) }
    var uploading by remember(owner) { mutableStateOf(false) }
    var uploadLibrary by remember(owner) { mutableStateOf<BookLibrary?>(null) }
    var uploadLibraries by remember(owner) { mutableStateOf<List<BookLibrary>?>(null) }
    val selected = remember(books, selectedId) { selectedId?.let { id -> books?.find { it.id == id } } }

    val scope = rememberCoroutineScope()
    val canUpload = repository.session.account?.profile in setOf("owner", "librarian")
    val selectEbook = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val library = uploadLibrary
        if (uri != null && library != null) scope.launch {
            uploading = true
            uploadError = null
            try {
                val resolver = context.contentResolver
                val name = withContext(Dispatchers.IO) {
                    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                        if (it.moveToFirst()) it.getString(0) else null
                    }
                } ?: throw IOException("Missing ebook name")
                val type = when (name.substringAfterLast('.').lowercase()) {
                    "epub" -> "application/epub+zip"
                    "txt" -> "text/plain"
                    else -> throw IllegalArgumentException("Unsupported ebook name")
                }.toMediaType()
                val body = object : RequestBody() {
                    override fun contentType() = type
                    override fun writeTo(sink: BufferedSink) {
                        val stream = resolver.openInputStream(uri) ?: throw IOException("Cannot open ebook")
                        stream.source().use { source -> sink.writeAll(source) }
                    }
                }
                repository.api().uploadEbook(
                    library.id.toRequestBody("text/plain".toMediaType()),
                    MultipartBody.Part.createFormData("file", name, body),
                    RequestOwner(repository.session.cacheScope()),
                )
                reload++
            } catch (cause: CancellationException) {
                throw cause
            } catch (cause: HttpException) {
                uploadError = if (cause.code() in setOf(413, 422)) AppLanguage.string(R.string.books_upload_failed) else friendlyError(cause)
            } catch (cause: Exception) {
                uploadError = friendlyError(cause)
            } finally {
                uploading = false
                uploadLibrary = null
            }
        }
    }

    var activeAudioBook by remember(owner) { mutableStateOf<Pair<String, String>?>(null) }
    DisposableEffect(context, owner) {
        val token = SessionToken(context, ComponentName(context, BookPlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        val pollJob = scope.launch {
            while (isActive) {
                if (future.isDone && !future.isCancelled) {
                    val ctrl = runCatching { future.get() }.getOrNull()
                    val item = ctrl?.currentMediaItem
                    val bId = item?.mediaMetadata?.extras?.getString("bookId")
                    val bTitle = item?.mediaMetadata?.albumTitle?.toString()
                    activeAudioBook = if (bId != null && (ctrl.isPlaying || ctrl.playWhenReady)) bId to (bTitle ?: bId) else null
                }
                delay(700)
            }
        }
        onDispose {
            pollJob.cancel()
            MediaController.releaseFuture(future)
        }
    }

    LaunchedEffect(owner, reload) {
        error = false
        try {
            val all = mutableListOf<BookSummary>()
            var offset = 0
            while (true) {
                val page = repository.api().books(limit = 100, offset = offset).items
                all += page
                if (page.size < 100) break
                offset += page.size
            }
            books = all
            if (owner != null) repository.database.books().replaceBooks(owner,
                all.map { BookEntity(owner, it.id, gson.toJson(it)) })
        } catch (cause: IOException) {
            val cached = owner?.let { key ->
                repository.database.books().books(key).map { gson.fromJson(it.payload, BookSummary::class.java) }
            }.orEmpty()
            if (cached.isNotEmpty()) books = cached
            error = true
        } catch (cause: HttpException) {
            books = null
            error = true
        }
    }
    BackHandler(selected != null) {
        if (reading || listening) { reading = false; listening = false }
        else selectedId = null
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val book = selected
        if (book != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { selectedId = null; reading = false; listening = false }) { Text(stringResource(R.string.books_back)) }
                if (book.hasEbook) FilterChip(reading, { reading = !reading }, { Text(stringResource(R.string.books_read)) })
                if (book.hasAudiobook) FilterChip(listening, { listening = !listening }, { Text(stringResource(R.string.books_listen)) })
            }
            Text(book.title, style = MaterialTheme.typography.headlineSmall)
            if (listening) BookListening(vm, book)
            if (reading) BookReading(vm, book, coverLoader)
        } else {
            activeAudioBook?.let { (playingBookId, playingTitle) ->
                Surface(
                    shape = MaterialTheme.shapes.medium,
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    onClick = {
                        selectedId = playingBookId
                        listening = true
                        reading = false
                    },
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            stringResource(R.string.books_now_listening, playingTitle),
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.labelLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(stringResource(R.string.books_listen), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
            Box(Modifier.fillMaxWidth()) {
                Column(Modifier.widthIn(max = 1180.dp).fillMaxWidth().align(Alignment.TopCenter), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(filter, { filter = it }, singleLine = true,
                        label = { Text(stringResource(R.string.books_find)) }, modifier = Modifier.fillMaxWidth())
                    if (canUpload) {
                        TextButton(enabled = !uploading, onClick = {
                            scope.launch {
                                try { uploadLibraries = repository.api().bookLibraries().items }
                                catch (cause: CancellationException) { throw cause }
                                catch (cause: Exception) { uploadError = friendlyError(cause) }
                            }
                        }) { Text(stringResource(R.string.books_upload)) }
                    }
                    uploadError?.let { msg ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(msg, Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { uploadError = null }) { Text(stringResource(R.string.books_close)) }
                        }
                    }
                    uploadLibraries?.let { libraries ->
                        AlertDialog(
                            onDismissRequest = { uploadLibraries = null },
                            title = { Text(stringResource(R.string.books_pick_library)) },
                            text = { LazyColumn {
                                if (libraries.isEmpty()) item { Text(stringResource(R.string.books_empty)) }
                                items(libraries) { library ->
                                    TextButton(onClick = {
                                        uploadLibrary = library
                                        uploadLibraries = null
                                        selectEbook.launch(arrayOf("application/epub+zip", "text/plain"))
                                    }) { Text(library.name) }
                                }
                            } },
                            confirmButton = { TextButton(onClick = { uploadLibraries = null }) { Text(stringResource(R.string.books_close)) } },
                        )
                    }
                    if (error) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.books_error), Modifier.weight(1f))
                            TextButton(onClick = { reload++ }) { Text(stringResource(R.string.books_retry)) }
                        }
                    }
                    val visible = books?.filter {
                        it.title.contains(filter, ignoreCase = true) ||
                            it.authors.any { a -> a.contains(filter, ignoreCase = true) }
                    }
                    if (visible == null && !error) {
                        LazyVerticalGrid(columns = GridCells.Adaptive(156.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(8) {
                                Surface(Modifier.fillMaxWidth().height(92.dp), shape = MaterialTheme.shapes.medium,
                                    color = MaterialTheme.colorScheme.surfaceVariant) {}
                            }
                        }
                    } else if (visible?.isEmpty() == true && !error) {
                        Text(stringResource(R.string.books_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else if (visible != null) {
                        val coverBase = repository.url("api", "v1", "books")
                        LazyVerticalGrid(columns = GridCells.Adaptive(164.dp), modifier = Modifier.fillMaxSize(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            items(visible, key = { it.id }) { item ->
                                Card(onClick = { selectedId = item.id }, modifier = Modifier.fillMaxWidth()) {
                                    Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                        if (item.hasCover) {
                                            AsyncImage(
                                                model = ImageRequest.Builder(context)
                                                    .data("$coverBase/${item.id}/cover")
                                                    .diskCacheKey("${owner.orEmpty()}:${item.id}:cover")
                                                    .memoryCacheKey("${owner.orEmpty()}:${item.id}:cover")
                                                    .build(),
                                                imageLoader = coverLoader,
                                                contentDescription = null,
                                                contentScale = ContentScale.Crop,
                                                modifier = Modifier.size(width = 44.dp, height = 62.dp).clip(MaterialTheme.shapes.small),
                                            )
                                        }
                                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                            Text(item.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                            if (item.authors.isNotEmpty()) {
                                                Text(item.authors.joinToString(", "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            }
                                            item.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                                            val formats = listOfNotNull(
                                                stringResource(R.string.books_ebook).takeIf { item.hasEbook },
                                                stringResource(R.string.books_audiobook).takeIf { item.hasAudiobook },
                                            )
                                            Text(formats.joinToString(" · "), style = MaterialTheme.typography.labelMedium)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private enum class PanelMode { CONTENTS, MARKS, ANNOTATIONS, SEARCH }

@Composable
private fun BookReading(vm: MusicViewModel, book: BookSummary, images: ImageLoader) {
    val repository = vm.repository
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val animateReaderUi = preferences.interfaceAnimations && playbackMotionAllowed()
    val appDark = LocalDarkAppearance.current
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val owner = repository.session.storageScope()
    val gson = remember { Gson() }
    val sync = remember(book.id, owner) {
        BookSync(repository, book.id, "reading", initialIntent = if (book.progressStatus == "finished") "restart" else "resume")
    }
    val scope = rememberCoroutineScope()
    var manifest by remember(book.id) { mutableStateOf<BookManifest?>(null) }
    var spine by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var blocks by remember(book.id) { mutableStateOf<List<BookBlock>?>(null) }
    var paged by rememberSaveable(book.id) { mutableStateOf(false) }
    var dark by rememberSaveable(book.id) { mutableStateOf(appDark) }
    var size by rememberSaveable(book.id) { mutableFloatStateOf(18f) }
    var anchor by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var charOffset by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var error by remember(book.id) { mutableStateOf(false) }
    var syncConflict by remember(book.id) { mutableStateOf(false) }
    var reloadReader by remember(book.id) { mutableIntStateOf(0) }
    var showTools by remember(book.id) { mutableStateOf(false) }
    var showPanel by remember(book.id) { mutableStateOf(false) }
    var panelMode by remember(book.id) { mutableStateOf(PanelMode.CONTENTS) }
    var marks by remember(book.id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var annotations by remember(book.id, owner) { mutableStateOf<List<BookAnnotation>>(emptyList()) }
    var searchQuery by remember(book.id) { mutableStateOf("") }
    var searchMatches by remember(book.id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selection by remember(book.id, spine) { mutableStateOf<BookSelection?>(null) }
    var annotation by remember(book.id) { mutableStateOf<BookSelection?>(null) }
    var jump by remember(book.id) { mutableIntStateOf(0) }
    val palette = if (dark) Color(0xFF181614) else Color(0xFFF6F3ED)
    val ink = if (dark) Color(0xFFE8E3D9) else Color(0xFF2A2B25)

    LaunchedEffect(book.id, owner, reloadReader) {
        error = false
        syncConflict = false
        try {
            val data = try {
                repository.api().bookManifest(book.id).also { next ->
                    if (owner != null) repository.database.books().saveChapters(next.chapters.map {
                        BookEbookChapterMetaEntity(owner, book.id, it.index, it.title, next.sha256)
                    })
                }
            } catch (cause: IOException) {
                val cache = owner?.let { repository.database.books().chapters(it, book.id) }.orEmpty()
                if (cache.isEmpty()) throw cause
                BookManifest(cache.map { BookChapter(it.spineIndex, it.title) }, cache.first().cacheKey)
            }
            val progress = sync.load()
            if (progress.version > 0) {
                spine = progress.spine
                anchor = progress.block
                charOffset = progress.offset
                paged = progress.mode == "paginated"
            }
            manifest = data
        } catch (cause: CancellationException) {
            throw cause
        } catch (_: Exception) {
            error = true
        }
    }

    LaunchedEffect(book.id, owner, reloadReader) {
        annotations = try {
            val items = repository.api().bookAnnotations(book.id).items
            if (owner != null) {
                repository.database.books().replaceAnnotations(
                    owner,
                    book.id,
                    items.map { BookAnnotationSyncEntity(owner, book.id, it.id, gson.toJson(it)) },
                )
            }
            items
        } catch (_: IOException) {
            owner?.let { repository.database.books().annotations(it, book.id) }.orEmpty().map {
                gson.fromJson(it.payload, BookAnnotation::class.java)
            }
        } catch (_: HttpException) {
            emptyList()
        }
    }

    LaunchedEffect(manifest, spine, reloadReader) {
        val data = manifest ?: return@LaunchedEffect
        blocks = null
        val cacheKey = MessageDigest.getInstance("SHA-256")
            .digest("${owner.orEmpty()}/${book.id}/${data.sha256}/$spine".toByteArray())
            .joinToString("") { "%02x".format(it) }
        val file = File(File(context.filesDir, "book_cache"), cacheKey)
        try {
            val content = try {
                repository.api().bookChapter(book.id, spine).also { next ->
                    withContext(Dispatchers.IO) {
                        file.parentFile?.mkdirs()
                        file.writeText(gson.toJson(next))
                        file.parentFile?.listFiles()?.filter(File::isFile)?.sortedByDescending(File::lastModified)
                            ?.drop(96)?.forEach { it.delete() }
                    }
                }
            } catch (cause: IOException) {
                withContext(Dispatchers.IO) { gson.fromJson(file.readText(), BookChapterContent::class.java) }
            }
            blocks = content.blocks
        } catch (cause: CancellationException) {
            throw cause
        } catch (_: Exception) {
            error = true
        }
    }

    fun savePosition(index: Int, offset: Int = 0, completed: Boolean = false) {
        anchor = index
        charOffset = offset
        val payload = JsonObject().apply {
            addProperty("spine_index", spine); addProperty("block_index", index)
            addProperty("char_offset", offset); addProperty("reading_mode", if (paged) "paginated" else "scroll")
            addProperty("completed", completed)
        }
        scope.launch {
            try { sync.save(payload) } catch (cause: CancellationException) { throw cause }
            catch (cause: HttpException) {
                if (cause.code() == 409) syncConflict = true else error = true
            } catch (cause: Exception) { if (cause !is IOException) error = true }
        }
    }

    val totalChapters = manifest?.chapters?.size ?: 0

    CompositionLocalProvider(LocalDarkAppearance provides dark) {
        MaterialTheme(colorScheme = if (dark) classicDarkColors else classicLightColors) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val wide = maxWidth >= 728.dp && maxHeight >= 480.dp
                Column(Modifier.fillMaxSize().background(palette).padding(12.dp).testTag("book-reader-stage"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        FilterChip(paged, {
                            focus.clearFocus()
                            selection = null
                            paged = !paged
                            if (blocks != null) savePosition(anchor, charOffset)
                        }, { Text(stringResource(if (paged) R.string.books_pages else R.string.books_scroll)) })
                        FilterChip(dark, { dark = !dark }, { Text(stringResource(R.string.books_dark)) })
                        TextButton(onClick = {
                            showTools = false
                            panelMode = PanelMode.CONTENTS
                            showPanel = true
                        }) { Text(stringResource(R.string.books_contents)) }
                        IconToggleButton(showTools, { showTools = it }, enabled = !blocks.isNullOrEmpty()) {
                            Icon(Icons.Default.MoreHoriz, stringResource(R.string.books_tools))
                        }
                    }
                    if (syncConflict) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.books_sync_conflict), Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { reloadReader++ }) { Text(stringResource(R.string.books_retry)) }
                        }
                    } else if (error) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.books_error), Modifier.weight(1f), color = ink)
                            TextButton(onClick = { reloadReader++ }) { Text(stringResource(R.string.books_retry)) }
                        }
                    }
                    val chapter = blocks
                    if (chapter == null && !error) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (!chapter.isNullOrEmpty()) {
                        val highlights = annotations.filter { it.spine == spine }
                        val imageBase = repository.url("api", "v1", "books", book.id, "ebook", "assets")
                        val imageScope = "$owner:${book.id}:${manifest?.sha256}"
                        BoxWithConstraints(
                            Modifier.weight(1f).widthIn(max = 760.dp).fillMaxWidth().align(Alignment.CenterHorizontally),
                        ) {
                            val density = LocalDensity.current
                            val measurer = rememberTextMeasurer()
                            val width = with(density) { maxWidth.roundToPx() }.coerceAtLeast(1)
                            val height = with(density) { maxHeight.roundToPx() }.coerceAtLeast(1)
                            if (paged) {
                                val gap = with(density) { 8.dp.roundToPx() }
                                val pages = remember(chapter, size, width, height, gap, measurer) {
                                    measurePages(chapter, measurer, size, width, height, gap)
                                }
                                val startPage = pages.indexOfLast { page ->
                                    page.isNotEmpty() && (page.first().block.index < anchor ||
                                        (page.first().block.index == anchor && page.first().offset <= charOffset))
                                }.coerceAtLeast(0)
                                val pager = rememberPagerState(initialPage = startPage) { pages.size }
                                LaunchedEffect(pager, pages, jump) {
                                    pager.scrollToPage(startPage.coerceIn(pages.indices))
                                    snapshotFlow { pager.settledPage }.drop(1).collect { page ->
                                        val isLastPage = spine >= totalChapters - 1 && page >= pages.lastIndex
                                        pages[page].firstOrNull()?.let { savePosition(it.block.index, it.offset, completed = isLastPage) }
                                    }
                                }
                                HorizontalPager(pager, Modifier.fillMaxSize()) { page ->
                                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        pages[page].forEach { piece ->
                                            val image = piece.block.imageKey
                                            if (image != null) BookImage(images, "$imageBase/$image", "$imageScope:$image", Modifier.fillMaxSize())
                                            else BookParagraph(piece, size, ink, highlights) { selection = it }
                                        }
                                    }
                                }
                            } else {
                                val list = rememberLazyListState(initialFirstVisibleItemIndex = anchor.coerceIn(chapter.indices))
                                fun textLayout(block: BookBlock) = measurer.measure(block.text, bookStyle(block, size),
                                    constraints = Constraints(maxWidth = width))
                                LaunchedEffect(list, chapter, size, width, height, jump) {
                                    val index = anchor.coerceIn(chapter.indices)
                                    val block = chapter[index]
                                    val top = if (charOffset > 0 && block.text.isNotEmpty()) {
                                        val position = block.text.offsetByCodePoints(0,
                                            charOffset.coerceAtMost(block.text.codePointCount(0, block.text.length)))
                                        val layout = textLayout(block)
                                        layout.getLineTop(layout.getLineForOffset(position)).toInt()
                                    } else 0
                                    list.scrollToItem(index, top)
                                    snapshotFlow {
                                        if (list.isScrollInProgress) null
                                        else {
                                            val lastVisible = list.layoutInfo.visibleItemsInfo.lastOrNull()
                                            val atBottom = spine >= totalChapters - 1 &&
                                                lastVisible != null &&
                                                lastVisible.index >= chapter.lastIndex &&
                                                (lastVisible.offset + lastVisible.size) <= list.layoutInfo.viewportEndOffset + 4
                                            Triple(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset, atBottom)
                                        }
                                    }.drop(1).filterNotNull().distinctUntilChanged().collect { (item, offset, atBottom) ->
                                        val first = chapter[item]
                                        val chars = if (offset > 0 && first.text.isNotEmpty()) {
                                            val layout = textLayout(first)
                                            first.text.codePointCount(0, layout.getLineStart(layout.getLineForVerticalPosition(offset.toFloat())))
                                        } else 0
                                        savePosition(first.index, chars, completed = atBottom)
                                    }
                                }
                                LazyColumn(Modifier.fillMaxSize(), state = list, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    items(chapter, key = { it.index }) { block ->
                                        val image = block.imageKey
                                        if (image != null) BookImage(images, "$imageBase/$image", "$imageScope:$image", Modifier.fillMaxWidth())
                                        else BookParagraph(PagePiece(block, 0), size, ink, highlights) { selection = it }
                                    }
                                }
                            }
                            if (selection != null) {
                                Surface(
                                    Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
                                    shape = MaterialTheme.shapes.large,
                                    color = MaterialTheme.colorScheme.secondaryContainer,
                                    tonalElevation = 2.dp,
                                ) {
                                    TextButton(onClick = {
                                        annotation = selection
                                        selection = null
                                        focus.clearFocus()
                                    }) { Text(stringResource(R.string.books_annotate)) }
                                }
                            }
                            BookReaderToolbar(showTools, animateReaderUi) {
                                FlowRow(Modifier.padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    TextButton(onClick = { size = (size - 1).coerceAtLeast(14f) }) { Text("A−") }
                                    TextButton(onClick = { size = (size + 1).coerceAtMost(24f) }) { Text("A+") }
                                    TextButton(onClick = {
                                        scope.launch {
                                            try {
                                                marks = repository.api().bookBookmarks(book.id).items.filter { it.get("kind").asString == "ebook" }
                                                showTools = false
                                                panelMode = PanelMode.MARKS
                                                showPanel = true
                                            } catch (cause: CancellationException) { throw cause }
                                            catch (_: Exception) { error = true }
                                        }
                                    }) { Text(stringResource(R.string.books_marks)) }
                                    TextButton(onClick = {
                                        scope.launch {
                                            try {
                                                val raw = blocks?.getOrNull(anchor)?.text.orEmpty()
                                                val cpCount = raw.codePointCount(0, raw.length)
                                                val startUtf = raw.offsetByCodePoints(0, charOffset.coerceIn(0, cpCount))
                                                val excerpt = raw.substring(startUtf).ifEmpty { raw }.take(100)
                                                repository.api().addBookBookmark(book.id, JsonObject().apply {
                                                    addProperty("kind", "ebook"); addProperty("spine_index", spine)
                                                    addProperty("block_index", anchor); addProperty("char_offset", charOffset)
                                                    addProperty("excerpt", excerpt)
                                                }, RequestOwner(repository.session.cacheScope()))
                                            } catch (cause: CancellationException) { throw cause }
                                            catch (_: Exception) { error = true }
                                        }
                                    }) { Text(stringResource(R.string.books_add_mark)) }
                                    TextButton(onClick = {
                                        showTools = false
                                        panelMode = PanelMode.ANNOTATIONS
                                        showPanel = true
                                    }) { Text(stringResource(R.string.books_annotations)) }
                                    TextButton(onClick = {
                                        showTools = false
                                        panelMode = PanelMode.SEARCH
                                        showPanel = true
                                    }) { Text(stringResource(R.string.books_search)) }
                                }
                            }
                        }
                    }
                    if (totalChapters > 1) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            TextButton(enabled = spine > 0, onClick = {
                                if (spine > 0) { spine--; savePosition(0); jump++ }
                            }) { Text(stringResource(R.string.books_prev_chapter)) }
                            Text("${spine + 1} / $totalChapters", style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"), color = ink)
                            TextButton(enabled = spine < totalChapters - 1, onClick = {
                                if (spine < totalChapters - 1) { spine++; savePosition(0); jump++ }
                            }) { Text(stringResource(R.string.books_next_chapter)) }
                        }
                    }
                }
                BackHandler(showTools) { showTools = false }
                val panelTitle = when (panelMode) {
                    PanelMode.CONTENTS -> stringResource(R.string.books_contents)
                    PanelMode.MARKS -> stringResource(R.string.books_marks)
                    PanelMode.ANNOTATIONS -> stringResource(R.string.books_annotations)
                    PanelMode.SEARCH -> stringResource(R.string.books_search)
                }
                BookReaderPanel(showPanel, wide, animateReaderUi, panelTitle, close = { showPanel = false }) {
                    when (panelMode) {
                        PanelMode.CONTENTS -> LazyColumn {
                            items(manifest?.chapters.orEmpty()) { item ->
                                TextButton(onClick = {
                                    spine = item.index
                                    savePosition(0)
                                    jump++
                                    showPanel = false
                                }) {
                                    Text(
                                        item.title,
                                        fontWeight = if (item.index == spine) FontWeight.Bold else FontWeight.Normal,
                                    )
                                }
                            }
                        }
                        PanelMode.MARKS -> LazyColumn {
                            if (marks.isEmpty()) item { Text(stringResource(R.string.books_no_marks)) }
                            items(marks) { item ->
                                val markId = item.get("id")?.takeUnless { it.isJsonNull }?.asString
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    TextButton(
                                        modifier = Modifier.weight(1f),
                                        onClick = {
                                            val next = item.get("spine_index")?.takeUnless { it.isJsonNull }?.asInt
                                            if (next != null) {
                                                spine = next
                                                savePosition(item.get("block_index").asInt, item.get("char_offset")?.asInt ?: 0)
                                                jump++
                                            }
                                            showPanel = false
                                        },
                                    ) { Text(item.get("excerpt")?.takeUnless { it.isJsonNull }?.asString.orEmpty(), maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                    if (markId != null) {
                                        IconButton(onClick = {
                                            scope.launch {
                                                runCatching { repository.api().deleteBookBookmark(book.id, markId, RequestOwner(repository.session.cacheScope())) }
                                                    .onSuccess { marks = marks.filterNot { it.get("id")?.asString == markId } }
                                            }
                                        }) { Icon(Icons.Default.Delete, stringResource(R.string.books_delete)) }
                                    }
                                }
                            }
                        }
                        PanelMode.ANNOTATIONS -> LazyColumn {
                            if (annotations.isEmpty()) item { Text(stringResource(R.string.books_no_annotations)) }
                            items(annotations, key = { it.id }) { ann ->
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    TextButton(
                                        modifier = Modifier.weight(1f),
                                        onClick = {
                                            spine = ann.spine
                                            savePosition(ann.startBlock, ann.startOffset)
                                            jump++
                                            showPanel = false
                                        },
                                    ) { Text(ann.selectedText.ifBlank { ann.color }, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                    IconButton(onClick = {
                                        scope.launch {
                                            runCatching { repository.api().deleteBookAnnotation(book.id, ann.id, RequestOwner(repository.session.cacheScope())) }
                                                .onSuccess {
                                                    annotations = annotations.filterNot { it.id == ann.id }
                                                    if (owner != null) repository.database.books().deleteAnnotation(owner, book.id, ann.id)
                                                }
                                        }
                                    }) { Icon(Icons.Default.Delete, stringResource(R.string.books_delete)) }
                                }
                            }
                        }
                        PanelMode.SEARCH -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(
                                    searchQuery,
                                    { searchQuery = it },
                                    singleLine = true,
                                    label = { Text(stringResource(R.string.books_search_hint)) },
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(enabled = searchQuery.isNotBlank(), onClick = {
                                    scope.launch {
                                        runCatching { repository.api().searchBookEbook(book.id, searchQuery.trim()).items }
                                            .onSuccess { searchMatches = it }
                                            .onFailure { error = true }
                                    }
                                }) { Text(stringResource(R.string.books_search)) }
                            }
                            LazyColumn {
                                items(searchMatches) { match ->
                                    TextButton(onClick = {
                                        val s = match.get("spine_index")?.asInt ?: 0
                                        val b = match.get("block_index")?.asInt ?: 0
                                        val c = match.get("char_offset")?.asInt ?: 0
                                        spine = s
                                        savePosition(b, c)
                                        jump++
                                        showPanel = false
                                    }) { Text(match.get("excerpt")?.takeUnless { it.isJsonNull }?.asString.orEmpty(), maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                }
                            }
                        }
                    }
                }
                annotation?.let { range ->
                    BookReaderDialog(
                        title = stringResource(R.string.books_annotate),
                        close = { annotation = null },
                    ) {
                        Column {
                            listOf("amber" to R.string.books_amber, "terracotta" to R.string.books_terracotta,
                                "sage" to R.string.books_sage, "stone" to R.string.books_stone).forEach { (color, label) ->
                                TextButton(onClick = {
                                    annotation = null
                                    scope.launch {
                                        try {
                                            val saved = repository.api().addBookAnnotation(book.id, JsonObject().apply {
                                                addProperty("spine_index", spine); addProperty("start_block_index", range.block)
                                                addProperty("start_char_offset", range.start); addProperty("end_block_index", range.block)
                                                addProperty("end_char_offset", range.end)
                                                addProperty("selected_text", range.text); addProperty("color", color)
                                            }, RequestOwner(repository.session.cacheScope()))
                                            annotations = annotations + gson.fromJson(saved, BookAnnotation::class.java)
                                            selection = null
                                            if (owner != null) repository.database.books().saveAnnotation(
                                                BookAnnotationSyncEntity(owner, book.id, saved.get("id").asString, saved.toString()))
                                        } catch (cause: CancellationException) { throw cause }
                                        catch (_: Exception) { error = true }
                                    }
                                }) { Text(stringResource(label)) }
                            }
                        }
                    }
                }
            }
        }
    }
}

internal data class PagePiece(val block: BookBlock, val offset: Int)

internal fun bookStyle(block: BookBlock, size: Float) = TextStyle(
    fontFamily = FontFamily.Serif,
    fontSize = (if (block.tag.startsWith("h")) size + 3 else size).sp,
    lineHeight = (size * 1.65).sp,
)

internal fun measurePages(
    blocks: List<BookBlock>, measurer: TextMeasurer, size: Float, width: Int, height: Int, gap: Int,
): List<List<PagePiece>> = measurePagesWith(blocks, width, height, gap) { block, remainder ->
    val layout = measurer.measure(remainder, bookStyle(block, size), constraints = Constraints(maxWidth = width))
    List(layout.lineCount) { line -> layout.getLineEnd(line) to layout.getLineBottom(line).toInt() }
}

internal fun measurePagesWith(
    blocks: List<BookBlock>,
    width: Int,
    height: Int,
    gap: Int,
    measureLines: (BookBlock, String) -> List<Pair<Int, Int>>,
): List<List<PagePiece>> {
    val pages = mutableListOf<MutableList<PagePiece>>(mutableListOf())
    var remaining = height
    for (block in blocks) {
        if (block.imageKey != null) {
            if (pages.last().isNotEmpty()) pages.add(mutableListOf())
            pages.last().add(PagePiece(block, 0))
            pages.add(mutableListOf())
            remaining = height
            continue
        }
        if (block.text.isBlank()) continue
        var from = 0
        while (from < block.text.length) {
            val remainder = block.text.substring(from)
            val lines = measureLines(block, remainder)
            val fit = lines.takeWhile { it.second <= remaining }.size
            if (fit == 0 && pages.last().isNotEmpty()) {
                pages.add(mutableListOf())
                remaining = height
                continue
            }
            val lineIndex = (fit - 1).coerceIn(0, (lines.size - 1).coerceAtLeast(0))
            val rawEnd = lines.getOrNull(lineIndex)?.first ?: remainder.length
            val count = rawEnd.coerceAtLeast(1).coerceAtMost(remainder.length)
            val bottom = lines.getOrNull(lineIndex)?.second ?: remaining
            val selected = remainder.substring(0, count)
            pages.last().add(PagePiece(block.copy(text = selected), block.text.codePointCount(0, from)))
            from += count
            remaining -= bottom + gap
            if (from < block.text.length) {
                pages.add(mutableListOf())
                remaining = height
            }
        }
    }
    return if (pages.size > 1 && pages.last().isEmpty()) pages.dropLast(1) else pages
}

@Composable
private fun BookImage(loader: ImageLoader, url: String, cacheKey: String, modifier: Modifier) {
    AsyncImage(
        model = ImageRequest.Builder(LocalContext.current).data(url).diskCacheKey(cacheKey)
            .memoryCacheKey(cacheKey).build(),
        imageLoader = loader, contentDescription = null, modifier = modifier,
    )
}

private data class BookSelection(val block: Int, val start: Int, val end: Int, val text: String)

@Composable
private fun BookParagraph(
    piece: PagePiece, size: Float, ink: Color, highlights: List<BookAnnotation>, select: (BookSelection?) -> Unit,
) {
    val block = piece.block
    val text = block.text
    if (text.isBlank()) return
    val length = text.codePointCount(0, text.length)
    var range by remember(block.index, piece.offset, text) { mutableStateOf(TextRange.Zero) }
    val styled = remember(piece, highlights) {
        buildAnnotatedString {
            append(text)
            var utfOffset = 0
            block.runs.orEmpty().forEach { run ->
                val slice = run.text
                if (slice.isEmpty()) return@forEach
                val foundAt = text.indexOf(slice, utfOffset)
                val startUtf = if (foundAt >= 0) foundAt else utfOffset
                val endUtf = (startUtf + slice.length).coerceAtMost(text.length)
                if (startUtf < endUtf && (run.bold || run.italic || run.code)) {
                    addStyle(
                        SpanStyle(
                            fontWeight = if (run.bold) FontWeight.Bold else null,
                            fontStyle = if (run.italic) FontStyle.Italic else null,
                            fontFamily = if (run.code) FontFamily.Monospace else null,
                        ),
                        startUtf,
                        endUtf,
                    )
                }
                utfOffset = endUtf
            }
            for (mark in highlights) {
                if (block.index !in mark.startBlock..mark.endBlock) continue
                val start = if (block.index == mark.startBlock) (mark.startOffset - piece.offset).coerceIn(0, length) else 0
                val end = if (block.index == mark.endBlock) (mark.endOffset - piece.offset).coerceIn(0, length) else length
                val color = when (mark.color) {
                    "amber" -> Color(0xFFECCB84)
                    "terracotta" -> Color(0xFFE1AD99)
                    "sage" -> Color(0xFFC1C8AA)
                    "stone" -> Color(0xFFD4C8BB)
                    else -> continue
                }
                if (start < end) addStyle(SpanStyle(color = Color(0xFF2A2B25), background = color),
                    text.offsetByCodePoints(0, start), text.offsetByCodePoints(0, end))
            }
        }
    }
    BasicTextField(
        value = TextFieldValue(styled, selection = range), readOnly = true,
        textStyle = bookStyle(block, size).copy(color = ink),
        onValueChange = { next ->
            range = next.selection
            val selected = text.substring(range.min, range.max)
            select(selected.takeIf { it.isNotBlank() && it.codePointCount(0, it.length) <= 8192 }?.let {
                BookSelection(block.index, piece.offset + text.codePointCount(0, range.min),
                    piece.offset + text.codePointCount(0, range.max), it)
            })
        },
    )
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun BookListening(vm: MusicViewModel, book: BookSummary) {
    val repository = vm.repository
    val context = LocalContext.current
    val owner = repository.session.storageScope()
    val profile = repository.session.cacheScope()
    val gson = remember { Gson() }
    val mainState by vm.state.collectAsStateWithLifecycle()
    val syncConflictBook by repository.bookSyncConflict.collectAsStateWithLifecycle()
    var controller by remember(book.id, profile) { mutableStateOf<MediaController?>(null) }
    var chapters by remember(book.id) { mutableStateOf<List<BookAudioChapter>>(emptyList()) }
    var preparedItems by remember(book.id) { mutableStateOf<List<MediaItem>>(emptyList()) }
    var startIndex by remember(book.id) { mutableIntStateOf(0) }
    var startPosMs by remember(book.id) { mutableLongStateOf(0L) }
    var index by remember(book.id) { mutableIntStateOf(0) }
    var position by remember(book.id) { mutableLongStateOf(0L) }
    var draggingPos by remember(book.id) { mutableStateOf<Float?>(null) }
    var playing by remember(book.id) { mutableStateOf(false) }
    var attached by remember(book.id, profile) { mutableStateOf(false) }
    var ready by remember(book.id, profile) { mutableStateOf(false) }
    var speed by remember(book.id) { mutableFloatStateOf(1f) }
    var sleep by remember(book.id) { mutableIntStateOf(0) }
    var error by remember(book.id) { mutableStateOf(false) }
    var reloadAudio by remember(book.id) { mutableIntStateOf(0) }
    val chapter = chapters.getOrNull(index)

    DisposableEffect(book.id, profile) {
        val token = SessionToken(context, ComponentName(context, BookPlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            if (!future.isCancelled) {
                try { controller = future.get() } catch (_: Exception) { error = true }
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose { MediaController.releaseFuture(future) }
    }

    LaunchedEffect(book.id, owner, controller, reloadAudio) {
        val player = controller ?: return@LaunchedEffect
        error = false
        try {
            val loadedChapters = try {
                repository.api().bookAudio(book.id).chapters.also { fresh ->
                    if (owner != null) repository.database.books().saveAudioChapters(fresh.map {
                        BookAudiobookChapterEntity(owner, book.id, it.index, gson.toJson(it))
                    })
                }
            } catch (cause: IOException) {
                val cached = owner?.let { repository.database.books().audioChapters(it, book.id) }.orEmpty()
                if (cached.isEmpty()) throw cause
                cached.map { gson.fromJson(it.payload, BookAudioChapter::class.java) }
            }
            chapters = loadedChapters
            val activeBookId = player.currentMediaItem?.mediaMetadata?.extras?.getString("bookId")
            if (activeBookId == book.id) {
                index = player.currentMediaItemIndex
                speed = player.playbackParameters.speed
                attached = true
                ready = true
                runCatching {
                    val status = player.sendCustomCommand(SessionCommand(BookPlaybackService.SLEEP_STATUS, Bundle.EMPTY), Bundle.EMPTY).get()
                    sleep = status.extras.getInt("minutes", 0)
                }
                return@LaunchedEffect
            }
            val sync = BookSync(repository, book.id, "listening", initialIntent = if (book.progressStatus == "finished") "restart" else "resume")
            val checkpoint = sync.load()
            startIndex = checkpoint.chapter.coerceIn(0, loadedChapters.lastIndex.coerceAtLeast(0))
            val steps = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f)
            speed = steps.minByOrNull { kotlin.math.abs(it - (if (checkpoint.speed > 0f) checkpoint.speed else 1f)) } ?: 1f
            index = startIndex
            startPosMs = if (loadedChapters.isNotEmpty()) checkpoint.position.coerceIn(0, (loadedChapters[startIndex].end - loadedChapters[startIndex].start).coerceAtLeast(0)) else 0L
            position = startPosMs
            val coverUri = if (book.hasCover) Uri.parse(repository.url("api", "v1", "books", book.id, "cover")) else null
            val intent = if (book.progressStatus == "finished") "restart" else "resume"
            val items = loadedChapters.map { entry ->
                val extras = Bundle().apply {
                    putString("bookId", book.id); putString("owner", profile)
                    putInt("chapter", entry.index); putLong("duration", entry.end - entry.start)
                    putInt("fileIndex", entry.fileIndex); putLong("start", entry.start); putLong("end", entry.end)
                    putInt("baseVersion", sync.currentVersion()); putString("intent", intent)
                }
                MediaItem.Builder()
                    .setMediaId("book:${book.id}:${entry.index}")
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(entry.title)
                            .setAlbumTitle(book.title)
                            .setArtworkUri(coverUri)
                            .setExtras(extras)
                            .build(),
                    )
                    .build()
            }
            preparedItems = items
            if (items.isNotEmpty() && !player.isPlaying && !player.playWhenReady) {
                player.setMediaItems(items, startIndex, startPosMs)
                player.setPlaybackSpeed(speed)
                attached = true
            }
            ready = items.isNotEmpty()
        } catch (cause: CancellationException) { throw cause }
        catch (_: Exception) { error = true }
    }

    LaunchedEffect(mainState.playing) {
        if (mainState.playing && controller?.isPlaying == true) controller?.pause()
    }
    LaunchedEffect(controller) {
        val player = controller ?: return@LaunchedEffect
        while (true) {
            delay(300)
            val matches = player.currentMediaItem?.mediaMetadata?.extras?.getString("bookId") == book.id
            attached = matches
            if (matches) {
                ready = true
                index = player.currentMediaItemIndex
                playing = player.isPlaying
                if (draggingPos == null) position = player.currentPosition.coerceAtLeast(0)
                if (player.playerError != null) error = true
            } else {
                playing = false
            }
        }
    }

    if (syncConflictBook == book.id) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.books_sync_conflict), Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
            TextButton(onClick = { repository.bookSyncConflict.value = null; reloadAudio++ }) { Text(stringResource(R.string.books_retry)) }
        }
    } else if (error) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.books_error), Modifier.weight(1f))
            TextButton(onClick = { reloadAudio++ }) { Text(stringResource(R.string.books_retry)) }
        }
    }
    if (!ready && !error) LinearProgressIndicator(Modifier.fillMaxWidth())
    val player = controller
    if (ready && chapter != null && player != null) {
        var chooser by remember { mutableStateOf(false) }
        val duration = (chapter.end - chapter.start).coerceAtLeast(1)
        val displayPos = draggingPos?.toLong() ?: position
        Column(Modifier.fillMaxWidth()) {
            Text(chapter.title, style = MaterialTheme.typography.titleMedium)
            Slider(
                value = displayPos.toFloat().coerceIn(0f, duration.toFloat()),
                onValueChange = { draggingPos = it },
                onValueChangeFinished = {
                    val target = draggingPos?.toLong() ?: return@Slider
                    draggingPos = null
                    position = target
                    if (attached) player.seekTo(target)
                    else startPosMs = target
                },
                valueRange = 0f..duration.toFloat(),
            )
            Text(
                "${formatTime(displayPos)} / ${formatTime(duration)}",
                style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = {
                    if (attached && player.isPlaying) {
                        player.pause()
                    } else {
                        vm.pausePlayback()
                        if (!attached && preparedItems.isNotEmpty()) {
                            player.setMediaItems(preparedItems, index.coerceIn(preparedItems.indices), position)
                            player.setPlaybackSpeed(speed)
                            attached = true
                        }
                        if (player.playbackState == Player.STATE_IDLE) player.prepare()
                        player.play()
                    }
                }) { Text(stringResource(if (playing) R.string.pause else R.string.books_play)) }
                TextButton(enabled = attached, onClick = { player.seekTo((player.currentPosition - 15_000).coerceAtLeast(0)) }) { Text("−15s") }
                TextButton(enabled = attached, onClick = { player.seekTo((player.currentPosition + 30_000).coerceAtMost(duration)) }) { Text("+30s") }
                TextButton(onClick = {
                    val steps = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f)
                    speed = steps.firstOrNull { it > speed + 0.01f } ?: steps.first()
                    if (attached) player.setPlaybackSpeed(speed)
                }) { Text("${speed}×", style = LocalTextStyle.current.copy(fontFeatureSettings = "tnum")) }
            }
            Row {
                TextButton(onClick = { chooser = true }) { Text(stringResource(R.string.books_contents)) }
                TextButton(onClick = {
                    sleep = if (sleep >= 60) 0 else sleep + 15
                    player.sendCustomCommand(SessionCommand(BookPlaybackService.SLEEP, Bundle.EMPTY),
                        Bundle().apply { putInt("minutes", sleep) })
                }) {
                    Text(if (sleep == 0) stringResource(R.string.books_sleep) else stringResource(R.string.books_minutes, sleep))
                }
            }
        }
        if (chooser) AlertDialog(
            onDismissRequest = { chooser = false }, title = { Text(stringResource(R.string.books_contents)) },
            text = { LazyColumn { items(chapters) { item ->
                TextButton(onClick = {
                    if (attached) {
                        player.seekTo(item.index, 0)
                    } else {
                        vm.pausePlayback()
                        player.setMediaItems(preparedItems, item.index, 0)
                        player.setPlaybackSpeed(speed)
                        attached = true
                    }
                    index = item.index
                    position = 0
                    chooser = false
                }) { Text(item.title) }
            } } },
            confirmButton = { TextButton(onClick = { chooser = false }) { Text(stringResource(R.string.books_close)) } },
        )
    }
}
