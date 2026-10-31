import CoreNetwork
import CorePlayback
import CryptoKit
import Foundation
import Observation

enum MacPage: String, CaseIterable, Identifiable {
    case music
    case discover
    case podcasts
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .music: return "音乐"
        case .discover: return "发现"
        case .podcasts: return "电台"
        case .settings: return "设置"
        }
    }

    var symbol: String {
        switch self {
        case .music: return "music.note"
        case .discover: return "sparkles"
        case .podcasts: return "antenna.radiowaves.left.and.right"
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

    static func load() -> [MacSavedServer] {
        guard let data = UserDefaults.standard.data(forKey: key),
            let servers = try? JSONDecoder().decode([MacSavedServer].self, from: data)
        else { return [] }
        return servers.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    static func upsert(_ server: MacSavedServer) {
        var servers = load()
        if let index = servers.firstIndex(where: { $0.address == server.address }) {
            servers[index] = server
        } else {
            servers.append(server)
        }
        if let data = try? JSONEncoder().encode(servers) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}

@MainActor
@Observable
final class MacSession {
    enum Phase: Equatable {
        case loading
        case connect
        case connected(server: String, username: String)
    }

    var phase: Phase = .loading
    var serverText = ""
    var username = ""
    var password = ""
    var allowInsecureHTTP = false
    var isBusy = false
    var errorMessage: String?
    var page: MacPage = .music
    var showLyrics = true
    var showQueue = false

    private(set) var client: WildstringClient?
    private(set) var playback: PlaybackService?
    private(set) var servers: [MacSavedServer] = []

    private let store: KeychainSessionStore
    private let queueStore: any QueueStore

    init() {
        store = KeychainSessionStore(service: "com.wildstring.mac.session")
        queueStore = (try? SwiftDataQueueStore.makeDefault()) ?? InMemoryQueueStore()
        servers = MacServers.load()
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
        let client = WildstringClient(server: address, store: store)
        client.preferClientHeader("macos")
        if await client.storedSessionExists() {
            if let status = try? await client.authStatus(), status.authenticated, let user = status.user {
                await activate(client: client, address: address, username: user.username)
                return
            }
        }
        phase = .connect
    }

    func login() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let address = try ServerAddress(input: serverText, allowsInsecureHTTP: allowInsecureHTTP)
            let client = WildstringClient(server: address, store: store)
            client.preferClientHeader("macos")
            let user = try await client.login(username: username, password: password)
            password = ""
            await activate(client: client, address: address, username: user.username)
        } catch let error as ServerAddress.ValidationError where error == .insecureHTTPNotAllowed {
            errorMessage = "这是未加密的 HTTP。确认后再连接。"
        } catch {
            errorMessage = "无法登录，请检查地址、账号和网络"
        }
    }

    func logout() async {
        playback?.shutdown()
        playback = nil
        if let client { try? await client.logout() }
        client = nil
        phase = .connect
    }

    func seek(by seconds: Double) {
        guard let playback else { return }
        playback.seek(to: playback.currentTime + seconds)
    }

    private func activate(client: WildstringClient, address: ServerAddress, username: String) async {
        self.client = client
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
        playback.podcastDeviceID = Self.deviceID()
        let libraryKey = "mac.library.\(address.description)|\(username)"
        if let library = UserDefaults.standard.string(forKey: libraryKey), !library.isEmpty {
            client.selectLibrary(library)
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
        MacServers.upsert(
            MacSavedServer(
                address: address.description,
                username: username,
                lastUsedAt: .now,
                allowInsecureHTTP: allowInsecureHTTP
            )
        )
        servers = MacServers.load()
        phase = .connected(server: address.description, username: username)
    }

    private static func deviceID() -> String {
        let defaults = UserDefaults.standard
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
