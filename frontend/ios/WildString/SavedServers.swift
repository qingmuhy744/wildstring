import Foundation

struct SavedServer: Codable, Equatable, Identifiable {
    var address: String
    var username: String
    var lastUsedAt: Date
    var allowInsecureHTTP: Bool

    var serverName: String?
    var alias: String?
    var instanceID: String?
    var label: String { alias.flatMap { $0.isEmpty ? nil : $0 } ?? serverName ?? address }
    var id: String { address }

    init(address: String, username: String, lastUsedAt: Date, allowInsecureHTTP: Bool = false, serverName: String? = nil, alias: String? = nil, instanceID: String? = nil) {
        self.serverName = serverName
        self.alias = alias
        self.instanceID = instanceID
        self.address = address
        self.username = username
        self.lastUsedAt = lastUsedAt
        self.allowInsecureHTTP = allowInsecureHTTP
    }

    private enum CodingKeys: String, CodingKey {
        case address, username, lastUsedAt, allowInsecureHTTP, serverName, alias, instanceID
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        serverName = try values.decodeIfPresent(String.self, forKey: .serverName)
        alias = try values.decodeIfPresent(String.self, forKey: .alias)
        instanceID = try values.decodeIfPresent(String.self, forKey: .instanceID)
        address = try values.decode(String.self, forKey: .address)
        username = try values.decode(String.self, forKey: .username)
        lastUsedAt = try values.decode(Date.self, forKey: .lastUsedAt)
        allowInsecureHTTP = try values.decodeIfPresent(Bool.self, forKey: .allowInsecureHTTP) ?? false
    }
}

/// Non-sensitive server list (address + account name) in UserDefaults; the
/// sessions themselves live per-origin in the Keychain.
enum SavedServersStore {
    private static let key = "savedServers"

    static func load(from defaults: UserDefaults = .standard) -> [SavedServer] {
        guard let data = defaults.data(forKey: key),
            let servers = try? JSONDecoder().decode([SavedServer].self, from: data)
        else { return [] }
        return servers.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    static func save(_ servers: [SavedServer], to defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(servers) {
            defaults.set(data, forKey: key)
        }
    }

    static func upsert(_ server: SavedServer, in defaults: UserDefaults = .standard) {
        var servers = load(from: defaults)
        if let index = servers.firstIndex(where: { $0.address == server.address }) {
            servers[index] = server
        } else {
            servers.append(server)
        }
        save(servers, to: defaults)
    }

    static func remove(address: String, in defaults: UserDefaults = .standard) {
        var servers = load(from: defaults)
        servers.removeAll { $0.address == address }
        save(servers, to: defaults)
    }
}
