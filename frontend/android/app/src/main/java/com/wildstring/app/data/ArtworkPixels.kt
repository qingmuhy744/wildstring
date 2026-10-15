package com.wildstring.app.data

/** Tiny, separable blur: O(pixel count), executed off the UI and playback threads. */
object ArtworkPixels {
    fun tint(pixels: IntArray): Int {
        val candidates = pixels.filter { pixel ->
            val channels = listOf(pixel shr 16 and 255, pixel shr 8 and 255, pixel and 255)
            channels.max() - channels.min() > 24 && channels.max() > 40
        }.ifEmpty { pixels.toList() }
        if (candidates.isEmpty()) return 0xFF59634F.toInt()
        val bins = candidates.groupBy { ((it shr 20 and 15) shl 8) or ((it shr 12 and 15) shl 4) or (it shr 4 and 15) }
        val dominant = bins.maxBy { it.value.size }.value
        val red = dominant.sumOf { (it shr 16 and 255).toLong() } / dominant.size
        val green = dominant.sumOf { (it shr 8 and 255).toLong() } / dominant.size
        val blue = dominant.sumOf { (it and 255).toLong() } / dominant.size
        return (0xFF000000L or (red shl 16) or (green shl 8) or blue).toInt()
    }
    fun blur(pixels: IntArray, width: Int, height: Int, radius: Int = 8): IntArray {
        require(width in 1..128 && height in 1..128 && pixels.size == width * height && radius in 1..32)
        var input = pixels.copyOf()
        repeat(3) {
            val horizontal = pass(input, width, height, radius, true)
            input = pass(horizontal, width, height, radius, false)
        }
        return input
    }
    private fun pass(input: IntArray, width: Int, height: Int, radius: Int, horizontal: Boolean): IntArray {
        val output = IntArray(input.size)
        val length = if (horizontal) width else height
        val rows = if (horizontal) height else width
        val count = radius * 2 + 1
        for (row in 0 until rows) {
            fun index(position: Int): Int = if (horizontal) row * width + position.coerceIn(0, length - 1) else position.coerceIn(0, length - 1) * width + row
            var red = 0; var green = 0; var blue = 0
            for (offset in -radius..radius) { val pixel = input[index(offset)]; red += pixel shr 16 and 255; green += pixel shr 8 and 255; blue += pixel and 255 }
            for (position in 0 until length) {
                output[index(position)] = (0xFF shl 24) or (red / count shl 16) or (green / count shl 8) or (blue / count)
                val remove = input[index(position - radius)]; val add = input[index(position + radius + 1)]
                red += (add shr 16 and 255) - (remove shr 16 and 255)
                green += (add shr 8 and 255) - (remove shr 8 and 255)
                blue += (add and 255) - (remove and 255)
            }
        }
        return output
    }
}
