import CoreNetwork
import CorePlayback
import Foundation
import Observation

/// Cross-device playback handoff: publishes paused snapshots and surfaces (or
/// auto-restores) another device's latest state, always paused.
@MainActor
@Observable
final class PlaybackSharingModel {
    struct Handoff: Equatable {
        var state: RemotePlaybackState
        var tracks: [Track]
    }

    private(set) var handoff: Handoff?
    private(set) var message: String?

    private let client: WildstringClient
    private let playback: PlaybackService
    private let defaults: UserDefaults
    let deviceId: String

    private var lastSeenVersion: Int
    private var lastPublishedAt = Date.distantPast
    private var lastSnapshot: PlaybackSnapshot?
    private var dismissedVersion: Int?
    private var task: Task<Void, Never>?
    private var isWorking = false

    init(client: WildstringClient, playback: PlaybackService, defaults: UserDefaults = .standard) {
        self.client = client
        self.playback = playback
        self.defaults = defaults
        if let stored = defaults.string(forKey: "playbackSyncDeviceID"), !stored.isEmpty {
            deviceId = stored
        } else {
            let created = UUID().uuidString
            defaults.set(created, forKey: "playbackSyncDeviceID")
            deviceId = created
        }
        lastSeenVersion = defaults.integer(forKey: "playbackSyncSeenVersion")
    }

    /// Device-local preference: off / ask / auto (default ask).
    var mode: String {
        let raw = defaults.string(forKey: "playbackSyncMode") ?? "ask"
        return ["off", "ask", "auto"].contains(raw) ? raw : "ask"
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        handoff = nil
    }

    /// Publishes the current queue when paused. Mirrors the Android client:
    /// 15-second throttle, identical snapshots skipped, and a single retry with
    /// a refreshed version when another device saved first (409).
    func publishIfPaused() async {
        guard mode != "off", !playback.isPlaying, !playback.items.isEmpty else { return }
        guard Date().timeIntervalSince(lastPublishedAt) > 15 else { return }
        let snapshot = playback.playbackSnapshot()
        if let last = lastSnapshot, last == snapshot {
            return
        }
        if await save(snapshot: snapshot, version: lastSeenVersion) {
            finishPublish(snapshot)
            return
        }
        guard let latest = try? await client.playbackState() else { return }
        recordVersion(latest.version)
        if await save(snapshot: snapshot, version: latest.version) {
            finishPublish(snapshot)
        }
    }

    private func finishPublish(_ snapshot: PlaybackSnapshot) {
        lastPublishedAt = Date()
        lastSnapshot = snapshot
        message = nil
    }

    private func save(snapshot: PlaybackSnapshot, version: Int) async -> Bool {
        do {
            let saved = try await client.savePlaybackState(
                RemotePlaybackState(
                    version: version,
                    deviceId: deviceId,
                    trackIds: snapshot.trackIDs,
                    index: snapshot.index,
                    positionMs: snapshot.positionMs,
                    mode: snapshot.mode
                )
            )
            recordVersion(saved.version)
            return true
        } catch let error as APIError where error.statusCode == 409 {
            return false
        } catch {
            message = "跨设备接续保存失败"
            return true
        }
    }

    private func recordVersion(_ version: Int) {
        lastSeenVersion = version
        defaults.set(version, forKey: "playbackSyncSeenVersion")
    }

    func accept(_ handoff: Handoff) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let latest = try await client.playbackState()
            guard latest.version == handoff.state.version, !latest.trackIds.isEmpty else {
                recordVersion(latest.version)
                self.handoff = nil
                message = "其他设备的进度已更新，请重新查看"
                return
            }
            let items = handoff.tracks.map(\.playbackItem)
            guard !items.isEmpty else {
                self.handoff = nil
                return
            }
            playback.adopt(
                items: items,
                startingAt: min(handoff.state.index, items.count - 1),
                position: Double(handoff.state.positionMs) / 1000,
                mode: handoff.state.mode
            )
            recordVersion(latest.version)
            self.handoff = nil
            message = nil
        } catch {
            message = "接续失败，请重试"
        }
    }

    func dismiss() {
        if let handoff {
            dismissedVersion = handoff.state.version
            recordVersion(handoff.state.version)
        }
        handoff = nil
    }

    private func poll() async {
        guard mode != "off", !playback.isPlaying, handoff == nil, !isWorking else { return }
        guard let remote = try? await client.playbackState() else { return }
        guard !remote.trackIds.isEmpty,
            !remote.deviceId.isEmpty,
            remote.deviceId != deviceId,
            remote.version > lastSeenVersion,
            remote.version != dismissedVersion
        else { return }
        guard let tracks = try? await resolveTracks(remote.trackIds), !tracks.isEmpty else {
            return
        }
        let candidate = Handoff(state: remote, tracks: tracks)
        if mode == "auto" {
            await accept(candidate)
        } else {
            handoff = candidate
        }
    }

    private func resolveTracks(_ ids: [String]) async throws -> [Track] {
        let client = self.client
        var tracks: [Track] = []
        for start in stride(from: 0, to: ids.count, by: 8) {
            let chunk = Array(ids[start..<min(start + 8, ids.count)])
            let resolved = try await withThrowingTaskGroup(of: (Int, Track).self) { group in
                for (offset, id) in chunk.enumerated() {
                    group.addTask { (offset, try await client.track(id: id)) }
                }
                var results: [(Int, Track)] = []
                for try await result in group {
                    results.append(result)
                }
                return results.sorted { $0.0 < $1.0 }.map(\.1)
            }
            tracks.append(contentsOf: resolved)
        }
        return tracks
    }
}
