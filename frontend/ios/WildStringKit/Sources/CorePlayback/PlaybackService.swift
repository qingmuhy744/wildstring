import AVFoundation
import CoreNetwork
import Foundation
import Observation

/// Queue/position/mode snapshot exchanged between devices.
public struct PlaybackSnapshot: Equatable, Sendable {
    public var trackIDs: [String]
    public var index: Int
    public var positionMs: Int64
    public var mode: String
    public var playbackState: String

    public init(
        trackIDs: [String],
        index: Int,
        positionMs: Int64,
        mode: String,
        playbackState: String
    ) {
        self.trackIDs = trackIDs
        self.index = index
        self.positionMs = positionMs
        self.mode = mode
        self.playbackState = playbackState
    }
}

/// Owns the single AVPlayer for the app, plus the queue, restore points and
/// system playback controls (lock screen, headphones).
@MainActor
@Observable
public final class PlaybackService {
    public struct Item: Identifiable, Equatable, Codable, Sendable {
        public var id: UUID
        public var trackID: String
        public var title: String
        public var artist: String
        public var album: String?
        public var hasCover: Bool
        public var streamPath: String

        private enum CodingKeys: String, CodingKey {
            case id, trackID, title, artist, album, hasCover, streamPath
        }

        public init(
            id: UUID = UUID(),
            trackID: String,
            title: String,
            artist: String,
            album: String? = nil,
            hasCover: Bool = false,
            streamPath: String
        ) {
            self.id = id
            self.trackID = trackID
            self.title = title
            self.artist = artist
            self.album = album
            self.hasCover = hasCover
            self.streamPath = streamPath
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(UUID.self, forKey: .id)
            trackID = try container.decode(String.self, forKey: .trackID)
            title = try container.decode(String.self, forKey: .title)
            artist = try container.decode(String.self, forKey: .artist)
            album = try container.decodeIfPresent(String.self, forKey: .album)
            hasCover = try container.decodeIfPresent(Bool.self, forKey: .hasCover) ?? false
            streamPath = try container.decode(String.self, forKey: .streamPath)
        }
    }

    public private(set) var queue = PlaybackQueue()
    public private(set) var isPlaying = false
    /// True when the queue stopped after its last track, so handoff publishes
    /// `ended` instead of offering a finished queue as a paused one.
    public private(set) var didFinishQueue = false
    public private(set) var isBuffering = false
    public private(set) var currentTime: Double = 0
    public private(set) var duration: Double = 0
    public private(set) var bufferedTime: Double = 0
    public var volume: Float = 1 {
        didSet { player.volume = volume }
    }
    public private(set) var errorMessage: String?

    public var items: [Item] { queue.items }
    public var playbackItems: [Item] { queue.playbackItems }
    public var currentIndex: Int? { queue.currentIndex }
    public var currentItem: Item? { queue.current }
    public var repeatMode: PlaybackQueue.RepeatMode { queue.repeatMode }
    public var isShuffled: Bool { queue.isShuffled }
    public private(set) var podcastPlaybackRate: Float = 1
    public var playbackRate: Float {
        currentItem?.trackID.hasPrefix("podcast_ep_") == true ? podcastPlaybackRate : 1
    }

    /// Sampled by visible lyric views; keeps animation separate from persistence ticks.
    public var lyricTime: Double {
        guard pendingSeek == nil, isPlaying, player.currentItem != nil else { return currentTime }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? transcodeBaseSeconds + seconds : currentTime
    }

