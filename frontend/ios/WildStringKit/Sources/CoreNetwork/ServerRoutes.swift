import Foundation
import Observation

public struct ServerRoute: Codable, Equatable, Identifiable, Sendable {
    public var id: String { address }
    public var name: String
    public var address: String
    public var allowHTTP: Bool
    public init(name: String, address: String, allowHTTP: Bool) {
        self.name = name; self.address = address; self.allowHTTP = allowHTTP
    }
}

public struct ServerRouteProfile: Codable, Equatable, Sendable {
    public var routes: [ServerRoute]
    /// nil means Fallback. Otherwise pin this exact address.
    public var manualAddress: String?
    public var instanceID: String?
    public var userID: String?
    public var activeAddress: String
    public init(primary: ServerRoute) {
        routes = [primary]; activeAddress = primary.address
    }
}

/// One logical server, independent sessions per route. Never forwards credentials.
@Observable @MainActor
public final class ServerRoutes {
    public private(set) var profile: ServerRouteProfile
    public private(set) var message: String?
    public private(set) var busy = false
    public var onSelected: (@MainActor (WildstringClient, ServerAddress) async -> Void)?
    private let makeClient: @MainActor (ServerAddress) -> WildstringClient
    private let defaults: UserDefaults
    private let key: String
    public let storageAddress: String
    private var loop: Task<Void, Never>?
    private var failures = 0
    private var failedPlaybackRoutes: Set<String> = []
    public var activeName: String { profile.routes.first { $0.address == profile.activeAddress }?.name ?? "默认线路" }

    public init(primary: ServerRoute, defaults: UserDefaults = .standard,
                makeClient: @escaping @MainActor (ServerAddress) -> WildstringClient) {
        self.defaults = defaults; self.makeClient = makeClient
        storageAddress = primary.address
        key = "server.routes." + Data(primary.address.utf8).base64EncodedString()
        if let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode(ServerRouteProfile.self, from: data) {
            profile = saved
        } else { profile = ServerRouteProfile(primary: primary) }
    }

    public func bind(info: ServerInfo?, userID: String?, activeAddress: String) {
        if let info { profile.instanceID = info.instance_id }
        if let userID { profile.userID = userID }
        profile.activeAddress = activeAddress
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(profile) { defaults.set(data, forKey: key) }
    }

    /// User supplies credentials to the chosen address explicitly; no password is retained.
    public func add(name: String, address input: String, allowHTTP: Bool, username: String, password: String) async throws {
        guard !busy else { return }
        guard let instanceID = profile.instanceID, let userID = profile.userID else {
            throw APIError(statusCode: 409, code: "请升级服务端并登录后再添加线路")
        }
        let address = try ServerAddress(input: input, allowsInsecureHTTP: allowHTTP)
        guard !profile.routes.contains(where: { $0.address != address.description && (try? ServerAddress(input: $0.address, allowsInsecureHTTP: $0.allowHTTP).origin) == address.origin }) else {
            throw APIError(statusCode: 409, code: "该地址或同源线路已经保存")
        }
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label.count <= 80 else { throw APIError(statusCode: 422, code: "请填写 1–80 字的线路名称") }
        busy = true; defer { busy = false }
        let candidate = makeClient(address)
        let info = try await candidate.serverInfo()
        guard info.instance_id == instanceID else { throw APIError(statusCode: 409, code: "这条线路不属于当前服务器") }
        let user = try await candidate.login(username: username, password: password)
        let authenticatedInfo = try await candidate.serverInfo()
        guard authenticatedInfo.instance_id == instanceID, user.id == userID else {
            try? await candidate.logout()
            await candidate.clearSession()
            throw APIError(statusCode: 409, code: "线路的服务器或账号不一致")
        }
        let route = ServerRoute(name: label, address: address.description, allowHTTP: allowHTTP)
        if let index = profile.routes.firstIndex(where: { $0.id == route.id }) { profile.routes[index] = route }
        else { profile.routes.append(route) }
        if profile.activeAddress == route.address { await onSelected?(candidate, address) }
        persist(); message = "线路已独立登录并保存"; start()
    }

    public func rename(_ route: ServerRoute, name: String) {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 80, let index = profile.routes.firstIndex(where: { $0.id == route.id }) else { return }
        profile.routes[index].name = value; persist()
    }

    public func move(_ route: ServerRoute, by distance: Int) {
        guard let index = profile.routes.firstIndex(where: { $0.id == route.id }), profile.routes.indices.contains(index + distance) else { return }
        profile.routes.swapAt(index, index + distance); persist()
    }

