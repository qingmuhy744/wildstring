import AppKit
import Foundation
import Observation

public struct MacReleaseAsset: Sendable, Equatable {
    public let name: String
    public let downloadURL: URL
    public let size: Int64

    public init(name: String, downloadURL: URL, size: Int64) {
        self.name = name
        self.downloadURL = downloadURL
        self.size = size
    }
}

public struct MacAppRelease: Sendable, Equatable {
    public let version: String
    public let tagName: String
    public let releaseNotes: String
    public let htmlURL: URL
    public let dmgAsset: MacReleaseAsset?
    public let publishedAt: Date?

    public init(
        version: String,
        tagName: String,
        releaseNotes: String,
        htmlURL: URL,
        dmgAsset: MacReleaseAsset?,
        publishedAt: Date?
    ) {
        self.version = version
        self.tagName = tagName
        self.releaseNotes = releaseNotes
        self.htmlURL = htmlURL
        self.dmgAsset = dmgAsset
        self.publishedAt = publishedAt
    }
}

public enum MacUpdateError: LocalizedError, Equatable {
    case invalidJSON
    case unstableRelease
    case invalidTag
    case networkFailed
    case rateLimited
    case serverError(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "更新信息格式不正确"
        case .unstableRelease:
            return "当前版本为预发布或草稿版本"
        case .invalidTag:
            return "版本标签格式不符合规范"
        case .networkFailed:
            return "网络连接失败，请检查网络后重试"
        case .rateLimited:
            return "检查更新过于频繁，请稍后再试"
        case .serverError(let code):
            return "更新服务暂不可用 (HTTP \(code))"
        }
    }
}

public struct MacVersion: Equatable, Sendable {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public init(_ major: Int, _ minor: Int, _ patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }
}

public enum MacUpdatePolicy {
    public static let repository = "https://github.com/qingmuhy744/wildstring"
    public static let latestReleaseEndpoint = "https://api.github.com/repos/qingmuhy744/wildstring/releases/latest"

    public static func parseVersion(_ string: String) -> MacVersion? {
        let cleaned = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let versionString = cleaned.hasPrefix("v") ? String(cleaned.dropFirst()) : cleaned
        let components = versionString.split(separator: ".")
        guard components.count == 3,
              let major = Int(components[0]), major >= 0,
              let minor = Int(components[1]), minor >= 0,
              let patch = Int(components[2]), patch >= 0 else {
            return nil
        }
        return MacVersion(major, minor, patch)
    }

    public static func isNewer(remote: String, current: String) -> Bool {
        guard let r = parseVersion(remote), let c = parseVersion(current) else { return false }
        if r.major != c.major { return r.major > c.major }
        if r.minor != c.minor { return r.minor > c.minor }
        return r.patch > c.patch
    }

    public static func parseRelease(from data: Data) throws -> MacAppRelease {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MacUpdateError.invalidJSON
        }
        if (json["draft"] as? Bool) == true || (json["prerelease"] as? Bool) == true {
            throw MacUpdateError.unstableRelease
        }
        guard let tag = json["tag_name"] as? String, tag.hasPrefix("v") else {
            throw MacUpdateError.invalidTag
        }
        let version = String(tag.dropFirst())
        guard parseVersion(version) != nil else {
            throw MacUpdateError.invalidTag
        }
        let body = (json["body"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let notes = (body?.isEmpty == false ? body : "暂无版本说明。") ?? "暂无版本说明。"

        let htmlString = (json["html_url"] as? String) ?? "\(repository)/releases/tag/\(tag)"
        let htmlURL = URL(string: htmlString) ?? URL(string: "\(repository)/releases/latest")!

        var dmgAsset: MacReleaseAsset?
        if let assets = json["assets"] as? [[String: Any]] {
            for item in assets {
                guard let name = item["name"] as? String,
                      let urlString = item["browser_download_url"] as? String,
                      let url = URL(string: urlString) else {
                    continue
                }
                let size = (item["size"] as? NSNumber)?.int64Value ?? 0
                if name == "WildString-macOS.dmg" || name.hasSuffix(".dmg") {
                    dmgAsset = MacReleaseAsset(name: name, downloadURL: url, size: size)
                    break
                }
            }
        }

        var publishedDate: Date?
        if let publishedAtString = json["published_at"] as? String {
            let formatter = ISO8601DateFormatter()
            publishedDate = formatter.date(from: publishedAtString)
        }

        return MacAppRelease(
            version: version,
            tagName: tag,
            releaseNotes: notes,
            htmlURL: htmlURL,
            dmgAsset: dmgAsset,
            publishedAt: publishedDate
        )
    }
}

@MainActor
@Observable
public final class MacUpdater {
    public enum Phase: Equatable {
        case idle
        case checking
        case available(MacAppRelease)
        case upToDate
        case error(String)
    }

