import Testing

// AVPlayer instances share process-wide MediaPlayer commands and now-playing state.
// Keep the suites that create players from running at the same time.
@Suite("AV playback", .serialized)
struct AVPlaybackTests {}
