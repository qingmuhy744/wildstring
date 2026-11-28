package com.wildstring.app.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.annotations.SerializedName
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException

internal fun canManageBooks(profile: String?): Boolean = profile == "owner" || profile == "librarian"

data class BookItems<T>(val items: List<T> = emptyList())
data class BookSummary(
    val id: String,
    val title: String,
    val subtitle: String?,
    val authors: List<String> = emptyList(),
    @SerializedName("library_id") val libraryId: String,
    @SerializedName("has_ebook") val hasEbook: Boolean,
    @SerializedName("has_audiobook") val hasAudiobook: Boolean,
    @SerializedName("has_cover") val hasCover: Boolean = false,
    @SerializedName("progress_status") val progressStatus: String? = null,
    @SerializedName("resume_kind") val resumeKind: String? = null,
    @SerializedName("reading_progress") val readingProgress: BookCarrierProgress? = null,
    @SerializedName("listening_progress") val listeningProgress: BookCarrierProgress? = null,
    val narrators: List<String>? = null,
    @SerializedName("series_name") val seriesName: String? = null,
    @SerializedName("series_index") val seriesIndex: Double? = null,
    val description: String? = null,
    val publisher: String? = null,
    @SerializedName("published_year") val publishedYear: Int? = null,
    val language: String? = null,
    val isbn10: String? = null,
    val isbn13: String? = null,
    val tags: List<String>? = null,
    @SerializedName("ebook_summary") val ebookSummary: BookEbookSummary? = null,
    @SerializedName("audiobook_summary") val audiobookSummary: BookAudioSummary? = null,
)
data class BookCarrierProgress(
    @SerializedName("chapter_title") val chapterTitle: String?,
    @SerializedName("overall_ratio") val overallRatio: Double = 0.0,
    val completed: Boolean = false,
    @SerializedName("updated_at") val updatedAt: Double = 0.0,
)
data class BookLibrary(
    val id: String,
    val name: String,
    @SerializedName("storage_mode") val storageMode: String = "copy",
    @SerializedName("storage_backend") val storageBackend: String? = null,
)
data class BookMetadataSource(
    val id: String,
    val name: String,
    val kind: String = "builtin",
    val enabled: Boolean = true,
)
data class BookEbookSummary(
    val format: String,
    @SerializedName("chapter_count") val chapterCount: Int,
    @SerializedName("total_chars") val totalChars: Int,
)
data class BookAudioSummary(
    @SerializedName("total_duration_ms") val totalDurationMs: Long,
    @SerializedName("chapter_count") val chapterCount: Int,
    @SerializedName("codec_summary") val codecSummary: String?,
)
data class BookChapter(@SerializedName("spine_index") val index: Int, val title: String, val level: Int? = null)
data class BookManifest(
    val chapters: List<BookChapter>,
    val sha256: String,
    @SerializedName("content_revision") val contentRevision: String? = null,
) {
    val cacheKey: String get() = if (contentRevision == null) sha256 else "$sha256:$contentRevision"
}

internal fun List<BookChapter>.ebookContents(): List<BookChapter> =
    filter { it.level != 0 }.ifEmpty { this }

data class BookRun(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
)
data class BookBlock(
    @SerializedName("block_index") val index: Int,
    val tag: String,
    val text: String,
    val runs: List<BookRun>? = null,
    @SerializedName("image_key") val imageKey: String?,
)
data class BookChapterContent(val title: String, val blocks: List<BookBlock>)
data class BookAnnotation(
    val id: String,
    @SerializedName("spine_index") val spine: Int,
    @SerializedName("start_block_index") val startBlock: Int,
    @SerializedName("start_char_offset") val startOffset: Int,
    @SerializedName("end_block_index") val endBlock: Int,
    @SerializedName("end_char_offset") val endOffset: Int,
    @SerializedName("selected_text") val selectedText: String = "",
    val color: String,
    val note: String? = null,
)

data class BookAudioManifest(
    @SerializedName("total_duration_ms") val totalDurationMs: Long = 0,
    val chapters: List<BookAudioChapter> = emptyList(),
)
data class BookAudioChapter(
    @SerializedName("chapter_index") val index: Int,
    @SerializedName("file_index") val fileIndex: Int,
    @SerializedName("start_file_ms") val start: Long,
    @SerializedName("end_file_ms") val end: Long,
    @SerializedName("start_book_ms") val startBookMs: Long = 0,
    @SerializedName("duration_ms") val durationMs: Long = 0,
    val title: String,
) {
    val resolvedDurationMs: Long get() = if (durationMs > 0L) durationMs else (end - start).coerceAtLeast(0L)
}
data class BookMetadataCandidate(
    val provider: String = "",
    @SerializedName("provider_name") val providerName: String? = null,
    @SerializedName("external_id") val externalId: String = "",
    val fields: JsonObject = JsonObject(),
)
data class BookCheckpoint(
    val version: Int = 0,
    @SerializedName("spine_index") val spine: Int = 0,
    @SerializedName("block_index") val block: Int = 0,
    @SerializedName("char_offset") val offset: Int = 0,
    @SerializedName("reading_mode") val mode: String? = null,
    @SerializedName("chapter_index") val chapter: Int = 0,
    @SerializedName("chapter_position_ms") val position: Long = 0,
    @SerializedName("playback_rate") val speed: Float = 1f,
)

