import CoreNetwork
import CorePlayback
import CryptoKit
import Foundation
import Observation

#if DEBUG
/// Ad-hoc debug signing changes the app's Keychain access identity between
/// builds. Keep the debug session in a separate local defaults suite so a
/// rebuild or restart does not fail before the login screen can load.
private final class MacDebugSessionStore: SessionStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let lock = NSLock()

    init() {
        defaults = UserDefaults(suiteName: "com.wildstring.mac.debug.session") ?? .standard
    }

    func loadSession(origin: String) throws -> StoredSession? {
        let data = lock.withLock { defaults.data(forKey: key(origin)) }
        guard let data else { return nil }
        return try JSONDecoder().decode(StoredSession.self, from: data)
    }

    func saveSession(_ session: StoredSession, origin: String) throws {
        let data = try JSONEncoder().encode(session)
        lock.withLock { defaults.set(data, forKey: key(origin)) }
    }

    func clearSession(origin: String) throws {
        lock.withLock { defaults.removeObject(forKey: key(origin)) }
    }

    private func key(_ origin: String) -> String {
        "session.\(Data(origin.utf8).base64EncodedString())"
    }
}
#endif

enum MacPage: String, Identifiable, Hashable {
    case home
    case search
    case tracks
    case albums
    case artists
    case playlists
    case favorites
    case discover
    case podcasts
    case assistant
    case listening
    case devices
    case notifications
    case drafts
    case manage
    case settings

    static let library: [MacPage] = [.tracks, .albums, .artists, .playlists, .favorites]
    static let explore: [MacPage] = [.discover, .podcasts, .assistant]

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "首页"
        case .search: return "搜索"
        case .tracks: return "全部歌曲"
        case .albums: return "专辑"
        case .artists: return "艺人"
        case .playlists: return "歌单"
        case .favorites: return "我喜欢"
        case .discover: return "每日推荐"
        case .podcasts: return "电台"
        case .assistant: return "音乐助手"
        case .listening: return "收听记录"
        case .devices: return "跨设备继续"
        case .notifications: return "通知"
        case .drafts: return "待确认草案"
        case .manage: return "管理"
        case .settings: return "设置"
        }
    }

    var symbol: String {
        switch self {
        case .home: return "house"
        case .search: return "magnifyingglass"
        case .tracks: return "music.note"
        case .albums: return "square.stack"
        case .artists: return "person.2"
        case .playlists: return "music.note.list"
        case .favorites: return "heart"
        case .discover: return "sparkles"
        case .podcasts: return "antenna.radiowaves.left.and.right"
        case .assistant: return "bubble.left.and.bubble.right"
        case .listening: return "clock"
        case .devices: return "arrow.triangle.2.circlepath"
        case .notifications: return "bell"
        case .drafts: return "checklist"
        case .manage: return "slider.horizontal.3"
        case .settings: return "gearshape"
        }
    }
}

struct MacSavedServer: Codable, Equatable, Identifiable {
    var address: String
    var username: String
    var lastUsedAt: Date
    var allowInsecureHTTP: Bool
    var id: String { address }
}

enum MacServers {
    private static let key = "mac.savedServers"

    static func load(defaults: UserDefaults = .standard) -> [MacSavedServer] {
        guard let data = defaults.data(forKey: key),
            let servers = try? JSONDecoder().decode([MacSavedServer].self, from: data)
        else { return [] }
        return servers.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    static func upsert(_ server: MacSavedServer, defaults: UserDefaults = .standard) {
        var servers = load(defaults: defaults)
        if let index = servers.firstIndex(where: { $0.address == server.address }) {
            servers[index] = server
        } else {
            servers.append(server)
        }
        if let data = try? JSONEncoder().encode(servers) {
            defaults.set(data, forKey: key)
        }
    }
}

@MainActor
@Observable
final class MacSession {
    var focusLibrarySearch = false
    enum Phase: Equatable {
        case loading
        case connect
        case connected(server: String, username: String)
    }

    var phase: Phase = .loading
    var serverText = ""
    var username = ""
    var allowInsecureHTTP = false
    var isBusy = false
    var errorMessage: String?
    var page: MacPage = .home
    let desktopLyrics = DesktopLyricsController()
    var desktopLyricsVisible: Bool { desktopLyrics.isVisible }
    var showLyrics = false
    var showQueue = false
    var showFullscreen = false
    var selectedLibraryID: String?
    var confirmLogout = false
    var showServerLogin = false
    var pendingServer: MacSavedServer?
    var serverSwitchError: String?

