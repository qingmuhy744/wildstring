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
        offlineLookup: @escaping @Sendable (String) -> URL? = { _ in nil }
    ) {
        self.server = server
        self.store = store
        self.persistence = PersistenceQueue(store: store)
        self.player = AVPlayer()
        self.fragmentCache = fragmentCache
        self.offlineLookup = offlineLookup
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
        if player.currentItem == nil {
            startCurrent(autoplay: true, startAt: currentTime)
        } else {
            player.play()
        }
    }

    public func pause() {
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
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
        currentTime = target
        persistProgress()
    }

    public func stopAndClear() {
        player.replaceCurrentItem(with: nil)
        queue = PlaybackQueue()
        currentTime = 0
        duration = 0
        isPlaying = false
        isBuffering = false
        errorMessage = nil
        clearSystemNowPlaying()
        persistence.enqueue { store in try? await store.clear() }
    }

    /// Removes observers and playback; used when the session ends.
    public func shutdown() {
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

    private func startCurrent(autoplay: Bool, startAt: Double) {
        guard let item = currentItem else {
            player.replaceCurrentItem(with: nil)
            isPlaying = false
            return
        }
        configureSystemPlaybackIfNeeded()
        let asset: AVURLAsset
        if let offline = offlineLookup(item.trackID),
            FileManager.default.fileExists(atPath: offline.path)
        {
            asset = AVURLAsset(url: offline)
        } else {
            asset = AVURLAsset(
                url: WildstringAudioResourceLoader.assetURL(
                    server: server,
                    path: item.streamPath
                )
            )
            asset.resourceLoader.setDelegate(resourceLoader, queue: .main)
        }
        let playerItem = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: playerItem)
        observe(playerItem: playerItem)
        currentTime = startAt
        duration = 0
        errorMessage = nil
        if startAt > 0 {
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
            let itemDuration = player.currentItem?.duration.seconds ?? 0
            if itemDuration.isFinite, itemDuration > 0 {
                duration = itemDuration
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
        currentTime = seconds
        secondsSinceCheckpoint += 1
        if secondsSinceCheckpoint >= 5 {
            secondsSinceCheckpoint = 0
            persistProgress()
        }
        updateSystemNowPlaying()
    }

    private func handleItemEnded() {
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