    @ObservationIgnored let server: ServerAddress
    @ObservationIgnored let player: AVPlayer
    @ObservationIgnored private let store: any QueueStore
    @ObservationIgnored private let persistence: PersistenceQueue
    @ObservationIgnored private let resourceLoader: WildstringAudioResourceLoader
    @ObservationIgnored let cookieHeader: @Sendable () async -> String?
    @ObservationIgnored private let fragmentCache: AudioDiskCache?
    @ObservationIgnored private let offlineLookup: @Sendable (String) -> URL?
    @ObservationIgnored private let planProvider:
        (@Sendable (String, Int?, Int64) async throws -> PlaybackPlan)?
    @ObservationIgnored private var assetLoadTask: Task<Void, Never>?
    @ObservationIgnored private var transcodeBaseSeconds: Double = 0
    @ObservationIgnored private var durationOverrideSeconds: Double?
    @ObservationIgnored private var currentIsTranscode = false
    @ObservationIgnored private var sleepTask: Task<Void, Never>?
    @ObservationIgnored private var didStreamFallback = false
    @ObservationIgnored var intendedPlaying = false
    @ObservationIgnored private var pendingSeek: Double?
    @ObservationIgnored private var seekInFlight = false
    @ObservationIgnored var activateAudioSession: () throws -> Void = activateSystemAudioSession
    /// AAC 档位（kbps）；nil 表示原音。
    @ObservationIgnored public var preferredBitrateKbps: Int?
    @ObservationIgnored private var listening = ListeningTracker()
    @ObservationIgnored private var activeMediaID: String?
    /// Return false when the upload failed so the same cumulative total is retried.
    @ObservationIgnored public var submitListening: (@Sendable (ListeningReport) async -> Bool)?
    @ObservationIgnored private var podcast = PodcastBookmark()
    @ObservationIgnored private var podcastBoot: Task<Void, Never>?
    @ObservationIgnored public var podcastDeviceID = ""
    /// Reads the bookmark version before a new episode session. Nil means the read failed.
    @ObservationIgnored public var loadPodcastBaseVersion: (@Sendable (String) async -> Int?)?
    @ObservationIgnored public var submitPodcastProgress:
        (@Sendable (String, PodcastProgressWrite) async -> PodcastSubmitResult)?
    public private(set) var podcastProgressMessage: String?
    public private(set) var currentOutputLabel: String?
    public private(set) var sleepTimerEnd: Date?
    public private(set) var pauseAfterCurrentTrack = false
    @ObservationIgnored private var itemObservations: [NSKeyValueObservation] = []
    @ObservationIgnored private var timeControlObservation: NSKeyValueObservation?
    @ObservationIgnored private var timeObserverToken: Any?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var secondsSinceCheckpoint: Double = 0
    @ObservationIgnored var systemControlsConfigured = false
    @ObservationIgnored var systemObserverTokens: [NSObjectProtocol] = []
#if os(iOS) || os(macOS)
    @ObservationIgnored var nowPlayingArtworkTask: Task<Void, Never>?
    @ObservationIgnored var nowPlayingArtworkTrackID: String?
#endif
    /// Sent with cover fetches for Now Playing artwork. The Mac app sets `macos`.
    @ObservationIgnored public var clientHeaderName = "ios"

    public init(
        server: ServerAddress,
        store: any QueueStore,
        cookieHeader: @escaping @Sendable () async -> String?,
        fragmentCache: AudioDiskCache? = nil,
        offlineLookup: @escaping @Sendable (String) -> URL? = { _ in nil },
        planProvider: (@Sendable (String, Int?, Int64) async throws -> PlaybackPlan)? = nil
    ) {
        self.server = server
        self.store = store
        self.persistence = PersistenceQueue(store: store)
        self.player = AVPlayer()
        self.player.automaticallyWaitsToMinimizeStalling = true
        self.cookieHeader = cookieHeader
        self.fragmentCache = fragmentCache
        self.offlineLookup = offlineLookup
        self.planProvider = planProvider
        self.resourceLoader = WildstringAudioResourceLoader(
            server: server,
            cookieHeader: cookieHeader,
            cache: fragmentCache
        )
    }

    /// Loads the persisted queue in a paused state; playback only starts on demand.
    public func restore() async {
        guard let persisted = try? await store.load() else { return }
        queue = PlaybackQueue(items: persisted.items, currentIndex: persisted.currentIndex)
        currentTime = persisted.position
        duration = 0
        isPlaying = false
        updateSystemNowPlaying()
    }

    // MARK: - Commands

    public func play(items: [Item], startingAt index: Int, position: Double = 0) {
        queue.set(items: items, startingAt: index)
        startCurrent(autoplay: true, startAt: max(0, position))
        persistQueueAndProgress()
    }

    public func togglePlayPause() {
        if intendedPlaying || isPlaying {
            pause()
        } else {
            resume()
        }
    }

    public func resume() {
        guard currentItem != nil else { return }
        intendedPlaying = true
        errorMessage = nil
        if assetLoadTask != nil { return }
        if player.currentItem == nil {
            startCurrent(autoplay: true, startAt: currentTime)
        } else {
            beginPlayback()
        }
    }

    public func setPodcastPlaybackRate(_ rate: Float) {
        guard (0.5...3).contains(rate) else { return }
        podcastPlaybackRate = rate
        if intendedPlaying { beginPlayback() }
        updateSystemNowPlaying()
    }

    public func pause() {
        intendedPlaying = false
        didFinishQueue = false
        player.pause()
        isPlaying = false
        isBuffering = false
        if pendingSeek == nil { persistProgress() }
        checkpointListening(state: "paused")
        checkpointPodcast(event: "pause", force: true)
        updateSystemNowPlaying()
    }

