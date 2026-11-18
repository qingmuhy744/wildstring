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

/// Which list the current podcast follows. Show playback never rewrites the cloud queue.
public enum PodcastPlaybackLine: Sendable {
    case show
    case queue
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
        public var mayHaveCover: Bool {
            hasCover || (album != nil && !album!.isEmpty)
        }
        public var coverTrackID: String? {
            mayHaveCover ? trackID : nil
        }
        public var streamPath: String
        public var unavailableReason: String?
        public var resumePositionSeconds: Double
        public var durationSeconds: Double

        private enum CodingKeys: String, CodingKey {
            case id, trackID, title, artist, album, hasCover, streamPath, unavailableReason, resumePositionSeconds, durationSeconds
        }

        public init(
            id: UUID = UUID(),
            trackID: String,
            title: String,
            artist: String,
            album: String? = nil,
            hasCover: Bool = false,
            streamPath: String,
            unavailableReason: String? = nil,
            resumePositionSeconds: Double = 0,
            durationSeconds: Double = 0
        ) {
            self.id = id
            self.trackID = trackID
            self.title = title
            self.artist = artist
            self.album = album
            self.hasCover = hasCover
            self.streamPath = streamPath
            self.unavailableReason = unavailableReason
            self.resumePositionSeconds = resumePositionSeconds
            self.durationSeconds = durationSeconds
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
            unavailableReason = try container.decodeIfPresent(String.self, forKey: .unavailableReason)
            resumePositionSeconds = try container.decodeIfPresent(Double.self, forKey: .resumePositionSeconds) ?? 0
            durationSeconds = try container.decodeIfPresent(Double.self, forKey: .durationSeconds) ?? 0
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

    public var wantsPlayback: Bool { intendedPlaying }
    public var items: [Item] { queue.items }
    public var playbackItems: [Item] { queue.playbackItems }
    public var currentIndex: Int? { queue.currentIndex }
    public var currentItem: Item? { podcastOverrideItem ?? queue.current }
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
    @ObservationIgnored private var currentItemIsPodcast = false
    @ObservationIgnored private var currentItemIsLocalFile = false
    @ObservationIgnored private var sleepTask: Task<Void, Never>?
    @ObservationIgnored private var didStreamFallback = false
    @ObservationIgnored var intendedPlaying = false
    @ObservationIgnored private var audioInterrupted = false
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
    @ObservationIgnored private var podcastBootToken: UUID?
    @ObservationIgnored private var podcastBootSeek: Double?
    @ObservationIgnored private var podcastResumeSeek: Double?
    public struct PodcastResumePrompt: Sendable {
        public let position: Int
        public let duration: Int
    }
    private struct PendingPodcastPrompt {
        let token: UUID
        let episode: String
        let snapshot: PodcastProgressSnapshot?
        let fallback: Double
        let autoplay: Bool
    }
    public private(set) var podcastResumePrompt: PodcastResumePrompt?
    @ObservationIgnored private var pendingPodcastPrompt: PendingPodcastPrompt?
    @ObservationIgnored private var podcastShouldAsk = false
    @ObservationIgnored private var podcastConflictVersion: Int?
    @ObservationIgnored private var podcastHasConflict = false
    @ObservationIgnored private var podcastKnownCompleted = false
    private struct StoredPodcast: Codable {
        var bookmark: PodcastBookmark
        var position: Double
        var duration: Double
        var completed: Bool
        var version: Int
        var conflict: Bool = false
        var conflictVersion: Int? = nil
        var pending: Bool? = nil
        var pendingEvent: String? = nil
    }
    @ObservationIgnored private var restoredPodcast: StoredPodcast?
    @ObservationIgnored var podcastReadTimeout: Duration = .milliseconds(1500)
    @ObservationIgnored private var podcastWriteTasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var podcastWriteTail: [String: UUID] = [:]
    @ObservationIgnored private var podcastHistoryFlush: Task<Void, Never>?
    @ObservationIgnored public var podcastDeviceID = ""
    /// Reads the remote bookmark before explicit episode selection or resume.
    @ObservationIgnored public var loadPodcastProgress: (@Sendable (String) async throws -> PodcastProgressSnapshot?)?
    /// Reads the bookmark version before a new episode session. Nil means the read failed.
    @ObservationIgnored public var loadPodcastBaseVersion: (@Sendable (String) async -> Int?)?
    @ObservationIgnored private var podcastExplicitStartPosition = false
    /// True only while an automatic transition (episode ended, skipping completed episodes) starts the next
    /// episode. User-initiated starts leave it false, so a completed episode restarts instead of being skipped.
    @ObservationIgnored private var podcastAutomaticStart = false
    @ObservationIgnored private var podcastSkippingCompleted = false
    @ObservationIgnored public var submitPodcastProgress:
        (@Sendable (String, PodcastProgressWrite) async -> PodcastSubmitResult)?
    public private(set) var podcastProgressMessage: String?
    public var podcastCanUseLocalProgress: Bool { podcastHasConflict }
    /// Cloud 待播 queue. Nil keeps the local player behavior used by tests.
    public var podcastCloud: PodcastCloudQueue? {
        didSet {
            podcastCloud?.onPreferencesChanged = { [weak self] in
                self?.syncContinuationPreferenceFromCloud()
            }
            syncContinuationPreferenceFromCloud()
        }
    }
    /// Client-side podcast auto-continuation state (never synced, never queued).
    public var podcastAutoContinueEnabled = true
    /// Queue line steps inside the cloud queue. Show line uses the show rule and does not fall into the queue.
    public private(set) var podcastLine: PodcastPlaybackLine = .show
    @ObservationIgnored private var podcastContinuationShowID: String?
    @ObservationIgnored private var podcastEpisodes: [PodcastContinuation.Episode] = []
    @ObservationIgnored private var podcastPreference = PodcastContinuation.Preference()
    /// Transient episode played by auto-continuation; deliberately not part of
    /// `queue`, so the "接下来" auto part stays a read-only preview.
    var podcastOverrideItem: Item?
    /// Bumped whenever a newer play should cancel an in-flight cloud handoff.
    @ObservationIgnored private var podcastTurn = 0
    @ObservationIgnored private var podcastContinuationTask: Task<Void, Never>?
    @ObservationIgnored private var podcastAdvanceTask: Task<Void, Never>?
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
        connectionFailure: (@Sendable () async -> Void)? = nil,
        offlineLookup: @escaping @Sendable (String) -> URL? = { _ in nil },
        planProvider: (@Sendable (String, Int?, Int64) async throws -> PlaybackPlan)? = nil,
        resourceConfiguration: URLSessionConfiguration? = nil
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
            configuration: resourceConfiguration,
            cache: fragmentCache,
            connectionFailure: connectionFailure
        )
    }

    /// Loads the persisted queue in a paused state; playback only starts on demand.
    public func restore() async {
        guard let persisted = try? await store.load() else { return }
        queue = PlaybackQueue(items: persisted.items, currentIndex: persisted.currentIndex)
        podcastOverrideItem = nil
        currentTime = persisted.position
        duration = currentItem.map { max(0, $0.durationSeconds) } ?? 0
        if let episode = Self.podcastEpisodeID(currentItem?.trackID ?? "") {
            restoredPodcast = loadStoredPodcast(episode)
        }
        isPlaying = false
        updateSystemNowPlaying()
    }

    /// Transfers an in-memory queue between routes of the same authenticated server.
    /// Preserve entry IDs, shuffle order, repeat mode and position without reloading items.
    public func restoreRouteQueue(_ snapshot: PlaybackQueue, position: Double) {
        queue = snapshot
        podcastOverrideItem = nil
        currentTime = max(0, position)
        duration = currentItem.map { max(0, $0.durationSeconds) } ?? 0
        isPlaying = false
        persistQueueAndProgress()
        updateSystemNowPlaying()
    }

    // MARK: - Commands

    public func play(items: [Item], startingAt index: Int, position: Double = 0) {
        guard items.indices.contains(index) else { return }
        let turn = invalidatePodcastAdvance()
        podcastOverrideItem = nil
        podcastExplicitStartPosition = true
        podcastAutomaticStart = false
        if let reason = items[index].unavailableReason {
            errorMessage = KitL10n("kit.playback.trackUnavailableRetry", items[index].title, reason)
            return
        }
        let playable = items.filter { $0.unavailableReason == nil }
        let selectedIndex = items.prefix(index).filter { $0.unavailableReason == nil }.count
        queue.set(items: playable, startingAt: selectedIndex)
        if let episodeID = Self.podcastEpisodeID(queue.current?.trackID ?? "") {
            podcastLine = .show
            preparePodcastContinuation(forEpisodeID: episodeID, turn: turn)
        }
        startCurrent(autoplay: true, startAt: max(0, position))
        persistQueueAndProgress()
    }

    // MARK: - Podcast auto-continuation

    /// Configures the client-side auto-continuation rule for the show currently
    /// being played. Pure local data: no network calls and no queue writes.
    public func configurePodcastContinuation(
        podcastID: String? = nil,
        episodes: [PodcastContinuation.Episode],
        preference: PodcastContinuation.Preference
    ) {
        podcastContinuationShowID = podcastID
        podcastEpisodes = episodes
        podcastPreference = preference
        podcastAutoContinueEnabled = preference.autoContinue
    }

    /// Plays one explicitly chosen episode without rewriting the cloud queue.
    /// `.show` follows that show. `.queue` continues from that row in the pending list.
    /// Music already in the local queue stays behind the episode.
    public func playPodcastEpisode(
        _ item: Item,
        position: Double? = nil,
        line: PodcastPlaybackLine = .show
    ) {
        podcastLine = line
        podcastResumeSeek = nil
        restoredPodcast = nil
        podcastResumePrompt = nil
        pendingPodcastPrompt = nil
        podcastShouldAsk = position == nil && podcastCloud?.resumeMode == "ask"
        activeMediaID = nil // A new explicit selection always starts a fresh session.
        let restart = position != nil || podcastCloud?.resumeMode == "restart"
        podcastExplicitStartPosition = restart
        podcastAutomaticStart = false
        startPodcastEpisode(item, position: position ?? (restart ? 0 : item.resumePositionSeconds))
    }

    private func startPodcastEpisode(_ item: Item, position: Double, autoplay: Bool = true) {
        let turn = invalidatePodcastAdvance()
        guard item.unavailableReason == nil else {
            errorMessage = KitL10n("kit.playback.itemUnavailable", item.title)
            return
        }
        podcastOverrideItem = nil
        if let episodeID = Self.podcastEpisodeID(item.trackID) {
            preparePodcastContinuation(forEpisodeID: episodeID, turn: turn)
        }
        let rest: [Item]
        if podcastCloud != nil {
            rest = queue.items.filter { !$0.trackID.hasPrefix("podcast_ep_") }
        } else {
            rest = queue.items.filter { $0.id != item.id }
        }
        queue.set(items: [item] + rest, startingAt: 0)
        startCurrent(autoplay: autoplay, startAt: max(0, position))
        persistQueueAndProgress()
    }

    private func preparePodcastContinuation(forEpisodeID episodeID: String, turn: Int) {
        if podcastEpisodes.contains(where: { $0.id == episodeID }) {
            syncContinuationPreferenceFromCloud()
            return
        }
        podcastEpisodes = []
        podcastContinuationShowID = podcastCloud?.episodes[episodeID]?.podcastId
        syncContinuationPreferenceFromCloud()
        guard let cloud = podcastCloud else { return }
        podcastContinuationTask?.cancel()
        podcastContinuationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            _ = try? await self.syncPodcastContinuation(forEpisodeID: episodeID, cloud: cloud, turn: turn)
        }
    }

    private func syncContinuationPreferenceFromCloud() {
        guard let cloud = podcastCloud, cloud.hasResolvedPreferences else { return }
        let pref = cloud.showPreference(podcastContinuationShowID ?? "").continuation
        podcastPreference = pref
        podcastAutoContinueEnabled = pref.autoContinue
    }

    private func syncPodcastContinuation(
        forEpisodeID episodeID: String,
        cloud: PodcastCloudQueue,
        turn: Int
    ) async throws {
        let context = try await cloud.continuationContext(forEpisodeID: episodeID)
        guard turn == podcastTurn else { return }
        configurePodcastContinuation(
            podcastID: context.podcastID,
            episodes: context.episodes,
            preference: context.preference
        )
    }

    /// Manual 上一集 / 下一集 in podcast mode. With a cloud queue, the step follows
    /// the current line and does not write auto-continue rows. Without one, the
    /// adjacent show episode stays a local override.
    public func skipPodcastEpisode(_ direction: PodcastContinuation.Skip) {
        podcastAutomaticStart = false
        if beginContextStep(direction) { return }
        invalidatePodcastAdvance()
        guard let currentID = currentItem?.trackID, currentID.hasPrefix("podcast_ep_"),
              let next = podcastAdjacentItem(
                  currentID: currentID, direction: direction, requireAutoContinue: false
              )
        else { return }
        podcastExplicitStartPosition = false
        podcastOverrideItem = next
        startCurrent(autoplay: intendedPlaying, startAt: next.resumePositionSeconds)
    }

    /// Read-only preview of what auto-continuation will play once the manual
    /// queue is exhausted. These items are never written to `queue`.
    public func podcastAutoPreview(limit: Int = 3, anchorTrackID: String? = nil) -> [Item] {
        guard podcastAutoContinueEnabled else { return [] }
        guard let anchor = anchorTrackID
                ?? podcastOverrideItem?.trackID
                ?? queue.items.last(where: { $0.trackID.hasPrefix("podcast_ep_") })?.trackID
                ?? currentItem?.trackID,
              anchor.hasPrefix("podcast_ep_") else { return [] }
        var result: [Item] = []
        var id = anchor
        while result.count < limit {
            guard let next = podcastAdjacentItem(
                currentID: id, direction: .next, requireAutoContinue: true
            ) else { break }
            result.append(next)
            id = next.trackID
        }
        return result
    }

    private func podcastAdjacentItem(
        currentID: String,
        direction: PodcastContinuation.Skip,
        requireAutoContinue: Bool
    ) -> Item? {
        let episodeID = String(currentID.dropFirst("podcast_ep_".count))
        var preference = podcastPreference
        preference.autoContinue = requireAutoContinue ? podcastAutoContinueEnabled : true
        let episode: PodcastContinuation.Episode?
        switch direction {
        case .next:
            episode = PodcastContinuation.nextEpisode(
                currentID: episodeID, episodes: podcastEpisodes, preference: preference
            )
        case .previous:
            episode = PodcastContinuation.previousEpisode(
                currentID: episodeID, episodes: podcastEpisodes, preference: preference
            )
        }
        guard let episode else { return nil }
        return Item(
            trackID: "podcast_ep_\(episode.id)",
            title: episode.title,
            artist: episode.artist,
            album: episode.album,
            streamPath: "api/v1/podcasts/episodes/\(episode.id)/stream?proxy=1&cache=1",
            resumePositionSeconds: episode.isCompleted ? 0 : episode.resumePositionSeconds,
            durationSeconds: episode.durationSeconds
        )
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
        if pendingPodcastPrompt != nil { return }
        if let episode = Self.podcastEpisodeID(currentItem?.trackID ?? ""), loadPodcastProgress != nil {
            if intendedPlaying, isPlaying || isBuffering || audioInterrupted || podcastBootToken != nil { return }
            intendedPlaying = true
            errorMessage = nil
            let token = UUID()
            podcastBootToken = token
            isBuffering = true
            player.pause()
            readPodcastProgress(episode, token: token) { [weak self] snapshot in
                self?.finishPodcastResume(token: token, episode: episode, snapshot: snapshot)
            }
            return
        }
        intendedPlaying = true
        errorMessage = nil
        if assetLoadTask != nil { return }
        if player.currentItem == nil {
            if activeMediaID == nil, Self.podcastEpisodeID(currentItem?.trackID ?? "") != nil {
                podcastShouldAsk = podcastCloud?.resumeMode == "ask"
                podcastExplicitStartPosition = podcastCloud?.resumeMode == "restart"
            }
            podcastAutomaticStart = false
            startCurrent(autoplay: true, startAt: podcastExplicitStartPosition ? 0 : currentTime)
        } else {
            beginPlayback()
            checkpointPodcast(event: "play", force: true)
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
        invalidatePodcastAdvance()
        podcastAdvanceTask?.cancel()
        podcastBoot?.cancel(); podcastBootToken = nil
        pendingPodcastPrompt = nil; podcastResumePrompt = nil
        didFinishQueue = false
        player.pause()
        isPlaying = false
        isBuffering = false
        if pendingSeek == nil, assetLoadTask == nil, player.currentItem?.status == .readyToPlay {
            let native = player.currentTime().seconds
            if native.isFinite { currentTime = transcodeBaseSeconds + native }
        }
        if pendingSeek == nil { persistProgress() }
        checkpointListening(state: "paused")
        checkpointPodcast(event: "pause", force: true)
        updateSystemNowPlaying()
    }

    public func next() {
        if beginContextStep(.next) { return }
        if podcastOverrideItem != nil { skipPodcastEpisode(.next); return }
        move(by: 1)
    }

    public func previous() {
        if beginContextStep(.previous) { return }
        if podcastOverrideItem != nil { skipPodcastEpisode(.previous); return }
        move(by: -1)
    }

    // MARK: - Queue editing and modes

    @discardableResult
    public func enqueue(items: [Item], next: Bool = false) -> Bool {
        let playable = items.filter { $0.unavailableReason == nil }
        guard !playable.isEmpty else {
            errorMessage = KitL10n("kit.playback.noPlayableTracks")
            return false
        }
        let podcasts = playable.filter { Self.podcastEpisodeID($0.trackID) != nil }
        let music = playable.filter { Self.podcastEpisodeID($0.trackID) == nil }
        if !podcasts.isEmpty {
            // Podcast add / play-next only edits the cloud queue. An empty music
            // queue must not start playback as a side effect.
            let currentID = Self.podcastEpisodeID(currentItem?.trackID ?? "")
            if let cloud = podcastCloud {
                for item in podcasts {
                    guard let episodeID = Self.podcastEpisodeID(item.trackID) else { continue }
                    cloud.enqueueEpisode(episodeID, next: next, currentEpisodeID: currentID)
                }
            } else {
                guard queue.count + podcasts.count <= 5000 else {
                    errorMessage = KitL10n("kit.playback.queueLimit")
                    return false
                }
                queue.enqueue(podcasts, next: next)
                persistQueueAndProgress()
            }
            if music.isEmpty { return true }
        }
        guard queue.count + music.count <= 5000 else {
            errorMessage = KitL10n("kit.playback.queueLimit")
            return false
        }
        let wasEmpty = queue.count == 0
        podcastOverrideItem = nil
        queue.enqueue(music, next: next)
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
        podcastOverrideItem = nil
        queue.move(to: index)
        startCurrent(autoplay: true, startAt: 0)
        persistProgress()
    }

    public func removeQueueEntry(at index: Int) {
        guard index != currentIndex else { return }
        podcastOverrideItem = nil
        queue.remove(at: index)
        persistQueueAndProgress()
    }

    public func movePlaybackEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        podcastOverrideItem = nil
        queue.movePlaybackEntries(fromOffsets: offsets, toOffset: destination)
        persistQueueAndProgress()
    }

    public func moveQueueEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        podcastOverrideItem = nil
        queue.moveEntries(fromOffsets: offsets, toOffset: destination)
        persistQueueAndProgress()
    }

    public func seek(to seconds: Double) {
        performSeek(to: seconds, isUserInitiated: true)
    }

    private func performSeek(to seconds: Double, isUserInitiated: Bool) {
        guard currentItem != nil else { return }
        if isUserInitiated, Self.podcastEpisodeID(currentItem?.trackID ?? "") != nil, !intendedPlaying || podcastBootToken != nil {
            podcastResumeSeek = max(0, seconds)
        }
        if isUserInitiated {
            if podcastBootToken != nil {
                podcastBootSeek = max(0, seconds)
                currentTime = max(0, seconds)
                return
            }
        }
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
        // Preserve millisecond lyric boundaries for music and local files, while allowing
        // coarse byte-offset seeking on remote podcasts so long MP3s don't scan from byte 0.
        let tolerance: CMTime = (currentItemIsPodcast && !currentItemIsLocalFile)
            ? CMTime(seconds: 0.5, preferredTimescale: 600)
            : .zero
        player.seek(
            to: CMTime(value: Self.milliseconds(target), timescale: 1000),
            toleranceBefore: tolerance, toleranceAfter: tolerance,
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
        if !finished { errorMessage = KitL10n("kit.playback.seekIncomplete") }
        updateSystemNowPlaying()
    }

    private func beginPlayback() {
        guard intendedPlaying, pendingSeek == nil, assetLoadTask == nil,
            player.currentItem != nil, podcastBootToken == nil, !audioInterrupted
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
            errorMessage = KitL10n("kit.playback.audioSessionFailed", error.localizedDescription)
            updateSystemNowPlaying()
        }
    }

    /// System recovery retains the original transport intent; only an explicit command reads the cloud.
    func beginAudioInterruption() {
        audioInterrupted = true
        player.pause()
    }

    func resumeAfterInterruption(allowed: Bool = true) {
        audioInterrupted = false
        if !allowed { pause(); return }
        guard intendedPlaying else { return }
        beginPlayback()
    }

    private func readPodcastProgress(_ episode: String, token: UUID,
        finish: @escaping @MainActor (PodcastProgressSnapshot?) -> Void) {
        guard let load = loadPodcastProgress else { return }
        podcastBoot?.cancel()
        podcastBoot = Task { @MainActor [weak self] in
            do {
                let snapshot = try await load(episode)
                guard let self, self.podcastBootToken == token else { return }
                finish(snapshot)
            } catch is CancellationError { return }
            catch let error as APIError where error.statusCode < 500 {
                guard let self, self.podcastBootToken == token else { return }
                self.podcastBootToken = nil
                self.intendedPlaying = false; self.isBuffering = false
                self.errorMessage = Self.message(for: error)
                self.updateSystemNowPlaying()
            } catch {
                guard let self, self.podcastBootToken == token else { return }
                finish(nil)
            }
        }
        Task { @MainActor [weak self] in
            guard let delay = self?.podcastReadTimeout else { return }
            try? await Task.sleep(for: delay)
            guard let self, self.podcastBootToken == token else { return }
            self.podcastBoot?.cancel()
            finish(nil)
        }
    }

    private func finishPodcastResume(token: UUID, episode: String, snapshot: PodcastProgressSnapshot?) {
        guard podcastBootToken == token, currentItem?.trackID == "podcast_ep_\(episode)" else { return }
        podcastBootToken = nil
        let stored = loadStoredPodcast(episode)
        let previous = podcast.ready ? podcast : stored?.bookmark ?? podcast
        let same = snapshot?.sessionId == previous.sessionId && snapshot?.deviceId == podcastDeviceID
        let localEnded = stored?.pendingEvent == "ended" && (snapshot == nil || same || snapshot?.version == 0)
        if podcastResumeSeek == nil, snapshot?.completed == true || localEnded || (snapshot == nil && stored?.completed == true) {
            intendedPlaying = false; isBuffering = false
            podcast.block(); podcastKnownCompleted = true
            podcastProgressMessage = KitL10n("kit.playback.podcastAlreadyCompleted")
            updateSystemNowPlaying()
            return
        }
        let position = podcastResumeSeek ?? (snapshot == nil || snapshot?.version == 0 || (same && previous.sequence >= (snapshot?.sequence ?? 0))
            ? (podcast.ready ? currentTime : stored?.position ?? currentTime) : Double(snapshot!.positionSeconds))
        let reuse = previous.ready && !previous.blocked && previous.intent != "restart" && (same || snapshot == nil)
        let rebuild = player.currentItem == nil || currentIsTranscode
        if rebuild {
            startCurrent(autoplay: intendedPlaying, startAt: position, podcastPrepared: true)
        }
        if reuse { podcast = previous }
        else {
            beginPodcastBookmark(episode: episode, snapshot: snapshot, stored: stored, intent: "resume")
        }
        podcastHasConflict = false; podcastConflictVersion = nil; podcastProgressMessage = nil
        podcastKnownCompleted = snapshot?.completed ?? stored?.completed ?? false
        restoredPodcast = nil; podcastResumeSeek = nil; podcastBootSeek = nil
        if !rebuild { performSeek(to: position, isUserInitiated: false) }
        saveStoredPodcast(position: position, completed: podcastKnownCompleted)
        if snapshot != nil { checkpointPodcast(event: "play", force: true) }
        beginPlayback()
    }

    public func stopAndClear(preservingStoredQueue: Bool = false) {
        if preservingStoredQueue { persistQueueAndProgress() }
        assetLoadTask?.cancel()
        assetLoadTask = nil
        cancelSleepTimer()
        intendedPlaying = false
        pendingSeek = nil
        seekInFlight = false
        resourceLoader.cancelPendingRequests()
        player.replaceCurrentItem(with: nil)
        queue = PlaybackQueue()
        podcastOverrideItem = nil
        podcastExplicitStartPosition = false
        currentTime = 0
        duration = 0
        isPlaying = false
        isBuffering = false
        errorMessage = nil
        transcodeBaseSeconds = 0
        durationOverrideSeconds = nil
        currentIsTranscode = false
        currentItemIsPodcast = false
        currentItemIsLocalFile = false
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
        podcastContinuationTask?.cancel()
        podcastContinuationTask = nil
        podcastAdvanceTask?.cancel()
        podcastAdvanceTask = nil
        podcast.clear()
        podcastProgressMessage = nil
        if !preservingStoredQueue {
            persistence.enqueue { store in try? await store.clear() }
        }
    }

    /// Removes observers and playback; used when the session ends.
    public func shutdown(preservingQueue: Bool = false) {
        assetLoadTask?.cancel()
        cancelSleepTimer()
        stopAndClear(preservingStoredQueue: preservingQueue)
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
        podcastOverrideItem = nil
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
        podcastExplicitStartPosition = false
        resourceLoader.cancelPendingRequests()
        player.replaceCurrentItem(with: nil)
        currentTime = max(0, position)
        duration = currentItem.map { max(0, $0.durationSeconds) } ?? 0
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

    /// Opens a connection to the server so the first playback request reuses
    /// a warm socket. Cheap HEAD; failures are ignored by design.
    public func warmConnection() {
        resourceLoader.warm()
    }

    private func startCurrent(autoplay: Bool, startAt: Double, podcastPrepared: Bool = false) {
        let automaticStart = podcastAutomaticStart
        podcastAutomaticStart = false
        assetLoadTask?.cancel()
        assetLoadTask = nil
        if !podcastPrepared {
            podcastBootToken = nil
            pendingPodcastPrompt = nil
            podcastResumePrompt = nil
        }
        intendedPlaying = autoplay
        pendingSeek = nil
        seekInFlight = false
        player.pause()
        resourceLoader.cancelPendingRequests()
        guard let item = currentItem else {
            adoptMedia(autoplay: false, startAt: 0)
            player.replaceCurrentItem(with: nil)
            isPlaying = false
            return
        }
        if !podcastPrepared, let episode = Self.podcastEpisodeID(item.trackID),
           item.trackID != activeMediaID, loadPodcastProgress != nil {
            let token = UUID()
            podcastBootToken = token
            podcastBootSeek = nil
            podcastBoot?.cancel()
            podcast.clear()
            podcastHasConflict = false
            podcastConflictVersion = nil
            podcastProgressMessage = nil
            player.replaceCurrentItem(with: nil)
            currentTime = max(0, startAt)
            isPlaying = false
            isBuffering = autoplay
            let restart = podcastExplicitStartPosition
            readPodcastProgress(episode, token: token) { [weak self] snapshot in
                self?.finishPodcastBoot(token: token, episode: episode, snapshot: snapshot,
                    fallback: startAt, autoplay: autoplay, restart: restart, automatic: automaticStart)
            }
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
                outputLabel: KitL10n("kit.playback.outputOffline"),
                autoplay: autoplay,
                startAt: startAt
            )
            return
        }
        if Self.podcastEpisodeID(item.trackID) == nil, planProvider != nil, preferredBitrateKbps != nil {
            player.replaceCurrentItem(with: nil)
            currentTime = startAt
            isPlaying = false
            isBuffering = autoplay
            assetLoadTask = Task {
                await self.resolveTranscodeAndStart(startAt: startAt)
            }
            return
        }
        if startAt <= 0 {
            prefetchLeadingBytes(of: item)
        }
        buildAsset(
            url: WildstringAudioResourceLoader.assetURL(server: server, path: item.streamPath),
            isTranscode: false,
            transcodeBaseSeconds: 0,
            durationOverride: nil,
            outputLabel: KitL10n("kit.playback.outputOriginal"),
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
                if startAt <= 0 {
                    prefetchLeadingBytes(of: item)
                }
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
            errorMessage = KitL10n("kit.playback.transcodeFallback")
            if startAt <= 0 {
                prefetchLeadingBytes(of: item)
            }
            buildAsset(
                url: WildstringAudioResourceLoader.assetURL(server: server, path: item.streamPath),
                isTranscode: false,
                transcodeBaseSeconds: 0,
                durationOverride: nil,
                outputLabel: KitL10n("kit.playback.outputOriginal"),
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
        let isPodcast = Self.podcastEpisodeID(currentItem?.trackID ?? "") != nil
        currentItemIsPodcast = isPodcast
        currentItemIsLocalFile = url.isFileURL
        // Precise timing forces AVURLAsset to scan every CBR MP3 frame from byte 0 before
        // seeking/playing. Keep it on for music and local files, and off for remote podcasts.
        let options = [AVURLAssetPreferPreciseDurationAndTimingKey: !isPodcast || url.isFileURL]
        let asset = AVURLAsset(url: url, options: options)
        if !url.isFileURL {
            asset.resourceLoader.setDelegate(resourceLoader, queue: resourceLoader.callbackQueue)
        }
        let playerItem = AVPlayerItem(asset: asset, automaticallyLoadedAssetKeys: ["playable"])
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
        let hintedDuration = currentItem.map { max(0, $0.durationSeconds) } ?? 0
        duration = durationOverride ?? hintedDuration
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
            return KitL10n("kit.playback.outputAacTranscode")
        }
        let codec = plan.output.codec.uppercased()
        return codec.isEmpty ? KitL10n("kit.playback.outputOriginal") : KitL10n("kit.playback.outputOriginalCodec", codec)
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
        guard let item = player.currentItem, item.status == .readyToPlay else { return }
        let itemDuration = item.duration.seconds
        if itemDuration.isFinite, itemDuration > 0, itemDuration != duration {
            duration = itemDuration
            updateSystemNowPlaying()
        }
    }

    func itemStatusChanged(status: AVPlayerItem.Status, error: Error?) {
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
                    outputLabel: KitL10n("kit.playback.outputOriginal"),
                    autoplay: intendedPlaying,
                    startAt: resumeAt
                )
                errorMessage = KitL10n("kit.playback.transcodeStreamFailedFallback")
                return
            }
            intendedPlaying = false
            // The queue already ended with its own message (for example the show's episode list
            // could not be read). A late load failure from the item that just finished must not
            // replace it; `resume()` clears the message, so failures after a replay still show.
            if didFinishQueue, errorMessage != nil { return }
            if let error = error as? APIError {
                errorMessage = Self.message(for: error)
            } else if let error {
                #if DEBUG
                    let nsError = error as NSError
                    errorMessage = KitL10n("kit.playback.cannotPlayDebug", nsError.domain, nsError.code)
                #else
                    errorMessage = KitL10n("kit.playback.cannotPlay")
                #endif
            } else {
                errorMessage = KitL10n("kit.playback.cannotPlay")
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

    func timeControlChanged(status: AVPlayer.TimeControlStatus) {
        isPlaying = status == .playing
        isBuffering = intendedPlaying && (status == .waitingToPlayAtSpecifiedRate
            || pendingSeek != nil || assetLoadTask != nil)
        if status == .paused, pendingSeek == nil {
            persistProgress()
        }
        updateSystemNowPlaying()
    }

    func handleTick(seconds: Double) {
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
        if isPlaying {
            checkpointPodcast(event: "progress", force: false)
        }
    }

    func handleItemEnded() {
        if pauseAfterCurrentTrack {
            pauseAfterCurrentTrack = false
            intendedPlaying = false
            isPlaying = false
            currentTime = duration
            checkpointPodcast(event: "ended", force: true)
            persistProgress()
            updateSystemNowPlaying()
            return
        }
        let endedTrackID = currentItem?.trackID
        let endedIsPodcast = endedTrackID?.hasPrefix("podcast_ep_") == true
        if !endedIsPodcast, queue.repeatMode == .one, podcastOverrideItem == nil {
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
        if let endedTrackID, let episodeID = Self.podcastEpisodeID(endedTrackID), podcastCloud != nil || submitPodcastProgress != nil {
            let turn = invalidatePodcastAdvance()
            let cloud = podcastCloud
            let session = podcast.sessionId
            let sequence = podcast.sequence
            let needsAcknowledgement = submitPodcastProgress != nil
            podcastAdvanceTask?.cancel()
            podcastAdvanceTask = Task { @MainActor in
                let deadline = ContinuousClock.now + self.podcastReadTimeout
                while needsAcknowledgement, !Task.isCancelled, turn == self.podcastTurn, self.podcast.sessionId == session,
                      !self.podcast.blocked, (self.podcast.completedSequence ?? 0) < sequence, ContinuousClock.now < deadline {
                    try? await Task.sleep(for: .milliseconds(20))
                }
                guard !Task.isCancelled, turn == self.podcastTurn, self.podcast.sessionId == session else { return }
                guard !needsAcknowledgement || (!self.podcast.blocked && (self.podcast.completedSequence ?? 0) >= sequence) else {
                    self.stopAtEndOfPodcast()
                    return
                }
                if cloud != nil {
                    await self.performContextStep(episodeID: episodeID, direction: .next, turn: turn, cloud: cloud, automatic: true)
                } else {
                    self.advanceLocalPodcast(endedTrackID: endedTrackID)
                }
            }
            return
        }
        if endedIsPodcast {
            advanceLocalPodcast(endedTrackID: endedTrackID)
            return
        }
        if podcastOverrideItem == nil, queue.advance() != nil {
            startCurrent(autoplay: true, startAt: 0)
            persistProgress()
            return
        }
        stopAtEndOfPodcast()
    }

    private func advanceLocalPodcast(endedTrackID: String?) {
        podcastExplicitStartPosition = false
        if podcastOverrideItem == nil, let next = advanceSequentialPodcastInLocalQueue() {
            podcastAutomaticStart = true
            startCurrent(autoplay: true, startAt: max(0, next.resumePositionSeconds))
            persistProgress()
            return
        }
        if let endedTrackID, let next = podcastAdjacentItem(currentID: endedTrackID, direction: .next, requireAutoContinue: true) {
            podcastOverrideItem = next
            podcastAutomaticStart = true
            startCurrent(autoplay: true, startAt: max(0, next.resumePositionSeconds))
            return
        }
        stopAtEndOfPodcast()
    }

    private func advanceSequentialPodcastInLocalQueue() -> Item? {
        guard let currentIndex = queue.currentIndex else { return nil }
        let nextIndex = currentIndex + 1
        guard queue.items.indices.contains(nextIndex),
              queue.items[nextIndex].trackID.hasPrefix("podcast_ep_")
        else { return nil }
        queue.move(to: nextIndex)
        return queue.current
    }

    /// Starts a cloud-backed previous/next. Returns false when this player should use the local queue.
    @discardableResult
    private func beginContextStep(_ direction: PodcastContinuation.Skip) -> Bool {
        guard podcastCloud != nil, let episodeID = Self.podcastEpisodeID(currentItem?.trackID ?? "") else {
            return false
        }
        let turn = invalidatePodcastAdvance()
        let cloud = podcastCloud
        podcastAdvanceTask?.cancel()
        podcastAdvanceTask = Task { @MainActor in
            await self.performContextStep(
                episodeID: episodeID,
                direction: direction,
                turn: turn,
                cloud: cloud,
                automatic: false
            )
        }
        return true
    }

    /// Queue line stays inside the queue. Show line uses the continuation rule and stops when the show ends.
    private func performContextStep(
        episodeID: String,
        direction: PodcastContinuation.Skip,
        turn: Int,
        cloud: PodcastCloudQueue?,
        automatic: Bool
    ) async {
        guard let cloud else { return }
        if podcastLine == .queue {
            await stepQueue(episodeID: episodeID, direction: direction, turn: turn, cloud: cloud, automatic: automatic)
            return
        }
        await stepShow(episodeID: episodeID, direction: direction, turn: turn, cloud: cloud, automatic: automatic)
    }

    private func stepQueue(
        episodeID: String,
        direction: PodcastContinuation.Skip,
        turn: Int,
        cloud: PodcastCloudQueue,
        automatic: Bool
    ) async {
        if direction == .previous {
            guard let previous = await cloud.episodeBefore(episodeID) else { return }
            guard let item = await cloud.playbackItem(for: previous.episodeId) else {
                guard turn == podcastTurn else { return }
                errorMessage = KitL10n("kit.playback.nextEpisodeUnavailable")
                return
            }
            guard turn == podcastTurn else { return }
            podcastExplicitStartPosition = false
            startPodcastEpisode(item, position: max(0, item.resumePositionSeconds), autoplay: intendedPlaying)
            return
        }
        let following = await cloud.episodeFinished(episodeID)
        guard turn == podcastTurn else { return }
        guard let following else {
            if automatic { stopAtEndOfPodcast() }
            return
        }
        guard let item = await cloud.playbackItem(for: following.episodeId) else {
            guard turn == podcastTurn else { return }
            errorMessage = KitL10n("kit.playback.nextEpisodeUnavailable")
            if automatic { stopAtEndOfPodcast() }
            return
        }
        guard turn == podcastTurn else { return }
        podcastExplicitStartPosition = false
        podcastAutomaticStart = automatic || podcastSkippingCompleted
        startPodcastEpisode(item, position: max(0, item.resumePositionSeconds), autoplay: automatic || intendedPlaying)
    }

    private func stepShow(
        episodeID: String,
        direction: PodcastContinuation.Skip,
        turn: Int,
        cloud: PodcastCloudQueue,
        automatic: Bool
    ) async {
        if automatic, direction == .next {
            _ = await cloud.episodeFinished(episodeID)
            guard turn == podcastTurn else { return }
        }
        let knownShowID = podcastContinuationShowID ?? cloud.episodes[episodeID]?.podcastId ?? ""
        if cloud.hasResolvedPreferences {
            let resolved = cloud.showPreference(knownShowID).continuation
            podcastPreference = resolved
            podcastAutoContinueEnabled = resolved.autoContinue
        }
        let missing = !podcastEpisodes.contains(where: { $0.id == episodeID })
        let anyShowEnablesAutoContinue = cloud.preferences?.shows.values.contains(where: \.autoContinue) == true
        let shouldSync = missing && (
            !automatic
                || !cloud.hasResolvedPreferences
                || podcastAutoContinueEnabled
                || (knownShowID.isEmpty && anyShowEnablesAutoContinue)
        )
        if shouldSync {
            do {
                try await syncPodcastContinuation(forEpisodeID: episodeID, cloud: cloud, turn: turn)
            } catch {
                guard turn == podcastTurn else { return }
                if automatic {
                    errorMessage = KitL10n("kit.playback.episodesReadFailed")
                    stopAtEndOfPodcast()
                }
                return
            }
        }
        guard turn == podcastTurn else { return }
        podcastExplicitStartPosition = false
        guard let adjacent = podcastAdjacentItem(
            currentID: "podcast_ep_\(episodeID)", direction: direction, requireAutoContinue: automatic
        ) else {
            if automatic { stopAtEndOfPodcast() }
            return
        }
        if !automatic, direction == .next {
            _ = await cloud.episodeFinished(episodeID)
            guard turn == podcastTurn else { return }
        }
        podcastOverrideItem = adjacent
        podcastAutomaticStart = automatic || podcastSkippingCompleted
        startCurrent(autoplay: automatic || intendedPlaying, startAt: max(0, adjacent.resumePositionSeconds))
    }

    private static func isPodcastSnapshotCompleted(_ snapshot: PodcastProgressSnapshot) -> Bool {
        snapshot.completed == true
    }

    func waitForPodcastTasks() async {
        var turn: Int
        repeat {
            turn = podcastTurn
            await podcastContinuationTask?.value
            await podcastAdvanceTask?.value
            await podcastBoot?.value
        } while turn != podcastTurn || podcastBootToken != nil
        await podcastHistoryFlush?.value
        while let writeTask = podcastWriteTasks.values.first {
            await writeTask.value
        }
    }

    private func stopAtEndOfPodcast() {
        podcastAutomaticStart = false
        intendedPlaying = false
        isPlaying = false
        didFinishQueue = true
        currentTime = duration
        persistProgress()
        updateSystemNowPlaying()
    }

    @discardableResult
    private func invalidatePodcastAdvance() -> Int {
        podcastTurn += 1
        return podcastTurn
    }

    public static func podcastEpisodeID(_ trackID: String) -> String? {
        guard trackID.hasPrefix("podcast_ep_") else { return nil }
        let episodeID = String(trackID.dropFirst("podcast_ep_".count))
        return episodeID.isEmpty ? nil : episodeID
    }

    private func persistQueueAndProgress() {
        var items = queue.items
        var index = queue.currentIndex
        if let podcastOverrideItem {
            if let index, items.indices.contains(index) { items[index] = podcastOverrideItem }
            else { items = [podcastOverrideItem]; index = 0 }
        }
        let savedItems = items
        let savedIndex = index
        let position = currentTime
        persistence.enqueue { store in
            try? await store.saveQueue(savedItems, currentIndex: savedIndex)
            try? await store.saveProgress(QueueProgress(index: savedIndex, position: position))
        }
    }

    private func persistProgress() {
        if podcastOverrideItem != nil { persistQueueAndProgress(); return }
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
        podcastResumeSeek = nil
        podcastBoot?.cancel()
        podcast.clear()
        podcastProgressMessage = nil
        podcastHasConflict = false
        podcastConflictVersion = nil
        if podcastOverrideItem != nil { persistQueueAndProgress() }
    }

    private func finishPodcastBoot(
        token: UUID, episode: String, snapshot: PodcastProgressSnapshot?,
        fallback: Double, autoplay: Bool, restart explicitRestart: Bool, automatic: Bool = false
    ) {
        guard podcastBootToken == token, currentItem?.trackID == "podcast_ep_\(episode)" else { return }
        podcastBootToken = nil
        let stored = loadStoredPodcast(episode)
        let completed = snapshot.map(Self.isPodcastSnapshotCompleted) ?? stored?.completed ?? false
        let promptPosition = snapshot?.positionSeconds ?? Int(stored?.position ?? fallback)
        if podcastShouldAsk, !explicitRestart, !completed, promptPosition > 0 {
            podcastShouldAsk = false
            pendingPodcastPrompt = PendingPodcastPrompt(token: token, episode: episode, snapshot: snapshot,
                                                       fallback: fallback, autoplay: autoplay)
            podcastResumePrompt = PodcastResumePrompt(position: promptPosition,
                duration: snapshot?.durationSeconds ?? Int(stored?.duration ?? duration))
            isBuffering = false
            return
        }
        podcastShouldAsk = false
        // Only automatic transitions skip a completed episode; the user choosing one replays it from the start.
        let skipsCompleted = !explicitRestart && completed && automatic
        let restart = explicitRestart || (completed && !automatic)
        podcastKnownCompleted = restart ? false : completed
        let shouldPlay = intendedPlaying
        if skipsCompleted {
            if let snapshot, let key = podcastStorageKey(episode) {
                let record = StoredPodcast(bookmark: stored?.bookmark ?? PodcastBookmark(),
                                           position: Double(snapshot.positionSeconds),
                                           duration: Double(snapshot.durationSeconds ?? 0),
                                           completed: true, version: snapshot.version)
                if let data = try? JSONEncoder().encode(record) { podcastCloud?.defaults.set(data, forKey: key) }
            }
            isBuffering = false
            if podcastCloud != nil {
                let turn = invalidatePodcastAdvance()
                podcastAdvanceTask = Task { @MainActor in
                    self.podcastSkippingCompleted = true
                    await self.performContextStep(episodeID: episode, direction: .next, turn: turn,
                                                  cloud: self.podcastCloud, automatic: false)
                    self.podcastSkippingCompleted = false
                    if self.currentItem?.trackID == "podcast_ep_\(episode)" {
                        self.stopAtEndOfPodcast()
                        self.podcastProgressMessage = KitL10n("kit.playback.podcastAlreadyCompleted")
                    }
                }
            } else if let next = podcastAdjacentItem(currentID: "podcast_ep_\(episode)", direction: .next,
                                                     requireAutoContinue: false) {
                podcastOverrideItem = next
                podcastExplicitStartPosition = false
                podcastAutomaticStart = true
                startCurrent(autoplay: shouldPlay, startAt: next.resumePositionSeconds)
            } else {
                stopAtEndOfPodcast()
                podcastProgressMessage = KitL10n("kit.playback.podcastAlreadyCompleted")
            }
            return
        }
        let bootSeek = podcastBootSeek
        podcastBootSeek = nil
        podcastResumeSeek = nil
        let same = stored != nil && snapshot?.sessionId == stored?.bookmark.sessionId && stored!.bookmark.sequence >= (snapshot?.sequence ?? 0)
        let observed = snapshot == nil || snapshot?.version == 0 || same
            ? stored?.position ?? snapshot.map { Double($0.positionSeconds) } ?? fallback
            : Double(snapshot!.positionSeconds)
        let position = bootSeek ?? (restart ? (completed && !automatic ? 0 : max(0, fallback)) : max(0, observed))
        startCurrent(autoplay: shouldPlay, startAt: position, podcastPrepared: true)
        if snapshot == nil, !restart, let restored = restoredPodcast, restored.bookmark.episodeId == episode {
            podcast = restored.bookmark
            if restored.conflict {
                podcastHasConflict = true
                podcastConflictVersion = restored.conflictVersion
                podcastProgressMessage = KitL10n("kit.playback.podcastProgressConflict")
            }
        } else {
            beginPodcastBookmark(episode: episode, snapshot: snapshot, stored: stored, intent: restart ? "restart" : "resume")
        }
        restoredPodcast = nil
        saveStoredPodcast(position: position, completed: false)
        if snapshot != nil { checkpointPodcast(event: bootSeek != nil ? "seek" : (shouldPlay ? "play" : "pause"), force: true) }
    }

    private func beginPodcastBookmark(episode: String, snapshot: PodcastProgressSnapshot?, stored: StoredPodcast?, intent: String) {
        let predecessor = stored.flatMap { saved in
            snapshot != nil && saved.bookmark.ready && !saved.bookmark.blocked &&
                (snapshot?.sessionId == saved.bookmark.sessionId || snapshot?.version == saved.bookmark.baseVersion)
                ? saved : nil
        }
        let localVersion = podcast.episodeId == episode ? podcast.baseVersion : 0
        let version = max(snapshot?.version ?? stored?.version ?? localVersion, predecessor?.version ?? 0)
        podcast.begin(episodeId: episode, deviceId: podcastDeviceID, baseVersion: version,
                      intent: intent, superseding: predecessor?.bookmark.sessionId)
    }

    public func answerPodcastResume(restart: Bool?) {
        guard let prompt = pendingPodcastPrompt else { return }
        pendingPodcastPrompt = nil
        podcastResumePrompt = nil
        guard let restart else {
            intendedPlaying = false
            isBuffering = false
            return
        }
        podcastBootToken = prompt.token
        finishPodcastBoot(token: prompt.token, episode: prompt.episode, snapshot: prompt.snapshot,
                          fallback: restart ? 0 : prompt.fallback, autoplay: prompt.autoplay, restart: restart)
    }

    private func podcastStorageKey(_ episode: String) -> String? {
        guard let account = podcastCloud?.accountKey else { return nil }
        return "wildstring.podcast.progress.\(account).\(episode)"
    }

    private func loadStoredPodcast(_ episode: String) -> StoredPodcast? {
        guard let key = podcastStorageKey(episode), let data = podcastCloud?.defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(StoredPodcast.self, from: data)
    }

    private func saveStoredPodcast(position: Double, completed: Bool, pending: Bool = true, event: String? = nil, acceptedVersion: Int? = nil) {
        guard podcast.ready, let key = podcastStorageKey(podcast.episodeId) else { return }
        let previous = loadStoredPodcast(podcast.episodeId)
        let pendingEvent = event ?? (previous?.bookmark.sessionId == podcast.sessionId ? previous?.pendingEvent : nil)
        let stored = StoredPodcast(bookmark: podcast, position: position, duration: duration,
                                   completed: completed, version: acceptedVersion ?? (previous?.bookmark.sessionId == podcast.sessionId ? previous!.version : podcast.baseVersion),
                                   conflict: podcastHasConflict, conflictVersion: podcastConflictVersion,
                                   pending: pending, pendingEvent: pendingEvent)
        if let data = try? JSONEncoder().encode(stored) { podcastCloud?.defaults.set(data, forKey: key) }
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
        if event == "ended" { podcastKnownCompleted = true }
        saveStoredPodcast(position: currentTime, completed: podcastKnownCompleted, event: event)
        guard let write = podcast.next(
            positionSeconds: Int(currentTime.rounded()),
            durationSeconds: Int(duration.rounded()),
            event: event,
            nowMs: Self.monotonicMs(),
            force: force
        ) else { return }
        flushHistoricalPodcastProgress(force: force)
        saveStoredPodcast(position: currentTime, completed: podcastKnownCompleted, event: event)
        let episode = podcast.episodeId
        let storageKey = podcastStorageKey(episode)
        enqueuePodcastWrite(write, episode: episode) { service, write, result in
            guard service.currentItem?.trackID == "podcast_ep_\(episode)",
                  service.podcast.sessionId == write.sessionId else {
                if case .conflictCurrent(let current) = result,
                   service.loadStoredPodcast(episode)?.bookmark.sessionId == write.sessionId,
                   let storageKey {
                    let stored = StoredPodcast(bookmark: PodcastBookmark(), position: Double(current.positionSeconds),
                                               duration: Double(current.durationSeconds ?? 0),
                                               completed: current.completed == true, version: current.version)
                    if let data = try? JSONEncoder().encode(stored) { service.podcastCloud?.defaults.set(data, forKey: storageKey) }
                }
                return
            }
            if result.isCompleted {
                service.podcast.acknowledgeCompletion(write)
                service.podcastKnownCompleted = true
                service.saveStoredPodcast(position: service.currentTime, completed: true)
            }
            if result.succeeded {
                let version: Int? = if case .accepted(let snapshot) = result { snapshot.version } else { nil }
                service.saveStoredPodcast(position: service.currentTime, completed: service.podcastKnownCompleted,
                    pending: service.podcast.sequence != write.sequence || Int(service.currentTime.rounded()) != write.positionSeconds,
                    acceptedVersion: version)
            }
            let conflictSnapshot: PodcastProgressSnapshot?
            switch result {
            case .conflictCurrent(let current): conflictSnapshot = current
            case .conflict: conflictSnapshot = nil
            default: return
            }
            service.podcast.block()
            service.saveStoredPodcast(position: service.currentTime, completed: service.podcastKnownCompleted)
            service.podcastHasConflict = true
            service.podcastProgressMessage = KitL10n("kit.playback.podcastProgressConflict")
            let latest: PodcastProgressSnapshot?
            if let conflictSnapshot { latest = conflictSnapshot }
            else { latest = try? await service.loadPodcastProgress?(episode) }
            guard let latest, service.currentItem?.trackID == "podcast_ep_\(episode)",
                  service.podcast.sessionId == write.sessionId else { return }
            service.podcastConflictVersion = latest.version
            service.saveStoredPodcast(position: service.currentTime, completed: service.podcastKnownCompleted)
        }
    }

    /// Serialize only progress writes for this episode; audio control never waits for this chain.
    @discardableResult
    private func enqueuePodcastWrite(_ write: PodcastProgressWrite, episode: String,
        completed: @escaping @MainActor (PlaybackService, PodcastProgressWrite, PodcastSubmitResult) async -> Void) -> Task<Void, Never>? {
        guard let submit = submitPodcastProgress else { return nil }
        let storageKey = podcastStorageKey(episode)
        let writeID = UUID()
        let previous = podcastWriteTail[episode].flatMap { podcastWriteTasks[$0] }
        podcastWriteTail[episode] = writeID
        let task = Task { @MainActor [weak self] in
            await previous?.value
            defer {
                self?.podcastWriteTasks.removeValue(forKey: writeID)
                if self?.podcastWriteTail[episode] == writeID { self?.podcastWriteTail.removeValue(forKey: episode) }
            }
            guard let self, storageKey == self.podcastStorageKey(episode) else { return }
            var write = write
            if self.currentItem?.trackID == "podcast_ep_\(episode)" {
                guard self.podcast.sessionId == write.sessionId, !self.podcast.blocked else { return }
                write.baseVersion = self.podcast.baseVersion
            } else if let stored = self.loadStoredPodcast(episode), stored.bookmark.sessionId != write.sessionId {
                return
            }
            let result = await submit(episode, write)
            guard storageKey == self.podcastStorageKey(episode) else { return }
            if self.podcast.sessionId != write.sessionId {
                if case .accepted(let snapshot) = result {
                    if self.currentItem?.trackID == "podcast_ep_\(episode)",
                       self.podcast.acknowledgePredecessor(snapshot, sent: write) {
                        self.saveStoredPodcast(position: self.currentTime, completed: self.podcastKnownCompleted,
                            acceptedVersion: snapshot.version)
                    } else if var stored = self.loadStoredPodcast(episode), stored.bookmark.sessionId == write.sessionId,
                              let storageKey {
                        stored.version = snapshot.version
                        if let data = try? JSONEncoder().encode(stored) { self.podcastCloud?.defaults.set(data, forKey: storageKey) }
                    }
                }
            }
            await completed(self, write, result)
        }
        podcastWriteTasks[writeID] = task
        return task
    }

    private func flushHistoricalPodcastProgress(force: Bool) {
        guard podcastHistoryFlush == nil, let cloud = podcastCloud, let account = cloud.accountKey,
              submitPodcastProgress != nil else { return }
        let prefix = "wildstring.podcast.progress.\(account)."
        let keys = cloud.defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(prefix) }
        podcastHistoryFlush = Task { @MainActor [weak self] in
            defer { self?.podcastHistoryFlush = nil }
            for key in keys {
                guard let self else { return }
                let episode = String(key.dropFirst(prefix.count))
                guard self.currentItem?.trackID != "podcast_ep_\(episode)",
                      var stored = self.loadStoredPodcast(episode), stored.pending != false,
                      stored.bookmark.ready, !stored.bookmark.blocked,
                      let write = stored.bookmark.next(positionSeconds: Int(stored.position.rounded()),
                                                       durationSeconds: Int(stored.duration.rounded()),
                                                       event: stored.completed ? "ended" : (stored.pendingEvent ?? "stop"),
                                                       nowMs: Self.monotonicMs(), force: force)
                else { continue }
                if let data = try? JSONEncoder().encode(stored) { cloud.defaults.set(data, forKey: key) }
                let submission = self.enqueuePodcastWrite(write, episode: episode) { service, write, result in
                    guard service.currentItem?.trackID != "podcast_ep_\(episode)",
                          service.loadStoredPodcast(episode)?.bookmark.sessionId == write.sessionId else { return }
                    switch result {
                    case .ok, .completed, .accepted:
                        stored.bookmark.clear()
                        stored.pending = false
                        stored.completed = stored.completed || result.isCompleted
                        if case .accepted(let snapshot) = result { stored.version = snapshot.version }
                    case .conflictCurrent(let current):
                        stored = StoredPodcast(bookmark: PodcastBookmark(), position: Double(current.positionSeconds),
                                               duration: Double(current.durationSeconds ?? 0),
                                               completed: current.completed == true, version: current.version)
                    case .conflict:
                        if let current = try? await service.loadPodcastProgress?(episode) {
                            stored = StoredPodcast(bookmark: PodcastBookmark(), position: Double(current.positionSeconds),
                                                   duration: Double(current.durationSeconds ?? 0),
                                                   completed: current.completed == true, version: current.version)
                        } else {
                            stored.bookmark.clear()
                        }
                    case .failed: return
                    }
                    guard service.currentItem?.trackID != "podcast_ep_\(episode)",
                          service.loadStoredPodcast(episode)?.bookmark.sessionId == write.sessionId else { return }
                    if let data = try? JSONEncoder().encode(stored) { cloud.defaults.set(data, forKey: key) }
                }
                await submission?.value
            }
        }
    }

    public func useLocalPodcastProgress() {
        guard podcastHasConflict, podcast.blocked, submitPodcastProgress != nil,
              let episode = Self.podcastEpisodeID(currentItem?.trackID ?? "") else { return }
        let oldSession = podcast.sessionId
        Task { @MainActor in
            var version = self.podcastConflictVersion
            if version == nil { version = try? await self.loadPodcastProgress?(episode)?.version }
            guard let version, self.podcast.sessionId == oldSession,
                  self.currentItem?.trackID == "podcast_ep_\(episode)" else { return }
            self.podcast.begin(episodeId: episode, deviceId: self.podcastDeviceID, baseVersion: version, intent: "resume")
            guard let write = self.podcast.next(positionSeconds: Int(self.currentTime.rounded()),
                                                 durationSeconds: Int(self.duration.rounded()), event: "progress",
                                                 nowMs: Self.monotonicMs(), force: true) else { return }
            self.saveStoredPodcast(position: self.currentTime, completed: self.podcastKnownCompleted, event: write.event)
            self.enqueuePodcastWrite(write, episode: episode) { service, write, result in
                guard service.podcast.sessionId == write.sessionId else { return }
                switch result {
                case .ok, .completed, .accepted:
                    if result.isCompleted { service.podcastKnownCompleted = true }
                    service.podcastProgressMessage = nil
                    service.podcastConflictVersion = nil
                    service.podcastHasConflict = false
                case .conflictCurrent(let current):
                    service.podcast.block()
                    service.podcastConflictVersion = current.version
                case .conflict:
                    service.podcast.block()
                    service.podcastConflictVersion = nil
                case .failed:
                    service.podcast.block()
                }
                let version: Int? = if case .accepted(let snapshot) = result { snapshot.version } else { nil }
                service.saveStoredPodcast(position: service.currentTime, completed: service.podcastKnownCompleted,
                    pending: !result.succeeded || service.podcast.sequence != write.sequence
                        || Int(service.currentTime.rounded()) != write.positionSeconds, event: write.event, acceptedVersion: version)
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
        case "authentication_required", "http_401": return KitL10n("kit.playback.authExpired")
        case "track_not_found": return KitL10n("kit.playback.trackNotFound")
        case "track_unavailable": return KitL10n("kit.playback.audioTempUnavailable")
        case "audio_not_found", "http_404": return KitL10n("kit.playback.audioMissing")
        case "audio_unavailable", "http_409": return KitL10n("kit.playback.audioUnreadable")
        case "file_changed", "file_changed_rescan_required": return KitL10n("kit.playback.fileChanged")
        default: return KitL10n("kit.playback.cannotPlayStatus", error.statusCode)
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