    public func remove(_ route: ServerRoute) async {
        guard profile.routes.count > 1, route.address != profile.activeAddress else { return }
        if let address = try? ServerAddress(input: route.address, allowsInsecureHTTP: route.allowHTTP) {
            let client = makeClient(address)
            try? await client.logout(); await client.clearSession()
        }
        profile.routes.removeAll { $0.id == route.id }; persist()
    }

    public func select(_ address: String?) async {
        guard !busy else { return }
        failedPlaybackRoutes = []
        let previous = profile.manualAddress
        profile.manualAddress = address
        // Selecting Fallback explicitly starts from the first priority. Automatic
        // probes keep the currently working route rather than bouncing back.
        if !(await choose(address.map { target in profile.routes.filter { $0.address == target } } ?? profile.routes)) {
            profile.manualAddress = previous
            message = "线路选择未完成，已保留原模式和连接；请检查网络或重新登录"
        }
        persist()
    }

    @discardableResult
    private func choose(_ routes: [ServerRoute]) async -> Bool {
        guard !busy else { return false }
        busy = true; defer { busy = false }
        for route in routes {
            if Task.isCancelled { return false }
            do {
                let address = try ServerAddress(input: route.address, allowsInsecureHTTP: route.allowHTTP)
                let candidate = makeClient(address)
                guard await candidate.storedSessionExists() else { continue }
                let status = try await candidate.authStatus(timeout: 5)
                guard status.authenticated, status.user?.id == profile.userID,
                      status.server?.instance_id == profile.instanceID else { continue }
                profile.activeAddress = route.address; persist(); failures = 0
                message = nil
                await onSelected?(candidate, address)
                return true
            } catch is CancellationError { return false }
            catch { continue }
        }
        message = profile.manualAddress == nil ? "没有可用的已登录线路，请检查网络或重新登录" : "手动线路不可用，请重新登录或切回 Fallback"
        return false
    }

    public func forget() { stop(); defaults.removeObject(forKey: key) }

    public func signOut() async {
        stop()
        for route in profile.routes {
            guard let address = try? ServerAddress(input: route.address, allowsInsecureHTTP: route.allowHTTP) else { continue }
            let client = makeClient(address)
            try? await client.logout(); await client.clearSession()
        }
    }

    public func restore() async -> (WildstringClient, ServerAddress, User)? {
        let candidates = profile.manualAddress.map { target in profile.routes.filter { $0.address == target } }
            ?? profile.routes.sorted { $0.address == profile.activeAddress && $1.address != profile.activeAddress }
        for route in candidates {
            do {
                let address = try ServerAddress(input: route.address, allowsInsecureHTTP: route.allowHTTP)
                let client = makeClient(address)
                guard await client.storedSessionExists() else { continue }
                let status = try await client.authStatus(timeout: 5)
                guard status.authenticated, let user = status.user else { continue }
                if let expected = profile.instanceID, status.server?.instance_id != expected { continue }
                if let expected = profile.userID, user.id != expected { continue }
                profile.activeAddress = route.address; persist()
                return (client, address, user)
            } catch { continue }
        }
        return nil
    }

    public func start() {
        stop()
        guard profile.routes.count > 1 else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard self != nil else { return }
                await self?.probe()
                do { try await Task.sleep(for: .seconds(10)) } catch { break }
            }
        }
    }
    public func stop() { loop?.cancel(); loop = nil }

    public func playbackConnectionFailed(address: String) async {
        guard profile.activeAddress == address, profile.manualAddress == nil, !busy else { return }
        failedPlaybackRoutes.insert(address)
        await choose(profile.routes.filter { !failedPlaybackRoutes.contains($0.address) })
    }

    public func probe() async {
        guard !busy, let route = profile.routes.first(where: { $0.address == profile.activeAddress }),
              let address = try? ServerAddress(input: route.address, allowsInsecureHTTP: route.allowHTTP) else { return }
        do {
            let status = try await makeClient(address).authStatus(timeout: 5)
            if !status.authenticated { message = "当前线路登录已过期，请重新登录" }
            else { failures = 0; message = nil }
        } catch {
            if let api = error as? APIError, api.statusCode < 500 && api.code != "https_required" {
                message = "当前线路认证或权限错误（\(api.statusCode)）"; return
            }
            if Task.isCancelled { return }
            failures += 1
            guard profile.manualAddress == nil else { message = "手动线路连接失败，未切换线路"; return }
            if failures >= 2 { await choose(profile.routes.filter { $0.address != profile.activeAddress }) }
        }
    }
}
