import Foundation

/// Preferences scoped by server address and username. Logout keeps other accounts.
struct AccountPreferences {
    let server: String
    let username: String
    private let defaults: UserDefaults

    init(server: String, username: String, defaults: UserDefaults = .standard) {
        self.server = server
        self.username = username
        self.defaults = defaults
    }

    private var scope: String { "\(server)|\(username)" }

    private func scopedKey(_ name: String) -> String { "ws.acct.\(scope).\(name)" }

    func string(_ name: String, default fallback: String) -> String {
        let key = scopedKey(name)
        if defaults.object(forKey: key) != nil {
            return defaults.string(forKey: key) ?? fallback
        }
        if let existing = defaults.string(forKey: name) {
            defaults.set(existing, forKey: key)
            return existing
        }
        return fallback
    }

    func setString(_ name: String, _ value: String, mirrorGlobal: Bool = false) {
        defaults.set(value, forKey: scopedKey(name))
        if mirrorGlobal { defaults.set(value, forKey: name) }
    }

    func int(_ name: String, default fallback: Int) -> Int {
        let key = scopedKey(name)
        if defaults.object(forKey: key) != nil {
            return defaults.integer(forKey: key)
        }
        if defaults.object(forKey: name) != nil {
            let value = defaults.integer(forKey: name)
            defaults.set(value, forKey: key)
            return value
        }
        return fallback
    }

    func setInt(_ name: String, _ value: Int, mirrorGlobal: Bool = false) {
        defaults.set(value, forKey: scopedKey(name))
        if mirrorGlobal { defaults.set(value, forKey: name) }
    }

    func bool(_ name: String, default fallback: Bool) -> Bool {
        let key = scopedKey(name)
        if defaults.object(forKey: key) != nil {
            return defaults.bool(forKey: key)
        }
        if defaults.object(forKey: name) != nil {
            let value = defaults.bool(forKey: name)
            defaults.set(value, forKey: key)
            return value
        }
        return fallback
    }

    func setBool(_ name: String, _ value: Bool, mirrorGlobal: Bool = false) {
        defaults.set(value, forKey: scopedKey(name))
        if mirrorGlobal { defaults.set(value, forKey: name) }
    }

    var cacheLimitMB: Int { int("fragmentCacheLimitMB", default: 512) }
    var qualityRaw: String { string("playbackQuality", default: "original") }
    var qualityBitrate: Int? { Int(qualityRaw) }
    var allowsCellularDownloads: Bool { bool("allowsCellularDownloads", default: true) }
    var libraryID: String? {
        let value = string("libraryID", default: "")
        return value.isEmpty ? nil : value
    }

    func setLibraryID(_ id: String?) {
        setString("libraryID", id ?? "")
    }

    /// Copies this account's appearance and playback choices onto the keys the live UI reads.
    func applyMirrors() {
        let theme = string("appearanceTheme", default: ThemeChoice.system.rawValue)
        let style = string("playerStyle", default: PlayerStyle.cover.rawValue)
        let size = string("songListSize", default: SongListSize.medium.rawValue)
        let quality = string("playbackQuality", default: "original")
        let sync = string("playbackSyncMode", default: "ask")
        defaults.set(theme, forKey: "appearanceTheme")
        defaults.set(style, forKey: "playerStyle")
        defaults.set(size, forKey: "songListSize")
        defaults.set(quality, forKey: "playbackQuality")
        defaults.set(sync, forKey: "playbackSyncMode")
        defaults.set(bool("hapticsEnabled", default: true), forKey: "hapticsEnabled")
        defaults.set(cacheLimitMB, forKey: "fragmentCacheLimitMB")
    }
}
