import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct SettingsView: View {
    let playback: PlaybackService
    let client: WildstringClient
    let server: String
    let username: String

    @Environment(OfflineModel.self) private var offline
    @Environment(\.isAdmin) private var isAdmin
    @State private var limitMB = 512
    @State private var theme = ThemeChoice.system.rawValue
    @State private var playerStyle = PlayerStyle.cover.rawValue
    @State private var songListSize = SongListSize.medium.rawValue
    @State private var hapticsEnabled = true
    @State private var playbackQuality = "original"
    @State private var syncMode = "ask"
    @State private var allowsCellular = true
    @State private var cacheBytes: Int64 = 0
    @State private var showingReview = false

    private var preferences: AccountPreferences {
        AccountPreferences(server: server, username: username)
    }

    init(playback: PlaybackService, client: WildstringClient, server: String, username: String) {
        self.playback = playback
        self.client = client
        self.server = server
        self.username = username
        let stored = AccountPreferences(server: server, username: username)
        _limitMB = State(initialValue: stored.cacheLimitMB)
        _theme = State(initialValue: stored.string("appearanceTheme", default: ThemeChoice.system.rawValue))
        _playerStyle = State(initialValue: stored.string("playerStyle", default: PlayerStyle.cover.rawValue))
        _songListSize = State(initialValue: stored.string("songListSize", default: SongListSize.medium.rawValue))
        _hapticsEnabled = State(initialValue: stored.bool("hapticsEnabled", default: true))
        _playbackQuality = State(initialValue: stored.qualityRaw)
        _syncMode = State(initialValue: stored.string("playbackSyncMode", default: "ask"))
        _allowsCellular = State(initialValue: stored.allowsCellularDownloads)
    }

    var body: some View {
        List {
            if isAdmin {
                Section("管理员") {
                    Button {
                        showingReview = true
                    } label: {
                        Label("批量核对资料", systemImage: "checklist")
                    }
                    NavigationLink {
                        ApplicationPolicyView(client: client)
                    } label: {
                        Label("整理方式", systemImage: "wand.and.stars")
                    }
                    NavigationLink(value: AdminDestination.scans) {
                        Label("扫描任务", systemImage: "arrow.triangle.2.circlepath")
                    }
                    NavigationLink(value: AdminDestination.imports) {
                        Label("导入记录", systemImage: "tray.and.arrow.down")
                    }
                }
                .sheet(isPresented: $showingReview) {
                    MetadataReviewView(client: client)
                }
            }
            Section("外观") {
                Picker("主题", selection: $theme) {
                    ForEach(ThemeChoice.allCases, id: \.self) { choice in
                        Text(choice.label).tag(choice.rawValue)
                    }
                }
                Picker("播放页样式", selection: $playerStyle) {
                    ForEach(PlayerStyle.allCases, id: \.self) { style in
                        Text(style.label).tag(style.rawValue)
                    }
                }
                Picker("歌曲列表大小", selection: $songListSize) {
                    ForEach(SongListSize.allCases, id: \.self) { size in
                        Text(size.label).tag(size.rawValue)
                    }
                }
                Toggle("轻触反馈", isOn: $hapticsEnabled)
            }
            Section("播放") {
                Picker("音质", selection: $playbackQuality) {
                    Text("原音").tag("original")
                    Text("AAC 128 kbps").tag("128")
                    Text("AAC 192 kbps").tag("192")
                    Text("AAC 256 kbps").tag("256")
                    Text("AAC 320 kbps").tag("320")
                }
                Text("无损源转为 AAC；有损源保持原文件。转码不可用时自动回退原音。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Picker("跨设备接续", selection: $syncMode) {
                    Text("关闭").tag("off")
                    Text("轻提示").tag("ask")
                    Text("自动恢复").tag("auto")
                }
                if syncMode != "off" {
                    Text("暂停时自动保存进度；仅提示其他设备最近 30 分钟内的暂停，每次暂停只提示一次；载入后保持暂停。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section("片段缓存") {
                LabeledContent("已用空间", value: byteText(cacheBytes))
                Picker("容量上限", selection: $limitMB) {
                    Text("关闭").tag(0)
                    Text("128 MB").tag(128)
                    Text("256 MB").tag(256)
                    Text("512 MB").tag(512)
                    Text("1 GB").tag(1024)
                    Text("2 GB").tag(2048)
                }
                Button("清除片段缓存") {
                    Task {
                        await playback.clearFragmentCache()
                        await refresh()
                    }
                }
                .disabled(cacheBytes == 0)
            }
            Section("离线下载") {
                LabeledContent("已下载", value: "\(offline.stats.count) 首")
                LabeledContent("占用空间", value: byteText(offline.stats.totalBytes))
                if offline.items.isEmpty {
                    Text("还没有离线下载。长按任意歌曲即可下载。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(offline.items) { item in
                        OfflineItemRow(item: item)
                            .swipeActions(edge: .trailing) {
                                Button("删除", role: .destructive) {
                                    Task { await offline.remove(trackID: item.trackID) }
                                }
                            }
                    }
                }
                Button("清除全部下载", role: .destructive) {
                    Task { await offline.clearAll() }
                }
                .disabled(offline.items.isEmpty)
                Toggle("允许使用蜂窝网络下载", isOn: $allowsCellular)
                Text("当前正在进行的下载仍按连接时的设置。下次登录后，新的下载会改用这里的选择。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("设置")
        .onChange(of: limitMB) { _, newValue in
            preferences.setInt("fragmentCacheLimitMB", newValue, mirrorGlobal: true)
            playback.setFragmentCacheLimit(Int64(newValue) * 1_048_576)
        }
        .onChange(of: playbackQuality) { _, newValue in
            preferences.setString("playbackQuality", newValue, mirrorGlobal: true)
            playback.preferredBitrateKbps = Int(newValue)
        }
        .onChange(of: theme) { _, newValue in
            preferences.setString("appearanceTheme", newValue, mirrorGlobal: true)
        }
        .onChange(of: playerStyle) { _, newValue in
            preferences.setString("playerStyle", newValue, mirrorGlobal: true)
        }
        .onChange(of: songListSize) { _, newValue in
            preferences.setString("songListSize", newValue, mirrorGlobal: true)
        }
        .onChange(of: hapticsEnabled) { _, newValue in
            preferences.setBool("hapticsEnabled", newValue, mirrorGlobal: true)
        }
        .onChange(of: syncMode) { _, newValue in
            preferences.setString("playbackSyncMode", newValue, mirrorGlobal: true)
        }
        .onChange(of: allowsCellular) { _, newValue in
            preferences.setBool("allowsCellularDownloads", newValue)
            OfflineDownloads.allowsCellularAccess = newValue
        }
        .onAppear(perform: loadPreferences)
        .task {
            playback.setFragmentCacheLimit(Int64(limitMB) * 1_048_576)
            playback.preferredBitrateKbps = Int(playbackQuality)
            await refresh()
            await offline.refresh()
        }
        .onChange(of: offline.items) { _, _ in
            Task { await refresh() }
        }
    }

    private func loadPreferences() {
        let stored = preferences
        limitMB = stored.cacheLimitMB
        theme = stored.string("appearanceTheme", default: ThemeChoice.system.rawValue)
        playerStyle = stored.string("playerStyle", default: PlayerStyle.cover.rawValue)
        songListSize = stored.string("songListSize", default: SongListSize.medium.rawValue)
        hapticsEnabled = stored.bool("hapticsEnabled", default: true)
        playbackQuality = stored.qualityRaw
        syncMode = stored.string("playbackSyncMode", default: "ask")
        allowsCellular = stored.allowsCellularDownloads
        stored.applyMirrors()
    }

    private func refresh() async {
        cacheBytes = await playback.fragmentCacheStats()?.totalBytes ?? 0
    }

    private func byteText(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

private struct OfflineItemRow: View {
    let item: OfflineDownloads.Item

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.title)
                .lineLimit(1)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var subtitle: String {
        if item.isCompleted {
            return
                "\(item.artist) · \(ByteCountFormatter.string(fromByteCount: item.sizeBytes, countStyle: .file))"
        }
        if item.isDownloading {
            if item.expectedBytes > 0 {
                let percent = Int(Double(item.receivedBytes) / Double(item.expectedBytes) * 100)
                return "下载中 \(percent)%"
            }
            return "下载中…"
        }
        return "下载失败，可再次长按重试"
    }
}
