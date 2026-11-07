import Foundation
import Testing
@testable import WildString

@Suite("Mac update policy")
struct MacUpdatePolicyTests {
    @Test func parseVersionAcceptsValidSemanticVersions() {
        #expect(MacUpdatePolicy.parseVersion("0.8.7") == MacVersion(0, 8, 7))
        #expect(MacUpdatePolicy.parseVersion("v0.8.8") == MacVersion(0, 8, 8))
        #expect(MacUpdatePolicy.parseVersion("V1.2.3") == MacVersion(1, 2, 3))
        #expect(MacUpdatePolicy.parseVersion(" 0.9.15 \n") == MacVersion(0, 9, 15))
    }

    @Test func parseVersionRejectsInvalidStrings() {
        #expect(MacUpdatePolicy.parseVersion("") == nil)
        #expect(MacUpdatePolicy.parseVersion("0.8") == nil)
        #expect(MacUpdatePolicy.parseVersion("1.2.3.4") == nil)
        #expect(MacUpdatePolicy.parseVersion("v0.8.8-beta") == nil)
        #expect(MacUpdatePolicy.parseVersion("invalid") == nil)
        #expect(MacUpdatePolicy.parseVersion("-1.0.0") == nil)
    }

    @Test func isNewerCorrectlyComparesVersions() {
        #expect(MacUpdatePolicy.isNewer(remote: "0.8.8", current: "0.8.7"))
        #expect(MacUpdatePolicy.isNewer(remote: "v0.8.8", current: "v0.8.7"))
        #expect(MacUpdatePolicy.isNewer(remote: "0.9.0", current: "0.8.8"))
        #expect(MacUpdatePolicy.isNewer(remote: "1.0.0", current: "0.9.9"))
        #expect(!MacUpdatePolicy.isNewer(remote: "0.8.7", current: "0.8.7"))
        #expect(!MacUpdatePolicy.isNewer(remote: "0.8.6", current: "0.8.7"))
        #expect(!MacUpdatePolicy.isNewer(remote: "0.7.9", current: "0.8.0"))
        #expect(!MacUpdatePolicy.isNewer(remote: "invalid", current: "0.8.7"))
    }

    @Test func parseReleaseExtractsDMGAndMetadata() throws {
        let json = """
        {
          "tag_name": "v0.8.8",
          "draft": false,
          "prerelease": false,
          "html_url": "https://github.com/qingmuhy744/wildstring/releases/tag/v0.8.8",
          "body": "## 更新内容\\n- 新增 macOS 自动更新检测",
          "published_at": "2026-11-07T08:00:00Z",
          "assets": [
            {
              "name": "WildString-macOS.dmg",
              "browser_download_url": "https://github.com/qingmuhy744/wildstring/releases/download/v0.8.8/WildString-macOS.dmg",
              "size": 7340032
            },
            {
              "name": "SHA256SUMS",
              "browser_download_url": "https://github.com/qingmuhy744/wildstring/releases/download/v0.8.8/SHA256SUMS",
              "size": 512
            }
          ]
        }
        """
        let data = try #require(json.data(using: .utf8))
        let release = try MacUpdatePolicy.parseRelease(from: data)
        #expect(release.version == "0.8.8")
        #expect(release.tagName == "v0.8.8")
        #expect(release.releaseNotes.contains("新增 macOS 自动更新检测"))
        #expect(release.htmlURL.absoluteString == "https://github.com/qingmuhy744/wildstring/releases/tag/v0.8.8")
        #expect(release.dmgAsset?.name == "WildString-macOS.dmg")
        #expect(release.dmgAsset?.size == 7340032)
        #expect(release.dmgAsset?.downloadURL.absoluteString == "https://github.com/qingmuhy744/wildstring/releases/download/v0.8.8/WildString-macOS.dmg")
    }

    @Test func parseReleaseRejectsDraftOrPrerelease() throws {
        let draftJSON = """
        {"tag_name": "v0.8.8", "draft": true, "prerelease": false, "assets": []}
        """
        #expect(throws: MacUpdateError.unstableRelease) {
            try MacUpdatePolicy.parseRelease(from: Data(draftJSON.utf8))
        }

        let preJSON = """
        {"tag_name": "v0.8.8", "draft": false, "prerelease": true, "assets": []}
        """
        #expect(throws: MacUpdateError.unstableRelease) {
            try MacUpdatePolicy.parseRelease(from: Data(preJSON.utf8))
        }
    }
}

