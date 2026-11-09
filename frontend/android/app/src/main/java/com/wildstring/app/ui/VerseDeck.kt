package com.wildstring.app.ui

/**
 * Draws indices in random order without repeating one until the whole deck has been used, then reshuffles.
 * The first draw of a new round never equals the last draw of the previous one, so a loop is never visible.
 */
internal class VerseDeck(private val size: Int, private val random: kotlin.random.Random = kotlin.random.Random.Default) {
    private var remaining = ArrayDeque<Int>()
    private var last = -1

    fun next(): Int {
        require(size > 0)
        if (remaining.isEmpty()) {
            do remaining = ArrayDeque((0 until size).shuffled(random)) while (size > 1 && remaining.first() == last)
        }
        return remaining.removeFirst().also { last = it }
    }
}