    private(set) var client: WildstringClient?
    private(set) var playback: PlaybackService?
    private(set) var favorites: MacFavorites?
    private(set) var sync: MacPlaybackSync?
    private(set) var assistant: MacAssistantModel?
    private(set) var connection: MacConnectionMonitor?
    private(set) var profile = "listener"

    var canManage: Bool { profile != "listener" }
    private(set) var servers: [MacSavedServer] = []

    private let store: any SessionStore
    private let queueStore: any QueueStore
    private let defaults: UserDefaults
    private let configuration: URLSessionConfiguration?

    init(store: (any SessionStore)? = nil, queueStore: (any QueueStore)? = nil,
        defaults: UserDefaults = .standard, configuration: URLSessionConfiguration? = nil) {
#if DEBUG
        self.store = store ?? MacDebugSessionStore()
#else
        self.store = store ?? KeychainSessionStore(service: "com.wildstring.mac.session")
#endif
        self.queueStore = queueStore ?? ((try? SwiftDataQueueStore.makeDefault()) ?? InMemoryQueueStore())
        self.defaults = defaults
        self.configuration = configuration
        servers = MacServers.load(defaults: defaults)
    }

    func restore() async {
        guard case .loading = phase else { return }
        guard let last = servers.first,
            let address = try? ServerAddress(input: last.address, allowsInsecureHTTP: last.allowInsecureHTTP)
        else {
            phase = .connect
            return
        }
        serverText = last.address
        username = last.username
        allowInsecureHTTP = last.allowInsecureHTTP
        let client = makeClient(address)
        if await client.storedSessionExists() {
            if let status = try? await client.authStatus(), status.authenticated, let user = status.user {
                await activate(client: client, address: address, username: user.username)
                return
            }
        }
        phase = .connect
    }

