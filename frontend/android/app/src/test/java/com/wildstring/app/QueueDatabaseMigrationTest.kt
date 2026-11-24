package com.wildstring.app

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37], application = Application::class)
class QueueDatabaseMigrationTest {
    @Test fun migrationFromVersion2BuildsBookshelfTablesAndIsolatesOwners() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "bookshelf-migration-test.db"
        context.deleteDatabase(name)
        context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null).use { v2 ->
            v2.execSQL("CREATE TABLE queue_entries (entryId TEXT NOT NULL PRIMARY KEY, trackId TEXT NOT NULL, orderIndex INTEGER NOT NULL)")
            v2.execSQL("CREATE TABLE playback_position (id INTEGER NOT NULL PRIMARY KEY, endpoint TEXT NOT NULL, entryId TEXT, positionMs INTEGER NOT NULL)")
            v2.execSQL("CREATE TABLE podcast_checkpoints (owner TEXT NOT NULL, episodeId TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner, episodeId))")
            v2.execSQL("INSERT INTO podcast_checkpoints VALUES ('srv:u1','ep1','saved')")
            v2.version = 2
        }
        val db = Room.databaseBuilder(context, QueueDatabase::class.java, name)
            .addMigrations(QueueDatabase.MIGRATION_1_2, QueueDatabase.MIGRATION_2_3)
            .build()
        try {
            assertEquals("saved", db.podcasts().get("srv:u1", "ep1")?.payload)
            db.books().replaceBooks("srv:u1", listOf(BookEntity("srv:u1", "b1", "{\"id\":\"b1\"}")))
            db.books().saveProgress(BookProgressSyncEntity("srv:u1", "b1", "reading", "{}"))
            db.books().saveAnnotation(BookAnnotationSyncEntity("srv:u1", "b1", "a1", "{}"))
            db.books().saveBooks(listOf(BookEntity("srv:u2", "b2", "{\"id\":\"b2\"}")))
            db.books().clearOwner("srv:u1")
            assertTrue(db.books().books("srv:u1").isEmpty())
            assertNull(db.books().progress("srv:u1", "b1", "reading"))
            assertEquals(1, db.books().books("srv:u2").size)
            db.books().clearEverything()
            assertTrue(db.books().books("srv:u2").isEmpty())
        } finally {
            db.close()
            context.deleteDatabase(name)
        }
    }
}
