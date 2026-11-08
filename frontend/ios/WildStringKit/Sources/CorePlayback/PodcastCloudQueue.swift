import CoreNetwork
import Foundation
import Observation

extension PodcastShowPreference {
    /// Server order `follow | asc | desc | off` mapped onto the local continuation rule.
    public var continuation: PodcastContinuation.Preference {
        let mapped: PodcastContinuation.Order
        switch order {
        case "asc": mapped = .oldestFirst
        case "desc": mapped = .newestFirst
        default: mapped = .follow
        }
        return PodcastContinuation.Preference(
            order: mapped,
            skipCompleted: skipCompleted,
            autoContinue: autoContinue && order != "off"
        )
    }
}

/// Cloud 稍后听 / 待播 queue for one signed-in account.
/// A 409 keeps the local items and exposes `conflict` for the user to resolve.
@MainActor
@Observable
public final class PodcastCloudQueue {
    public private(set) var version = 0
    public private(set) var items: [PodcastQueueItem] = []
    public private(set) var episodes: [String: PodcastEpisode] = [:]
    public private(set) var loading = false
    public private(set) var syncError: String?
    public private(set) var conflict: PodcastQueueConflict?
    public private(set) var inbox = PodcastInbox(version: 0, items: [])
    public private(set) var inboxEpisodes: [String: PodcastEpisode] = [:]
    public private(set) var inboxLoading = false
    public private(set) var inboxError: String?
    public private(set) var preferences: PodcastQueuePreferences?
    public private(set) var preferenceError: String?
    public var notice: String?

    public struct UnifiedPendingEpisode: Identifiable, Equatable, Sendable {
        public enum Source: String, Sendable {
            case queue
            case inbox
        }

        public var id: String { episodeId }
        public let episodeId: String
        public let origin: String
        public let source: Source
        public let episode: PodcastEpisode?

        public init(episodeId: String, origin: String, source: Source, episode: PodcastEpisode?) {
            self.episodeId = episodeId
            self.origin = origin
            self.source = source
            self.episode = episode
        }
    }

    public struct ContinuationContext: Equatable, Sendable {
        public var podcastID: String
        public var episodes: [PodcastContinuation.Episode]
        public var preference: PodcastContinuation.Preference

        public init(
            podcastID: String,
            episodes: [PodcastContinuation.Episode],
            preference: PodcastContinuation.Preference
        ) {
            self.podcastID = podcastID
            self.episodes = episodes
            self.preference = preference
        }
    }

    public let deviceID: String
    public let accountKey: String?

    private let client: WildstringClient
    private let defaults: UserDefaults
    private var cachedPreferences: PodcastQueuePreferences?
    var onPreferencesChanged: (@MainActor () -> Void)?
    private var tail: Task<Void, Never>?
    private var preferenceTail: Task<Void, Never>?
    private var hasLoaded = false
    private var pendingWrite = false

    public static let conflictMessage =
        "队列在其他设备上有更新。本机队列已保留。可以选择使用服务器上的队列，或用本机覆盖。"

    public init(
        client: WildstringClient,
        deviceID: String,
        accountKey: String? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.client = client
        self.deviceID = deviceID
        let normalizedKey = accountKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accountKey = (normalizedKey?.isEmpty == false) ? normalizedKey : nil
        self.defaults = defaults
        self.cachedPreferences = Self.loadCachedPreferences(accountKey: self.accountKey, defaults: defaults)
    }

    public var hasResolvedPreferences: Bool {
        preferences != nil || cachedPreferences != nil
    }

    public func title(for episodeID: String) -> String {
        episodes[episodeID]?.title ?? inboxEpisodes[episodeID]?.title ?? "正在读取单集…"
    }

    public func upcoming(after episodeID: String?) -> [PodcastQueueItem] {
        guard let episodeID, let index = items.firstIndex(where: { $0.episodeId == episodeID }) else {
            return items
        }
        return Array(items.dropFirst(index + 1))
    }

    public func showPreference(_ podcastID: String) -> PodcastShowPreference {
        let source = preferences ?? cachedPreferences
        if !podcastID.isEmpty, let show = source?.shows[podcastID] { return show }
        let accountAutoContinue = source?.autoContinue ?? true
        return PodcastShowPreference(
            action: source?.defaultAction ?? "inbox",
            autoLimit: source?.autoLimit ?? 3,
            order: accountAutoContinue ? "follow" : "off",
            skipCompleted: true,
            autoContinue: accountAutoContinue
        )
    }

