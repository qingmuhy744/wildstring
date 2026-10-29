package com.wildstring.app

import android.content.Context
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PodcastCheckpointStorageTest {
    @Test fun migrationKeepsQueueAndReopenKeepsAccountScopedOutbox() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "podcast-migration-test.db"
        context.deleteDatabase(name)
        context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null).use { old ->
            old.execSQL("CREATE TABLE queue_entries (entryId TEXT NOT NULL PRIMARY KEY, trackId TEXT NOT NULL, orderIndex INTEGER NOT NULL)")
            old.execSQL("CREATE TABLE playback_position (id INTEGER NOT NULL PRIMARY KEY, endpoint TEXT NOT NULL, entryId TEXT, positionMs INTEGER NOT NULL)")
            old.execSQL("INSERT INTO queue_entries VALUES ('entry','podcast_ep_one',0)")
            old.execSQL("INSERT INTO playback_position VALUES (1,'https://server.example','entry',120000)")
            old.version = 1
        }
        fun open() = Room.databaseBuilder(context, QueueDatabase::class.java, name).addMigrations(QueueDatabase.MIGRATION_1_2).build()
        try {
            val first = open()
            try {
                val database = first
                assertEquals(120000L, database.queue().position()?.positionMs)
                assertEquals("podcast_ep_one", database.queue().entries().single().trackId)
                database.podcasts().save(PodcastCheckpointRow("server-A:user-A", "one", "pending-A"))
                database.podcasts().save(PodcastCheckpointRow("server-A:user-B", "one", "pending-B"))
                database.queue().clear()
            } finally { first.close() }
            val reopened = open()
            try {
                val database = reopened
                assertEquals("pending-A", database.podcasts().get("server-A:user-A", "one")?.payload)
                assertEquals("pending-B", database.podcasts().get("server-A:user-B", "one")?.payload)
                assertNull(database.podcasts().get("server-B:user-A", "one"))
            } finally { reopened.close() }
        } finally { context.deleteDatabase(name) }
    }
}
