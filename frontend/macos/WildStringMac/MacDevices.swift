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
            message = "无法读取其他设备的进度"
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
        if message == nil { message = "当前队列与进度已共享" }
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
            message = "已载入这条进度，先保持暂停"
        } catch {
            message = "有些歌曲已经不可用，没能载入"
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
        message = "已接上其他设备的暂停位置"
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
            message = "进度没有共享出去"
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
        Form {
            if let sync {
                Section("账号共享进度") {
                    if let snapshot = sync.snapshot, !snapshot.trackIds.isEmpty {
                        LabeledContent("队列", value: "\(snapshot.trackIds.count) 首")
                        LabeledContent("位置", value: "第 \(snapshot.index + 1) 首 · \(clock(Double(snapshot.positionMs) / 1000))")
                        LabeledContent("方式", value: modeName(snapshot.mode))
                    } else {
                        Text("还没有共享的播放进度")
                            .foregroundStyle(.secondary)
                    }
                    if let message = sync.message {
                        Text(message).font(.callout)
                    }
                    Button(sync.busy ? "处理中…" : "读取最新进度") {
                        Task { await sync.refresh() }
                    }
                    .disabled(sync.busy)
                    Button("共享当前播放进度") {
                        Task { await sync.shareCurrent() }
                    }
                    .disabled(sync.busy || playback.currentItem == nil)
                    Button("载入并暂停在这里") {
                        Task { await sync.loadRemote() }
                    }
                    .disabled(sync.busy || (sync.snapshot?.trackIds.isEmpty ?? true))
                }
                Section {
                    Text("暂停时会记下进度。其他设备最近一次暂停会出现在窗口顶部，载入后先不播放。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("跨设备继续")
        .padding()
    }

    private func modeName(_ mode: String) -> String {
        switch mode {
        case "shuffle": return "随机"
        case "repeat_one": return "单曲循环"
        case "repeat_all": return "列表循环"
        default: return "顺序播放"
        }
    }

    private func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
