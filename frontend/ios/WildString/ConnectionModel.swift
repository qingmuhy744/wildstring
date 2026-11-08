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
    var allowInsecureHTTP = false
    var showInsecureHTTPWarning = false
    private(set) var routes: ServerRoutes?
    var isBusy = false
    var errorMessage: String?

    private(set) var client: WildstringClient?
    private(set) var playback: PlaybackService?
    private(set) var favorites: FavoritesModel?
    private(set) var offline: OfflineModel?
    private(set) var profile: String?
    private(set) var servers: [SavedServer] = []
    private(set) var sharing: PlaybackSharingModel?
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
            let address = try? makeAddress(last.address, allowInsecureHTTP: last.allowInsecureHTTP)
        else {
            phase = .connect
            return
        }
        serverText = last.address
        username = last.username
        allowInsecureHTTP = last.allowInsecureHTTP
        let savedRoutes = makeRoutes(address, allowHTTP: last.allowInsecureHTTP)
        if savedRoutes.profile.routes.count > 1 {
            if let (candidate, selected, user) = await savedRoutes.restore() {
                await activate(client: candidate, address: selected, username: user.username, profile: user.profile, routeProfile: savedRoutes)
            } else { routes = savedRoutes; phase = .servers }
            return
        }
        let client = WildstringClient(server: address, store: store)
        if await client.storedSessionExists() {
            do {
                let status = try await client.authStatus()
                if status.authenticated, let user = status.user {
                    InterfaceLanguage.store(user.language)
                    await activate(
                        client: client,
                        address: address,
                        username: user.username,
                        profile: user.profile
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
        if serverText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("http://") && !allowInsecureHTTP {
            showInsecureHTTPWarning = true
            return
        }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let address = try makeAddress(serverText, allowInsecureHTTP: allowInsecureHTTP)
            let client = WildstringClient(server: address, store: store)
            let user = try await client.login(username: username, password: password)
            InterfaceLanguage.store(user.language)
            serverText = address.description
            password = ""
            await activate(
                client: client,
                address: address,
                username: user.username,
                profile: user.profile
            )
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func confirmInsecureHTTP() {
        allowInsecureHTTP = true
        showInsecureHTTPWarning = false
        Task { await login() }
    }

    func logout() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        if let playback {
            await playback.clearFragmentCache()
        }
        let previousRoutes = routes
        routes = nil
        previousRoutes?.stop()
        sharing?.stop()
        sharing = nil
        playback?.shutdown()
        playback = nil
        await previousRoutes?.signOut()
        if let offline {
            await offline.shutdown()
        }
        offline = nil
        favorites = nil
        profile = nil
        if let client {
            try? await client.logout()
        }
        client = nil
        username = ""
        password = ""
        errorMessage = nil
        // Signed out: follow the system language until the next account loads.
        InterfaceLanguage.store(nil)
        phase = servers.isEmpty ? .connect : .servers
    }

    /// Switches to a saved server; reuses its session or asks for the password.
    func connect(to server: SavedServer) async {
        guard !isBusy else { return }
        errorMessage = nil
        serverText = server.address
        username = server.username
        allowInsecureHTTP = server.allowInsecureHTTP
        if server.address.lowercased().hasPrefix("http://") && !allowInsecureHTTP {
            showInsecureHTTPWarning = true
            phase = .connect
            return
        }
        guard let address = try? makeAddress(server.address, allowInsecureHTTP: allowInsecureHTTP) else {
            errorMessage = "服务器地址已失效"
            return
        }
        isBusy = true
        defer { isBusy = false }
        let savedRoutes = makeRoutes(address, allowHTTP: server.allowInsecureHTTP)
        if savedRoutes.profile.routes.count > 1 {
            if let (candidate, selected, user) = await savedRoutes.restore() {
                await activate(client: candidate, address: selected, username: user.username, profile: user.profile, routeProfile: savedRoutes)
            } else { routes = savedRoutes; errorMessage = "已保存线路不可用，请检查网络或登录状态" }
            return
        }
        let client = WildstringClient(server: address, store: store)
        if await client.storedSessionExists() {
            do {
                let status = try await client.authStatus()
                if status.authenticated, let user = status.user {
                    InterfaceLanguage.store(user.language)
                    await activate(
                        client: client,
                        address: address,
                        username: user.username,
                        profile: user.profile
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

    func setAlias(_ alias: String, for server: SavedServer) {
        var saved = server
        saved.alias = String(alias.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        SavedServersStore.upsert(saved)
        servers = SavedServersStore.load()
    }

    func showAddServer() {
        serverText = ""
        username = ""
        password = ""
        allowInsecureHTTP = false
        errorMessage = nil
        phase = .connect
    }

    func showServers() {
        errorMessage = nil
        phase = .servers
    }

    /// Deletes a server and its session, caches, offline copies and queue space.
    func deleteServer(_ server: SavedServer) async {
        if let address = try? makeAddress(server.address, allowInsecureHTTP: server.allowInsecureHTTP) {
            let savedRoutes = makeRoutes(address, allowHTTP: server.allowInsecureHTTP)
            await savedRoutes.signOut()
            savedRoutes.forget()
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

    private static func deviceID() -> String {
        let defaults = UserDefaults.standard
        if let stored = defaults.string(forKey: "playbackSyncDeviceID"), !stored.isEmpty {
            return stored
        }
        let created = UUID().uuidString
        defaults.set(created, forKey: "playbackSyncDeviceID")
        return created
    }

    private func makeRoutes(_ address: ServerAddress, allowHTTP: Bool) -> ServerRoutes {
        let controller = ServerRoutes(primary: ServerRoute(name: "默认线路", address: address.description, allowHTTP: allowHTTP)) { [store] in WildstringClient(server: $0, store: store) }
        controller.onSelected = { [weak self, weak controller] candidate, selected in
            guard let self, let controller, self.routes === controller,
                  let status = try? await candidate.authStatus(), let user = status.user else { return }
            await self.activate(client: candidate, address: selected, username: user.username, profile: user.profile, routeProfile: controller)
        }
        return controller
    }

    private func activate(
        client: WildstringClient,
        address: ServerAddress,
        username: String,
        profile: String,
        routeProfile: ServerRoutes? = nil
    ) async {
        let sameServer = routeProfile != nil && routeProfile === routes && playback != nil
        let resume = sameServer && playback?.wantsPlayback == true
        let queueSnapshot = playback?.queue
        let positionSnapshot = playback?.currentTime ?? 0
        let volumeSnapshot = playback?.volume ?? 1
        let rateSnapshot = playback?.podcastPlaybackRate ?? 1
        if !sameServer { routes?.stop() }
        let controller = routeProfile ?? makeRoutes(address, allowHTTP: address.url.scheme == "http")
        let primary = (try? ServerAddress(input: controller.storageAddress, allowsInsecureHTTP: true)) ?? address
        sharing?.stop()
        playback?.pause()
        playback?.shutdown(preservingQueue: true)
        await playback?.flushPersistence()
        await offline?.shutdown()
        routes = controller
        self.client = client
        let preferences = AccountPreferences(server: primary.description, username: username)
        preferences.applyMirrors()
        OfflineDownloads.allowsCellularAccess = preferences.allowsCellularDownloads
        if let library = preferences.libraryID {
            client.selectLibrary(library)
        }
        let space = Self.spaceName(for: primary)
        let fragmentCache = AudioDiskCache(
            directory: Self.cachesRoot().appendingPathComponent(space, isDirectory: true),
            limitBytes: Int64(preferences.cacheLimitMB) * 1_048_576
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
            connectionFailure: { [weak controller] in await controller?.playbackConnectionFailed(address: address.description) },
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
        playback.preferredBitrateKbps = preferences.qualityBitrate
        let podcastDeviceID = Self.deviceID()
        playback.podcastDeviceID = podcastDeviceID
        playback.podcastCloud = PodcastCloudQueue(
            client: client,
            deviceID: WildstringDeviceID.resolve(preferred: podcastDeviceID),
            accountKey: "\(primary.description)|\(username)"
        )
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
        if sameServer, let queueSnapshot {
            playback.restoreRouteQueue(queueSnapshot, position: positionSnapshot)
            playback.volume = volumeSnapshot
            playback.setPodcastPlaybackRate(rateSnapshot)
        }
        self.playback = playback
        let podcastCloud = playback.podcastCloud
        Task { await podcastCloud?.refresh() }
        self.favorites = FavoritesModel(client: client)
        self.offline = OfflineModel(downloads: downloads)
        self.profile = profile
        self.sharing = PlaybackSharingModel(client: client, playback: playback)
        Task {
            guard let libraries = try? await client.libraries() else { return }
            if let selected = client.selectedLibrary(),
                !libraries.contains(where: { $0.id == selected })
            {
                client.selectLibrary(nil)
                preferences.setLibraryID(nil)
            }
        }
        let previous = servers.first { $0.address == primary.description }
        let info = try? await client.serverInfo()
        SavedServersStore.upsert(
            SavedServer(address: primary.description, username: username, lastUsedAt: .now, allowInsecureHTTP: primary.url.scheme == "http", serverName: info?.name ?? previous?.serverName, alias: previous?.alias, instanceID: info?.instance_id ?? previous?.instanceID)
        )
        servers = SavedServersStore.load()
        let status = try? await client.authStatus()
        controller.bind(info: info, userID: status?.user?.id, activeAddress: address.description)
        controller.onSelected = { [weak self, weak controller] candidate, address in
            guard let self, let controller, self.routes === controller else { return }
            await self.activate(client: candidate, address: address, username: username, profile: profile, routeProfile: controller)
        }
        phase = .connected(server: primary.description, username: username)
        if resume { playback.resume() }
        if !sameServer { controller.start() }
    }

    private func makeAddress(_ raw: String) throws -> ServerAddress {
        try makeAddress(raw, allowInsecureHTTP: false)
    }

    private func makeAddress(_ raw: String, allowInsecureHTTP: Bool) throws -> ServerAddress {
        try ServerAddress(input: raw, allowsInsecureHTTP: allowInsecureHTTP)
    }

    private static func message(for error: Error) -> String {
        if let error = error as? APIError {
            switch error.code {
            case "https_required": return "服务器仅允许 HTTPS，请使用 HTTPS 线路登录"
            case "invalid_credentials": return "用户名或密码错误"
            case "login_throttled": return "尝试次数过多，请稍后再试"
            case "owner_setup_required": return "服务器尚未初始化所有者，请先在服务端完成设置"
            case "client_header_required": return "服务器版本过旧，暂不支持 iOS 客户端"
            case "invalid_account_input": return "输入内容不符合要求"
            default: return "服务器返回错误（\(error.statusCode)）"
            }
        }
        if let error = error as? ServerAddress.ValidationError {
            switch error {
            case .invalidURL: return "服务器地址格式不正确"
            case .unsupportedScheme: return "仅支持 http 或 https 地址"
            case .insecureHTTPNotAllowed: return "需要 HTTPS 地址，或先确认使用未加密 HTTP"
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