@Entity(tableName = "bookshelf_books", primaryKeys = ["owner", "bookId"])
data class BookEntity(val owner: String, val bookId: String, val payload: String)
@Entity(tableName = "bookshelf_ebook_chapters", primaryKeys = ["owner", "bookId", "spineIndex"])
data class BookEbookChapterMetaEntity(
    val owner: String, val bookId: String, val spineIndex: Int, val title: String, val cacheKey: String,
)
@Entity(tableName = "bookshelf_audio_chapters", primaryKeys = ["owner", "bookId", "chapterIndex"])
data class BookAudiobookChapterEntity(val owner: String, val bookId: String, val chapterIndex: Int, val payload: String)
@Entity(tableName = "bookshelf_progress", primaryKeys = ["owner", "bookId", "kind"])
data class BookProgressSyncEntity(val owner: String, val bookId: String, val kind: String, val payload: String)
@Entity(tableName = "bookshelf_annotations", primaryKeys = ["owner", "bookId", "annotationId"])
data class BookAnnotationSyncEntity(val owner: String, val bookId: String, val annotationId: String, val payload: String)

@Dao
interface BookshelfDao {
    @Query("SELECT * FROM bookshelf_books WHERE owner = :owner ORDER BY bookId")
    suspend fun books(owner: String): List<BookEntity>
    @Query("DELETE FROM bookshelf_books WHERE owner = :owner")
    suspend fun clearBooks(owner: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveBooks(books: List<BookEntity>)
    @Transaction
    suspend fun replaceBooks(owner: String, books: List<BookEntity>) {
        clearBooks(owner)
        saveBooks(books)
    }
    @Query("SELECT * FROM bookshelf_ebook_chapters WHERE owner = :owner AND bookId = :bookId ORDER BY spineIndex")
    suspend fun chapters(owner: String, bookId: String): List<BookEbookChapterMetaEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveChapters(chapters: List<BookEbookChapterMetaEntity>)
    @Query("DELETE FROM bookshelf_ebook_chapters WHERE owner = :owner AND bookId = :bookId")
    suspend fun clearBookChapters(owner: String, bookId: String)
    @Transaction
    suspend fun replaceChapters(owner: String, bookId: String, chapters: List<BookEbookChapterMetaEntity>) {
        clearBookChapters(owner, bookId)
        saveChapters(chapters)
    }
    @Query("SELECT * FROM bookshelf_audio_chapters WHERE owner = :owner AND bookId = :bookId ORDER BY chapterIndex")
    suspend fun audioChapters(owner: String, bookId: String): List<BookAudiobookChapterEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveAudioChapters(chapters: List<BookAudiobookChapterEntity>)
    @Query("SELECT * FROM bookshelf_progress WHERE owner = :owner AND bookId = :bookId AND kind = :kind")
    suspend fun progress(owner: String, bookId: String, kind: String): BookProgressSyncEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveProgress(progress: BookProgressSyncEntity)
    @Query("SELECT * FROM bookshelf_annotations WHERE owner = :owner AND bookId = :bookId")
    suspend fun annotations(owner: String, bookId: String): List<BookAnnotationSyncEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveAnnotation(annotation: BookAnnotationSyncEntity)
    @Query("DELETE FROM bookshelf_annotations WHERE owner = :owner AND bookId = :bookId")
    suspend fun clearAnnotations(owner: String, bookId: String)
    @Query("DELETE FROM bookshelf_annotations WHERE owner = :owner AND bookId = :bookId AND annotationId = :annotationId")
    suspend fun deleteAnnotation(owner: String, bookId: String, annotationId: String)
    @Transaction
    suspend fun replaceAnnotations(owner: String, bookId: String, items: List<BookAnnotationSyncEntity>) {
        clearAnnotations(owner, bookId)
        items.forEach { saveAnnotation(it) }
    }
    @Query("DELETE FROM bookshelf_ebook_chapters WHERE owner = :owner")
    suspend fun clearEbookChapters(owner: String)
    @Query("DELETE FROM bookshelf_audio_chapters WHERE owner = :owner")
    suspend fun clearAudioChapters(owner: String)
    @Query("DELETE FROM bookshelf_progress WHERE owner = :owner")
    suspend fun clearProgress(owner: String)
    @Query("DELETE FROM bookshelf_annotations WHERE owner = :owner")
    suspend fun clearOwnerAnnotations(owner: String)
    @Query("DELETE FROM bookshelf_books WHERE owner = :owner AND bookId = :bookId")
    suspend fun deleteSummary(owner: String, bookId: String)
    @Query("DELETE FROM bookshelf_audio_chapters WHERE owner = :owner AND bookId = :bookId")
    suspend fun clearBookAudioChapters(owner: String, bookId: String)
    @Query("DELETE FROM bookshelf_progress WHERE owner = :owner AND bookId = :bookId")
    suspend fun clearBookProgress(owner: String, bookId: String)
    @Transaction
    suspend fun deleteBook(owner: String, bookId: String) {
        deleteSummary(owner, bookId)
        clearBookChapters(owner, bookId)
        clearBookAudioChapters(owner, bookId)
        clearBookProgress(owner, bookId)
        clearAnnotations(owner, bookId)
    }
    @Transaction
    suspend fun clearOwner(owner: String) {
        clearBooks(owner)
        clearEbookChapters(owner)
        clearAudioChapters(owner)
        clearProgress(owner)
        clearOwnerAnnotations(owner)
    }
    @Query("DELETE FROM bookshelf_books")
    suspend fun dropBooks()
    @Query("DELETE FROM bookshelf_ebook_chapters")
    suspend fun dropEbookChapters()
    @Query("DELETE FROM bookshelf_audio_chapters")
    suspend fun dropAudioChapters()
    @Query("DELETE FROM bookshelf_progress")
    suspend fun dropProgress()
    @Query("DELETE FROM bookshelf_annotations")
    suspend fun dropAnnotations()
    @Transaction
    suspend fun clearEverything() {
        dropBooks()
        dropEbookChapters()
        dropAudioChapters()
        dropProgress()
        dropAnnotations()
    }
}

internal class BookSync(
    private val repository: Repository,
    private val id: String,
    private val kind: String,
    initialVersion: Int? = null,
    initialIntent: String = "resume",
) {
    private val owner = repository.session.storageScope()
    private val profile = repository.session.cacheScope()
    private val session = UUID.randomUUID().toString()
    private val device = repository.bookDeviceId()
    private val mutex = kotlinx.coroutines.sync.Mutex()
    private var version = initialVersion ?: 0
    private var sequence = 0
    private var blocked = false
    private var pendingIntent = initialIntent
    private val gson = Gson()
    var conflict: Boolean = false
        private set

    fun currentVersion(): Int = version

    private data class StoredProgress(
        val checkpoint: BookCheckpoint? = null,
        val pendingPayload: JsonObject? = null,
        val baseVersion: Int = 0,
    )

    suspend fun load(): BookCheckpoint {
        val localRow = owner?.let { repository.database.books().progress(it, id, kind) }
        val localStored = localRow?.let { runCatching { gson.fromJson(it.payload, StoredProgress::class.java) }.getOrNull() }
        val localFallback = localRow?.let { runCatching { gson.fromJson(it.payload, BookCheckpoint::class.java) }.getOrNull() }
        return try {
            val fresh = repository.api().bookProgress(id, kind, RequestOwner(profile))
            version = fresh.version
            val pending = localStored?.pendingPayload
            val effective = if (pending != null && localStored.baseVersion == fresh.version) {
                try {
                    val push = pending.deepCopy().apply {
                        addProperty("session_id", session)
                        addProperty("device_id", device)
                        addProperty("base_version", fresh.version)
                        addProperty("sequence", ++sequence)
                        addProperty("intent", "resume")
                    }
                    repository.api().saveBookProgress(id, kind, push, RequestOwner(profile)).also {
                        version = it.version
                    }
                } catch (_: IOException) {
                    fresh
                } catch (_: HttpException) {
                    fresh
                }
            } else {
                fresh
            }
            if (owner != null) {
                repository.database.books().saveProgress(
                    BookProgressSyncEntity(owner, id, kind, gson.toJson(StoredProgress(checkpoint = effective))),
                )
            }
            effective
        } catch (cause: IOException) {
            val offline = localStored?.checkpoint ?: localFallback ?: BookCheckpoint()
            version = offline.version
            offline
        }
    }

    suspend fun save(value: JsonObject) {
        mutex.withLock {
            if (blocked || profile != repository.session.cacheScope()) return
            val intent = pendingIntent
            pendingIntent = "resume"
            val payload = value.deepCopy().apply {
                addProperty("session_id", session)
                addProperty("device_id", device)
                addProperty("base_version", version)
                addProperty("sequence", ++sequence)
                addProperty("intent", intent)
            }
            try {
                val saved = repository.api().saveBookProgress(id, kind, payload, RequestOwner(profile))
                version = saved.version
                conflict = false
                if (owner != null) {
                    repository.database.books().saveProgress(
                        BookProgressSyncEntity(owner, id, kind, gson.toJson(StoredProgress(checkpoint = saved))),
                    )
                }
            } catch (cause: IOException) {
                if (owner != null) {
                    val localSnapshot = gson.fromJson(value, BookCheckpoint::class.java).copy(version = version)
                    repository.database.books().saveProgress(
                        BookProgressSyncEntity(
                            owner,
                            id,
                            kind,
                            gson.toJson(StoredProgress(checkpoint = localSnapshot, pendingPayload = value, baseVersion = version)),
                        ),
                    )
                }
                throw cause
            } catch (cause: HttpException) {
                if (cause.code() == 409) {
                    blocked = true
                    conflict = true
                    repository.bookSyncConflict.value = id
                }
                throw cause
            }
        }
    }
}