    func login(serverText: String, username: String, password: String, allowInsecureHTTP: Bool) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let address = try ServerAddress(input: serverText, allowsInsecureHTTP: allowInsecureHTTP)
            let client = makeClient(address)
            let user = try await client.login(username: username, password: password)
            self.serverText = serverText
            self.username = user.username
            self.allowInsecureHTTP = allowInsecureHTTP
            await activate(client: client, address: address, username: user.username)
            showServerLogin = false
        } catch let error as ServerAddress.ValidationError where error == .insecureHTTPNotAllowed {
            errorMessage = "这是未加密的 HTTP。确认后再连接。"
        } catch {
            errorMessage = "无法登录，请检查地址、账号和网络"
        }
    }

    func logout() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        let previousClient = client
        await deactivate(preservingQueue: false)
        if let previousClient {
            try? await previousClient.logout()
            await previousClient.clearSession()
        }
        phase = .connect
    }

    func addServer() {
        pendingServer = nil
        errorMessage = nil
        showServerLogin = true
    }

    func switchServer(_ server: MacSavedServer) async {
        guard !isBusy, client?.server.description != server.address else { return }
        isBusy = true
        serverSwitchError = nil
        errorMessage = nil
        defer { isBusy = false }
        do {
            let address = try ServerAddress(input: server.address, allowsInsecureHTTP: server.allowInsecureHTTP)
            let candidate = makeClient(address)
            guard await candidate.storedSessionExists() else {
                pendingServer = server
                errorMessage = "请登录这个服务器"
                showServerLogin = client != nil
                return
            }
            let status = try await candidate.authStatus()
            guard status.authenticated, let user = status.user else {
                pendingServer = server
                errorMessage = "登录已过期，请重新登录"
                showServerLogin = client != nil
                return
            }
            serverText = server.address
            username = user.username
            allowInsecureHTTP = server.allowInsecureHTTP
            await activate(client: candidate, address: address, username: user.username)
            showServerLogin = false
        } catch {
            serverSwitchError = "暂时无法连接所选服务器，当前连接已保留。"
        }
    }

    private func makeClient(_ address: ServerAddress) -> WildstringClient {
        let client = WildstringClient(server: address, store: store, configuration: configuration)
        client.preferClientHeader("macos")
        return client
    }

    private func deactivate(preservingQueue: Bool) async {
        sync?.stop()
        connection?.stop()
        desktopLyrics.close()
        if let playback {
            playback.pause()
            playback.shutdown(preservingQueue: preservingQueue)
            await playback.flushPersistence()
        }
        playback = nil
        favorites = nil
        assistant = nil
        sync = nil
        connection = nil
        profile = "listener"
        client = nil
        selectedLibraryID = nil
        page = .home
        showFullscreen = false
        showLyrics = false
        showQueue = false
    }

    func selectLibrary(_ id: String?) {
        client?.selectLibrary(id)
        selectedLibraryID = id
        let favorites = favorites
        Task { await favorites?.load() }
        guard case .connected(let server, let username) = phase else { return }
        let key = "mac.library.\(server)|\(username)"
        if let id, !id.isEmpty {
            defaults.set(id, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    func seek(by seconds: Double) {
        guard let playback else { return }
        playback.seek(to: playback.currentTime + seconds)
    }

    private func activate(client: WildstringClient, address: ServerAddress, username: String) async {
        await deactivate(preservingQueue: true)
        self.client = client
        assistant = MacAssistantModel(client: client)
        let space = Self.spaceName(address.origin)
        let cache = AudioDiskCache(
            directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("WildStringMac/\(space)", isDirectory: true),
            limitBytes: 512 * 1_048_576
        )
        let playback = PlaybackService(
            server: address,
            store: queueStore.scoped(to: space),
            cookieHeader: { [weak client] in await client?.cookieHeaderValue() },
            fragmentCache: cache,
            planProvider: { trackID, bitrate, startMs in
                try await client.playbackPlan(trackID: trackID, bitrateKbps: bitrate, startMs: startMs)
            }
        )
        playback.clientHeaderName = "macos"
        let bitrate = defaults.integer(forKey: "macPreferredBitrate")
        playback.preferredBitrateKbps = bitrate == 0 ? nil : bitrate
        let rate = defaults.double(forKey: "podcastPlaybackRate")
        if rate > 0 { playback.setPodcastPlaybackRate(Float(rate)) }
        playback.podcastDeviceID = Self.deviceID(defaults: defaults)
        let libraryKey = "mac.library.\(address.description)|\(username)"
        if let library = defaults.string(forKey: libraryKey), !library.isEmpty {
            client.selectLibrary(library)
            selectedLibraryID = library
        } else {
            selectedLibraryID = nil
        }
        playback.submitListening = { [weak client] report in
            guard let client else { return false }
            do {
                try await client.reportListening(report)
                return true
            } catch {
                return false
            }
        }
        playback.loadPodcastBaseVersion = { [weak client] episodeID in
            guard let client else { return nil }
            return try? await client.podcastProgress(episodeId: episodeID).version
        }
        playback.submitPodcastProgress = { [weak client] episodeID, write in
            guard let client else { return .failed }
            do {
                try await client.savePodcastProgress(episodeId: episodeID, write: write)
                return .ok
            } catch let error as APIError where error.statusCode == 409 {
                return .conflict
            } catch {
                return .failed
            }
        }
        await playback.restore()
        self.playback = playback
        playback.warmConnection()
        let monitor = MacConnectionMonitor(server: address)
        monitor.start()
        connection = monitor
        let favorites = MacFavorites(client: client)
        self.favorites = favorites
        let sync = MacPlaybackSync(client: client, playback: playback, deviceId: Self.deviceID(defaults: defaults))
        self.sync = sync
        sync.start()
        Task { await favorites.load() }
        MacServers.upsert(
            MacSavedServer(
                address: address.description,
                username: username,
                lastUsedAt: .now,
                allowInsecureHTTP: allowInsecureHTTP
            ), defaults: defaults
        )
        servers = MacServers.load(defaults: defaults)
        if let status = try? await client.authStatus() {
            profile = status.user?.profile ?? "listener"
        }
        phase = .connected(server: address.description, username: username)
    }

    private static func deviceID(defaults: UserDefaults) -> String {
        if let stored = defaults.string(forKey: "mac.deviceID"), !stored.isEmpty { return stored }
        let created = UUID().uuidString
        defaults.set(created, forKey: "mac.deviceID")
        return created
    }

    private static func spaceName(_ origin: String) -> String {
        var hasher = SHA256()
        hasher.update(data: Data(origin.utf8))
        return hasher.finalize().prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}

extension Notification.Name {
    static let wildstringShowDesktopLyrics = Notification.Name("wildstring.showDesktopLyrics")
}
