package com.wildstring.app.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.annotations.SerializedName
import java.io.IOException
import java.util.UUID
import retrofit2.HttpException

data class BookItems<T>(val items: List<T> = emptyList())
data class BookSummary(
    val id: String,
    val title: String,
    val subtitle: String?,
    @SerializedName("library_id") val libraryId: String,
    @SerializedName("has_ebook") val hasEbook: Boolean,
    @SerializedName("has_audiobook") val hasAudiobook: Boolean,
)
data class BookLibrary(val id: String, val name: String)
data class BookChapter(@SerializedName("spine_index") val index: Int, val title: String)
data class BookManifest(val chapters: List<BookChapter>, val sha256: String)
data class BookBlock(
    @SerializedName("block_index") val index: Int,
    val tag: String,
    val text: String,
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
    val color: String,
)

data class BookAudioManifest(val chapters: List<BookAudioChapter>)
data class BookAudioChapter(
    @SerializedName("chapter_index") val index: Int,
    @SerializedName("file_index") val fileIndex: Int,
    @SerializedName("start_file_ms") val start: Long,
    @SerializedName("end_file_ms") val end: Long,
    val title: String,
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
    @androidx.room.Transaction
    suspend fun replaceBooks(owner: String, books: List<BookEntity>) {
        clearBooks(owner)
        saveBooks(books)
    }
    @Query("SELECT * FROM bookshelf_ebook_chapters WHERE owner = :owner AND bookId = :bookId ORDER BY spineIndex")
    suspend fun chapters(owner: String, bookId: String): List<BookEbookChapterMetaEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveChapters(chapters: List<BookEbookChapterMetaEntity>)
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
}

internal class BookSync(private val repository: Repository, private val id: String, private val kind: String) {
    private val owner = repository.session.storageScope()
    private val profile = repository.session.cacheScope()
    private val session = UUID.randomUUID().toString()
    private val device = UUID.randomUUID().toString()
    private val mutex = kotlinx.coroutines.sync.Mutex()
    private var version = 0
    private var sequence = 0
    private var blocked = false
    private val gson = Gson()

    suspend fun load(): BookCheckpoint {
        val fresh = try {
            repository.api().bookProgress(id, kind, RequestOwner(profile))
        } catch (cause: IOException) {
            owner?.let { repository.database.books().progress(it, id, kind) }?.let {
                gson.fromJson(it.payload, BookCheckpoint::class.java)
            } ?: BookCheckpoint()
        }
        version = fresh.version
        return fresh
    }

    suspend fun save(value: JsonObject) {
        mutex.lock()
        try {
            if (blocked || profile != repository.session.cacheScope()) return
            value.addProperty("session_id", session)
            value.addProperty("device_id", device)
            value.addProperty("base_version", version)
            value.addProperty("sequence", ++sequence)
            val saved = repository.api().saveBookProgress(id, kind, value, RequestOwner(profile))
            version = saved.version
            if (owner != null) repository.database.books().saveProgress(BookProgressSyncEntity(owner, id, kind, gson.toJson(saved)))
        } catch (cause: HttpException) {
            if (cause.code() == 409) blocked = true
            throw cause
        } finally {
            mutex.unlock()
        }
    }
}