    public func refresh() async {
        await refreshPreferences()
        await refreshQueue()
    }

    public func refreshQueue() async {
        await performAndWait {
            guard !self.pendingWrite, self.conflict == nil else { return }
            await self.loadQueue()
        }
    }

    public func refreshInbox() async {
        inboxLoading = inbox.items.isEmpty
        defer { inboxLoading = false }
        do {
            let loaded = try await client.podcastInbox()
            inbox = loaded
            inboxError = nil
            await resolveInbox()
        } catch {
            inboxError = "暂时读不到稍后听。\(Self.explain(error)) 可以重试。"
        }
    }

    public func refreshPreferences() async {
        do {
            let loaded = try await client.podcastQueuePreferences()
            preferences = loaded
            saveCachedPreferences(loaded)
            preferenceError = nil
            onPreferencesChanged?()
        } catch {
            preferenceError = "暂时读不到新集处理。\(Self.explain(error)) 可以重试。"
            onPreferencesChanged?()
        }
    }

    public func noteUserPlay(episodeID: String) {
        perform {
            await self.edit { items in
                items = PodcastQueueMerge.playing(episodeID, queue: items)
            }
        }
    }

    public func enqueueEpisode(_ episodeID: String, next: Bool, currentEpisodeID: String?) {
        perform {
            if !self.hasLoaded, !self.pendingWrite, self.conflict == nil {
                await self.loadQueue()
            }
            let exists = self.items.contains { $0.episodeId == episodeID }
            if !exists, self.items.count >= PodcastQueueMerge.limit {
                self.syncError = "待播队列已有 \(PodcastQueueMerge.limit) 集，这一集没有加入。"
                return
            }
            await self.edit { items in
                items = PodcastQueueMerge.enqueue(
                    episodeID, queue: items, next: next, after: currentEpisodeID
                )
            }
            self.notice = next ? "已加入待播 · 下一集播放" : "已加入待播"
        }
    }

    public func removeEpisode(_ episodeID: String) {
        perform {
            await self.edit { items in
                items = PodcastQueueMerge.removing(episodeID, queue: items)
            }
            if self.inbox.items.contains(where: { $0.episodeId == episodeID }) {
                await self.removeFromInbox(episodeID: episodeID)
            }
            self.notice = "已从待播清单移除"
        }
    }

    public func isQueued(episodeID: String) -> Bool {
        items.contains { $0.episodeId == episodeID }
    }

    public var unifiedPendingEpisodes: [UnifiedPendingEpisode] {
        var result: [UnifiedPendingEpisode] = []
        var seen = Set<String>()
        for item in items {
            seen.insert(item.episodeId)
            result.append(
                UnifiedPendingEpisode(
                    episodeId: item.episodeId,
                    origin: item.origin,
                    source: .queue,
                    episode: episodes[item.episodeId]
                )
            )
        }
        for item in inbox.items {
            if !seen.contains(item.episodeId) {
                seen.insert(item.episodeId)
                result.append(
                    UnifiedPendingEpisode(
                        episodeId: item.episodeId,
                        origin: "manual",
                        source: .inbox,
                        episode: inboxEpisodes[item.episodeId] ?? episodes[item.episodeId]
                    )
                )
            }
        }
        return result
    }

    public func moveItems(from offsets: IndexSet, to destination: Int) {
        perform {
            await self.edit { items in
                items = PodcastQueueMerge.moving(items, from: offsets, to: destination)
            }
        }
    }

    /// Removes the finished episode and returns the next queued item, if any.
    /// Auto-continue is not inserted here.
    public func episodeFinished(_ episodeID: String) async -> PodcastQueueItem? {
        await withCheckedContinuation { continuation in
            perform {
                await self.edit { items in
                    items = PodcastQueueMerge.finished(episodeID, queue: items)
                }
                continuation.resume(returning: self.items.first { $0.episodeId != episodeID })
            }
        }
    }

    public func playbackItem(for episodeID: String) async -> PlaybackService.Item? {
        let episode: PodcastEpisode
        if let cached = episodes[episodeID] ?? inboxEpisodes[episodeID] {
            episode = cached
        } else {
            do {
                episode = try await client.podcastEpisode(id: episodeID)
                var copy = episodes
                copy[episodeID] = episode
                episodes = copy
            } catch {
                return nil
            }
        }
        return PlaybackService.Item(
            trackID: "podcast_ep_\(episode.id)",
            title: episode.title,
            artist: "电台",
            album: nil,
            streamPath: "api/v1/podcasts/episodes/\(episode.id)/stream?proxy=1&cache=1"
        )
    }

