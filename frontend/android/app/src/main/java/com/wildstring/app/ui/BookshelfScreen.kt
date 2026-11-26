@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package com.wildstring.app.ui

import android.graphics.drawable.BitmapDrawable
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
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
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.disk.DiskCache
import coil.request.ImageRequest
import coil.size.Size
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import com.wildstring.app.data.*
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import retrofit2.HttpException

@Composable
internal fun BookshelfScreen(
    vm: MusicViewModel,
    suppressSystemBars: Boolean = false,
    onExpandBookPlayer: () -> Unit = {},
) {
    val repository = vm.repository
    val vmState by vm.state.collectAsStateWithLifecycle()
    val bookPlaybackState by vm.bookPlayback.state.collectAsStateWithLifecycle()
    val owner = repository.session.storageScope()
    val profileName = repository.session.account?.profile
    val canUpload = profileName in setOf("owner", "librarian")
    val canEdit = profileName in setOf("owner", "librarian", "editor")
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
    var bookLibraries by remember(owner) { mutableStateOf<List<BookLibrary>>(emptyList()) }
    var selectedId by rememberSaveable(owner) { mutableStateOf<String?>(null) }
    var reading by rememberSaveable(owner) { mutableStateOf(false) }
    var initialSpine by rememberSaveable(owner) { mutableStateOf<Int?>(null) }
    var error by remember(owner) { mutableStateOf(false) }
    var actionError by remember(owner) { mutableStateOf<String?>(null) }
    var filter by rememberSaveable(owner) { mutableStateOf("") }
    var libraryFilter by rememberSaveable(owner) { mutableStateOf<String?>(null) }
    var formatFilter by rememberSaveable(owner) { mutableStateOf("all") }
    var statusFilter by rememberSaveable(owner) { mutableStateOf("all") }
    var reload by remember(owner) { mutableIntStateOf(0) }
    var coverRev by remember(owner) { mutableIntStateOf(0) }
    var uploading by remember(owner) { mutableStateOf(false) }
    var uploadLibrary by remember(owner) { mutableStateOf<BookLibrary?>(null) }
    var attachTargetBookId by remember(owner) { mutableStateOf<String?>(null) }
    var coverTargetBookId by remember(owner) { mutableStateOf<String?>(null) }
    var showEdit by rememberSaveable(selectedId) { mutableStateOf(false) }

    val selected = remember(books, selectedId) { selectedId?.let { id -> books?.find { it.id == id } } }

    LaunchedEffect(vmState.focusedBookId) {
        val target = vmState.focusedBookId ?: return@LaunchedEffect
        selectedId = target
        reading = false
        initialSpine = null
        vm.consumeFocusedBook()
    }

    val isActivelyReading = selected != null && reading
    LaunchedEffect(isActivelyReading) { vm.setReadingBook(isActivelyReading) }
    DisposableEffect(Unit) { onDispose { vm.setReadingBook(false) } }

    val scope = rememberCoroutineScope()

    fun buildMultipartFromUri(uri: Uri, fieldName: String, fallbackExt: String, allowedMime: (String) -> String): Pair<String, RequestBody> {
        val resolver = context.contentResolver
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: "upload.$fallbackExt"
        val mime = allowedMime(name).toMediaType()
        val body = object : RequestBody() {
            override fun contentType() = mime
            override fun writeTo(sink: BufferedSink) {
                val stream = resolver.openInputStream(uri) ?: throw IOException("Cannot open file")
                stream.source().use { source -> sink.writeAll(source) }
            }
        }
        return name to body
    }

    val selectEbook = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val library = uploadLibrary
        val attachId = attachTargetBookId
        if (uri != null) scope.launch {
            uploading = true
            actionError = null
            try {
                val (name, body) = withContext(Dispatchers.IO) {
                    buildMultipartFromUri(uri, "file", "epub") { fileName ->
                        when (fileName.substringAfterLast('.').lowercase()) {
                            "epub" -> "application/epub+zip"
                            "txt" -> "text/plain"
                            else -> throw IllegalArgumentException("Unsupported ebook name")
                        }
                    }
                }
                val part = MultipartBody.Part.createFormData("file", name, body)
                val reqOwner = RequestOwner(repository.session.cacheScope())
                if (attachId != null) {
                    repository.api().attachBookEbook(attachId, part, reqOwner)
                } else {
                    repository.api().uploadEbook(
                        library?.id?.toRequestBody("text/plain".toMediaType()),
                        part,
                        reqOwner,
                    )
                }
                reload++
            } catch (cause: CancellationException) {
                throw cause
            } catch (cause: HttpException) {
                actionError = if (cause.code() in setOf(413, 422)) AppLanguage.string(R.string.books_upload_failed) else friendlyError(cause)
            } catch (cause: Exception) {
                actionError = friendlyError(cause)
            } finally {
                uploading = false
                uploadLibrary = null
                attachTargetBookId = null
            }
        } else {
            uploadLibrary = null
            attachTargetBookId = null
        }
    }

    val selectCover = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val bookId = coverTargetBookId
        coverTargetBookId = null
        if (uri != null && bookId != null) scope.launch {
            uploading = true
            actionError = null
            try {
                val (name, body) = withContext(Dispatchers.IO) {
                    buildMultipartFromUri(uri, "file", "jpg") { fileName ->
                        when (fileName.substringAfterLast('.').lowercase()) {
                            "png" -> "image/png"
                            "webp" -> "image/webp"
                            else -> "image/jpeg"
                        }
                    }
                }
                repository.api().uploadBookCover(
                    bookId,
                    MultipartBody.Part.createFormData("file", name, body),
                    RequestOwner(repository.session.cacheScope()),
                )
                coverRev++
                reload++
            } catch (cause: CancellationException) {
                throw cause
            } catch (cause: Exception) {
                actionError = friendlyError(cause)
            } finally {
                uploading = false
            }
        }
    }

    LaunchedEffect(owner, reload) {
        error = false
        runCatching { repository.api().bookLibraries().items }.onSuccess { libs ->
            bookLibraries = libs
            if (libraryFilter != null && libs.none { it.id == libraryFilter }) {
                libraryFilter = null
            }
        }
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
            all.firstOrNull { it.id == bookPlaybackState.book?.id }?.let { updated ->
                vm.bookPlayback.refreshBookSummary(updated)
            }
            if (owner != null) {
                repository.database.books().replaceBooks(
                    owner,
                    all.map { BookEntity(owner, it.id, gson.toJson(it)) },
                )
            }
        } catch (_: IOException) {
            val cached = owner?.let { key ->
                repository.database.books().books(key).map { gson.fromJson(it.payload, BookSummary::class.java) }
            }.orEmpty()
            if (cached.isNotEmpty()) books = cached
            error = true
        } catch (_: HttpException) {
            books = null
            error = true
        }
    }

    BackHandler(selected != null) {
        if (reading) {
            reading = false
            initialSpine = null
        } else {
            selectedId = null
        }
    }

    val book = selected
    if (book != null && reading) {
        BookReading(
            vm = vm,
            book = book,
            images = coverLoader,
            initialSpine = initialSpine,
            suppressSystemBars = suppressSystemBars,
            onExpandAudioPlayer = onExpandBookPlayer,
            onBack = {
                reading = false
                initialSpine = null
                reload++
            },
        )
        return
    }

    Box(Modifier.fillMaxSize().padding(horizontal = 16.dp), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 1180.dp).fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (book != null) {
                BookDetailScreen(
                    vm = vm,
                    book = book,
                    allBooks = books.orEmpty(),
                    bookPlaybackState = bookPlaybackState,
                    canEdit = canEdit,
                    canUpload = canUpload,
                    uploading = uploading,
                    showEdit = showEdit,
                    onToggleEdit = { showEdit = !showEdit },
                    coverRevision = coverRev,
                    actionError = actionError,
                    onClearError = { actionError = null },
                    onBack = {
                        selectedId = null
                        initialSpine = null
                    },
                    onRead = { spineIndex ->
                        initialSpine = spineIndex
                        reading = true
                    },
                    onListen = { chapterIndex ->
                        vm.bookPlayback.open(book, autoplay = true, targetChapterIndex = chapterIndex)
                    },
                    onPickCover = {
                        coverTargetBookId = book.id
                        selectCover.launch("image/*")
                    },
                    onAttachEbook = {
                        attachTargetBookId = book.id
                        selectEbook.launch(arrayOf("application/epub+zip", "text/plain"))
                    },
                    onRefreshBook = {
                        coverRev++
                        reload++
                    },
                    onReportError = { actionError = it },
                )
            } else {
                Spacer(Modifier.height(2.dp))
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = filter,
                        onValueChange = { filter = it },
                        modifier = Modifier.weight(1f).testTag("books-search"),
                        placeholder = { Text(stringResource(R.string.books_find)) },
                        singleLine = true,
                        shape = RoundedCornerShape(10.dp),
                        leadingIcon = { Icon(Icons.Default.Search, null) },
                        trailingIcon = {
                            if (filter.isNotEmpty()) {
                                IconButton({ filter = "" }) {
                                    Icon(Icons.Default.Close, stringResource(R.string.clear_search))
                                }
                            }
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                            unfocusedBorderColor = Color.Transparent,
                            focusedBorderColor = MaterialTheme.colorScheme.primary,
                        ),
                    )
                    if (canUpload) {
                        FilledTonalButton(
                            enabled = !uploading,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.heightIn(min = 48.dp).testTag("books-upload-button"),
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                            onClick = {
                                actionError = null
                                uploadLibrary = bookLibraries.firstOrNull {
                                    it.id == libraryFilter && it.storageMode != "hardlink"
                                } ?: bookLibraries.firstOrNull { it.storageMode != "hardlink" }
                                selectEbook.launch(arrayOf("application/epub+zip", "text/plain"))
                            },
                        ) {
                            Icon(Icons.Default.UploadFile, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(stringResource(R.string.books_upload), maxLines = 1, softWrap = false)
                        }
                    }
                }

                // Compact filter strip
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (bookLibraries.size > 1) {
                        var libMenu by remember { mutableStateOf(false) }
                        val libLabel = bookLibraries.find { it.id == libraryFilter }?.name
                            ?: stringResource(R.string.books_all_libraries)
                        Box {
                            BookChoicePill(
                                label = libLabel,
                                selected = libraryFilter != null,
                                onClick = { libMenu = true },
                                trailingIcon = Icons.Default.ArrowDropDown,
                            )
                            DropdownMenu(libMenu, { libMenu = false }) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.books_all_libraries)) },
                                    onClick = { libMenu = false; libraryFilter = null },
                                )
                                bookLibraries.forEach { lib ->
                                    DropdownMenuItem(
                                        text = { Text(lib.name) },
                                        trailingIcon = if (libraryFilter == lib.id) {
                                            { Icon(Icons.Default.Check, null, Modifier.size(16.dp)) }
                                        } else null,
                                        onClick = { libMenu = false; libraryFilter = lib.id },
                                    )
                                }
                            }
                        }
                    }

                    var fmtMenu by remember { mutableStateOf(false) }
                    val fmtLabel = when (formatFilter) {
                        "ebook" -> stringResource(R.string.books_ebook)
                        "audiobook" -> stringResource(R.string.books_audiobook)
                        else -> stringResource(R.string.books_all_formats)
                    }
                    Box {
                        BookChoicePill(
                            label = fmtLabel,
                            selected = formatFilter != "all",
                            onClick = { fmtMenu = true },
                            trailingIcon = Icons.Default.ArrowDropDown,
                        )
                        DropdownMenu(fmtMenu, { fmtMenu = false }) {
                            listOf(
                                "all" to R.string.books_all_formats,
                                "ebook" to R.string.books_ebook,
                                "audiobook" to R.string.books_audiobook,
                            ).forEach { (key, res) ->
                                DropdownMenuItem(
                                    text = { Text(stringResource(res)) },
                                    trailingIcon = if (formatFilter == key) {
                                        { Icon(Icons.Default.Check, null, Modifier.size(16.dp)) }
                                    } else null,
                                    onClick = { fmtMenu = false; formatFilter = key },
                                )
                            }
                        }
                    }

                    var stMenu by remember { mutableStateOf(false) }
                    val stLabel = when (statusFilter) {
                        "in_progress" -> stringResource(R.string.books_status_in_progress)
                        "unread" -> stringResource(R.string.books_status_unread)
                        "finished" -> stringResource(R.string.books_status_finished)
                        else -> stringResource(R.string.books_all_statuses)
                    }
                    Box {
                        BookChoicePill(
                            label = stLabel,
                            selected = statusFilter != "all",
                            onClick = { stMenu = true },
                            trailingIcon = Icons.Default.ArrowDropDown,
                        )
                        DropdownMenu(stMenu, { stMenu = false }) {
                            listOf(
                                "all" to R.string.books_all_statuses,
                                "in_progress" to R.string.books_status_in_progress,
                                "unread" to R.string.books_status_unread,
                                "finished" to R.string.books_status_finished,
                            ).forEach { (key, res) ->
                                DropdownMenuItem(
                                    text = { Text(stringResource(res)) },
                                    trailingIcon = if (statusFilter == key) {
                                        { Icon(Icons.Default.Check, null, Modifier.size(16.dp)) }
                                    } else null,
                                    onClick = { stMenu = false; statusFilter = key },
                                )
                            }
                        }
                    }
                }

                actionError?.let { msg ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(msg, Modifier.weight(1f), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { actionError = null }) { Text(stringResource(R.string.books_close)) }
                    }
                }

                if (error) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.books_error), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { reload++ }) { Text(stringResource(R.string.books_retry)) }
                    }
                }

                val visible = books?.filter { item ->
                    val matchesLib = libraryFilter == null || item.libraryId == libraryFilter
                    val matchesFmt = formatFilter == "all" ||
                        (formatFilter == "ebook" && item.hasEbook) ||
                        (formatFilter == "audiobook" && item.hasAudiobook)
                    val matchesStatus = statusFilter == "all" || item.progressStatus == statusFilter
                    val q = filter.trim()
                    val matchesQuery = q.isEmpty() ||
                        item.title.contains(q, ignoreCase = true) ||
                        item.subtitle?.contains(q, ignoreCase = true) == true ||
                        item.authors.any { a -> a.contains(q, ignoreCase = true) }
                    matchesLib && matchesFmt && matchesStatus && matchesQuery
                }

                if (visible == null && !error) {
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(260.dp),
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(6) {
                            Surface(
                                Modifier.fillMaxWidth().height(98.dp),
                                shape = RoundedCornerShape(14.dp),
                                color = MaterialTheme.colorScheme.surfaceContainer,
                                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                            ) {}
                        }
                    }
                } else if (visible?.isEmpty() == true && !error) {
                    Box(Modifier.weight(1f).fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.TopCenter) {
                        Text(stringResource(R.string.books_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else if (visible != null) {
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(260.dp),
                        modifier = Modifier.weight(1f).fillMaxWidth().testTag("books-grid"),
                        contentPadding = PaddingValues(bottom = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(visible, key = { it.id }) { item ->
                            val isActiveAudio = bookPlaybackState.book?.id == item.id && bookPlaybackState.playing
                            val statusText = progressStatusLabel(item.progressStatus)
                            val meta = listOfNotNull(
                                stringResource(R.string.books_ebook).takeIf { item.hasEbook },
                                stringResource(R.string.books_audiobook).takeIf { item.hasAudiobook },
                                statusText,
                            ).joinToString(" · ")
                            Surface(
                                onClick = {
                                    selectedId = item.id
                                    initialSpine = null
                                    reading = false
                                    actionError = null
                                },
                                modifier = Modifier.fillMaxWidth().testTag("book-card-${item.id}"),
                                shape = RoundedCornerShape(14.dp),
                                color = if (isActiveAudio) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surfaceContainer,
                                border = BorderStroke(
                                    1.dp,
                                    if (isActiveAudio) MaterialTheme.colorScheme.primary.copy(alpha = 0.5f) else MaterialTheme.colorScheme.outlineVariant,
                                ),
                            ) {
                                Row(
                                    Modifier.padding(12.dp),
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    BookCoverThumb(
                                        vm = vm,
                                        book = item,
                                        modifier = Modifier.size(width = 52.dp, height = 74.dp),
                                        cornerRadius = 8.dp,
                                        monogramSize = 20.sp,
                                        cacheRevision = coverRev,
                                    )
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Text(
                                            item.title,
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.Medium,
                                            maxLines = 2,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        if (item.authors.isNotEmpty()) {
                                            Text(
                                                item.authors.joinToString(" · "),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                        if (meta.isNotEmpty()) {
                                            Text(
                                                meta,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = if (isActiveAudio || item.progressStatus == "in_progress") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                    val showReadingResume = item.resumeKind == "reading" && item.hasEbook
                                    val showListeningResume = (item.resumeKind == "listening" || isActiveAudio) && item.hasAudiobook
                                    if (showReadingResume || showListeningResume) {
                                        val containerColor = if (isActiveAudio) MaterialTheme.colorScheme.primaryContainer
                                        else MaterialTheme.colorScheme.secondaryContainer
                                        val iconColor = if (isActiveAudio) MaterialTheme.colorScheme.onPrimaryContainer
                                        else MaterialTheme.colorScheme.onSecondaryContainer
                                        val resumeDescription = stringResource(
                                            if (showListeningResume) R.string.books_continue_listening else R.string.books_continue_reading,
                                            item.title,
                                        )
                                        FilledTonalIconButton(
                                            onClick = {
                                                actionError = null
                                                if (showListeningResume) {
                                                    if (isActiveAudio) vm.bookPlayback.togglePlay()
                                                    else vm.bookPlayback.open(item, autoplay = true)
                                                } else {
                                                    selectedId = item.id
                                                    initialSpine = null
                                                    reading = true
                                                }
                                            },
                                            colors = IconButtonDefaults.filledTonalIconButtonColors(
                                                containerColor = containerColor,
                                                contentColor = iconColor,
                                            ),
                                            modifier = Modifier
                                                .size(44.dp)
                                                .focusProperties { canFocus = false }
                                                .testTag("book-card-resume-${item.id}"),
                                        ) {
                                            Icon(
                                                when {
                                                    isActiveAudio -> Icons.Default.GraphicEq
                                                    showListeningResume -> Icons.Default.Headphones
                                                    else -> Icons.AutoMirrored.Filled.MenuBook
                                                },
                                                resumeDescription,
                                                Modifier.size(20.dp),
                                            )
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

@Composable
private fun BookDetailScreen(
    vm: MusicViewModel,
    book: BookSummary,
    allBooks: List<BookSummary>,
    bookPlaybackState: BookPlaybackState,
    canEdit: Boolean,
    canUpload: Boolean,
    uploading: Boolean,
    showEdit: Boolean,
    onToggleEdit: () -> Unit,
    coverRevision: Int,
    actionError: String?,
    onClearError: () -> Unit,
    onBack: () -> Unit,
    onRead: (Int?) -> Unit,
    onListen: (Int?) -> Unit,
    onPickCover: () -> Unit,
    onAttachEbook: () -> Unit,
    onRefreshBook: () -> Unit,
    onReportError: (String) -> Unit,
) {
    val repository = vm.repository
    val scope = rememberCoroutineScope()
    var audioChapters by remember(book.id) { mutableStateOf<List<BookAudioChapter>?>(null) }
    var ebookChapters by remember(book.id) { mutableStateOf<List<BookChapter>?>(null) }
    var chapterTab by rememberSaveable(book.id) {
        mutableStateOf(if (book.hasAudiobook) "audio" else "ebook")
    }
    var chapterReload by remember(book.id) { mutableIntStateOf(0) }
    var editingChapter by remember { mutableStateOf<BookAudioChapter?>(null) }

    LaunchedEffect(book.id, book.hasAudiobook, book.hasEbook, chapterReload) {
        if (book.hasAudiobook) {
            audioChapters = runCatching { repository.api().bookAudio(book.id).chapters }.getOrElse { emptyList() }
        } else {
            audioChapters = emptyList()
        }
        if (book.hasEbook) {
            ebookChapters = runCatching { repository.api().bookManifest(book.id).chapters }.getOrElse { emptyList() }
        } else {
            ebookChapters = emptyList()
        }
    }

    val displayedAudioChapters = if (bookPlaybackState.book?.id == book.id && bookPlaybackState.chapters.isNotEmpty()) {
        bookPlaybackState.chapters
    } else {
        audioChapters
    }
    val statusLabel = progressStatusLabel(book.progressStatus)
    val authorsLine = book.authors.joinToString(" · ")
    val carrierLine = listOfNotNull(
        stringResource(R.string.books_ebook).takeIf { book.hasEbook },
        stringResource(R.string.books_audiobook).takeIf { book.hasAudiobook },
        statusLabel,
    ).joinToString(" · ")

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = onBack,
                contentPadding = PaddingValues(start = 0.dp, end = 12.dp, top = 4.dp, bottom = 4.dp),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.books_back))
            }
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surfaceContainer,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(
                Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    BookCoverThumb(
                        vm = vm,
                        book = book,
                        modifier = Modifier.size(width = 80.dp, height = 112.dp),
                        cornerRadius = 8.dp,
                        monogramSize = 30.sp,
                        cacheRevision = coverRevision,
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            book.title,
                            fontFamily = FontFamily.Serif,
                            fontWeight = FontWeight.Medium,
                            fontSize = 22.sp,
                            lineHeight = 28.sp,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                        book.subtitle?.takeIf { it.isNotBlank() }?.let { sub ->
                            Text(
                                sub,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (authorsLine.isNotBlank()) {
                            Text(
                                authorsLine,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (carrierLine.isNotEmpty()) {
                            Text(
                                carrierLine,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (book.progressStatus == "in_progress") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }

                val isPad = LocalAndroidLayoutMode.current == AndroidLayoutMode.Pad
                if (book.hasEbook || book.hasAudiobook || canEdit || canUpload) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val actionModifier = if (isPad) {
                            Modifier.widthIn(min = 136.dp).height(48.dp)
                        } else {
                            Modifier.weight(1f).height(48.dp)
                        }
                        if (book.hasEbook) {
                            Button(
                                onClick = { onRead(null) },
                                shape = RoundedCornerShape(999.dp),
                                contentPadding = PaddingValues(horizontal = 16.dp),
                                modifier = actionModifier,
                            ) {
                                Icon(Icons.AutoMirrored.Filled.MenuBook, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(stringResource(R.string.books_read), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (book.hasAudiobook) {
                            if (book.hasEbook) {
                                FilledTonalButton(
                                    onClick = { onListen(null) },
                                    shape = RoundedCornerShape(999.dp),
                                    contentPadding = PaddingValues(horizontal = 16.dp),
                                    modifier = actionModifier,
                                ) {
                                    Icon(Icons.Default.Headphones, null, Modifier.size(18.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text(stringResource(R.string.books_listen), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                                }
                            } else {
                                Button(
                                    onClick = { onListen(null) },
                                    shape = RoundedCornerShape(999.dp),
                                    contentPadding = PaddingValues(horizontal = 16.dp),
                                    modifier = actionModifier,
                                ) {
                                    Icon(Icons.Default.Headphones, null, Modifier.size(18.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text(stringResource(R.string.books_listen), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                        if (canEdit || canUpload) {
                            if (isPad) {
                                if (showEdit) {
                                    FilledTonalButton(
                                        onClick = onToggleEdit,
                                        shape = RoundedCornerShape(999.dp),
                                        contentPadding = PaddingValues(horizontal = 16.dp),
                                        modifier = Modifier.height(48.dp).focusProperties { canFocus = false }.testTag("books-edit-toggle"),
                                    ) {
                                        Icon(Icons.Default.Tune, null, Modifier.size(18.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text(stringResource(R.string.books_edit_book), maxLines = 1, softWrap = false)
                                    }
                                } else {
                                    OutlinedButton(
                                        onClick = onToggleEdit,
                                        shape = RoundedCornerShape(999.dp),
                                        contentPadding = PaddingValues(horizontal = 16.dp),
                                        modifier = Modifier.height(48.dp).focusProperties { canFocus = false }.testTag("books-edit-toggle"),
                                    ) {
                                        Icon(Icons.Default.Tune, null, Modifier.size(18.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text(stringResource(R.string.books_edit_book), maxLines = 1, softWrap = false)
                                    }
                                }
                            } else {
                                val editModifier = (if (!book.hasEbook && !book.hasAudiobook) Modifier.weight(1f) else Modifier.size(48.dp))
                                    .focusProperties { canFocus = false }
                                    .testTag("books-edit-toggle")
                                if (showEdit) {
                                    FilledTonalIconButton(onClick = onToggleEdit, modifier = editModifier) {
                                        Icon(Icons.Default.Tune, stringResource(R.string.books_edit_book), Modifier.size(20.dp))
                                    }
                                } else {
                                    OutlinedIconButton(
                                        onClick = onToggleEdit,
                                        modifier = editModifier,
                                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                                    ) {
                                        Icon(Icons.Default.Tune, stringResource(R.string.books_edit_book), Modifier.size(20.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        actionError?.let { msg ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(msg, Modifier.weight(1f), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = onClearError) { Text(stringResource(R.string.books_close)) }
            }
        }

        AnimatedVisibility(visible = showEdit && (canEdit || canUpload)) {
            BookEditCard(
                vm = vm,
                book = book,
                allBooks = allBooks,
                canEdit = canEdit,
                canUpload = canUpload,
                uploading = uploading,
                onPickCover = onPickCover,
                onAttachEbook = onAttachEbook,
                onSaved = onRefreshBook,
                onReportError = onReportError,
            )
        }

        if (book.hasAudiobook || book.hasEbook) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val showAudio = book.hasAudiobook && (!book.hasEbook || chapterTab == "audio")
                    if (book.hasEbook && book.hasAudiobook) {
                        val audioCount = displayedAudioChapters?.size ?: 0
                        val ebookCount = ebookChapters?.size ?: 0
                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.fillMaxWidth().padding(3.dp),
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                listOf(
                                    Triple("audio", R.string.books_audio_chapters_count, audioCount),
                                    Triple("ebook", R.string.books_ebook_contents_count, ebookCount),
                                ).forEach { (tabKey, labelRes, count) ->
                                    val selectedTab = chapterTab == tabKey
                                    Box(
                                        Modifier
                                            .weight(1f)
                                            .heightIn(min = 42.dp)
                                            .clip(RoundedCornerShape(7.dp))
                                            .background(if (selectedTab) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                                            .semantics { selected = selectedTab }
                                            .clickable(role = Role.Tab) { chapterTab = tabKey }
                                            .padding(horizontal = 10.dp, vertical = 8.dp),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            stringResource(labelRes, count),
                                            style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
                                            fontWeight = if (selectedTab) FontWeight.SemiBold else FontWeight.Medium,
                                            color = if (selectedTab) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            softWrap = false,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                        }
                    } else {
                        val total = (if (showAudio) displayedAudioChapters?.size else ebookChapters?.size) ?: 0
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                stringResource(if (showAudio) R.string.books_chapters else R.string.books_contents),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                stringResource(R.string.books_chapter_count, total),
                                style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
                    }

                    if (showAudio) {
                        val list = displayedAudioChapters
                        if (list == null) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                        } else if (list.isEmpty()) {
                            Text(stringResource(R.string.books_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        } else {
                            list.forEach { chapter ->
                                val active = bookPlaybackState.book?.id == book.id && bookPlaybackState.index == chapter.index
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(if (active) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                                        .clickable { onListen(chapter.index) }
                                        .padding(start = 8.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Text(
                                        if (active && bookPlaybackState.playing) "▶" else "%02d".format(chapter.index + 1),
                                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace, fontFeatureSettings = "tnum"),
                                        color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.width(28.dp),
                                    )
                                    Text(
                                        chapter.title,
                                        Modifier.weight(1f),
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        formatTime(chapter.resolvedDurationMs),
                                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontFeatureSettings = "tnum"),
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    if (canEdit) {
                                        IconButton(
                                            onClick = { editingChapter = chapter },
                                            modifier = Modifier.size(48.dp),
                                        ) {
                                            Icon(
                                                Icons.Default.Edit,
                                                stringResource(R.string.books_edit_chapter),
                                                Modifier.size(18.dp),
                                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        val list = ebookChapters
                        if (list == null) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                        } else if (list.isEmpty()) {
                            Text(stringResource(R.string.books_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        } else {
                            list.forEach { chapter ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .clickable { onRead(chapter.index) }
                                        .padding(horizontal = 8.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Text(
                                        "%02d".format(chapter.index + 1),
                                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace, fontFeatureSettings = "tnum"),
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.width(28.dp),
                                    )
                                    Text(
                                        chapter.title,
                                        Modifier.weight(1f),
                                        style = MaterialTheme.typography.bodyMedium,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    editingChapter?.let { target ->
        var chapterTitle by remember(target.index) { mutableStateOf(target.title) }
        var savingChapter by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!savingChapter) editingChapter = null },
            title = { Text(stringResource(R.string.books_edit_chapter)) },
            text = {
                OutlinedTextField(
                    value = chapterTitle,
                    onValueChange = { chapterTitle = it.take(4096) },
                    label = { Text(stringResource(R.string.books_chapter_title_label)) },
                    singleLine = true,
                    enabled = !savingChapter,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !savingChapter && chapterTitle.trim().isNotBlank(),
                    onClick = {
                        val trimmed = chapterTitle.trim()
                        scope.launch {
                            savingChapter = true
                            try {
                                repository.api().updateBookAudioChapter(
                                    book.id,
                                    target.index,
                                    obj("title" to trimmed),
                                    RequestOwner(repository.session.cacheScope()),
                                )
                                vm.bookPlayback.renameChapter(target.index, trimmed)
                                editingChapter = null
                                chapterReload++
                            } catch (cause: CancellationException) {
                                throw cause
                            } catch (cause: Exception) {
                                onReportError(friendlyError(cause))
                            } finally {
                                savingChapter = false
                            }
                        }
                    },
                ) { Text(stringResource(R.string.books_save)) }
            },
            dismissButton = {
                TextButton(enabled = !savingChapter, onClick = { editingChapter = null }) {
                    Text(stringResource(R.string.books_close))
                }
            },
        )
    }
}

@Composable
private fun BookEditCard(
    vm: MusicViewModel,
    book: BookSummary,
    allBooks: List<BookSummary>,
    canEdit: Boolean,
    canUpload: Boolean,
    uploading: Boolean,
    onPickCover: () -> Unit,
    onAttachEbook: () -> Unit,
    onSaved: () -> Unit,
    onReportError: (String) -> Unit,
) {
    val repository = vm.repository
    val scope = rememberCoroutineScope()
    var titleInput by remember(book.id, book.title) { mutableStateOf(book.title) }
    var availableSources by remember {
        mutableStateOf(
            listOf(
                BookMetadataSource("itunes", "Apple iTunes", "builtin", true),
                BookMetadataSource("openlibrary", "Open Library", "builtin", true),
            ),
        )
    }
    var selectedSources by remember(book.id) { mutableStateOf(setOf("itunes", "openlibrary")) }
    var candidates by remember(book.id) { mutableStateOf<List<BookMetadataCandidate>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var mergePickerOpen by remember { mutableStateOf(false) }
    var selectedMergeBook by remember(book.id) { mutableStateOf<BookSummary?>(null) }

    LaunchedEffect(book.id, canEdit) {
        if (!canEdit) return@LaunchedEffect
        runCatching { repository.api().bookMetadataSources().items }.onSuccess { items ->
            availableSources = items
            selectedSources = items.map { it.id }.toSet()
        }
    }

    val isPad = LocalAndroidLayoutMode.current == AndroidLayoutMode.Pad
    val pairable = remember(book, allBooks) {
        allBooks.filter { other ->
            other.id != book.id &&
                other.libraryId == book.libraryId &&
                other.hasEbook != book.hasEbook &&
                other.hasAudiobook != book.hasAudiobook
        }
    }

    Surface(
        modifier = Modifier.fillMaxWidth().testTag("books-edit-panel"),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (canEdit) {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = titleInput,
                        onValueChange = { titleInput = it.take(1000) },
                        label = { Text(stringResource(R.string.books_book_title_label)) },
                        singleLine = true,
                        enabled = !busy,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        enabled = !busy && titleInput.trim().isNotBlank(),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.padding(top = 6.dp).heightIn(min = 52.dp),
                        onClick = {
                            scope.launch {
                                busy = true
                                try {
                                    repository.api().updateBookMetadata(
                                        book.id,
                                        obj("title" to titleInput.trim()),
                                        RequestOwner(repository.session.cacheScope()),
                                    )
                                    onSaved()
                                } catch (cause: CancellationException) {
                                    throw cause
                                } catch (cause: Exception) {
                                    onReportError(friendlyError(cause))
                                } finally {
                                    busy = false
                                }
                            }
                        },
                    ) { Text(stringResource(R.string.books_save)) }
                }

                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        stringResource(R.string.books_metadata_search),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    val sourceSelector: @Composable (Modifier) -> Unit = { selectorModifier ->
                        if (availableSources.isEmpty()) {
                            Text(
                                stringResource(R.string.books_metadata_no_sources),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = selectorModifier,
                            )
                        } else {
                            FlowRow(
                                modifier = selectorModifier,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                availableSources.forEach { source ->
                                    val chosen = source.id in selectedSources
                                    FilterChip(
                                        selected = chosen,
                                        enabled = !busy,
                                        onClick = {
                                            selectedSources = if (chosen) selectedSources - source.id else selectedSources + source.id
                                        },
                                        label = { Text(source.name, maxLines = 1, softWrap = false) },
                                        leadingIcon = if (chosen) {
                                            { Icon(Icons.Default.Check, null, Modifier.size(16.dp)) }
                                        } else null,
                                        modifier = Modifier.focusProperties { canFocus = false }.testTag("books-source-chip-${source.id}"),
                                    )
                                }
                            }
                        }
                    }
                    val runMetadataSearch: () -> Unit = {
                        val activeSources = availableSources
                            .map { it.id }
                            .filter { it in selectedSources }
                            .joinToString(",")
                        if (activeSources.isNotEmpty()) scope.launch {
                            busy = true
                            try {
                                candidates = repository.api().searchBookMetadata(
                                    id = book.id,
                                    sources = activeSources,
                                    q = titleInput.trim().takeIf { it.isNotEmpty() },
                                ).items
                            } catch (cause: CancellationException) {
                                throw cause
                            } catch (cause: Exception) {
                                onReportError(friendlyError(cause))
                            } finally {
                                busy = false
                            }
                        }
                    }
                    if (isPad) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            sourceSelector(Modifier.weight(1f))
                            FilledTonalButton(
                                enabled = !busy && selectedSources.isNotEmpty(),
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.widthIn(min = 132.dp).heightIn(min = 46.dp).testTag("books-metadata-search-btn"),
                                onClick = runMetadataSearch,
                            ) {
                                Icon(Icons.Default.Search, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(stringResource(R.string.books_search))
                            }
                        }
                    } else {
                        sourceSelector(Modifier.fillMaxWidth())
                        FilledTonalButton(
                            enabled = !busy && selectedSources.isNotEmpty(),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp).testTag("books-metadata-search-btn"),
                            onClick = runMetadataSearch,
                        ) {
                            Icon(Icons.Default.Search, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(stringResource(R.string.books_search))
                        }
                    }
                    candidates?.let { list ->
                        if (list.isEmpty()) {
                            Text(
                                stringResource(R.string.books_metadata_empty),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.testTag("books-metadata-empty"),
                            )
                        } else {
                            list.take(8).forEach { candidate ->
                                val candTitle = candidate.fields.get("title")?.takeUnless { it.isJsonNull }?.asString.orEmpty()
                                val candAuthors = candidate.fields.getAsJsonArray("authors")
                                    ?.mapNotNull { it.takeIf { elem -> elem.isJsonPrimitive }?.asString }
                                    .orEmpty()
                                val metaLine = listOfNotNull(
                                    candAuthors.joinToString(" · ").takeIf { it.isNotBlank() },
                                    candidate.providerName?.takeIf { it.isNotBlank() } ?: candidate.provider.takeIf { it.isNotBlank() },
                                ).joinToString(" · ")
                                Surface(
                                    onClick = {
                                        scope.launch {
                                            busy = true
                                            try {
                                                repository.api().updateBookMetadata(
                                                    book.id,
                                                    candidate.fields,
                                                    RequestOwner(repository.session.cacheScope()),
                                                )
                                                candidates = null
                                                onSaved()
                                            } catch (cause: CancellationException) {
                                                throw cause
                                            } catch (cause: Exception) {
                                                onReportError(friendlyError(cause))
                                            } finally {
                                                busy = false
                                            }
                                        }
                                    },
                                    shape = RoundedCornerShape(10.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(candTitle, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                                        if (metaLine.isNotEmpty()) {
                                            Text(
                                                metaLine,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (canUpload) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val uploadActionModifier = if (isPad) {
                        Modifier.widthIn(min = 148.dp).heightIn(min = 46.dp)
                    } else {
                        Modifier.weight(1f).heightIn(min = 46.dp)
                    }
                    OutlinedButton(
                        enabled = !uploading && !busy,
                        shape = RoundedCornerShape(10.dp),
                        modifier = uploadActionModifier,
                        onClick = onPickCover,
                    ) {
                        Text(
                            stringResource(R.string.books_cover),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (!book.hasEbook) {
                        OutlinedButton(
                            enabled = !uploading && !busy,
                            shape = RoundedCornerShape(10.dp),
                            modifier = uploadActionModifier,
                            onClick = onAttachEbook,
                        ) {
                            Text(
                                stringResource(R.string.books_upload),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }

                if (book.hasEbook && book.hasAudiobook) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.books_carrier_split_label), style = MaterialTheme.typography.labelLarge)
                            Text(
                                stringResource(R.string.books_carrier_merged_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        OutlinedButton(
                            enabled = !busy,
                            modifier = Modifier.heightIn(min = 48.dp),
                            onClick = {
                                scope.launch {
                                    busy = true
                                    try {
                                        repository.api().splitBook(
                                            book.id,
                                            obj("carrier" to "audiobook"),
                                            RequestOwner(repository.session.cacheScope()),
                                        )
                                        onSaved()
                                    } catch (cause: CancellationException) {
                                        throw cause
                                    } catch (cause: Exception) {
                                        onReportError(friendlyError(cause))
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                        ) { Text(stringResource(R.string.books_split_formats)) }
                    }
                } else if (pairable.isNotEmpty()) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    Text(stringResource(R.string.books_carrier_pair_label), style = MaterialTheme.typography.labelLarge)
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(Modifier.weight(1f)) {
                            OutlinedButton(
                                onClick = { mergePickerOpen = true },
                                enabled = !busy,
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            ) {
                                Text(
                                    selectedMergeBook?.title ?: stringResource(
                                        if (book.hasAudiobook) R.string.books_select_ebook_merge
                                        else R.string.books_select_audiobook_merge,
                                    ),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Icon(Icons.Default.ArrowDropDown, null)
                            }
                            DropdownMenu(mergePickerOpen, { mergePickerOpen = false }) {
                                pairable.forEach { candidate ->
                                    DropdownMenuItem(
                                        text = { Text(candidate.title) },
                                        onClick = {
                                            selectedMergeBook = candidate
                                            mergePickerOpen = false
                                        },
                                    )
                                }
                            }
                        }
                        Button(
                            enabled = !busy && selectedMergeBook != null,
                            modifier = Modifier.heightIn(min = 48.dp),
                            onClick = {
                                val target = selectedMergeBook ?: return@Button
                                scope.launch {
                                    busy = true
                                    try {
                                        repository.api().pairBook(
                                            book.id,
                                            obj("other_book_id" to target.id),
                                            RequestOwner(repository.session.cacheScope()),
                                        )
                                        selectedMergeBook = null
                                        onSaved()
                                    } catch (cause: CancellationException) {
                                        throw cause
                                    } catch (cause: Exception) {
                                        onReportError(friendlyError(cause))
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                        ) { Text(stringResource(R.string.books_pair_action)) }
                    }
                }
            }
        }
    }
}

private fun annotationHighlightColorOrNull(color: String): Color? = when (color) {
    "amber" -> Color(0xFFECCB84)
    "terracotta" -> Color(0xFFE1AD99)
    "sage" -> Color(0xFFC1C8AA)
    "stone" -> Color(0xFFD4C8BB)
    else -> null
}

@Composable
internal fun BookChoicePill(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    swatchColor: Color? = null,
    trailingIcon: ImageVector? = null,
) {
    val bg = if (selected) MaterialTheme.colorScheme.secondaryContainer
    else MaterialTheme.colorScheme.surfaceContainerLow
    val borderColor = if (selected) MaterialTheme.colorScheme.secondary.copy(alpha = 0.45f)
    else MaterialTheme.colorScheme.outlineVariant
    val textColor = if (selected) MaterialTheme.colorScheme.onSecondaryContainer
    else MaterialTheme.colorScheme.onSurface
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = modifier
            .heightIn(min = 40.dp)
            .clip(shape)
            .background(bg)
            .border(1.dp, borderColor, shape)
            .focusProperties { canFocus = false }
            .semantics { this.selected = selected }
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(start = 12.dp, end = if (trailingIcon != null) 6.dp else 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (swatchColor != null) {
            Box(
                Modifier
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(swatchColor)
                    .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape),
            )
        }
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            color = textColor,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
        )
        if (trailingIcon != null) {
            Icon(
                trailingIcon,
                null,
                Modifier.size(18.dp),
                tint = textColor.copy(alpha = 0.78f),
            )
        }
    }
}

private enum class PanelMode { CONTENTS, NOTES, MARKS, ANNOTATIONS, SEARCH }

@Composable
private fun BookReading(
    vm: MusicViewModel,
    book: BookSummary,
    images: ImageLoader,
    initialSpine: Int?,
    suppressSystemBars: Boolean = false,
    onExpandAudioPlayer: () -> Unit = {},
    onBack: () -> Unit,
) {
    val repository = vm.repository
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val bookPlaybackState by vm.bookPlayback.state.collectAsStateWithLifecycle()
    val isThisBookAudio = book.hasAudiobook && bookPlaybackState.book?.id == book.id
    var showAudioBar by rememberSaveable(book.id) {
        mutableStateOf(isThisBookAudio && (bookPlaybackState.playing || bookPlaybackState.loading))
    }
    LaunchedEffect(book.id, isThisBookAudio, bookPlaybackState.playing) {
        if (isThisBookAudio && bookPlaybackState.playing) showAudioBar = true
    }
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
    var spine by rememberSaveable(book.id, initialSpine) { mutableIntStateOf(initialSpine ?: 0) }
    var pendingInitialSpine by remember(book.id, initialSpine) { mutableStateOf(initialSpine) }
    var blocks by remember(book.id) { mutableStateOf<List<BookBlock>?>(null) }
    var imageSizes by remember(book.id) { mutableStateOf<Map<String, BookImageSize>>(emptyMap()) }
    var paged by rememberSaveable(book.id) { mutableStateOf(false) }
    var dark by rememberSaveable(book.id) { mutableStateOf(appDark) }
    var serif by rememberSaveable(book.id) { mutableStateOf(true) }
    var size by rememberSaveable(book.id) { mutableFloatStateOf(18f) }
    var anchor by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var charOffset by rememberSaveable(book.id) { mutableIntStateOf(0) }
    var error by remember(book.id) { mutableStateOf(false) }
    var syncConflict by remember(book.id) { mutableStateOf(false) }
    var reloadReader by remember(book.id) { mutableIntStateOf(0) }
    var showTools by remember(book.id) { mutableStateOf(false) }
    var immersive by rememberSaveable(book.id) { mutableStateOf(false) }
    var showPanel by remember(book.id) { mutableStateOf(false) }
    var panelMode by remember(book.id) { mutableStateOf(PanelMode.CONTENTS) }
    var marks by remember(book.id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var annotations by remember(book.id, owner) { mutableStateOf<List<BookAnnotation>>(emptyList()) }
    var searchQuery by remember(book.id) { mutableStateOf("") }
    var searchMatches by remember(book.id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selection by remember(book.id, spine) { mutableStateOf<BookSelection?>(null) }
    var annotation by remember(book.id) { mutableStateOf<BookSelection?>(null) }
    var editingAnnotation by remember(book.id) { mutableStateOf<BookAnnotation?>(null) }
    var jump by remember(book.id) { mutableIntStateOf(0) }
    val palette = if (dark) Color(0xFF181614) else Color(0xFFF6F3ED)
    val ink = if (dark) Color(0xFFE8E3D9) else Color(0xFF2A2B25)

    fun savePosition(index: Int, offset: Int = 0, completed: Boolean = false) {
        anchor = index
        charOffset = offset
        val payload = JsonObject().apply {
            addProperty("spine_index", spine)
            addProperty("block_index", index)
            addProperty("char_offset", offset)
            addProperty("reading_mode", if (paged) "paginated" else "scroll")
            addProperty("completed", completed)
        }
        scope.launch {
            try { sync.save(payload) } catch (cause: CancellationException) { throw cause }
            catch (cause: HttpException) {
                if (cause.code() == 409) syncConflict = true else error = true
            } catch (cause: Exception) { if (cause !is IOException) error = true }
        }
    }

    LaunchedEffect(book.id, owner, reloadReader) {
        error = false
        syncConflict = false
        try {
            val data = try {
                repository.api().bookManifest(book.id).also { next ->
                    if (owner != null) {
                        repository.database.books().saveChapters(
                            next.chapters.map { BookEbookChapterMetaEntity(owner, book.id, it.index, it.title, next.sha256) },
                        )
                    }
                }
            } catch (cause: IOException) {
                val cache = owner?.let { repository.database.books().chapters(it, book.id) }.orEmpty()
                if (cache.isEmpty()) throw cause
                BookManifest(cache.map { BookChapter(it.spineIndex, it.title) }, cache.first().cacheKey)
            }
            val progress = sync.load()
            if (progress.version > 0) {
                paged = progress.mode == "paginated"
            }
            val explicitTarget = pendingInitialSpine
            if (explicitTarget != null) {
                pendingInitialSpine = null
                spine = explicitTarget
                anchor = 0
                charOffset = 0
                savePosition(0, 0)
            } else if (progress.version > 0) {
                spine = progress.spine
                anchor = progress.block
                charOffset = progress.offset
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
        runCatching {
            marks = repository.api().bookBookmarks(book.id).items.filter { it.get("kind")?.asString == "ebook" }
        }
    }

    LaunchedEffect(manifest, spine, reloadReader) {
        val data = manifest ?: return@LaunchedEffect
        blocks = null
        imageSizes = emptyMap()
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
            } catch (_: IOException) {
                withContext(Dispatchers.IO) { gson.fromJson(file.readText(), BookChapterContent::class.java) }
            }
            val assetKeys = content.blocks.mapNotNull { it.imageKey }.distinct()
            if (assetKeys.isNotEmpty()) {
                val base = repository.url("api", "v1", "books", book.id, "ebook", "assets")
                val cacheScope = "$owner:${book.id}:${data.sha256}"
                suspend fun resolveAssetSize(key: String): BookImageSize? = try {
                    val req = ImageRequest.Builder(context)
                        .data("$base/$key")
                        .diskCacheKey("$cacheScope:$key")
                        .memoryCacheKey("$cacheScope:$key")
                        .size(Size.ORIGINAL)
                        .build()
                    val drawable = images.execute(req).drawable
                    val bmp = (drawable as? BitmapDrawable)?.bitmap
                    val w = bmp?.width ?: drawable?.intrinsicWidth ?: 0
                    val h = bmp?.height ?: drawable?.intrinsicHeight ?: 0
                    if (w > 0 && h > 0) BookImageSize(w, h) else null
                } catch (cause: CancellationException) {
                    throw cause
                } catch (_: Exception) {
                    null
                }
                val quick = withTimeoutOrNull(300L) {
                    assetKeys.map { key -> async { key to resolveAssetSize(key) } }
                        .awaitAll()
                        .mapNotNull { (k, v) -> v?.let { k to it } }
                        .toMap()
                }.orEmpty()
                imageSizes = quick
                if (quick.size < assetKeys.size) {
                    val remainingKeys = assetKeys.filter { it !in quick }
                    launch {
                        val rest = remainingKeys.map { key -> async { key to resolveAssetSize(key) } }
                            .awaitAll()
                            .mapNotNull { (k, v) -> v?.let { k to it } }
                            .toMap()
                        if (rest.isNotEmpty()) imageSizes = imageSizes + rest
                    }
                }
            }
            blocks = content.blocks
        } catch (cause: CancellationException) {
            throw cause
        } catch (_: Exception) {
            error = true
        }
    }

    val totalChapters = manifest?.chapters?.size ?: 0
    val activeChapterTitle = manifest?.chapters?.getOrNull(spine)?.title ?: book.title
    val window = LocalActivity.current?.window
    val view = LocalView.current

    DisposableEffect(window, view, dark, appDark, suppressSystemBars) {
        val lightBars = if (suppressSystemBars) !appDark else !dark
        window?.let {
            WindowCompat.getInsetsController(it, view).apply {
                isAppearanceLightStatusBars = lightBars
                isAppearanceLightNavigationBars = lightBars
            }
        }
        onDispose {
            window?.let {
                WindowCompat.getInsetsController(it, view).apply {
                    isAppearanceLightStatusBars = !appDark
                    isAppearanceLightNavigationBars = !appDark
                }
            }
        }
    }

    CompositionLocalProvider(LocalDarkAppearance provides dark) {
        MaterialTheme(colorScheme = if (dark) classicDarkColors else classicLightColors) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(palette)
                    .windowInsetsPadding(WindowInsets.safeDrawing),
            ) {
                val handleStageTap by rememberUpdatedState(newValue = { hadSelectionBeforeTap: Boolean ->
                    if (hadSelectionBeforeTap) {
                        selection = null
                        focus.clearFocus()
                    } else if (showTools) {
                        selection = null
                        focus.clearFocus()
                        showTools = false
                    } else {
                        selection = null
                        focus.clearFocus()
                        immersive = !immersive
                    }
                })
                val toggleImmersiveLabel = stringResource(
                    if (immersive) R.string.books_exit_fullscreen else R.string.books_fullscreen,
                )
                BoxWithConstraints(
                    Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) { detectTapGestures { handleStageTap(selection != null) } },
                ) {
                    val wide = maxWidth >= 728.dp && maxHeight >= 480.dp
                    val topInset = 56.dp
                    val audioBarOpen = book.hasAudiobook && showAudioBar

                    Column(
                        Modifier
                            .widthIn(max = 760.dp)
                            .fillMaxHeight()
                            .fillMaxWidth()
                            .align(Alignment.TopCenter)
                            .padding(horizontal = 20.dp)
                            .semantics {
                                customActions = listOf(
                                    CustomAccessibilityAction(toggleImmersiveLabel) {
                                        showTools = false
                                        immersive = !immersive
                                        true
                                    },
                                )
                            }
                            .testTag("book-reader-stage"),
                    ) {
                        if (syncConflict) {
                            Row(
                                Modifier.padding(top = topInset),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(stringResource(R.string.books_sync_conflict), Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                                TextButton(onClick = { reloadReader++ }) { Text(stringResource(R.string.books_retry)) }
                            }
                        } else if (error) {
                            Row(
                                Modifier.padding(top = topInset),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(stringResource(R.string.books_error), Modifier.weight(1f), color = ink)
                                TextButton(onClick = { reloadReader++ }) { Text(stringResource(R.string.books_retry)) }
                            }
                        }

                        val chapter = blocks
                        if (chapter == null && !error) {
                            LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = topInset))
                        }
                        if (!chapter.isNullOrEmpty()) {
                            val highlights = annotations.filter { it.spine == spine }
                            val imageBase = repository.url("api", "v1", "books", book.id, "ebook", "assets")
                            val imageScope = "$owner:${book.id}:${manifest?.sha256}"
                            BoxWithConstraints(
                                Modifier
                                    .weight(1f)
                                    .fillMaxWidth()
                                    .padding(top = if (paged) topInset else 0.dp),
                            ) {
                                val density = LocalDensity.current
                                val measurer = rememberTextMeasurer()
                                val width = with(density) { maxWidth.roundToPx() }.coerceAtLeast(1)
                                val height = with(density) { maxHeight.roundToPx() }.coerceAtLeast(1)
                                if (paged) {
                                    val gap = with(density) { 8.dp.roundToPx() }
                                    val companionTextHeightDp = with(density) {
                                        (MaterialTheme.typography.labelLarge.lineHeight.toPx() +
                                            MaterialTheme.typography.labelSmall.lineHeight.toPx()).toDp()
                                    }
                                    val footerSpaceDp = 2.dp + 12.dp + maxOf(44.dp, companionTextHeightDp + 9.dp) + 8.dp
                                    val footerSpacePx = with(density) { footerSpaceDp.roundToPx() }
                                    val pageHeight = (height - footerSpacePx).coerceAtLeast(1)
                                    val pages = remember(chapter, size, serif, width, pageHeight, gap, measurer, imageSizes, density.density) {
                                        measurePages(chapter, measurer, size, width, pageHeight, gap, serif, imageSizes, density.density)
                                    }
                                    val startPage = pages.indexOfLast { page ->
                                        page.isNotEmpty() && (page.first().block.index < anchor ||
                                            (page.first().block.index == anchor && page.first().offset <= charOffset))
                                    }.coerceAtLeast(0)
                                    val pager = rememberPagerState(initialPage = startPage) { pages.size }
                                    val latestSpine by rememberUpdatedState(spine)
                                    val latestTotal by rememberUpdatedState(totalChapters)
                                    val latestLastPage by rememberUpdatedState(pages.lastIndex)
                                    val edgeThresholdPx = with(density) { 72.dp.toPx() }
                                    val chapterBoundaryConnection = remember(pager, edgeThresholdPx) {
                                        object : NestedScrollConnection {
                                            private var edgePullPx = 0f

                                            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                                                if (available.x * edgePullPx < 0f) edgePullPx = 0f
                                                return Offset.Zero
                                            }

                                            override fun onPostScroll(
                                                consumed: Offset,
                                                available: Offset,
                                                source: NestedScrollSource,
                                            ): Offset {
                                                if (source == NestedScrollSource.UserInput && latestTotal > 1) {
                                                    val atStart = pager.settledPage == 0 && latestSpine > 0 && available.x > 0f
                                                    val atEnd = pager.settledPage == latestLastPage &&
                                                        latestSpine < latestTotal - 1 && available.x < 0f
                                                    if (atStart || atEnd) {
                                                        edgePullPx += available.x
                                                    }
                                                }
                                                return Offset.Zero
                                            }

                                            override suspend fun onPreFling(available: Velocity): Velocity {
                                                val pulled = edgePullPx
                                                edgePullPx = 0f
                                                if (latestTotal > 1) {
                                                    if (pulled < -edgeThresholdPx && pager.settledPage == latestLastPage &&
                                                        latestSpine < latestTotal - 1
                                                    ) {
                                                        spine++
                                                        savePosition(0)
                                                        jump++
                                                    } else if (pulled > edgeThresholdPx && pager.settledPage == 0 && latestSpine > 0) {
                                                        spine--
                                                        savePosition(0)
                                                        jump++
                                                    }
                                                }
                                                return Velocity.Zero
                                            }

                                            override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
                                                edgePullPx = 0f
                                                return Velocity.Zero
                                            }
                                        }
                                    }
                                    LaunchedEffect(pager, pages, jump) {
                                        pager.scrollToPage(startPage.coerceIn(pages.indices))
                                        snapshotFlow { pager.settledPage }.drop(1).collect { page ->
                                            val isLastPage = spine >= totalChapters - 1 && page >= pages.lastIndex
                                            pages[page].firstOrNull()?.let { savePosition(it.block.index, it.offset, completed = isLastPage) }
                                        }
                                    }
                                    Column(Modifier.fillMaxSize()) {
                                        HorizontalPager(
                                            pager,
                                            Modifier
                                                .fillMaxWidth()
                                                .weight(1f)
                                                .nestedScroll(chapterBoundaryConnection)
                                                .testTag("book-reader-pager"),
                                        ) { page ->
                                            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                                pages[page].forEach { piece ->
                                                    val image = piece.block.imageKey
                                                    if (image != null) {
                                                        BookImage(
                                                            images,
                                                            "$imageBase/$image",
                                                            "$imageScope:$image",
                                                            Modifier
                                                                .fillMaxWidth()
                                                                .height(with(density) { piece.imageHeight.toDp() }),
                                                        )
                                                    } else {
                                                        BookParagraph(
                                                            piece = piece,
                                                            size = size,
                                                            ink = ink,
                                                            serif = serif,
                                                            highlights = highlights,
                                                            hasActiveSelection = selection != null,
                                                            onTap = { hadSelection -> handleStageTap(hadSelection) },
                                                        ) { selection = it }
                                                    }
                                                }
                                            }
                                        }
                                        Box(
                                            Modifier.fillMaxWidth().height(footerSpaceDp),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            val hideForAudio = audioBarOpen && !immersive
                                            Text(
                                                "${pager.currentPage + 1} / ${pages.size}",
                                                modifier = Modifier
                                                    .graphicsLayer { alpha = if (hideForAudio) 0f else 1f }
                                                    .testTag("book-reader-page-indicator"),
                                                style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum"),
                                                color = ink.copy(alpha = 0.58f),
                                            )
                                        }
                                    }
                                } else {
                                    val list = rememberLazyListState(initialFirstVisibleItemIndex = anchor.coerceIn(chapter.indices))
                                    fun textLayout(block: BookBlock) = measurer.measure(
                                        block.text,
                                        bookStyle(block, size, serif),
                                        constraints = Constraints(maxWidth = width),
                                    )
                                    LaunchedEffect(list, chapter, size, serif, width, height, jump) {
                                        val index = anchor.coerceIn(chapter.indices)
                                        val block = chapter[index]
                                        val top = if (charOffset > 0 && block.text.isNotEmpty()) {
                                            val position = block.text.offsetByCodePoints(
                                                0,
                                                charOffset.coerceAtMost(block.text.codePointCount(0, block.text.length)),
                                            )
                                            val layout = textLayout(block)
                                            layout.getLineTop(layout.getLineForOffset(position)).toInt()
                                        } else 0
                                        list.scrollToItem(index, top)
                                        snapshotFlow {
                                            if (list.isScrollInProgress) null
                                            else {
                                                val lastBlock = list.layoutInfo.visibleItemsInfo.firstOrNull { it.index == chapter.lastIndex }
                                                val atBottom = spine >= totalChapters - 1 &&
                                                    lastBlock != null &&
                                                    (lastBlock.offset + lastBlock.size) <= list.layoutInfo.viewportEndOffset + 4
                                                Triple(list.firstVisibleItemIndex.coerceIn(chapter.indices), list.firstVisibleItemScrollOffset, atBottom)
                                            }
                                        }.drop(1).filterNotNull().distinctUntilChanged().collect { (item, offset, atBottom) ->
                                            val first = chapter[item]
                                            val chars = if (list.firstVisibleItemIndex < chapter.size && offset > 0 && first.text.isNotEmpty()) {
                                                val layout = textLayout(first)
                                                first.text.codePointCount(0, layout.getLineStart(layout.getLineForVerticalPosition(offset.toFloat())))
                                            } else 0
                                            savePosition(first.index, chars, completed = atBottom)
                                        }
                                    }
                                    LazyColumn(
                                        Modifier.fillMaxSize(),
                                        state = list,
                                        contentPadding = PaddingValues(top = topInset, bottom = if (audioBarOpen && !immersive) 88.dp else 28.dp),
                                        verticalArrangement = Arrangement.spacedBy(12.dp),
                                    ) {
                                        items(chapter, key = { it.index }) { block ->
                                            val image = block.imageKey
                                            if (image != null) {
                                                val scrollImgHeightPx = computeBookImageHeight(width, height, imageSizes[image], density.density)
                                                BookImage(
                                                    images,
                                                    "$imageBase/$image",
                                                    "$imageScope:$image",
                                                    Modifier
                                                        .fillMaxWidth()
                                                        .let { mod ->
                                                            if (imageSizes.containsKey(image)) mod.height(with(density) { scrollImgHeightPx.toDp() })
                                                            else mod.heightIn(max = with(density) { (height * 0.55f).roundToInt().coerceAtLeast(1).toDp() })
                                                        },
                                                )
                                            } else {
                                                BookParagraph(
                                                    piece = PagePiece(block, 0),
                                                    size = size,
                                                    ink = ink,
                                                    serif = serif,
                                                    highlights = highlights,
                                                    hasActiveSelection = selection != null,
                                                    onTap = { hadSelection -> handleStageTap(hadSelection) },
                                                ) { selection = it }
                                            }
                                        }
                                        if (totalChapters > 1) {
                                            item(key = "chapter-nav-footer") {
                                                Column(
                                                    Modifier
                                                        .fillMaxWidth()
                                                        .padding(top = 20.dp, bottom = 12.dp)
                                                        .testTag("book-reader-chapter-footer"),
                                                    verticalArrangement = Arrangement.spacedBy(12.dp),
                                                ) {
                                                    HorizontalDivider(
                                                        thickness = 0.5.dp,
                                                        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
                                                    )
                                                    Row(
                                                        Modifier.fillMaxWidth(),
                                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                                        verticalAlignment = Alignment.CenterVertically,
                                                    ) {
                                                        if (spine > 0) {
                                                            OutlinedButton(
                                                                onClick = { spine--; savePosition(0); jump++ },
                                                                shape = RoundedCornerShape(10.dp),
                                                                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                                                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                                                            ) {
                                                                Text(stringResource(R.string.books_prev_chapter), maxLines = 1, softWrap = false)
                                                            }
                                                        } else {
                                                            Spacer(Modifier.weight(1f))
                                                        }
                                                        Text(
                                                            "${spine + 1} / $totalChapters",
                                                            style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                                                            color = ink.copy(alpha = 0.65f),
                                                        )
                                                        if (spine < totalChapters - 1) {
                                                            FilledTonalButton(
                                                                onClick = { spine++; savePosition(0); jump++ },
                                                                shape = RoundedCornerShape(10.dp),
                                                                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                                                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                                                            ) {
                                                                Text(stringResource(R.string.books_next_chapter), maxLines = 1, softWrap = false)
                                                            }
                                                        } else {
                                                            Spacer(Modifier.weight(1f))
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                if (selection != null) {
                                    Surface(
                                        Modifier.align(Alignment.BottomCenter)
                                            .padding(bottom = if (audioBarOpen && !immersive) 84.dp else 44.dp)
                                            .pointerInput(Unit) { detectTapGestures {} },
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
                            }
                        }
                    }

                    BookReaderToolbar(
                        visible = showTools && !immersive,
                        animate = animateReaderUi,
                        close = { showTools = false },
                        contentMaxWidth = 760.dp,
                        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 52.dp),
                    ) {
                        FlowRow(
                            Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            TextButton(onClick = { size = (size - 1).coerceAtLeast(14f) }) { Text("A−") }
                            TextButton(onClick = { size = (size + 1).coerceAtMost(24f) }) { Text("A+") }
                            TextButton(onClick = { serif = !serif }) {
                                Text(stringResource(if (serif) R.string.books_font_serif else R.string.books_font_sans))
                            }
                            TextButton(onClick = {
                                focus.clearFocus()
                                selection = null
                                paged = !paged
                                if (blocks != null) savePosition(anchor, charOffset)
                            }) {
                                Text(
                                    stringResource(if (paged) R.string.books_pages else R.string.books_scroll),
                                    fontWeight = if (paged) FontWeight.SemiBold else FontWeight.Medium,
                                )
                            }
                            TextButton(onClick = { dark = !dark }) {
                                Text(
                                    stringResource(R.string.books_dark),
                                    color = if (dark) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontWeight = if (dark) FontWeight.SemiBold else FontWeight.Medium,
                                )
                            }
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
                                        val excerpt = if (raw.isNotBlank()) {
                                            val cpCount = raw.codePointCount(0, raw.length)
                                            val startUtf = raw.offsetByCodePoints(0, charOffset.coerceIn(0, cpCount))
                                            raw.substring(startUtf).ifEmpty { raw }.take(100)
                                        } else {
                                            (blocks?.drop(anchor)?.firstOrNull { it.text.isNotBlank() }?.text ?: activeChapterTitle).take(100)
                                        }
                                        val saved = repository.api().addBookBookmark(
                                            book.id,
                                            JsonObject().apply {
                                                addProperty("kind", "ebook")
                                                addProperty("spine_index", spine)
                                                addProperty("block_index", anchor)
                                                addProperty("char_offset", charOffset)
                                                addProperty("excerpt", excerpt)
                                            },
                                            RequestOwner(repository.session.cacheScope()),
                                        )
                                        marks = marks + saved
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
                                panelMode = PanelMode.NOTES
                                showPanel = true
                            }) { Text(stringResource(R.string.books_notes)) }
                            TextButton(onClick = {
                                showTools = false
                                panelMode = PanelMode.SEARCH
                                showPanel = true
                            }) { Text(stringResource(R.string.books_search)) }
                            if (book.hasAudiobook) {
                                TextButton(onClick = {
                                    showTools = false
                                    showAudioBar = true
                                    vm.bookPlayback.open(book, autoplay = true)
                                }) { Text(stringResource(R.string.books_listen)) }
                            }
                        }
                    }

                    BookReaderChrome(
                        visible = !immersive,
                        animate = animateReaderUi,
                        showBottomBar = audioBarOpen,
                        onTopBarTap = if (showTools) ({ showTools = false }) else null,
                        topBar = {
                            Column(Modifier.fillMaxWidth().background(palette)) {
                                Row(
                                    Modifier
                                        .widthIn(max = 760.dp)
                                        .fillMaxWidth()
                                        .align(Alignment.CenterHorizontally)
                                        .padding(horizontal = 8.dp, vertical = 2.dp),
                                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    IconButton(
                                        onClick = onBack,
                                        modifier = Modifier.size(48.dp).focusProperties { canFocus = false },
                                    ) {
                                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.books_back), tint = ink)
                                    }
                                    Text(
                                        activeChapterTitle,
                                        color = ink,
                                        style = MaterialTheme.typography.titleSmall,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f).padding(end = 4.dp),
                                    )
                                    TextButton(
                                        onClick = {
                                            showTools = false
                                            panelMode = PanelMode.CONTENTS
                                            showPanel = true
                                        },
                                        modifier = Modifier.focusProperties { canFocus = false },
                                        contentPadding = PaddingValues(horizontal = 8.dp),
                                    ) { Text(stringResource(R.string.books_contents), maxLines = 1, softWrap = false) }
                                    if (book.hasAudiobook) {
                                        val audioHighlighted = showAudioBar || (isThisBookAudio && bookPlaybackState.playing)
                                        IconButton(
                                            onClick = {
                                                showTools = false
                                                if (!showAudioBar) {
                                                    showAudioBar = true
                                                    if (!isThisBookAudio) {
                                                        vm.bookPlayback.open(book, autoplay = true)
                                                    }
                                                } else {
                                                    showAudioBar = false
                                                }
                                            },
                                            modifier = Modifier
                                                .size(48.dp)
                                                .focusProperties { canFocus = false }
                                                .testTag("book-reader-audio-toggle"),
                                        ) {
                                            Icon(
                                                Icons.Default.Headphones,
                                                stringResource(R.string.books_companion_audio),
                                                tint = if (audioHighlighted) MaterialTheme.colorScheme.primary else ink,
                                            )
                                        }
                                    }
                                    IconButton(
                                        onClick = { showTools = !showTools },
                                        enabled = !blocks.isNullOrEmpty(),
                                        modifier = Modifier
                                            .size(48.dp)
                                            .focusProperties { canFocus = false }
                                            .semantics { selected = showTools },
                                    ) {
                                        Icon(
                                            Icons.Default.MoreHoriz,
                                            stringResource(R.string.books_tools),
                                            tint = if (showTools) MaterialTheme.colorScheme.primary else ink,
                                        )
                                    }
                                }
                                HorizontalDivider(
                                    thickness = 0.5.dp,
                                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                                )
                            }
                        },
                        bottomBar = if (book.hasAudiobook) {
                            {
                                BookCompanionAudioBar(
                                    vm = vm,
                                    book = book,
                                    bookPlaybackState = bookPlaybackState,
                                    isThisBookAudio = isThisBookAudio,
                                    palette = palette,
                                    ink = ink,
                                    onExpandPlayer = onExpandAudioPlayer,
                                    onHide = { showAudioBar = false },
                                )
                            }
                        } else null,
                    )

                    BackHandler(immersive) { immersive = false }
                    BackHandler(showTools) { showTools = false }

                val panelTitle = when (panelMode) {
                    PanelMode.CONTENTS -> stringResource(R.string.books_contents)
                    PanelMode.NOTES -> stringResource(R.string.books_notes)
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
                        PanelMode.NOTES -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (marks.isEmpty() && annotations.isEmpty()) {
                                item { Text(stringResource(R.string.books_no_marks), style = MaterialTheme.typography.bodySmall) }
                            }
                            if (marks.isNotEmpty()) {
                                item { Text(stringResource(R.string.books_marks), style = MaterialTheme.typography.labelMedium) }
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
                            if (annotations.isNotEmpty()) {
                                item { Text(stringResource(R.string.books_annotations), style = MaterialTheme.typography.labelMedium) }
                                items(annotations, key = { it.id }) { ann ->
                                    AnnotationNoteCard(
                                        annotation = ann,
                                        onJump = {
                                            spine = ann.spine
                                            savePosition(ann.startBlock, ann.startOffset)
                                            jump++
                                            showPanel = false
                                        },
                                        onEdit = { editingAnnotation = ann },
                                        onDelete = {
                                            scope.launch {
                                                runCatching { repository.api().deleteBookAnnotation(book.id, ann.id, RequestOwner(repository.session.cacheScope())) }
                                                    .onSuccess {
                                                        annotations = annotations.filterNot { it.id == ann.id }
                                                        if (owner != null) repository.database.books().deleteAnnotation(owner, book.id, ann.id)
                                                    }
                                            }
                                        },
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
                        PanelMode.ANNOTATIONS -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (annotations.isEmpty()) item { Text(stringResource(R.string.books_no_annotations)) }
                            items(annotations, key = { it.id }) { ann ->
                                AnnotationNoteCard(
                                    annotation = ann,
                                    onJump = {
                                        spine = ann.spine
                                        savePosition(ann.startBlock, ann.startOffset)
                                        jump++
                                        showPanel = false
                                    },
                                    onEdit = { editingAnnotation = ann },
                                    onDelete = {
                                        scope.launch {
                                            runCatching { repository.api().deleteBookAnnotation(book.id, ann.id, RequestOwner(repository.session.cacheScope())) }
                                                .onSuccess {
                                                    annotations = annotations.filterNot { it.id == ann.id }
                                                    if (owner != null) repository.database.books().deleteAnnotation(owner, book.id, ann.id)
                                                }
                                        }
                                    },
                                )
                            }
                        }
                        PanelMode.SEARCH -> {
                            var searched by remember(book.id) { mutableStateOf(false) }
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                                                .onSuccess { searchMatches = it; searched = true }
                                                .onFailure { error = true }
                                        }
                                    }) { Text(stringResource(R.string.books_search)) }
                                }
                                if (searched && searchMatches.isEmpty()) {
                                    Text(stringResource(R.string.books_search_no_matches), style = MaterialTheme.typography.bodySmall)
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
                }

                annotation?.let { range ->
                    var chosenColor by remember(range) { mutableStateOf("amber") }
                    var noteDraft by remember(range) { mutableStateOf("") }
                    BookReaderDialog(
                        title = stringResource(R.string.books_annotate),
                        close = { annotation = null },
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(
                                range.text,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                listOf(
                                    "amber" to R.string.books_amber,
                                    "terracotta" to R.string.books_terracotta,
                                    "sage" to R.string.books_sage,
                                    "stone" to R.string.books_stone,
                                ).forEach { (color, label) ->
                                    BookChoicePill(
                                        label = stringResource(label),
                                        selected = chosenColor == color,
                                        onClick = { chosenColor = color },
                                        swatchColor = annotationHighlightColorOrNull(color),
                                    )
                                }
                            }
                            OutlinedTextField(
                                value = noteDraft,
                                onValueChange = { noteDraft = it },
                                label = { Text(stringResource(R.string.books_note_hint)) },
                                modifier = Modifier.fillMaxWidth().testTag("book-annotation-note-input"),
                                minLines = 2,
                                maxLines = 4,
                            )
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                            ) {
                                TextButton(onClick = { annotation = null }) {
                                    Text(stringResource(R.string.books_close))
                                }
                                Button(
                                    modifier = Modifier.testTag("book-annotation-save"),
                                    onClick = {
                                        val cleanNote = noteDraft.trim()
                                        val selectedColor = chosenColor
                                        annotation = null
                                        scope.launch {
                                            try {
                                                val saved = repository.api().addBookAnnotation(
                                                    book.id,
                                                    JsonObject().apply {
                                                        addProperty("spine_index", spine)
                                                        addProperty("start_block_index", range.block)
                                                        addProperty("start_char_offset", range.start)
                                                        addProperty("end_block_index", range.block)
                                                        addProperty("end_char_offset", range.end)
                                                        addProperty("selected_text", range.text)
                                                        addProperty("color", selectedColor)
                                                        if (cleanNote.isNotEmpty()) addProperty("note", cleanNote)
                                                    },
                                                    RequestOwner(repository.session.cacheScope()),
                                                )
                                                annotations = annotations + gson.fromJson(saved, BookAnnotation::class.java)
                                                selection = null
                                                if (owner != null) {
                                                    repository.database.books().saveAnnotation(
                                                        BookAnnotationSyncEntity(owner, book.id, saved.get("id").asString, saved.toString()),
                                                    )
                                                }
                                            } catch (cause: CancellationException) { throw cause }
                                            catch (_: Exception) { error = true }
                                        }
                                    },
                                ) { Text(stringResource(R.string.books_save)) }
                            }
                        }
                    }
                }

                editingAnnotation?.let { editing ->
                    var chosenColor by remember(editing.id) { mutableStateOf(editing.color) }
                    var noteDraft by remember(editing.id) { mutableStateOf(editing.note.orEmpty()) }
                    BookReaderDialog(
                        title = stringResource(R.string.books_edit_note),
                        close = { editingAnnotation = null },
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(
                                editing.selectedText,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                listOf(
                                    "amber" to R.string.books_amber,
                                    "terracotta" to R.string.books_terracotta,
                                    "sage" to R.string.books_sage,
                                    "stone" to R.string.books_stone,
                                ).forEach { (color, label) ->
                                    BookChoicePill(
                                        label = stringResource(label),
                                        selected = chosenColor == color,
                                        onClick = { chosenColor = color },
                                        swatchColor = annotationHighlightColorOrNull(color),
                                    )
                                }
                            }
                            OutlinedTextField(
                                value = noteDraft,
                                onValueChange = { noteDraft = it },
                                label = { Text(stringResource(R.string.books_note_hint)) },
                                modifier = Modifier.fillMaxWidth().testTag("book-annotation-edit-input"),
                                minLines = 2,
                                maxLines = 4,
                            )
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                            ) {
                                TextButton(onClick = { editingAnnotation = null }) {
                                    Text(stringResource(R.string.books_close))
                                }
                                Button(
                                    modifier = Modifier.testTag("book-annotation-edit-save"),
                                    onClick = {
                                        val cleanNote = noteDraft.trim()
                                        val selectedColor = chosenColor
                                        editingAnnotation = null
                                        scope.launch {
                                            try {
                                                val saved = repository.api().updateBookAnnotation(
                                                    book.id,
                                                    editing.id,
                                                    JsonObject().apply {
                                                        addProperty("spine_index", editing.spine)
                                                        addProperty("start_block_index", editing.startBlock)
                                                        addProperty("start_char_offset", editing.startOffset)
                                                        addProperty("end_block_index", editing.endBlock)
                                                        addProperty("end_char_offset", editing.endOffset)
                                                        addProperty("selected_text", editing.selectedText)
                                                        addProperty("color", selectedColor)
                                                        if (cleanNote.isNotEmpty()) addProperty("note", cleanNote) else add("note", com.google.gson.JsonNull.INSTANCE)
                                                    },
                                                    RequestOwner(repository.session.cacheScope()),
                                                )
                                                val updated = gson.fromJson(saved, BookAnnotation::class.java)
                                                annotations = annotations.map { if (it.id == editing.id) updated else it }
                                                if (owner != null) {
                                                    repository.database.books().saveAnnotation(
                                                        BookAnnotationSyncEntity(owner, book.id, editing.id, saved.toString()),
                                                    )
                                                }
                                            } catch (cause: CancellationException) { throw cause }
                                            catch (_: Exception) { error = true }
                                        }
                                    },
                                ) { Text(stringResource(R.string.books_save)) }
                            }
                        }
                    }
                }
            }
            }
        }
    }
}

private fun progressStatusLabelValue(status: String?): String? = null

@Composable
private fun progressStatusLabel(status: String?): String? = when (status) {
    "finished" -> stringResource(R.string.books_status_finished)
    "in_progress" -> stringResource(R.string.books_status_in_progress)
    "unread" -> stringResource(R.string.books_status_unread)
    else -> null
}

@Composable
private fun AnnotationNoteCard(
    annotation: BookAnnotation,
    onJump: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val accent = when (annotation.color) {
        "amber" -> Color(0xFFC58A1C)
        "terracotta" -> Color(0xFFBC5438)
        "sage" -> Color(0xFF6C8052)
        else -> Color(0xFF8A7F72)
    }
    Surface(
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(start = 10.dp, end = 4.dp, top = 8.dp, bottom = 8.dp).height(IntrinsicSize.Min),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(accent, RoundedCornerShape(2.dp)))
            Column(
                Modifier.weight(1f).clickable(onClick = onJump),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    annotation.selectedText.ifBlank { annotation.color },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                annotation.note?.takeIf { it.isNotBlank() }?.let { noteText ->
                    Text(
                        noteText,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            IconButton(onClick = onEdit) {
                Icon(Icons.Default.Edit, stringResource(R.string.books_edit_note), Modifier.size(18.dp))
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, stringResource(R.string.books_delete), Modifier.size(18.dp))
            }
        }
    }
}

internal data class BookImageSize(val widthPx: Int, val heightPx: Int)
internal data class PagePiece(val block: BookBlock, val offset: Int, val imageHeight: Int = 0)

internal fun computeBookImageHeight(
    columnWidthPx: Int,
    viewportHeightPx: Int,
    intrinsic: BookImageSize?,
    density: Float = 1f,
): Int {
    val maxImageHeight = (viewportHeightPx * 0.55f).roundToInt().coerceIn(1, viewportHeightPx)
    if (intrinsic == null || intrinsic.widthPx <= 0 || intrinsic.heightPx <= 0) {
        return minOf((columnWidthPx * 9) / 16, maxImageHeight).coerceAtLeast(1)
    }
    val naturalW = intrinsic.widthPx * density.coerceAtLeast(0.5f)
    val naturalH = intrinsic.heightPx * density.coerceAtLeast(0.5f)
    val scale = minOf(1f, columnWidthPx.toFloat() / naturalW, maxImageHeight.toFloat() / naturalH)
    return (naturalH * scale).roundToInt().coerceIn(1, maxImageHeight)
}

internal fun bookStyle(block: BookBlock, size: Float, serif: Boolean = true) = TextStyle(
    fontFamily = if (serif) FontFamily.Serif else FontFamily.SansSerif,
    fontSize = (if (block.tag.startsWith("h")) size + 3 else size).sp,
    lineHeight = (size * 1.65).sp,
)

internal fun measurePages(
    blocks: List<BookBlock>,
    measurer: TextMeasurer,
    size: Float,
    width: Int,
    height: Int,
    gap: Int,
    serif: Boolean = true,
    imageSizes: Map<String, BookImageSize> = emptyMap(),
    density: Float = 1f,
): List<List<PagePiece>> = measurePagesWith(
    blocks = blocks,
    width = width,
    height = height,
    gap = gap,
    measureImage = { block ->
        computeBookImageHeight(width, height, block.imageKey?.let(imageSizes::get), density)
    },
) { block, remainder ->
    val layout = measurer.measure(remainder, bookStyle(block, size, serif), constraints = Constraints(maxWidth = width))
    List(layout.lineCount) { line -> layout.getLineEnd(line) to layout.getLineBottom(line).toInt() }
}

internal fun measurePagesWith(
    blocks: List<BookBlock>,
    width: Int,
    height: Int,
    gap: Int,
    measureImage: (BookBlock) -> Int = { computeBookImageHeight(width, height, null) },
    measureLines: (BookBlock, String) -> List<Pair<Int, Int>>,
): List<List<PagePiece>> {
    val pages = mutableListOf<MutableList<PagePiece>>(mutableListOf())
    var remaining = height
    for (block in blocks) {
        if (block.imageKey != null) {
            val imgHeight = measureImage(block).coerceIn(1, height)
            if (imgHeight > remaining && pages.last().isNotEmpty()) {
                pages.add(mutableListOf())
                remaining = height
            }
            pages.last().add(PagePiece(block, 0, imageHeight = imgHeight))
            remaining -= imgHeight + gap
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
        imageLoader = loader,
        contentDescription = null,
        contentScale = ContentScale.Fit,
        alignment = Alignment.Center,
        modifier = modifier,
    )
}

private data class BookSelection(val block: Int, val start: Int, val end: Int, val text: String)

@Composable
private fun BookCompanionAudioBar(
    vm: MusicViewModel,
    book: BookSummary,
    bookPlaybackState: BookPlaybackState,
    isThisBookAudio: Boolean,
    palette: Color,
    ink: Color,
    onExpandPlayer: () -> Unit,
    onHide: () -> Unit,
) {
    val active = if (isThisBookAudio) bookPlaybackState else null
    val posMs by vm.bookPlayback.positionMs.collectAsStateWithLifecycle()
    val durMs = active?.let { it.durationMs.takeIf { d -> d > 0L } ?: it.activeChapter?.resolvedDurationMs } ?: 0L
    val currentPos = if (isThisBookAudio) posMs else 0L
    val fraction = if (durMs > 0L) (currentPos.toFloat() / durMs.toFloat()).coerceIn(0f, 1f) else 0f
    val loading = active?.loading == true
    val buffering = active?.buffering == true
    val playing = active?.playing == true
    val subtitleColor = ink.copy(alpha = 0.72f)
    val subtitle = when {
        active?.error != null -> active.error
        loading -> stringResource(R.string.preparing)
        active?.activeChapter != null -> "${formatTime(currentPos)} / ${formatTime(durMs)} · ${active.speed}×"
        else -> stringResource(R.string.books_audiobook)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(palette)
            .testTag("book-reader-audio-bar"),
    ) {
        if (active?.syncConflict == true) {
            Row(
                Modifier
                    .widthIn(max = 760.dp)
                    .fillMaxWidth()
                    .align(Alignment.CenterHorizontally)
                    .padding(start = 14.dp, end = 6.dp, top = 6.dp)
                    .testTag("book-companion-sync-conflict"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    stringResource(R.string.books_audio_sync_conflict),
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                TextButton(
                    onClick = { vm.bookPlayback.reloadFromServer() },
                    modifier = Modifier.testTag("book-companion-sync-reload"),
                ) {
                    Text(stringResource(R.string.books_resume_from_server))
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(2.dp)) {
            if (fraction > 0f) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f)))
                Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(MaterialTheme.colorScheme.primary))
            } else {
                HorizontalDivider(
                    modifier = Modifier.align(Alignment.TopCenter),
                    thickness = 0.5.dp,
                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                )
            }
        }
        Row(
            Modifier
                .widthIn(max = 760.dp)
                .fillMaxWidth()
                .align(Alignment.CenterHorizontally)
                .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Column(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .focusProperties { canFocus = false }
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) {
                        if (!isThisBookAudio) vm.bookPlayback.open(book, autoplay = false)
                        onExpandPlayer()
                    }
                    .padding(horizontal = 6.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                Text(
                    active?.activeChapter?.title ?: book.title,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Medium,
                    color = ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontFeatureSettings = "tnum"),
                    color = if (active?.error != null) MaterialTheme.colorScheme.error else subtitleColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(
                onClick = { vm.bookPlayback.seekBy(-15_000L) },
                enabled = active?.activeChapter != null && !loading,
                modifier = Modifier.size(44.dp).focusProperties { canFocus = false },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Replay, stringResource(R.string.pod_player_rewind_15), Modifier.size(22.dp), tint = ink)
                    Text("15", fontSize = 8.sp, fontWeight = FontWeight.SemiBold, color = ink, modifier = Modifier.padding(top = 2.dp))
                }
            }
            FilledIconButton(
                onClick = {
                    if (isThisBookAudio) vm.bookPlayback.togglePlay()
                    else vm.bookPlayback.open(book, autoplay = true)
                },
                enabled = !loading,
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                modifier = Modifier.size(40.dp).focusProperties { canFocus = false }.testTag("book-reader-audio-play"),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    if (loading || delayed(buffering, 300)) {
                        CircularProgressIndicator(
                            Modifier.size(28.dp),
                            color = LocalContentColor.current.copy(alpha = 0.88f),
                            trackColor = LocalContentColor.current.copy(alpha = 0.2f),
                            strokeWidth = 2.dp,
                        )
                    }
                    Icon(
                        if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                        if (playing) stringResource(R.string.pause) else stringResource(R.string.play),
                        Modifier.size(22.dp).offset(x = if (playing) 0.dp else 1.dp),
                    )
                }
            }
            IconButton(
                onClick = { vm.bookPlayback.seekBy(30_000L) },
                enabled = active?.activeChapter != null && !loading,
                modifier = Modifier.size(44.dp).focusProperties { canFocus = false },
            ) {
                Icon(Icons.Default.Forward30, stringResource(R.string.pod_player_forward_30), Modifier.size(22.dp), tint = ink)
            }
            IconButton(
                onClick = onHide,
                modifier = Modifier.size(40.dp).focusProperties { canFocus = false }.testTag("book-reader-audio-hide"),
            ) {
                Icon(Icons.Default.KeyboardArrowDown, stringResource(R.string.books_hide_companion_audio), tint = subtitleColor)
            }
        }
    }
}

private class ParagraphTouchGate {
    var active: Boolean = false
    var downWallMs: Long = 0L
    var downEventMs: Long = 0L
    var lastEventMs: Long = 0L
    var hadSelectionAtDown: Boolean = false
    var longPressTimeoutMs: Long = 400L
}

private fun Modifier.readerParagraphTap(
    gate: ParagraphTouchGate,
    hasActiveSelection: () -> Boolean,
    onTap: (hadSelectionAtDown: Boolean) -> Unit,
): Modifier = pointerInput(gate) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        val downPos = down.position
        val slop = viewConfiguration.touchSlop
        val longPressMs = viewConfiguration.longPressTimeoutMillis
        gate.active = true
        gate.downWallMs = android.os.SystemClock.uptimeMillis()
        gate.downEventMs = down.uptimeMillis
        gate.lastEventMs = down.uptimeMillis
        gate.hadSelectionAtDown = hasActiveSelection()
        gate.longPressTimeoutMs = longPressMs
        var validTap = true
        try {
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (event.changes.size > 1) validTap = false
                val tracked = event.changes.firstOrNull { it.id == down.id } ?: event.changes.first()
                gate.lastEventMs = tracked.uptimeMillis
                if ((tracked.position - downPos).getDistance() > slop) validTap = false
                val heldMs = maxOf(
                    tracked.uptimeMillis - gate.downEventMs,
                    android.os.SystemClock.uptimeMillis() - gate.downWallMs,
                )
                if (heldMs >= longPressMs) validTap = false
                if (event.changes.none { it.pressed }) {
                    val hadSelection = gate.hadSelectionAtDown
                    gate.active = false
                    if (validTap && !tracked.isConsumed) {
                        val mainEvent = awaitPointerEvent(PointerEventPass.Main)
                        mainEvent.changes.forEach { it.consume() }
                        onTap(hadSelection)
                    }
                    break
                }
            }
        } finally {
            gate.active = false
        }
    }
}

@Composable
private fun BookParagraph(
    piece: PagePiece,
    size: Float,
    ink: Color,
    serif: Boolean,
    highlights: List<BookAnnotation>,
    hasActiveSelection: Boolean = false,
    onTap: (Boolean) -> Unit = {},
    select: (BookSelection?) -> Unit,
) {
    val block = piece.block
    val text = block.text
    if (text.isBlank()) return
    val length = text.codePointCount(0, text.length)
    var range by remember(block.index, piece.offset, text) { mutableStateOf(TextRange.Zero) }
    val gate = remember { ParagraphTouchGate() }
    val latestHasSelection by rememberUpdatedState(hasActiveSelection)
    val latestOnTap by rememberUpdatedState(onTap)
    LaunchedEffect(hasActiveSelection) {
        if (!hasActiveSelection && !range.collapsed) {
            range = TextRange.Zero
        }
    }
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
                val color = annotationHighlightColorOrNull(mark.color) ?: continue
                if (start < end) {
                    addStyle(
                        SpanStyle(color = Color(0xFF2A2B25), background = color),
                        text.offsetByCodePoints(0, start),
                        text.offsetByCodePoints(0, end),
                    )
                }
            }
        }
    }
    BasicTextField(
        value = TextFieldValue(styled, selection = range),
        readOnly = true,
        modifier = Modifier.readerParagraphTap(gate, { latestHasSelection }) { latestOnTap(it) },
        textStyle = bookStyle(block, size, serif).copy(color = ink),
        onValueChange = { next ->
            val heldMs = maxOf(
                gate.lastEventMs - gate.downEventMs,
                android.os.SystemClock.uptimeMillis() - gate.downWallMs,
            )
            if (!next.selection.collapsed && gate.active && !gate.hadSelectionAtDown && heldMs < gate.longPressTimeoutMs) {
                range = TextRange.Zero
                return@BasicTextField
            }
            range = next.selection
            val selected = text.substring(range.min, range.max)
            select(
                selected.takeIf { it.isNotBlank() && it.codePointCount(0, it.length) <= 8192 }?.let {
                    BookSelection(
                        block.index,
                        piece.offset + text.codePointCount(0, range.min),
                        piece.offset + text.codePointCount(0, range.max),
                        it,
                    )
                },
            )
        },
    )
}
