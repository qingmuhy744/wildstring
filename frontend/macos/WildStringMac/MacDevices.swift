import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
@Observable
final class MacPlaybackSync {
    struct Offer: Equatable {
        var state: RemotePlaybackState
        var tracks: [Track]
        var title: String
    }

    private let client: WildstringClient
    private let playback: PlaybackService
    private let deviceId: String
    private var version = 0
    private var task: Task<Void, Never>?
    private var dismissedVersion: Int?

    private(set) var snapshot: RemotePlaybackState?
    private(set) var handoff: Offer?
    var message: String?
    var busy = false

    init(client: WildstringClient, playback: PlaybackService, deviceId: String) {
        self.client = client
        self.playback = playback
        self.deviceId = deviceId
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            await self?.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                await self?.poll()
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        handoff = nil
    }

    func localPlaybackStarted() {
        handoff = nil
    }

    func dismiss() {
        dismissedVersion = handoff?.state.version
        handoff = nil
    }

    func refresh() async {
        do {
            let remote = try await client.playbackState()
            snapshot = remote
            version = remote.version
            message = nil
        } catch {
            message = L10n("macDevices.cannotReadProgress")
        }
    }

    func publishCurrent() async {
        guard !playback.items.isEmpty else { return }
        let snap = playback.playbackSnapshot()
        if await save(snap, version: version) { return }
        await refresh()
        _ = await save(snap, version: version)
    }

    func shareCurrent() async {
        busy = true
        defer { busy = false }
        await publishCurrent()
        if message == nil { message = L10n("macDevices.sharedCurrentProgress") }
    }

    func loadRemote() async {
        guard let snapshot, !snapshot.trackIds.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let tracks = try await resolve(snapshot.trackIds)
            playback.adopt(
                items: tracks.map(MacPlayback.item),
                startingAt: snapshot.index,
                position: Double(snapshot.positionMs) / 1000,
                mode: snapshot.mode
            )
            message = L10n("macDevices.loadedPaused")
        } catch {
            message = L10n("macDevices.someTracksUnavailable")
        }
    }

    func accept() async {
        guard let handoff else { return }
        playback.adopt(
            items: handoff.tracks.map(MacPlayback.item),
            startingAt: handoff.state.index,
            position: Double(handoff.state.positionMs) / 1000,
            mode: handoff.state.mode
        )
        self.handoff = nil
        message = L10n("macDevices.connectedPausePosition")
    }

    private func poll() async {
        guard !playback.isPlaying, handoff == nil else { return }
        guard let remote = try? await client.playbackState() else { return }
        snapshot = remote
        version = remote.version
        guard remote.handoffEligible == true,
            remote.playbackState == "paused",
            remote.deviceId != deviceId,
            remote.version != dismissedVersion,
            !remote.trackIds.isEmpty
        else { return }
        guard let tracks = try? await resolve(remote.trackIds), !tracks.isEmpty else { return }
        let index = min(max(0, remote.index), tracks.count - 1)
        handoff = Offer(state: remote, tracks: tracks, title: tracks[index].title)
    }

    private func save(_ snap: PlaybackSnapshot, version: Int) async -> Bool {
        do {
            let saved = try await client.savePlaybackState(
                RemotePlaybackState(
                    version: version,
                    deviceId: deviceId,
                    trackIds: snap.trackIDs,
                    index: snap.index,
                    positionMs: snap.positionMs,
                    mode: snap.mode,
                    playbackState: snap.playbackState
                )
            )
            self.version = saved.version
            snapshot = saved
            return true
        } catch let error as APIError where error.statusCode == 409 {
            return false
        } catch {
            message = L10n("macDevices.failedToShare")
            return true
        }
    }

    private func resolve(_ ids: [String]) async throws -> [Track] {
        let ids = Array(ids.prefix(200))
        var tracks: [Track] = []
        tracks.reserveCapacity(ids.count)
        var index = 0
        while index < ids.count {
            let end = min(index + 8, ids.count)
            let chunk = Array(ids[index..<end])
            let client = self.client
            let loaded = try await withThrowingTaskGroup(of: (Int, Track).self) { group in
                for (offset, id) in chunk.enumerated() {
                    group.addTask { (offset, try await client.track(id: id)) }
                }
                var rows: [(Int, Track)] = []
                for try await row in group { rows.append(row) }
                return rows.sorted { $0.0 < $1.0 }.map(\.1)
            }
            tracks.append(contentsOf: loaded)
            index = end
        }
        return tracks
    }
}

struct MacDevicesView: View {
    let sync: MacPlaybackSync?
    let playback: PlaybackService

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let sync {
                    if let snapshot = sync.snapshot, !snapshot.trackIds.isEmpty {
                        VStack(spacing: 0) {
                            infoRow(L10n("macDevices.queue"), L10n("macDevices.trackCount", snapshot.trackIds.count))
                            infoRow(
                                L10n("macDevices.position"),
                                L10n("macDevices.positionDetail", snapshot.index + 1, clock(Double(snapshot.positionMs) / 1000))
                            )
                            infoRow(L10n("macDevices.mode"), modeName(snapshot.mode))
                        }
                        .background(
                            MacTheme.panel,
                            in: RoundedRectangle(cornerRadius: MacTheme.panelRadius, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: MacTheme.panelRadius, style: .continuous)
                                .strokeBorder(MacTheme.border, lineWidth: 1)
                        )
                    } else {
                        Text(L10n("macDevices.noSharedProgress"))
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                    }
                    HStack(spacing: 10) {
                        Button(sync.busy ? L10n("macDevices.processing") : L10n("macDevices.fetchLatest")) {
                            Task { await sync.refresh() }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(MacTheme.accentDeep)
                        .disabled(sync.busy)
                        Button(L10n("macDevices.shareCurrent")) {
                            Task { await sync.shareCurrent() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(sync.busy || playback.currentItem == nil)
                        Button(L10n("macDevices.loadAndPause")) {
                            Task { await sync.loadRemote() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(sync.busy || (sync.snapshot?.trackIds.isEmpty ?? true))
                    }
                    if let message = sync.message {
                        Text(message)
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.accentDeep)
                    }
                    Text(L10n("macDevices.syncHint"))
                        .font(MacTheme.caption)
                        .foregroundStyle(MacTheme.muted)
                }
            }
            .padding(24)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(MacTheme.canvas)
        .navigationTitle(L10n("macDevices.title"))
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
            Spacer()
            Text(value).font(.system(size: 13)).foregroundStyle(MacTheme.ink)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(MacTheme.border.opacity(0.55))
                .frame(height: 1)
                .padding(.horizontal, 16)
        }
    }

    private func modeName(_ mode: String) -> String {
        switch mode {
        case "shuffle": return L10n("macDevices.modeShuffle")
        case "repeat_one": return L10n("macDevices.modeRepeatOne")
        case "repeat_all": return L10n("macDevices.modeRepeatAll")
        default: return L10n("macDevices.modeSequential")
        }
    }

    private func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
