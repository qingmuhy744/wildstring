import AVFoundation
import CoreNetwork
import Foundation
import Observation

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
        public var streamPath: String

        public init(
            id: UUID = UUID(),
            trackID: String,
            title: String,
            artist: String,
            album: String? = nil,
            streamPath: String
        ) {
            self.id = id
            self.trackID = trackID
            self.title = title
            self.artist = artist
            self.album = album
            self.streamPath = streamPath
        }
    }

    public private(set) var queue = PlaybackQueue()
    public private(set) var isPlaying = false
    public private(set) var isBuffering = false
    public private(set) var currentTime: Double = 0
    public private(set) var duration: Double = 0
    public private(set) var errorMessage: String?

    public var items: [Item] { queue.items }
    public var currentIndex: Int? { queue.currentIndex }
    public var currentItem: Item? { queue.current }
    public var repeatMode: PlaybackQueue.RepeatMode { queue.repeatMode }
    public var isShuffled: Bool { queue.isShuffled }

    @ObservationIgnored let server: ServerAddress
    @ObservationIgnored let player: AVPlayer
    @ObservationIgnored private let store: any QueueStore
    @ObservationIgnored private let persistence: PersistenceQueue
    @ObservationIgnored private let resourceLoader: WildstringAudioResourceLoader
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
    @ObservationIgnored private var intendedPlaying = false
    /// AAC 档位（kbps）；nil 表示原音。
    @ObservationIgnored public var preferredBitrateKbps: Int?
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

    public func play(items: [Item], startingAt index: Int) {
        queue.set(items: items, startingAt: index)
        startCurrent(autoplay: true, startAt: 0)
        persistQueueAndProgress()
    }

    public func togglePlayPause() {
        if isPlaying {
            pause()
        } else {
            resume()
        }
    }

    public func resume() {
        guard currentItem != nil else { return }
        intendedPlaying = true
        if player.currentItem == nil {
            startCurrent(autoplay: true, startAt: currentTime)
        } else {
            player.play()
        }
    }

    public func pause() {
        intendedPlaying = false
        player.pause()
        persistProgress()
    }

    public func next() {
        move(by: 1)
    }

    public func previous() {
        move(by: -1)
    }

    // MARK: - Queue editing and modes

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
        queue.remove(at: index)
        persistQueueAndProgress()
    }

    public func moveQueueEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        queue.moveEntries(fromOffsets: offsets, toOffset: destination)
        persistQueueAndProgress()
    }

    public func seek(to seconds: Double) {
        let upper = duration > 0 ? duration : seconds
        let target = min(max(0, seconds), upper)
        if currentIsTranscode {
            // Transcode streams are not byte-seekable: reload the plan from the
            // target position instead (start_ms semantics).
            currentTime = target
            persistProgress()
            startCurrent(autoplay: isPlaying, startAt: target)
            return
        }
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
        currentTime = target
        persistProgress()
    }

    public func stopAndClear() {
        assetLoadTask?.cancel()
        assetLoadTask = nil
        cancelSleepTimer()
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
        startCurrent(autoplay: isPlaying, startAt: 0)
        persistProgress()
    }

    private func prefetchLeadingBytes(of item: Item) {
        resourceLoader.prefetch(path: item.streamPath)
    }

    private func startCurrent(autoplay: Bool, startAt: Double) {
        guard let item = currentItem else {
            player.replaceCurrentItem(with: nil)
            isPlaying = false
            return
        }
        configureSystemPlaybackIfNeeded()
        assetLoadTask?.cancel()
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
        if let planProvider, preferredBitrateKbps != nil {
            assetLoadTask = Task {
                await self.resolveTranscodeAndStart(autoplay: autoplay, startAt: startAt)
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
    private func resolveTranscodeAndStart(autoplay: Bool, startAt: Double) async {
        guard let item = currentItem, let planProvider, let bitrate = preferredBitrateKbps else {
            return
        }
        do {
            let plan = try await planProvider(item.trackID, bitrate, Int64(startAt * 1000))
            try Task.checkCancellation()
            guard currentItem?.id == item.id else { return }
            if plan.isTranscode, let path = Self.relativePath(from: plan.streamUrl) {
                let baseMs = plan.startMs ?? 0
                buildAsset(
                    url: WildstringAudioResourceLoader.assetURL(server: server, path: path),
                    isTranscode: true,
                    transcodeBaseSeconds: Double(baseMs) / 1000,
                    durationOverride: plan.durationMs.map { Double($0) / 1000 },
                    outputLabel: Self.outputLabel(for: plan),
                    autoplay: autoplay,
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
                    autoplay: autoplay,
                    startAt: startAt
                )
            }
        } catch is CancellationError {
            return
        } catch {
            guard currentItem?.id == item.id else { return }
            errorMessage = "转码暂不可用，已回退原音"
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
        let asset = AVURLAsset(url: url)
        if !url.isFileURL {
            asset.resourceLoader.setDelegate(resourceLoader, queue: .main)
        }
        let playerItem = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: playerItem)
        observe(playerItem: playerItem)
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
        errorMessage = nil
        if startAt > 0, !isTranscode {
            player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600))
        }
        if autoplay {
            player.play()
            isPlaying = true
        } else {
            isPlaying = false
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
        itemObservations = [
            playerItem.observe(\.status, options: [.new]) { [weak self] item, _ in
                let status = item.status
                let error = item.error
                Task { @MainActor [weak self] in
                    self?.itemStatusChanged(status: status, error: error)
                }
            }
        ]
        if timeControlObservation == nil {
            timeControlObservation = player.observe(\.timeControlStatus, options: [.new]) {
                [weak self] player, _ in
                let status = player.timeControlStatus
                Task { @MainActor [weak self] in
                    self?.timeControlChanged(status: status)
                }
            }
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: playerItem,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleItemEnded()
            }
        }
        if timeObserverToken == nil {
            timeObserverToken = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 1, preferredTimescale: 1),
                queue: .main
            ) { [weak self] time in
                let seconds = time.seconds
                Task { @MainActor [weak self] in
                    self?.handleTick(seconds: seconds)
                }
            }
        }
    }

    private func itemStatusChanged(status: AVPlayerItem.Status, error: Error?) {
        switch status {
        case .failed:
            isPlaying = false
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
            updateSystemNowPlaying()
        default:
            break
        }
    }

    private func timeControlChanged(status: AVPlayer.TimeControlStatus) {
        isPlaying = status == .playing
        isBuffering = status == .waitingToPlayAtSpecifiedRate
        if status == .paused {
            persistProgress()
        }
        updateSystemNowPlaying()
    }

    private func handleTick(seconds: Double) {
        guard seconds.isFinite else { return }
        currentTime = transcodeBaseSeconds + seconds
        secondsSinceCheckpoint += 1
        if secondsSinceCheckpoint >= 5 {
            secondsSinceCheckpoint = 0
            persistProgress()
        }
        updateSystemNowPlaying()
    }

    private func handleItemEnded() {
        if pauseAfterCurrentTrack {
            pauseAfterCurrentTrack = false
            isPlaying = false
            currentTime = duration
            persistProgress()
            updateSystemNowPlaying()
            return
        }
        if queue.repeatMode == .one {
            player.seek(to: .zero)
            currentTime = 0
            player.play()
            isPlaying = true
            persistProgress()
            updateSystemNowPlaying()
            return
        }
        if queue.advance() != nil {
            startCurrent(autoplay: true, startAt: 0)
            persistProgress()
        } else {
            isPlaying = false
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

    private static func message(for error: APIError) -> String {
        switch error.code {
        case "authentication_required": return "登录已过期，请重新登录"
        case "track_not_found": return "这首歌曲已不在曲库"
        case "file_changed", "track_unavailable": return "音频文件已变化，无法播放"
        default: return "无法播放（\(error.statusCode)）"
        }
    }
}

#if !os(iOS)
    extension PlaybackService {
        func configureSystemPlaybackIfNeeded() {}
        func updateSystemNowPlaying() {}
        func clearSystemNowPlaying() {}
    }
#endif

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
