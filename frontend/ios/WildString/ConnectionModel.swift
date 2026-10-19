import CoreNetwork
import CorePlayback
import Foundation
import Observation

@MainActor
@Observable
final class ConnectionModel {
    enum Phase: Equatable {
        case loading
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
    let demoAutoPlay: Bool

    private let store: any SessionStore
    private let defaults: UserDefaults
    private let queueStore: any QueueStore

    private static let lastServerKey = "lastServerAddress"

    init(
        store: any SessionStore = KeychainSessionStore(),
        defaults: UserDefaults = .standard
    ) {
        self.store = store
        self.defaults = defaults
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
        guard let saved = defaults.string(forKey: Self.lastServerKey),
            let address = try? makeAddress(saved)
        else {
            phase = .connect
            return
        }
        serverText = saved
        let client = WildstringClient(server: address, store: store)
        guard await client.storedSessionExists() else {
            phase = .connect
            return
        }
        do {
            let status = try await client.authStatus()
            if status.authenticated, let user = status.user {
                await activate(client: client, address: address, username: user.username)
                return
            }
            await client.clearSession()
        } catch {
            // Keep the saved address prefilled; explain failures when the user retries.
        }
        phase = .connect
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
            defaults.set(address.description, forKey: Self.lastServerKey)
            password = ""
            await activate(client: client, address: address, username: user.username)
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func logout() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        playback?.shutdown()
        playback = nil
        if let client {
            try? await client.logout()
        }
        client = nil
        username = ""
        password = ""
        errorMessage = nil
        phase = .connect
    }

    private func activate(
        client: WildstringClient,
        address: ServerAddress,
        username: String
    ) async {
        self.client = client
        let playback = PlaybackService(
            server: address,
            store: queueStore,
            cookieHeader: { [weak client] in
                await client?.cookieHeaderValue()
            }
        )
        await playback.restore()
        self.playback = playback
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
