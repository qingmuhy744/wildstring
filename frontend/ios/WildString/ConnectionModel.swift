import CoreNetwork
import CorePlayback
import CryptoKit
import Foundation
import Observation

@MainActor
@Observable
final class ConnectionModel {
    enum Phase: Equatable {
        case loading
        case servers
        case connect
        case connected(server: String, username: String)
    }

    var phase: Phase = .loading
    var serverText = ""
    var username = ""
    var password = ""
    var isBusy = false
    var errorMessage: String?

    private(set) var client: WildstringClient?
    private(set) var playback: PlaybackService?
    private(set) var favorites: FavoritesModel?
    private(set) var offline: OfflineModel?
    private(set) var role: String?
    private(set) var servers: [SavedServer] = []
    let demoAutoPlay: Bool

    private let store: any SessionStore
    private let queueStore: any QueueStore

    init(store: any SessionStore = KeychainSessionStore()) {
        self.store = store
        if let queueStore = try? SwiftDataQueueStore.makeDefault() {
            self.queueStore = queueStore
        } else {
            self.queueStore = InMemoryQueueStore()
        }
        #if DEBUG
            demoAutoPlay = ProcessInfo.processInfo.environment["WILDSTRING_DEMO_AUTOPLAY"] == "1"
        #else
            demoAutoPlay = false
        #endif
        servers = SavedServersStore.load()
    }

    var canSubmit: Bool {
        !serverText.trimmingCharacters(in: .whitespaces).isEmpty
            && !username.isEmpty
            && !password.isEmpty
    }

    func restore() async {
        guard case .loading = phase else { return }
        #if DEBUG
            if let demo = ProcessInfo.processInfo.environment["WILDSTRING_DEMO_SERVER"],
                !demo.isEmpty
            {
                serverText = demo
                username =
                    ProcessInfo.processInfo.environment["WILDSTRING_DEMO_USER"] ?? "admin"
                password =
                    ProcessInfo.processInfo.environment["WILDSTRING_DEMO_PASSWORD"] ?? ""
                errorMessage = nil
                if !password.isEmpty {
                    await login()
                } else {
                    phase = .connect
                }
                return
            }
        #endif
        guard let last = servers.max(by: { $0.lastUsedAt < $1.lastUsedAt }),
            let address = try? makeAddress(last.address)
        else {
            phase = .connect
            return
        }
        serverText = last.address
        username = last.username
        let client = WildstringClient(server: address, store: store)
        if await client.storedSessionExists() {
            do {
                let status = try await client.authStatus()
                if status.authenticated, let user = status.user {
                    await activate(
                        client: client,
                        address: address,
                        username: user.username,
                        role: user.role
                    )
                    return
                }
                await client.clearSession()
            } catch {
                // Server unreachable: keep the session so a retry can reuse it.
            }
        }
        phase = .servers
    }

