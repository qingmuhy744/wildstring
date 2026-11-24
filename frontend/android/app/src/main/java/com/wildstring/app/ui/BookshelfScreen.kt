package com.wildstring.app.ui

import android.content.ComponentName
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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.disk.DiskCache
import coil.request.ImageRequest
import com.google.gson.Gson
import com.google.gson.JsonObject
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
    var books by remember(owner) { mutableStateOf<List<BookSummary>?>(null) }
    var selected by remember(owner) { mutableStateOf<BookSummary?>(null) }
    var reading by remember(owner) { mutableStateOf(false) }
    var listening by remember(owner) { mutableStateOf(false) }
    var error by remember(owner) { mutableStateOf(false) }
    var filter by rememberSaveable(owner) { mutableStateOf("") }
    var reload by remember(owner) { mutableIntStateOf(0) }
    var uploading by remember(owner) { mutableStateOf(false) }
    var uploadLibrary by remember(owner) { mutableStateOf<BookLibrary?>(null) }
    var uploadLibraries by remember(owner) { mutableStateOf<List<BookLibrary>?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val canUpload = repository.session.account?.profile in setOf("owner", "librarian")
    val selectEbook = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val library = uploadLibrary
        if (uri != null && library != null) scope.launch {
            uploading = true
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
                    else -> throw IOException("Unsupported ebook name")
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
            } catch (cause: Exception) {
                error = true
            } finally {
                uploading = false
                uploadLibrary = null
            }
        }
    }

    LaunchedEffect(owner, reload) {
        error = false
        try {
            val fresh = repository.api().books().items
            books = fresh
            if (owner != null) repository.database.books().replaceBooks(owner,
                fresh.map { BookEntity(owner, it.id, gson.toJson(it)) })
        } catch (cause: IOException) {
            books = owner?.let { key ->
                repository.database.books().books(key).map { gson.fromJson(it.payload, BookSummary::class.java) }
            }
            error = true
        } catch (cause: HttpException) {
            books = null
            error = true
        }
    }
    BackHandler(selected != null) {
        if (reading || listening) { reading = false; listening = false }
        else selected = null
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val book = selected
        if (book != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { selected = null; reading = false; listening = false }) { Text(stringResource(R.string.books_back)) }
                if (book.hasEbook) FilterChip(reading, { reading = !reading }, { Text(stringResource(R.string.books_read)) })
                if (book.hasAudiobook) FilterChip(listening, { listening = !listening }, { Text(stringResource(R.string.books_listen)) })
            }
            Text(book.title, style = MaterialTheme.typography.headlineSmall)
            if (listening) BookListening(vm, book)
            if (reading) BookReading(repository, book)
        } else {
            OutlinedTextField(filter, { filter = it }, singleLine = true,
                label = { Text(stringResource(R.string.books_find)) }, modifier = Modifier.fillMaxWidth())
            if (canUpload) {
                TextButton(enabled = !uploading, onClick = {
                    scope.launch {
                        try { uploadLibraries = repository.api().bookLibraries().items }
                        catch (cause: CancellationException) { throw cause }
                        catch (cause: Exception) { error = true }
                    }
                }) { Text(stringResource(R.string.books_upload)) }
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
                Text(stringResource(R.string.books_error))
                TextButton(onClick = { reload++ }) { Text(stringResource(R.string.books_retry)) }
            }
            val visible = books?.filter { it.title.contains(filter, ignoreCase = true) }
            if (visible == null && !error) {
                LazyVerticalGrid(columns = GridCells.Adaptive(156.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(8) {
                        Surface(Modifier.fillMaxWidth().height(84.dp), shape = MaterialTheme.shapes.medium,
                            color = MaterialTheme.colorScheme.surfaceVariant) {}
                    }
                }
            } else if (visible?.isEmpty() == true && !error) {
                Text(stringResource(R.string.books_empty))
            } else if (visible != null) {
                LazyVerticalGrid(columns = GridCells.Adaptive(156.dp), modifier = Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(visible, key = { it.id }) { item ->
                        Card(onClick = { selected = item }, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(item.title, style = MaterialTheme.typography.titleMedium)
                                item.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
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

@Composable
private fun BookReading(repository: Repository, book: BookSummary) {
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val owner = repository.session.storageScope()
    val gson = remember { Gson() }
    val images = remember(repository, owner) {
        ImageLoader.Builder(context).okHttpClient(repository.client).diskCache {
            DiskCache.Builder().directory(File(context.filesDir, "book_cache/images"))
                .maxSizeBytes(32L * 1024 * 1024).build()
        }.build()
    }
    DisposableEffect(images) { onDispose { images.shutdown() } }
    val sync = remember(book.id, owner) { BookSync(repository, book.id, "reading") }
    val scope = rememberCoroutineScope()
    var manifest by remember(book.id) { mutableStateOf<BookManifest?>(null) }
    var spine by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var blocks by remember(book.id) { mutableStateOf<List<BookBlock>?>(null) }
    var paged by rememberSaveable(book.id) { mutableStateOf(false) }
    var dark by rememberSaveable(book.id) { mutableStateOf(false) }
    var size by rememberSaveable(book.id) { mutableFloatStateOf(18f) }
    var anchor by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var charOffset by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var error by remember(book.id) { mutableStateOf(false) }
    var showContents by remember(book.id) { mutableStateOf(false) }
    var showMarks by remember(book.id) { mutableStateOf(false) }
    var marks by remember(book.id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var annotations by remember(book.id, owner) { mutableStateOf<List<BookAnnotation>>(emptyList()) }
    var selection by remember(book.id, spine) { mutableStateOf<BookSelection?>(null) }
    var annotation by remember(book.id) { mutableStateOf<BookSelection?>(null) }
    var jump by remember(book.id) { mutableIntStateOf(0) }
    val palette = if (dark) Color(0xFF181614) else Color(0xFFF6F3ED)
    val ink = if (dark) Color(0xFFE8E3D9) else Color(0xFF2A2B25)

    LaunchedEffect(book.id, owner) {
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
            if (progress.version > 0) { spine = progress.spine; anchor = progress.block; charOffset = progress.offset; paged = progress.mode == "paginated" }
            manifest = data
        } catch (cause: CancellationException) {
            throw cause
        } catch (cause: Exception) {
            error = true
        }
    }

    LaunchedEffect(book.id, owner) {
        annotations = try {
            repository.api().bookAnnotations(book.id).items
        } catch (cause: IOException) {
            owner?.let { repository.database.books().annotations(it, book.id) }.orEmpty().map {
                gson.fromJson(it.payload, BookAnnotation::class.java)
            }
        } catch (cause: HttpException) {
            emptyList()
        }
    }

    LaunchedEffect(manifest, spine) {
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
        } catch (cause: Exception) {
            error = true
        }
    }

    fun savePosition(index: Int, offset: Int = 0) {
        anchor = index
        charOffset = offset
        val payload = JsonObject().apply {
            addProperty("spine_index", spine); addProperty("block_index", index)
            addProperty("char_offset", offset); addProperty("reading_mode", if (paged) "paginated" else "scroll")
        }
        scope.launch {
            try { sync.save(payload) } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { if (cause !is IOException) error = true }
        }
    }

    Column(Modifier.fillMaxWidth().background(palette).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(paged, {
                focus.clearFocus()
                selection = null
                paged = !paged
            }, { Text(stringResource(if (paged) R.string.books_pages else R.string.books_scroll)) })
            FilterChip(dark, { dark = !dark }, { Text(stringResource(R.string.books_dark)) })
            TextButton(onClick = { showContents = true }) { Text(stringResource(R.string.books_contents)) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { size = (size - 1).coerceAtLeast(14f) }) { Text("A−") }
            TextButton(onClick = { size = (size + 1).coerceAtMost(24f) }) { Text("A+") }
            TextButton(onClick = {
                scope.launch {
                    try {
                        marks = repository.api().bookBookmarks(book.id).items
                        showMarks = true
                    } catch (cause: CancellationException) { throw cause }
                    catch (cause: Exception) { error = true }
                }
            }) { Text(stringResource(R.string.books_marks)) }
            TextButton(onClick = {
                scope.launch {
                    try {
                        repository.api().addBookBookmark(book.id, JsonObject().apply {
                            addProperty("kind", "ebook"); addProperty("spine_index", spine)
                            addProperty("block_index", anchor); addProperty("char_offset", charOffset)
                            addProperty("excerpt", blocks?.getOrNull(anchor)?.text?.take(100))
                        }, RequestOwner(repository.session.cacheScope()))
                    } catch (cause: CancellationException) { throw cause }
                    catch (cause: Exception) { error = true }
                }
            }) { Text(stringResource(R.string.books_add_mark)) }
        }
        if (selection != null) {
            TextButton(onClick = {
                annotation = selection
                selection = null
                focus.clearFocus()
            }) { Text(stringResource(R.string.books_annotate)) }
        }
        if (error) Text(stringResource(R.string.books_error), color = ink)
        val chapter = blocks
        if (chapter == null && !error) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (!chapter.isNullOrEmpty()) {
            val highlights = annotations.filter { it.spine == spine }
            val imageBase = repository.url("api", "v1", "books", book.id, "ebook", "assets")
            val imageScope = "$owner:${book.id}:${manifest?.sha256}"
            if (paged) {
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                    val density = LocalDensity.current
                    val measurer = rememberTextMeasurer()
                    val width = with(density) { maxWidth.roundToPx() }.coerceAtLeast(1)
                    val height = with(density) { maxHeight.roundToPx() }.coerceAtLeast(1)
                    val gap = with(density) { 8.dp.roundToPx() }
                    val pages = remember(chapter, size, width, height, gap, measurer) {
                        measurePages(chapter, measurer, size, width, height, gap)
                    }
                    val startPage = pages.indexOfLast { page ->
                        page.isNotEmpty() && (page.first().block.index < anchor ||
                            (page.first().block.index == anchor && page.first().offset <= charOffset))
                    }.coerceAtLeast(0)
                    val pager = rememberPagerState(initialPage = startPage) { pages.size }
                    LaunchedEffect(pages, jump) { pager.scrollToPage(startPage.coerceIn(pages.indices)) }
                    LaunchedEffect(pager, pages) {
                        snapshotFlow { pager.settledPage }.distinctUntilChanged().collect { page ->
                            pages.getOrNull(page)?.firstOrNull()?.let { piece ->
                                savePosition(piece.block.index, piece.offset)
                            }
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
                }
            } else {
                val list = rememberLazyListState(initialFirstVisibleItemIndex = anchor.coerceIn(chapter.indices))
                LaunchedEffect(list, jump) {
                    list.scrollToItem(anchor.coerceIn(chapter.indices))
                    snapshotFlow { list.firstVisibleItemIndex }.distinctUntilChanged().collect {
                        savePosition(it, if (it == anchor) charOffset else 0)
                    }
                }
                LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list,
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(chapter, key = { it.index }) { block ->
                        val image = block.imageKey
                        if (image != null) BookImage(images, "$imageBase/$image", "$imageScope:$image", Modifier.fillMaxWidth())
                        else BookParagraph(PagePiece(block, 0), size, ink, highlights) { selection = it }
                    }
                }
            }
        }
        if (showContents) AlertDialog(
            onDismissRequest = { showContents = false },
            title = { Text(stringResource(R.string.books_contents)) },
            text = { LazyColumn { items(manifest?.chapters.orEmpty()) { item ->
                TextButton(onClick = { spine = item.index; anchor = 0; charOffset = 0; jump++; showContents = false }) { Text(item.title) }
            } } },
            confirmButton = { TextButton(onClick = { showContents = false }) { Text(stringResource(R.string.books_close)) } },
        )
        if (showMarks) AlertDialog(
            onDismissRequest = { showMarks = false },
            title = { Text(stringResource(R.string.books_marks)) },
            text = { LazyColumn { items(marks) { item ->
                TextButton(onClick = {
                    val next = item.get("spine_index")?.takeUnless { it.isJsonNull }?.asInt
                    if (next != null) { spine = next; anchor = item.get("block_index").asInt; charOffset = item.get("char_offset")?.asInt ?: 0; jump++ }
                    showMarks = false
                }) { Text(item.get("excerpt")?.takeUnless { it.isJsonNull }?.asString.orEmpty()) }
            } } },
            confirmButton = { TextButton(onClick = { showMarks = false }) { Text(stringResource(R.string.books_close)) } },
        )
        annotation?.let { range ->
            AlertDialog(
                onDismissRequest = { annotation = null },
                title = { Text(stringResource(R.string.books_annotate)) },
                text = { Column {
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
                                catch (cause: Exception) { error = true }
                            }
                        }) { Text(stringResource(label)) }
                    }
                } },
                confirmButton = { TextButton(onClick = { annotation = null }) { Text(stringResource(R.string.books_close)) } },
            )
        }
    }
}

