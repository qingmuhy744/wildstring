import Foundation

struct SavedServer: Codable, Equatable, Identifiable {
    var address: String
    var username: String
    var lastUsedAt: Date

    var id: String { address }
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
