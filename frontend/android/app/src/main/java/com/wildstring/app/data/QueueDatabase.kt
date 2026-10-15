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
@Database(entities = [QueueEntry::class, SavedPosition::class], version = 1, exportSchema = true)
abstract class QueueDatabase : RoomDatabase() { abstract fun queue(): QueueDao }