    func login() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let address = try makeAddress(serverText)
            let client = WildstringClient(server: address, store: store)
            let user = try await client.login(username: username, password: password)
            serverText = address.description
            password = ""
            await activate(
                client: client,
                address: address,
                username: user.username,
                role: user.role
            )
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func logout() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        if let playback {
            await playback.clearFragmentCache()
        }
        playback?.shutdown()
        playback = nil
        if let offline {
            await offline.shutdown()
        }
        offline = nil
        favorites = nil
        role = nil
        if let client {
            try? await client.logout()
        }
        client = nil
        username = ""
        password = ""
        errorMessage = nil
        phase = servers.isEmpty ? .connect : .servers
    }

    /// Switches to a saved server; reuses its session or asks for the password.
    func connect(to server: SavedServer) async {
        guard !isBusy else { return }
        errorMessage = nil
        serverText = server.address
        username = server.username
        guard let address = try? makeAddress(server.address) else {
            errorMessage = "服务器地址已失效"
            return
        }
        isBusy = true
        defer { isBusy = false }
        let client = WildstringClient(server: address, store: store)
        if await client.storedSessionExists() {
            do {
                let status = try await client.authStatus()
                if status.authenticated, let user = status.user {
                    await activate(
                        client: client,
                        address: address,
                        username: user.username,
                        role: user.role
                    )
                    return
                }
                await client.clearSession()
            } catch {
                // Unreachable: keep the session for a later retry.
                errorMessage = "无法连接该服务器，请检查网络或地址"
                return
            }
        }
        password = ""
        phase = .connect
    }

    func showAddServer() {
        serverText = ""
        username = ""
        password = ""
        errorMessage = nil
        phase = .connect
    }

    func showServers() {
        errorMessage = nil
        phase = .servers
    }

    /// Deletes a server and its session, caches, offline copies and queue space.
    func deleteServer(_ server: SavedServer) async {
        if let address = try? makeAddress(server.address) {
            try? store.clearSession(origin: address.origin)
            let space = Self.spaceName(for: address)
            try? FileManager.default.removeItem(
                at: Self.cachesRoot().appendingPathComponent(space)
            )
            try? FileManager.default.removeItem(
                at: Self.offlineRoot().appendingPathComponent(space)
            )
            try? await queueStore.scoped(to: space).clear()
        }
        SavedServersStore.remove(address: server.address)
        servers = SavedServersStore.load()
    }

    private static func cachesRoot() -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("WildString", isDirectory: true)
    }

    private static func offlineRoot() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("WildString/Offline", isDirectory: true)
    }

    private static func spaceName(for address: ServerAddress) -> String {
        var hasher = SHA256()
        hasher.update(data: Data(address.origin.utf8))
        return hasher.finalize().prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static func fragmentCacheLimitBytes() -> Int64 {
        let stored = UserDefaults.standard.object(forKey: "fragmentCacheLimitMB") as? Int
        return Int64(stored ?? 512) * 1_048_576
    }

    private static func savedQualityBitrate() -> Int? {
        Int(UserDefaults.standard.string(forKey: "playbackQuality") ?? "original")
    }

    private func activate(
        client: WildstringClient,
        address: ServerAddress,
        username: String,
        role: String
    ) async {
        self.client = client
        let space = Self.spaceName(for: address)
        let fragmentCache = AudioDiskCache(
            directory: Self.cachesRoot().appendingPathComponent(space, isDirectory: true),
            limitBytes: Self.fragmentCacheLimitBytes()
        )
        let offlineDirectory = Self.offlineRoot().appendingPathComponent(
            space,
            isDirectory: true
        )
        let downloads = OfflineDownloads(
            directory: offlineDirectory,
            sessionIdentifier: "com.wildstring.app.offline",
            server: address,
            cookieHeader: { [weak client] in
                await client?.cookieHeaderValue()
            }
        )
        let playback = PlaybackService(
            server: address,
            store: queueStore.scoped(to: space),
            cookieHeader: { [weak client] in
                await client?.cookieHeaderValue()
            },
            fragmentCache: fragmentCache,
            offlineLookup: { trackID in
                let url = offlineDirectory.appendingPathComponent(
                    OfflineDownloads.fileName(for: trackID)
                )
                return FileManager.default.fileExists(atPath: url.path) ? url : nil
            },
            planProvider: { trackID, bitrate, startMs in
                try await client.playbackPlan(
                    trackID: trackID,
                    bitrateKbps: bitrate,
                    startMs: startMs
                )
            }
        )
        playback.preferredBitrateKbps = Self.savedQualityBitrate()
        await playback.restore()
        self.playback = playback
        self.favorites = FavoritesModel(client: client)
        self.offline = OfflineModel(downloads: downloads)
        self.role = role
        SavedServersStore.upsert(
            SavedServer(address: address.description, username: username, lastUsedAt: .now)
        )
        servers = SavedServersStore.load()
        phase = .connected(server: address.description, username: username)
    }

    private func makeAddress(_ raw: String) throws -> ServerAddress {
        #if DEBUG
            try ServerAddress(input: raw, allowsInsecureLocalhost: true)
        #else
            try ServerAddress(input: raw, allowsInsecureLocalhost: false)
        #endif
    }

    private static func message(for error: Error) -> String {
        if let error = error as? APIError {
            switch error.code {
            case "invalid_credentials": return "用户名或密码错误"
            case "login_throttled": return "尝试次数过多，请稍后再试"
            case "admin_setup_required": return "服务器尚未初始化管理员，请先在服务端完成设置"
            case "client_header_required": return "服务器版本过旧，暂不支持 iOS 客户端"
            case "invalid_account_input": return "输入内容不符合要求"
            default: return "服务器返回错误（\(error.statusCode)）"
            }
        }
        if let error = error as? ServerAddress.ValidationError {
            switch error {
            case .invalidURL: return "服务器地址格式不正确"
            case .unsupportedScheme: return "仅支持 http 或 https 地址"
            case .insecureHTTPNotAllowed: return "需要 HTTPS 地址（开发版仅允许本机 HTTP）"
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .timedOut: return "连接超时，请检查地址和网络"
            case .cannotConnectToHost, .cannotFindHost: return "无法连接服务器，请检查地址和网络"
            case .notConnectedToInternet: return "当前网络不可用"
            case .serverCertificateUntrusted, .secureConnectionFailed: return "TLS 证书校验失败"
            case .appTransportSecurityRequiresSecureConnection: return "系统要求 HTTPS 连接"
            default: return "网络错误（\(error.code.rawValue)）"
            }
        }
        return "发生未知错误"
    }
}