@Suite("Mac updater")
@MainActor
struct MacUpdaterTests {
    @Test func manualCheckDiscoversNewerRelease() async throws {
        let suite = "wildstring.updater-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let releaseJSON = """
        {
          "tag_name": "v0.8.8",
          "draft": false,
          "prerelease": false,
          "html_url": "https://github.com/qingmuhy744/wildstring/releases/tag/v0.8.8",
          "body": "macOS 自动更新检测上线",
          "assets": [
            {
              "name": "WildString-macOS.dmg",
              "browser_download_url": "https://github.com/qingmuhy744/wildstring/releases/download/v0.8.8/WildString-macOS.dmg",
              "size": 10485760
            }
          ]
        }
        """

        StubURLProtocol.respond { request in
            if request.url?.path.contains("/releases/latest") == true {
                return .json(headers: ["ETag": "\"etag-test-123\""], body: releaseJSON)
            }
            return .empty(status: 404)
        }

        let updater = MacUpdater(
            currentVersion: "0.8.7",
            defaults: defaults,
            sessionConfiguration: StubURLProtocol.configuration()
        )

        await updater.checkForUpdates(manual: true)

        #expect(updater.phase == .available(updater.latestRelease!))
        #expect(updater.latestRelease?.version == "0.8.8")
        #expect(updater.showUpdateAlert == true)
        #expect(updater.showUpToDateAlert == false)
        #expect(updater.showErrorAlert == false)
        #expect(updater.lastCheckedAt != nil)
    }

    @Test func manualCheckReportsUpToDateWhenCurrentMatchesOrExceeds() async throws {
        let suite = "wildstring.updater-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let releaseJSON = """
        {
          "tag_name": "v0.8.7",
          "draft": false,
          "prerelease": false,
          "html_url": "https://github.com/qingmuhy744/wildstring/releases/tag/v0.8.7",
          "body": "当前版本说明",
          "assets": []
        }
        """

        StubURLProtocol.respond { request in
            if request.url?.path.contains("/releases/latest") == true {
                return .json(body: releaseJSON)
            }
            return .empty(status: 404)
        }

        let updater = MacUpdater(
            currentVersion: "0.8.7",
            defaults: defaults,
            sessionConfiguration: StubURLProtocol.configuration()
        )

        await updater.checkForUpdates(manual: true)

        #expect(updater.phase == .upToDate)
        #expect(updater.showUpToDateAlert == true)
        #expect(updater.showUpdateAlert == false)
    }

    @Test func manualCheckSurfacesErrorOnNetworkOrRateLimitFailure() async throws {
        let suite = "wildstring.updater-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        StubURLProtocol.respond { _ in
            return .empty(status: 429)
        }

        let updater = MacUpdater(
            currentVersion: "0.8.7",
            defaults: defaults,
            sessionConfiguration: StubURLProtocol.configuration()
        )

        await updater.checkForUpdates(manual: true)

        #expect(updater.phase == .error(MacUpdateError.rateLimited.localizedDescription))
        #expect(updater.showErrorAlert == true)
        #expect(updater.errorMessage != nil)
    }

    @Test func automaticCheckRespectsCooldownAndDisabledPreference() async throws {
        let suite = "wildstring.updater-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        final class Flag: @unchecked Sendable {
            var value = false
        }
        let requested = Flag()
        StubURLProtocol.respond { _ in
            requested.value = true
            return .empty(status: 500)
        }

        let updater = MacUpdater(
            currentVersion: "0.8.7",
            defaults: defaults,
            sessionConfiguration: StubURLProtocol.configuration()
        )
        updater.autoCheckEnabled = false

        await updater.checkForUpdates(manual: false)
        #expect(!requested.value)

        updater.autoCheckEnabled = true
        updater.lastCheckedAt = Date().addingTimeInterval(-1800) // 30 minutes ago, cooldown not met

        await updater.checkForUpdates(manual: false)
        #expect(!requested.value)
    }

    @Test func automaticCheckFailsSilentlyWithoutAlertingUser() async throws {
        let suite = "wildstring.updater-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        StubURLProtocol.respond { _ in
            return .empty(status: 503)
        }

        let updater = MacUpdater(
            currentVersion: "0.8.7",
            defaults: defaults,
            sessionConfiguration: StubURLProtocol.configuration()
        )

        await updater.checkForUpdates(manual: false)

        #expect(updater.phase == .idle)
        #expect(updater.showErrorAlert == false)
    }
}