    public var phase: Phase = .idle
    public var lastCheckedAt: Date?
    public var showManualFeedback: Bool = false
    public var showUpdateAlert: Bool = false
    public var showUpToDateAlert: Bool = false
    public var showErrorAlert: Bool = false
    public var errorMessage: String?
    public var latestRelease: MacAppRelease?

    public var autoCheckEnabled: Bool {
        get {
            defaults.object(forKey: Self.autoCheckKey) as? Bool ?? true
        }
        set {
            defaults.set(newValue, forKey: Self.autoCheckKey)
        }
    }

    public var currentVersion: String

    private let defaults: UserDefaults
    private let sessionConfiguration: URLSessionConfiguration
    private var activeTask: Task<Void, Never>?

    public static let autoCheckKey = "wildstring_mac_auto_check_updates"
    public static let lastCheckedKey = "wildstring_mac_last_update_check"
    public static let cachedETagKey = "wildstring_mac_update_etag"
    public static let autoCheckInterval: TimeInterval = 6 * 3600 // 6 hours cooldown

    public init(
        currentVersion: String? = nil,
        defaults: UserDefaults = .standard,
        sessionConfiguration: URLSessionConfiguration = .ephemeral
    ) {
        self.defaults = defaults
        self.sessionConfiguration = sessionConfiguration
        if let currentVersion {
            self.currentVersion = currentVersion
        } else {
            let bundleVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
            self.currentVersion = bundleVersion?.isEmpty == false ? bundleVersion! : "0.8.7"
        }
        if let timestamp = defaults.object(forKey: Self.lastCheckedKey) as? Double {
            self.lastCheckedAt = Date(timeIntervalSince1970: timestamp)
        }
    }

    public func checkForUpdates(manual: Bool = false) async {
        if !manual {
            guard autoCheckEnabled else { return }
            if let last = lastCheckedAt, Date().timeIntervalSince(last) < Self.autoCheckInterval {
                return
            }
        }

        guard phase != .checking else { return }

        phase = .checking
        showManualFeedback = manual
        errorMessage = nil

        let endpointString = MacUpdatePolicy.latestReleaseEndpoint
        guard let url = URL(string: endpointString) else {
            finishError("更新检查地址无效", manual: manual)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("WildString-macOS-Updater/\(currentVersion)", forHTTPHeaderField: "User-Agent")

        let storedETag = defaults.string(forKey: Self.cachedETagKey)
        if !manual, let storedETag {
            request.setValue(storedETag, forHTTPHeaderField: "If-None-Match")
        }

        let session = URLSession(configuration: sessionConfiguration)
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                finishError("服务器返回无效响应", manual: manual)
                return
            }

            let now = Date()
            lastCheckedAt = now
            defaults.set(now.timeIntervalSince1970, forKey: Self.lastCheckedKey)

            if http.statusCode == 304 {
                // Not modified since last check
                phase = .upToDate
                if manual {
                    showUpToDateAlert = true
                }
                return
            }

            if http.statusCode == 403 || http.statusCode == 429 {
                finishError(MacUpdateError.rateLimited.localizedDescription, manual: manual)
                return
            }

            guard (200...299).contains(http.statusCode) else {
                finishError(MacUpdateError.serverError(http.statusCode).localizedDescription, manual: manual)
                return
            }

            if let newETag = http.value(forHTTPHeaderField: "ETag") {
                defaults.set(newETag, forKey: Self.cachedETagKey)
            }

            let release = try MacUpdatePolicy.parseRelease(from: data)
            latestRelease = release

            if MacUpdatePolicy.isNewer(remote: release.version, current: currentVersion) {
                phase = .available(release)
                showUpdateAlert = true
            } else {
                phase = .upToDate
                if manual {
                    showUpToDateAlert = true
                }
            }
        } catch is CancellationError {
            phase = .idle
        } catch {
            finishError(MacUpdateError.networkFailed.localizedDescription, manual: manual)
        }
    }

    private func finishError(_ message: String, manual: Bool) {
        if manual {
            phase = .error(message)
            errorMessage = message
            showErrorAlert = true
        } else {
            // Background checks fail silently to avoid annoying alerts
            phase = .idle
        }
    }

    public func openDownload(for release: MacAppRelease) {
        let targetURL = release.dmgAsset?.downloadURL ?? release.htmlURL
        NSWorkspace.shared.open(targetURL)
    }

    public func openReleasePage(for release: MacAppRelease) {
        NSWorkspace.shared.open(release.htmlURL)
    }
}
