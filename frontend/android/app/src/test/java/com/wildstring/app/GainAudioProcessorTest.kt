package com.wildstring.app

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import com.wildstring.app.playback.GainAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test

class GainAudioProcessorTest {
    private fun pcm(gain: Float, samples: ShortArray): ShortArray {
        val processor = GainAudioProcessor().apply { factor = gain }
        processor.configure(AudioFormat(48000, 2, C.ENCODING_PCM_16BIT)); processor.flush()
        val input = ByteBuffer.allocateDirect(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        samples.forEach { input.putShort(it) }; input.flip(); processor.queueInput(input)
        val output = processor.output.order(ByteOrder.LITTLE_ENDIAN)
        return ShortArray(samples.size) { output.short }
    }
    @Test fun unityPreservesPcmAndAttenuationAndBoostReachTheAudioSamples() {
        val original = shortArrayOf(-32768, -16000, -1, 0, 1, 16000, 32767)
        assertArrayEquals(original, pcm(1f, original))
        assertArrayEquals(shortArrayOf(-8000, 0, 8000), pcm(0.5f, shortArrayOf(-16000, 0, 16000)))
        assertArrayEquals(shortArrayOf(-32768, 32767), pcm(2f, shortArrayOf(-30000, 30000)))
        assertArrayEquals(original, pcm(Float.NaN, original))
    }
    @Test fun floatingPointOutputRemainsFiniteAndBounded() {
        val processor = GainAudioProcessor().apply { factor = 2f }
        processor.configure(AudioFormat(48000, 1, C.ENCODING_PCM_FLOAT)); processor.flush()
        val input = ByteBuffer.allocateDirect(12).order(ByteOrder.LITTLE_ENDIAN)
        input.putFloat(0.25f).putFloat(-0.8f).putFloat(Float.NaN).flip()
        processor.queueInput(input)
        val output = processor.output.order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(0.5f, output.float, 0.00001f); assertEquals(-1f, output.float, 0f); assertEquals(0f, output.float, 0f)
    }
}
