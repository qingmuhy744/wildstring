package com.wildstring.app.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/** PCM trim preserves the source file and remains independent of the user's volume slider. */
@UnstableApi
internal class GainAudioProcessor : BaseAudioProcessor() {
    @Volatile var factor = 1f
    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat =
        if (inputAudioFormat.encoding in listOf(C.ENCODING_PCM_16BIT, C.ENCODING_PCM_FLOAT)) inputAudioFormat else AudioFormat.NOT_SET

    override fun queueInput(inputBuffer: ByteBuffer) {
        val output = replaceOutputBuffer(inputBuffer.remaining()).order(ByteOrder.LITTLE_ENDIAN)
        inputBuffer.order(ByteOrder.LITTLE_ENDIAN)
        val gain = factor.takeIf { it.isFinite() }?.coerceIn(0.001f, 32f) ?: 1f
        if (inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT) {
            while (inputBuffer.remaining() >= 4) output.putFloat((inputBuffer.float.takeIf { it.isFinite() }?.times(gain) ?: 0f).coerceIn(-1f, 1f))
        } else {
            while (inputBuffer.remaining() >= 2) output.putShort((inputBuffer.short * gain).roundToInt().coerceIn(-32768, 32767).toShort())
        }
        output.flip()
    }
}
