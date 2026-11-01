package com.wildstring.app.data

/** Shared by the capacity picker and the preference write boundary. Values are in MiB. */
internal object CacheLimits {
    val metadataMb = listOf(0, 8, 16, 32, 64, 128, 256)
    val artworkMb = listOf(0, 32, 64, 128, 256, 512, 1024)
    val audioMb = listOf(0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768)
}