    public func next() {
        move(by: 1)
    }

    public func previous() {
        move(by: -1)
    }

    // MARK: - Queue editing and modes

    @discardableResult
    public func enqueue(items: [Item], next: Bool = false) -> Bool {
        guard !items.isEmpty else { return false }
        guard queue.count + items.count <= 5000 else {
            errorMessage = "播放队列最多 5000 首。"
            return false
        }
        let wasEmpty = queue.count == 0
        queue.enqueue(items, next: next)
        persistQueueAndProgress()
        if wasEmpty { startCurrent(autoplay: true, startAt: 0) }
        return true
    }

    public func toggleShuffle() {
        queue.toggleShuffle()
        persistQueueAndProgress()
    }

    public func cycleRepeatMode() {
        queue.cycleRepeatMode()
    }

    public func playQueueEntry(at index: Int) {
        queue.move(to: index)
        startCurrent(autoplay: true, startAt: 0)
        persistProgress()
    }

    public func removeQueueEntry(at index: Int) {
        guard index != currentIndex else { return }
        queue.remove(at: index)
        persistQueueAndProgress()
    }

    public func movePlaybackEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        queue.movePlaybackEntries(fromOffsets: offsets, toOffset: destination)
        persistQueueAndProgress()
    }

    public func moveQueueEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        queue.moveEntries(fromOffsets: offsets, toOffset: destination)
        persistQueueAndProgress()
    }

    public func seek(to seconds: Double) {
        guard currentItem != nil else { return }
        let upper = duration > 0 ? duration : seconds
        let target = min(max(0, seconds), upper)
        if currentIsTranscode || assetLoadTask != nil {
            // Transcode streams are not byte-seekable: reload the plan from the
            // target position instead (start_ms semantics).
            currentTime = target
            persistProgress()
            startCurrent(autoplay: intendedPlaying, startAt: target)
            return
        }
        currentTime = target
        errorMessage = nil
        guard player.currentItem != nil else {
            persistProgress()
            updateSystemNowPlaying()
            return
        }
        pendingSeek = target
        player.pause()
        isPlaying = false
        isBuffering = intendedPlaying
        seekPendingPosition()
    }

    private func seekPendingPosition() {
        guard !seekInFlight, let target = pendingSeek,
            let item = player.currentItem, item.status == .readyToPlay
        else { return }
        seekInFlight = true
        // Preserve millisecond lyric boundaries, and wait for completion before
        // issuing the latest requested position or restarting playback.
        player.seek(
            to: CMTime(value: Self.milliseconds(target), timescale: 1000),
            toleranceBefore: .zero, toleranceAfter: .zero,
            completionHandler: seekCompletion(
                CallbackRef(value: item), target: target, box: PlaybackServiceBox(self)
            )
        )
    }

    fileprivate func seekCompleted(target: Double, finished: Bool) {
        seekInFlight = false
        guard let latest = pendingSeek else { return }
        if latest != target {
            seekPendingPosition()
            return
        }
        pendingSeek = nil
        let actual = player.currentTime().seconds
        if actual.isFinite { currentTime = transcodeBaseSeconds + actual }
        persistProgress()
        listening.reanchor(
            nowMs: Self.monotonicMs(),
            positionMs: Self.milliseconds(currentTime),
            playing: intendedPlaying
        )
        if finished { checkpointPodcast(event: "seek", force: true) }
        beginPlayback()
        if !finished { errorMessage = "跳转未完成，请重试" }
        updateSystemNowPlaying()
    }

    private func beginPlayback() {
        guard intendedPlaying, pendingSeek == nil, assetLoadTask == nil,
            player.currentItem != nil
        else { return }
        do {
            try activateAudioSession()
            player.defaultRate = playbackRate
            player.play()
            timeControlChanged(status: player.timeControlStatus)
        } catch {
            intendedPlaying = false
            player.pause()
            isPlaying = false
            isBuffering = false
            errorMessage = "无法启用音频播放，请重试：\(error.localizedDescription)"
            updateSystemNowPlaying()
        }
    }

    public func stopAndClear() {
        assetLoadTask?.cancel()
        assetLoadTask = nil
        cancelSleepTimer()
        intendedPlaying = false
        pendingSeek = nil
        seekInFlight = false
        player.replaceCurrentItem(with: nil)
        queue = PlaybackQueue()
        currentTime = 0
        duration = 0
        isPlaying = false
        isBuffering = false
        errorMessage = nil
        transcodeBaseSeconds = 0
        durationOverrideSeconds = nil
        currentIsTranscode = false
        currentOutputLabel = nil
        clearSystemNowPlaying()
        _ = listening.begin(
            trackID: nil,
            nowMs: Self.monotonicMs(),
            positionMs: 0,
            playing: false,
            startedAt: Date().timeIntervalSince1970
        )
        activeMediaID = nil
        podcastBoot?.cancel()
        podcast.clear()
        podcastProgressMessage = nil
        persistence.enqueue { store in try? await store.clear() }
    }

    /// Removes observers and playback; used when the session ends.
    public func shutdown() {
        assetLoadTask?.cancel()
        cancelSleepTimer()
        stopAndClear()
        if let timeObserverToken {
            player.removeTimeObserver(timeObserverToken)
            self.timeObserverToken = nil
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
        itemObservations = []
        timeControlObservation = nil
        for token in systemObserverTokens {
            NotificationCenter.default.removeObserver(token)
        }
        systemObserverTokens = []
    }

    /// Waits until queued persistence writes have been flushed (tests, teardown).
    public func flushPersistence() async {
        await persistence.flush()
    }

    // MARK: - Cross-device handoff

    /// Snapshot of the current queue/position/mode for another device.
    public func playbackSnapshot() -> PlaybackSnapshot {
        let mode: String
        if queue.isShuffled {
            mode = "shuffle"
        } else {
            switch queue.repeatMode {
            case .off: mode = "sequential"
            case .all: mode = "repeat_all"
            case .one: mode = "repeat_one"
            }
        }
        return PlaybackSnapshot(
            trackIDs: queue.items.map(\.trackID),
            index: queue.currentIndex ?? 0,
            positionMs: Int64(max(0, currentTime) * 1000),
            mode: mode,
            playbackState: didFinishQueue ? "ended" : (isPlaying ? "playing" : "paused")
        )
    }

    /// Adopts a snapshot from another device: queue, mode and paused position.
    public func adopt(items: [Item], startingAt index: Int, position: Double, mode: String) {
        guard !items.isEmpty else { return }
        queue.set(items: items, startingAt: min(max(0, index), items.count - 1))
        let shuffled = mode == "shuffle"
        if queue.isShuffled != shuffled {
            queue.toggleShuffle()
        }
        switch mode {
        case "repeat_one": queue.setRepeatMode(.one)
        case "repeat_all", "shuffle": queue.setRepeatMode(.all)
        default: queue.setRepeatMode(.off)
        }
        assetLoadTask?.cancel()
        assetLoadTask = nil
        intendedPlaying = false
        pendingSeek = nil
        seekInFlight = false
        player.replaceCurrentItem(with: nil)
        currentTime = max(0, position)
        duration = 0
        isPlaying = false
        isBuffering = false
        didFinishQueue = false
        errorMessage = nil
        persistQueueAndProgress()
        updateSystemNowPlaying()
    }

    // MARK: - Sleep timer

    public func setSleepTimer(minutes: Int) {
        cancelSleepTimer()
        sleepTimerEnd = Date().addingTimeInterval(TimeInterval(minutes) * 60)
        sleepTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(minutes * 60))
            guard !Task.isCancelled else { return }
            self?.fireSleepTimer()
        }
    }

    public func sleepAfterCurrentTrack() {
        cancelSleepTimer()
        pauseAfterCurrentTrack = true
    }

    public func cancelSleepTimer() {
        sleepTask?.cancel()
        sleepTask = nil
        sleepTimerEnd = nil
        pauseAfterCurrentTrack = false
    }

    private func fireSleepTimer() {
        sleepTask = nil
        sleepTimerEnd = nil
        pause()
    }

    // MARK: - Fragment cache management

    public func fragmentCacheStats() async -> AudioDiskCache.Stats? {
        guard let fragmentCache else { return nil }
        return await fragmentCache.stats()
    }

    public func setFragmentCacheLimit(_ bytes: Int64) {
        guard let fragmentCache else { return }
        Task { await fragmentCache.setLimit(bytes) }
    }

    public func clearFragmentCache() async {
        guard let fragmentCache else { return }
        try? await fragmentCache.clear()
    }

    // MARK: - Internals

    private func move(by delta: Int) {
        let result = delta >= 0 ? queue.advance() : queue.rewind()
        guard result != nil else { return }
        startCurrent(autoplay: intendedPlaying, startAt: 0)
        persistProgress()
    }

    private func prefetchLeadingBytes(of item: Item) {
        resourceLoader.prefetch(path: item.streamPath)
    }

    private func startCurrent(autoplay: Bool, startAt: Double) {
        assetLoadTask?.cancel()
        assetLoadTask = nil
        intendedPlaying = autoplay
        pendingSeek = nil
        seekInFlight = false
        player.pause()
        guard let item = currentItem else {
            adoptMedia(autoplay: false, startAt: 0)
            player.replaceCurrentItem(with: nil)
            isPlaying = false
            return
        }
        adoptMedia(autoplay: autoplay, startAt: startAt)
        didFinishQueue = false
        configureSystemPlaybackIfNeeded()
        if let offline = offlineLookup(item.trackID),
            FileManager.default.fileExists(atPath: offline.path)
        {
            buildAsset(
                url: offline,
                isTranscode: false,
                transcodeBaseSeconds: 0,
                durationOverride: nil,
                outputLabel: "离线",
                autoplay: autoplay,
                startAt: startAt
            )
            return
        }
        if planProvider != nil, preferredBitrateKbps != nil {
            player.replaceCurrentItem(with: nil)
            currentTime = startAt
            isPlaying = false
            isBuffering = autoplay
            assetLoadTask = Task {
                await self.resolveTranscodeAndStart(startAt: startAt)
            }
            return
        }
        prefetchLeadingBytes(of: item)
        buildAsset(
            url: WildstringAudioResourceLoader.assetURL(server: server, path: item.streamPath),
            isTranscode: false,
            transcodeBaseSeconds: 0,
            durationOverride: nil,
            outputLabel: "原音",
            autoplay: autoplay,
            startAt: startAt
        )
    }

    /// Fetches the playback decision first: AAC transcodes carry their own start
    /// offset and duration, and fall back to the original stream when the server
    /// cannot transcode (base playback never depends on FFmpeg).
    private func resolveTranscodeAndStart(startAt: Double) async {
        guard !Task.isCancelled else { return }
        guard let item = currentItem, let planProvider, let bitrate = preferredBitrateKbps else {
            assetLoadTask = nil
            return
        }
        do {
            let plan = try await planProvider(item.trackID, bitrate, Int64(startAt * 1000))
            try Task.checkCancellation()
            guard currentItem?.id == item.id else { return }
            assetLoadTask = nil
            if plan.isTranscode, let path = Self.relativePath(from: plan.streamUrl) {
                let baseMs = plan.startMs ?? 0
                buildAsset(
                    url: WildstringAudioResourceLoader.assetURL(server: server, path: path),
                    isTranscode: true,
                    transcodeBaseSeconds: Double(baseMs) / 1000,
                    durationOverride: plan.durationMs.map { Double($0) / 1000 },
                    outputLabel: Self.outputLabel(for: plan),
                    autoplay: intendedPlaying,
                    startAt: 0
                )
            } else {
                prefetchLeadingBytes(of: item)
                buildAsset(
                    url: WildstringAudioResourceLoader.assetURL(
                        server: server,
                        path: item.streamPath
                    ),
                    isTranscode: false,
                    transcodeBaseSeconds: 0,
                    durationOverride: plan.durationMs.map { Double($0) / 1000 },
                    outputLabel: Self.outputLabel(for: plan),
                    autoplay: intendedPlaying,
                    startAt: startAt
                )
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, currentItem?.id == item.id else { return }
            assetLoadTask = nil
            errorMessage = "转码暂不可用，已回退原音"
            prefetchLeadingBytes(of: item)
            buildAsset(
                url: WildstringAudioResourceLoader.assetURL(server: server, path: item.streamPath),
                isTranscode: false,
                transcodeBaseSeconds: 0,
                durationOverride: nil,
                outputLabel: "原音",
                autoplay: intendedPlaying,
                startAt: startAt
            )
        }
    }

    private func buildAsset(
        url: URL,
        isTranscode: Bool,
        transcodeBaseSeconds: Double,
        durationOverride: Double?,
        outputLabel: String?,
        autoplay: Bool,
        startAt: Double
    ) {
        let options = [AVURLAssetPreferPreciseDurationAndTimingKey: true]
        let asset = AVURLAsset(url: url, options: options)
        if !url.isFileURL {
            asset.resourceLoader.setDelegate(resourceLoader, queue: resourceLoader.callbackQueue)
        }
        let playerItem = AVPlayerItem(asset: asset)
        playerItem.audioTimePitchAlgorithm = .timeDomain
        player.pause()
        pendingSeek = !isTranscode && startAt > 0 ? startAt : nil
        seekInFlight = false
        if isTranscode {
            didStreamFallback = false
        }
        self.transcodeBaseSeconds = isTranscode ? transcodeBaseSeconds : 0
        self.durationOverrideSeconds = durationOverride
        self.currentIsTranscode = isTranscode
        self.currentOutputLabel = outputLabel
        intendedPlaying = autoplay
        currentTime = isTranscode ? transcodeBaseSeconds : startAt
        duration = durationOverride ?? 0
        bufferedTime = 0
        errorMessage = nil
        isPlaying = false
        isBuffering = autoplay
        // Observe before association, which starts preparing the item.
        observe(playerItem: playerItem)
        player.replaceCurrentItem(with: playerItem)
        if pendingSeek != nil {
            seekPendingPosition()
        } else {
            beginPlayback()
        }
        updateSystemNowPlaying()
    }

    private static func relativePath(from streamUrl: String) -> String? {
        guard let url = URL(string: streamUrl) else { return nil }
        var path = url.path
        while path.hasPrefix("/") { path.removeFirst() }
        guard !path.isEmpty else { return nil }
        if let query = url.query, !query.isEmpty {
            path += "?" + query
        }
        return path
    }

    private static func outputLabel(for plan: PlaybackPlan) -> String {
        if plan.isTranscode {
            if let bitrate = plan.output.bitrateKbps {
                return "AAC \(bitrate) kbps"
            }
            return "AAC 转码"
        }
        let codec = plan.output.codec.uppercased()
        return codec.isEmpty ? "原音" : "原音 · \(codec)"
    }

    private func observe(playerItem: AVPlayerItem) {
        // Handlers are built outside this main-actor method. Closures formed
        // here inherit a main-actor check, and AVFoundation invokes KVO on its
        // own queue, which traps in `_dispatch_assert_queue_fail`.
        let box = PlaybackServiceBox(self)
        let item = CallbackRef(value: playerItem)
        itemObservations = [
            observeItemStatus(item, box: box),
            observeItemDuration(item, box: box),
        ]
        if timeControlObservation == nil {
            timeControlObservation = observeTimeControl(CallbackRef(value: player), box: box)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = observeItemEnded(item, box: box)
        if timeObserverToken == nil {
            timeObserverToken = observePlaybackTicks(CallbackRef(value: player), box: box)
        }
    }

    fileprivate func itemDurationChanged() {
        guard durationOverrideSeconds == nil || durationOverrideSeconds == 0 else { return }
        let itemDuration = player.currentItem?.duration.seconds ?? 0
        if itemDuration.isFinite, itemDuration > 0, itemDuration != duration {
            duration = itemDuration
            updateSystemNowPlaying()
        }
    }

    fileprivate func itemStatusChanged(status: AVPlayerItem.Status, error: Error?) {
        switch status {
        case .failed:
            isPlaying = false
            isBuffering = false
            pendingSeek = nil
            seekInFlight = false
            if currentIsTranscode, !didStreamFallback, let item = currentItem {
                // The transcode stream failed mid-flight (e.g. no FFmpeg on the
                // server): fall back to the original file once, keeping position.
                didStreamFallback = true
                let resumeAt = transcodeBaseSeconds
                buildAsset(
                    url: WildstringAudioResourceLoader.assetURL(
                        server: server,
                        path: item.streamPath
                    ),
                    isTranscode: false,
                    transcodeBaseSeconds: 0,
                    durationOverride: nil,
                    outputLabel: "原音",
                    autoplay: intendedPlaying,
                    startAt: resumeAt
                )
                errorMessage = "转码流失败，已回退原音"
                return
            }
            intendedPlaying = false
            if let error = error as? APIError {
                errorMessage = Self.message(for: error)
            } else if let error {
                #if DEBUG
                    let nsError = error as NSError
                    errorMessage = "无法播放这首歌曲（\(nsError.domain) \(nsError.code)）"
                #else
                    errorMessage = "无法播放这首歌曲"
                #endif
            } else {
                errorMessage = "无法播放这首歌曲"
            }
        case .readyToPlay:
            if let durationOverrideSeconds, durationOverrideSeconds > 0 {
                duration = durationOverrideSeconds
            } else {
                let itemDuration = player.currentItem?.duration.seconds ?? 0
                if itemDuration.isFinite, itemDuration > 0 {
                    duration = itemDuration
                }
            }
            seekPendingPosition()
            updateSystemNowPlaying()
        default:
            break
        }
    }

    fileprivate func timeControlChanged(status: AVPlayer.TimeControlStatus) {
        isPlaying = status == .playing
        isBuffering = intendedPlaying && (status == .waitingToPlayAtSpecifiedRate
            || pendingSeek != nil || assetLoadTask != nil)
        if status == .paused, pendingSeek == nil {
            persistProgress()
        }
        updateSystemNowPlaying()
    }

    fileprivate func handleTick(seconds: Double) {
        guard pendingSeek == nil, player.currentItem != nil, seconds.isFinite else { return }
        currentTime = transcodeBaseSeconds + seconds
        if duration <= 0, durationOverrideSeconds == nil,
            let itemDuration = player.currentItem?.duration.seconds,
            itemDuration.isFinite, itemDuration > 0
        {
            duration = itemDuration
            updateSystemNowPlaying()
        }
        secondsSinceCheckpoint += 1
        if secondsSinceCheckpoint >= 5 {
            secondsSinceCheckpoint = 0
            persistProgress()
        }
        let state = isPlaying ? "playing" : "paused"
        if let report = listening.sample(
            nowMs: Self.monotonicMs(),
            positionMs: Self.milliseconds(currentTime),
            playing: isPlaying,
            state: state
        ) {
            deliver(report)
        }
        checkpointPodcast(event: isPlaying ? "progress" : "pause", force: false)
    }

    fileprivate func handleItemEnded() {
        if pauseAfterCurrentTrack {
            pauseAfterCurrentTrack = false
            intendedPlaying = false
            isPlaying = false
            currentTime = duration
            persistProgress()
            updateSystemNowPlaying()
            return
        }
        if queue.repeatMode == .one {
            intendedPlaying = true
            seek(to: 0)
            return
        }
        if let report = listening.flush(
            state: "ended",
            nowMs: Self.monotonicMs(),
            positionMs: Self.milliseconds(currentTime)
        ) {
            deliver(report)
        }
        checkpointPodcast(event: "ended", force: true)
        if queue.advance() != nil {
            startCurrent(autoplay: true, startAt: 0)
            persistProgress()
        } else {
            intendedPlaying = false
            isPlaying = false
            didFinishQueue = true
            currentTime = duration
            persistProgress()
            updateSystemNowPlaying()
        }
    }

    private func persistQueueAndProgress() {
        let items = queue.items
        let index = queue.currentIndex
        let position = currentTime
        persistence.enqueue { store in
            try? await store.saveQueue(items, currentIndex: index)
            try? await store.saveProgress(QueueProgress(index: index, position: position))
        }
    }

    private func persistProgress() {
        let progress = QueueProgress(index: queue.currentIndex, position: currentTime)
        persistence.enqueue { store in
            try? await store.saveProgress(progress)
        }
    }

    private func adoptMedia(autoplay: Bool, startAt: Double) {
        let identifier = currentItem?.trackID
        let now = Self.monotonicMs()
        let position = Self.milliseconds(startAt)
        if identifier == activeMediaID {
            listening.reanchor(nowMs: now, positionMs: position, playing: autoplay)
            checkpointPodcast(event: "seek", force: true)
            return
        }
        if let report = listening.begin(
            trackID: identifier,
            nowMs: now,
            positionMs: position,
            playing: autoplay,
            startedAt: Date().timeIntervalSince1970
        ) {
            deliver(report)
        }
        activeMediaID = identifier
        podcastBoot?.cancel()
        podcast.clear()
        podcastProgressMessage = nil
        guard let identifier, ListeningTracker.isPodcast(identifier) else { return }
        let episode = String(identifier.dropFirst("podcast_ep_".count))
        podcastBoot = Task { [weak self] in
            await self?.bootPodcast(episode)
        }
    }

    private func bootPodcast(_ episode: String) async {
        guard let load = loadPodcastBaseVersion else { return }
        guard let version = await load(episode) else { return }
        if Task.isCancelled || currentItem?.trackID != "podcast_ep_\(episode)" { return }
        podcast.begin(episodeId: episode, deviceId: podcastDeviceID, baseVersion: version)
        checkpointPodcast(event: "play", force: true)
    }

    private func checkpointListening(state: String) {
        if let report = listening.flush(
            state: state,
            nowMs: Self.monotonicMs(),
            positionMs: Self.milliseconds(currentTime)
        ) {
            deliver(report)
        }
    }

    private func checkpointPodcast(event: String, force: Bool) {
        guard let write = podcast.next(
            positionSeconds: Int(currentTime.rounded()),
            durationSeconds: Int(duration.rounded()),
            event: event,
            nowMs: Self.monotonicMs(),
            force: force
        ) else { return }
        let episode = podcast.episodeId
        guard let submit = submitPodcastProgress else { return }
        Task { @MainActor in
            let result = await submit(episode, write)
            if result == .conflict {
                self.podcast.block()
                self.podcastProgressMessage = "这集在其他设备有更新的进度"
            }
        }
    }

    private func deliver(_ report: ListeningReport) {
        guard let submit = submitListening else { return }
        Task { @MainActor in
            let ok = await submit(report)
            if !ok {
                self.listening.reject(sessionId: report.sessionId)
            }
        }
    }

    private static func monotonicMs() -> Int64 {
        Int64((ProcessInfo.processInfo.systemUptime * 1000).rounded())
    }

    private static func milliseconds(_ seconds: Double) -> Int64 {
        guard seconds.isFinite else { return 0 }
        return Int64((seconds * 1000).rounded())
    }

    private static func message(for error: APIError) -> String {
        switch error.code {
        case "authentication_required": return "登录已过期，请重新登录"
        case "track_not_found": return "这首歌曲已不在曲库"
        case "file_changed", "track_unavailable": return "音频文件已变化，无法播放"
        default: return "无法播放（\(error.statusCode)）"
        }
    }
}

#if !os(iOS) && !os(macOS)
    extension PlaybackService {
        func configureSystemPlaybackIfNeeded() {}
        func updateSystemNowPlaying() {}
        func clearSystemNowPlaying() {}
    }
#endif

/// Holds the player service for callbacks AVFoundation makes off the main actor.
final class PlaybackServiceBox: @unchecked Sendable {
    nonisolated(unsafe) weak var service: PlaybackService?

    init(_ service: PlaybackService) {
        self.service = service
    }
}

private struct CallbackRef<T>: @unchecked Sendable {
    let value: T
}

/// Status KVO is delivered on an AVFoundation queue, not the main queue.
private func observeItemStatus(
    _ item: CallbackRef<AVPlayerItem>,
    box: PlaybackServiceBox
) -> NSKeyValueObservation {
    item.value.observe(\.status, options: [.initial, .new]) { _, _ in
        let service = box.service
        Task { @MainActor in
            guard let service, service.player.currentItem === item.value else { return }
            service.itemStatusChanged(status: item.value.status, error: item.value.error)
        }
    }
}

private func observeItemDuration(
    _ item: CallbackRef<AVPlayerItem>,
    box: PlaybackServiceBox
) -> NSKeyValueObservation {
    item.value.observe(\.duration, options: [.initial, .new]) { _, _ in
        let service = box.service
        Task { @MainActor in
            guard let service, service.player.currentItem === item.value else { return }
            service.itemDurationChanged()
        }
    }
}

private func observeTimeControl(
    _ player: CallbackRef<AVPlayer>,
    box: PlaybackServiceBox
) -> NSKeyValueObservation {
    player.value.observe(\.timeControlStatus, options: [.initial, .new]) { _, _ in
        let service = box.service
        Task { @MainActor in
            service?.timeControlChanged(status: player.value.timeControlStatus)
        }
    }
}

private func observeItemEnded(
    _ item: CallbackRef<AVPlayerItem>,
    box: PlaybackServiceBox
) -> NSObjectProtocol {
    NotificationCenter.default.addObserver(
        forName: AVPlayerItem.didPlayToEndTimeNotification,
        object: item.value,
        queue: .main
    ) { _ in
        let service = box.service
        Task { @MainActor in
            guard let service, service.player.currentItem === item.value else { return }
            service.handleItemEnded()
        }
    }
}

private func observePlaybackTicks(
    _ player: CallbackRef<AVPlayer>,
    box: PlaybackServiceBox
) -> Any {
    player.value.addPeriodicTimeObserver(
        forInterval: CMTime(seconds: 1, preferredTimescale: 1),
        queue: .main
    ) { _ in
        let service = box.service
        Task { @MainActor in
            service?.handleTick(seconds: player.value.currentTime().seconds)
        }
    }
}

private func seekCompletion(
    _ item: CallbackRef<AVPlayerItem>, target: Double, box: PlaybackServiceBox
) -> @Sendable (Bool) -> Void {
    { finished in
        let service = box.service
        Task { @MainActor in
            guard let service, service.player.currentItem === item.value else { return }
            service.seekCompleted(target: target, finished: finished)
        }
    }
}

/// Serializes fire-and-forget persistence writes in call order.
final class PersistenceQueue: @unchecked Sendable {
    private let store: any QueueStore
    private let lock = NSLock()
    private var pending: Task<Void, Never> = Task {}

    init(store: any QueueStore) {
        self.store = store
    }

    func enqueue(_ operation: @escaping @Sendable (any QueueStore) async -> Void) {
        lock.withLock {
            let previous = pending
            let store = self.store
            pending = Task {
                await previous.value
                await operation(store)
            }
        }
    }

    func flush() async {
        let task = lock.withLock { pending }
        await task.value
    }
}