    public func addToInbox(episodeID: String) async -> String? {
        do {
            try await client.addPodcastInboxItem(episodeID: episodeID)
            inboxError = nil
            await refreshInbox()
            return nil
        } catch {
            let message = "没能加入稍后听。\(Self.explain(error)) 可以重试。"
            inboxError = message
            return message
        }
    }

    public func removeFromInbox(episodeID: String) async {
        do {
            try await client.removePodcastInboxItem(episodeID: episodeID)
            inbox.items.removeAll { $0.episodeId == episodeID }
            inboxError = nil
        } catch {
            inboxError = "没能移出稍后听。\(Self.explain(error)) 可以重试。"
        }
    }

    public func updateShow(
        podcastID: String,
        action: String,
        autoLimit: Int,
        order: String
    ) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let previous = preferenceTail
            let task = Task { @MainActor in
                await previous?.value
                do {
                    var prefs = try await self.client.podcastQueuePreferences()
                    var show = prefs.shows[podcastID] ?? PodcastShowPreference(
                        action: prefs.defaultAction,
                        autoLimit: prefs.autoLimit,
                        autoContinue: prefs.autoContinue
                    )
                    show.action = action
                    show.autoLimit = min(100, max(0, autoLimit))
                    show.order = order
                    show.autoContinue = order != "off"
                    prefs.shows[podcastID] = show
                    let saved = try await self.client.savePodcastQueuePreferences(prefs)
                    self.preferences = saved
                    self.saveCachedPreferences(saved)
                    self.preferenceError = nil
                    self.onPreferencesChanged?()
                } catch {
                    self.preferenceError = "没能保存新集处理。\(Self.explain(error)) 可以重试。"
                }
                continuation.resume()
            }
            preferenceTail = task
        }
    }

    public func updateAutoContinue(_ enabled: Bool) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let previous = preferenceTail
            let task = Task { @MainActor in
                await previous?.value
                do {
                    var prefs = try await self.client.podcastQueuePreferences()
                    prefs.autoContinue = enabled
                    let saved = try await self.client.savePodcastQueuePreferences(prefs)
                    self.preferences = saved
                    self.saveCachedPreferences(saved)
                    self.preferenceError = nil
                    self.onPreferencesChanged?()
                } catch {
                    self.preferenceError = "没能保存新集处理。\(Self.explain(error)) 可以重试。"
                }
                continuation.resume()
            }
            preferenceTail = task
        }
    }

    public func podcastID(forEpisodeID episodeID: String) async throws -> String {
        if let cached = episodes[episodeID] ?? inboxEpisodes[episodeID] {
            return cached.podcastId
        }
        let loaded = try await client.podcastEpisode(id: episodeID)
        var copy = episodes
        copy[episodeID] = loaded
        episodes = copy
        return loaded.podcastId
    }

    public func continuationContext(forEpisodeID episodeID: String) async throws -> ContinuationContext {
        if !hasResolvedPreferences {
            await refreshPreferences()
        }
        let showID = try await podcastID(forEpisodeID: episodeID)
        let detail = try await client.podcast(id: showID)
        let show = detail.podcast
        let artist = show.author.isEmpty ? "电台" : show.author
        let refs = detail.episodes.enumerated().map { index, ep in
            PodcastContinuation.Episode(
                id: ep.id,
                title: ep.title,
                artist: artist,
                album: show.title,
                chronologicalIndex: detail.episodes.count - 1 - index,
                isCompleted: ep.positionSeconds > 0 && ep.durationSeconds > 0
                    && ep.positionSeconds >= ep.durationSeconds
            )
        }
        let preference = showPreference(show.id).continuation
        return ContinuationContext(podcastID: show.id, episodes: refs, preference: preference)
    }

    private static func preferencesCacheKey(for accountKey: String?) -> String? {
        guard let accountKey, !accountKey.isEmpty else { return nil }
        return "wildstring.podcast.preferences.\(accountKey)"
    }

    private static func loadCachedPreferences(
        accountKey: String?,
        defaults: UserDefaults
    ) -> PodcastQueuePreferences? {
        guard let key = preferencesCacheKey(for: accountKey),
              let data = defaults.data(forKey: key)
        else { return nil }
        return try? JSONDecoder().decode(PodcastQueuePreferences.self, from: data)
    }

    private func saveCachedPreferences(_ prefs: PodcastQueuePreferences) {
        cachedPreferences = prefs
        guard let key = Self.preferencesCacheKey(for: accountKey),
              let data = try? JSONEncoder().encode(prefs)
        else { return }
        defaults.set(data, forKey: key)
    }

    public func adoptServerQueue() {
        perform {
            guard let conflict = self.conflict else { return }
            self.version = conflict.current.version
            self.items = conflict.current.items
            self.conflict = nil
            self.pendingWrite = false
            self.hasLoaded = true
            self.syncError = nil
            await self.resolveMissing()
        }
    }

    public func overwriteWithLocal() {
        perform {
            guard let conflict = self.conflict else { return }
            self.version = conflict.current.version
            self.conflict = nil
            self.syncError = nil
            self.pendingWrite = true
            await self.flushOnce()
        }
    }

    public func retrySync() async {
        await performAndWait {
            if self.conflict != nil { return }
            if self.pendingWrite {
                await self.flushOnce()
            } else {
                await self.loadQueue()
            }
        }
    }

    private func edit(_ change: (inout [PodcastQueueItem]) -> Void) async {
        if !hasLoaded, !pendingWrite, conflict == nil {
            await loadQueue()
        }
        var updated = items
        change(&updated)
        guard updated != items else { return }
        items = updated
        pendingWrite = true
        if conflict != nil {
            syncError = Self.conflictMessage
            return
        }
        await flushOnce()
        await resolveMissing()
    }

    private func loadQueue() async {
        loading = items.isEmpty
        defer { loading = false }
        do {
            let state = try await client.podcastQueue()
            if !pendingWrite, conflict == nil {
                version = state.version
                items = state.items
            }
            hasLoaded = true
            if conflict == nil, !pendingWrite { syncError = nil }
            await resolveMissing()
        } catch {
            syncError = "暂时无法同步，本机播放不受影响。\(Self.explain(error)) 可以重试。"
        }
    }

    private func flushOnce() async {
        guard pendingWrite, conflict == nil else { return }
        let snapshot = items
        do {
            let saved = try await client.replacePodcastQueue(
                PodcastQueueUpdate(version: version, deviceId: deviceID, items: snapshot)
            )
            version = saved.version
            if items == snapshot {
                items = saved.items
                pendingWrite = false
            }
            conflict = nil
            syncError = nil
            hasLoaded = true
        } catch let error as PodcastQueueConflict {
            conflict = error
            hasLoaded = true
            syncError = Self.conflictMessage
        } catch {
            syncError = "暂时无法同步，本机播放不受影响。\(Self.explain(error)) 可以重试。"
        }
    }

    private func resolveMissing() async {
        let missing = items.map(\.episodeId).filter { episodes[$0] == nil }
        guard !missing.isEmpty else { return }
        var copy = episodes
        for id in missing {
            if let episode = try? await client.podcastEpisode(id: id) {
                copy[id] = episode
            }
        }
        episodes = copy
    }

    private func resolveInbox() async {
        let missing = inbox.items.map(\.episodeId).filter { inboxEpisodes[$0] == nil }
        guard !missing.isEmpty else { return }
        var copy = inboxEpisodes
        for id in missing {
            if let episode = try? await client.podcastEpisode(id: id) {
                copy[id] = episode
            }
        }
        inboxEpisodes = copy
    }

    private func perform(_ work: @escaping @MainActor () async -> Void) {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            await work()
        }
        tail = task
    }

    private func performAndWait(_ work: @escaping @MainActor () async -> Void) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            perform {
                await work()
                continuation.resume()
            }
        }
    }

    private static func explain(_ error: Error) -> String {
        if let api = error as? APIError {
            switch api.statusCode {
            case 401: return "登录已失效，请重新登录后再试。"
            case 403: return "没有权限修改这个列表。"
            case 404: return "这集已经不在服务器上。"
            case 422: return "服务器没有接受这次修改。"
            default: return "服务器返回 \(api.statusCode)。"
            }
        }
        if error is URLError { return "网络连接中断。" }
        return "网络或数据暂时不可用。"
    }
}
