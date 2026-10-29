package com.wildstring.app.data

import androidx.room.*

@Entity(tableName = "queue_entries")
data class QueueEntry(@PrimaryKey val entryId: String, val trackId: String, val orderIndex: Int)
@Entity(tableName = "playback_position")
data class SavedPosition(@PrimaryKey val id: Int = 1, val endpoint: String, val entryId: String?, val positionMs: Long)
@Dao
abstract class QueueDao {
    @Query("SELECT * FROM queue_entries ORDER BY orderIndex") abstract suspend fun entries(): List<QueueEntry>
    @Query("SELECT * FROM playback_position WHERE id = 1") abstract suspend fun position(): SavedPosition?
    @Insert abstract suspend fun insertEntries(entries: List<QueueEntry>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun insertPosition(position: SavedPosition)
    @Query("DELETE FROM queue_entries") abstract suspend fun clearEntries()
    @Query("DELETE FROM playback_position") abstract suspend fun clearPosition()
    @Transaction open suspend fun save(entries: List<QueueEntry>, position: SavedPosition) {
        clearEntries(); clearPosition(); insertEntries(entries); insertPosition(position)
    }
    @Transaction open suspend fun clear() { clearEntries(); clearPosition() }
}
@Entity(tableName = "podcast_checkpoints", primaryKeys = ["owner", "episodeId"])
data class PodcastCheckpointRow(val owner: String, val episodeId: String, val payload: String)
@Dao
interface PodcastCheckpointDao {
    @Query("SELECT * FROM podcast_checkpoints WHERE owner = :owner AND episodeId = :episodeId")
    suspend fun get(owner: String, episodeId: String): PodcastCheckpointRow?
    @Query("SELECT * FROM podcast_checkpoints WHERE owner = :owner")
    suspend fun all(owner: String): List<PodcastCheckpointRow>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(row: PodcastCheckpointRow)
}
@Database(entities = [QueueEntry::class, SavedPosition::class, PodcastCheckpointRow::class], version = 2, exportSchema = true)
abstract class QueueDatabase : RoomDatabase() {
    abstract fun queue(): QueueDao
    abstract fun podcasts(): PodcastCheckpointDao
    companion object {
        val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS podcast_checkpoints (owner TEXT NOT NULL, episodeId TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner, episodeId))")
            }
        }
    }
}
