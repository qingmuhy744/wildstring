import CorePlayback
import SwiftUI

@MainActor
struct SettingsView: View {
    let playback: PlaybackService

    @Environment(OfflineModel.self) private var offline
    @Environment(\.isAdmin) private var isAdmin
    @AppStorage("fragmentCacheLimitMB") private var limitMB = 512
    @AppStorage("appearanceTheme") private var theme = ThemeChoice.system.rawValue
    @AppStorage("playerStyle") private var playerStyle = PlayerStyle.cover.rawValue
    @AppStorage("songListSize") private var songListSize = SongListSize.medium.rawValue
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    @State private var cacheBytes: Int64 = 0

    var body: some View {
        List {
            if isAdmin {
                Section("管理员") {
                    NavigationLink(value: AdminDestination.scans) {
                        Label("扫描任务", systemImage: "arrow.triangle.2.circlepath")
                    }
                    NavigationLink(value: AdminDestination.imports) {
                        Label("导入记录", systemImage: "tray.and.arrow.down")
                    }
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
            }
        }
        .navigationTitle("设置")
        .onChange(of: limitMB) { _, newValue in
            playback.setFragmentCacheLimit(Int64(newValue) * 1_048_576)
        }
        .task {
            playback.setFragmentCacheLimit(Int64(limitMB) * 1_048_576)
            await refresh()
            await offline.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { break }
                await refresh()
                await offline.refresh()
            }
        }
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
