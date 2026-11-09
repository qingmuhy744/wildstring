package com.wildstring.app

import com.wildstring.app.ui.VerseDeck
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import kotlin.random.Random

class VerseDeckTest {
    @Test fun everyVerseAppearsOnceBeforeAnyRepeats() {
        val deck = VerseDeck(40, Random(7))
        assertEquals((0 until 40).toSet(), List(40) { deck.next() }.toSet())
    }

    @Test fun neverRepeatsTheSameVerseBackToBackAcrossRounds() {
        repeat(50) { seed ->
            val deck = VerseDeck(5, Random(seed))
            val draws = List(500) { deck.next() }
            draws.zipWithNext().forEach { (a, b) -> assertNotEquals(a, b) }
        }
    }

    @Test fun aSingleVerseDeckKeepsReturningThatVerse() {
        val deck = VerseDeck(1)
        repeat(3) { assertEquals(0, deck.next()) }
    }
}