private data class PagePiece(val block: BookBlock, val offset: Int)

private fun bookStyle(block: BookBlock, size: Float) = TextStyle(
    fontFamily = FontFamily.Serif,
    fontSize = (if (block.tag.startsWith("h")) size + 3 else size).sp,
    lineHeight = (size * 1.65).sp,
)

private fun measurePages(
    blocks: List<BookBlock>, measurer: TextMeasurer, size: Float, width: Int, height: Int, gap: Int,
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
            val layout = measurer.measure(remainder, bookStyle(block, size), constraints = Constraints(maxWidth = width))
            val fit = (0 until layout.lineCount).takeWhile { layout.getLineBottom(it) <= remaining }.size
            if (fit == 0 && pages.last().isNotEmpty()) {
                pages.add(mutableListOf())
                remaining = height
                continue
            }
            val line = (fit - 1).coerceAtLeast(0)
            val count = layout.getLineEnd(line).coerceAtLeast(1).coerceAtMost(remainder.length)
            val selected = remainder.substring(0, count)
            pages.last().add(PagePiece(block.copy(text = selected), block.text.codePointCount(0, from)))
            from += count
            remaining -= layout.getLineBottom(line).toInt() + gap
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
    var controller by remember(book.id, profile) { mutableStateOf<MediaController?>(null) }
    var chapters by remember(book.id) { mutableStateOf<List<BookAudioChapter>>(emptyList()) }
    var index by remember(book.id) { mutableIntStateOf(0) }
    var position by remember(book.id) { mutableLongStateOf(0L) }
    var playing by remember(book.id) { mutableStateOf(false) }
    var ready by remember(book.id, profile) { mutableStateOf(false) }
    var speed by remember(book.id) { mutableFloatStateOf(1f) }
    var sleep by remember(book.id) { mutableIntStateOf(0) }
    var error by remember(book.id) { mutableStateOf(false) }
    val chapter = chapters.getOrNull(index)

    DisposableEffect(book.id, profile) {
        val token = SessionToken(context, ComponentName(context, BookPlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            if (!future.isCancelled) {
                try { controller = future.get() } catch (cause: Exception) { error = true }
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose { MediaController.releaseFuture(future) }
    }

    LaunchedEffect(book.id, owner, controller) {
        val player = controller ?: return@LaunchedEffect
        try {
            chapters = repository.api().bookAudio(book.id).chapters
            if (owner != null) repository.database.books().saveAudioChapters(chapters.map {
                BookAudiobookChapterEntity(owner, book.id, it.index, gson.toJson(it))
            })
            if (player.currentMediaItem?.mediaMetadata?.extras?.getString("bookId") == book.id) {
                index = player.currentMediaItemIndex
                speed = player.playbackParameters.speed
                return@LaunchedEffect
            }
            val checkpoint = BookSync(repository, book.id, "listening").load()
            index = checkpoint.chapter.coerceIn(0, chapters.lastIndex.coerceAtLeast(0))
            speed = if (checkpoint.speed > 0) checkpoint.speed else 1f
            val items = chapters.map { entry ->
                val extras = Bundle().apply {
                    putString("bookId", book.id); putString("owner", profile)
                    putInt("chapter", entry.index); putLong("duration", entry.end - entry.start)
                    putInt("fileIndex", entry.fileIndex); putLong("start", entry.start); putLong("end", entry.end)
                }
                MediaItem.Builder()
                    .setMediaId("book:${book.id}:${entry.index}")
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(entry.title).setAlbumTitle(book.title)
                        .setExtras(extras).build())
                    .build()
            }
            if (items.isNotEmpty()) {
                player.pause()
                player.setMediaItems(items, index, checkpoint.position.coerceIn(0, chapters[index].end - chapters[index].start))
                player.setPlaybackSpeed(speed)
            }
        } catch (cause: CancellationException) { throw cause }
        catch (cause: Exception) { error = true }
    }

    LaunchedEffect(mainState.playing) {
        if (mainState.playing && controller?.isPlaying == true) controller?.pause()
    }
    LaunchedEffect(controller) {
        val player = controller ?: return@LaunchedEffect
        while (true) {
            delay(300)
            ready = player.currentMediaItem?.mediaMetadata?.extras?.getString("bookId") == book.id
            if (ready) {
                index = player.currentMediaItemIndex
                playing = player.isPlaying
                position = player.currentPosition.coerceAtLeast(0)
                error = player.playerError != null
            }
        }
    }

    if (error) Text(stringResource(R.string.books_error))
    if (!ready && !error) LinearProgressIndicator(Modifier.fillMaxWidth())
    val player = controller
    if (ready && chapter != null && player != null) {
        var chooser by remember { mutableStateOf(false) }
        Column(Modifier.fillMaxWidth()) {
            Text(chapter.title, style = MaterialTheme.typography.titleMedium)
            Slider(value = position.toFloat().coerceIn(0f, (chapter.end - chapter.start).coerceAtLeast(1).toFloat()),
                onValueChange = { position = it.toLong(); player.seekTo(position) },
                valueRange = 0f..(chapter.end - chapter.start).coerceAtLeast(1).toFloat())
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = {
                    if (player.isPlaying) player.pause()
                    else {
                        if (mainState.playing) vm.toggle()
                        if (player.playbackState == Player.STATE_IDLE) player.prepare()
                        player.play()
                    }
                }) { Text(stringResource(if (playing) R.string.pause else R.string.books_play)) }
                TextButton(onClick = { player.seekTo((player.currentPosition - 15_000).coerceAtLeast(0)) }) { Text("−15s") }
                TextButton(onClick = { player.seekTo((player.currentPosition + 30_000).coerceAtMost(chapter.end - chapter.start)) }) { Text("+30s") }
                TextButton(onClick = { speed = if (speed >= 2.5f) 0.75f else speed + 0.25f; player.setPlaybackSpeed(speed) }) { Text("${speed}×") }
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
                TextButton(onClick = { player.seekTo(item.index, 0); index = item.index; chooser = false }) { Text(item.title) }
            } } },
            confirmButton = { TextButton(onClick = { chooser = false }) { Text(stringResource(R.string.books_close)) } },
        )
    }
}
