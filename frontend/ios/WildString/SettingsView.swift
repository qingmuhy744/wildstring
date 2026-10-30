import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct SettingsView: View {
    let playback: PlaybackService
    let client: WildstringClient

    @Environment(OfflineModel.self) private var offline
    @Environment(\.isAdmin) private var isAdmin
    @AppStorage("fragmentCacheLimitMB") private var limitMB = 512
    @AppStorage("appearanceTheme") private var theme = ThemeChoice.system.rawValue
    @AppStorage("playerStyle") private var playerStyle = PlayerStyle.cover.rawValue
    @AppStorage("songListSize") private var songListSize = SongListSize.medium.rawValue
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true
    @AppStorage("playbackQuality") private var playbackQuality = "original"
    @AppStorage("playbackSyncMode") private var syncMode = "ask"
    @AppStorage(InterfaceLanguage.storageKey) private var language = InterfaceLanguage.auto.rawValue
    @State private var savingLanguage = false
    @State private var languageError = false
    @State private var cacheBytes: Int64 = 0
    @State private var showingReview = false

    var body: some View {
        List {
            if isAdmin {
                Section("settings.admin") {
                    Button {
                        showingReview = true
                    } label: {
                        Label("settings.admin.review", systemImage: "checklist")
                    }
                    NavigationLink {
                        ApplicationPolicyView(client: client)
                    } label: {
                        Label("settings.admin.policy", systemImage: "wand.and.stars")
                    }
                    NavigationLink(value: AdminDestination.scans) {
                        Label("settings.admin.scans", systemImage: "arrow.triangle.2.circlepath")
                    }
                    NavigationLink(value: AdminDestination.imports) {
                        Label("settings.admin.imports", systemImage: "tray.and.arrow.down")
                    }
                }
                .sheet(isPresented: $showingReview) {
                    MetadataReviewView(client: client)
                }
            }
            Section("settings.appearance") {
                Picker("settings.language", selection: languageBinding) {
                    ForEach(InterfaceLanguage.allCases, id: \.self) { choice in
                        Text(choice.label).tag(choice.rawValue)
                    }
                }
                .disabled(savingLanguage)
                Text(languageError ? LocalizedStringKey("settings.language.failed") : LocalizedStringKey("settings.language.hint"))
                    .font(.footnote)
                    .foregroundStyle(languageError ? Color.red : Color.secondary)
                Picker("settings.theme", selection: $theme) {
                    ForEach(ThemeChoice.allCases, id: \.self) { choice in
                        Text(choice.label).tag(choice.rawValue)
                    }
                }
                Picker("settings.playerStyle", selection: $playerStyle) {
                    ForEach(PlayerStyle.allCases, id: \.self) { style in
                        Text(style.label).tag(style.rawValue)
                    }
                }
                Picker("settings.songListSize", selection: $songListSize) {
                    ForEach(SongListSize.allCases, id: \.self) { size in
                        Text(size.label).tag(size.rawValue)
                    }
                }
                Toggle("settings.haptics", isOn: $hapticsEnabled)
            }
            Section("settings.playback") {
                Picker("settings.quality", selection: $playbackQuality) {
                    Text("settings.quality.original").tag("original")
                    Text("AAC 128 kbps").tag("128")
                    Text("AAC 192 kbps").tag("192")
                    Text("AAC 256 kbps").tag("256")
                    Text("AAC 320 kbps").tag("320")
                }
                Text("settings.quality.hint")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Picker("settings.handoff", selection: $syncMode) {
                    Text("settings.off").tag("off")
                    Text("settings.handoff.ask").tag("ask")
                    Text("settings.handoff.auto").tag("auto")
                }
                if syncMode != "off" {
                    Text("settings.handoff.hint")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section("settings.fragmentCache") {
                LabeledContent("settings.cache.used", value: byteText(cacheBytes))
                Picker("settings.cache.limit", selection: $limitMB) {
                    Text("settings.off").tag(0)
                    Text("128 MB").tag(128)
                    Text("256 MB").tag(256)
                    Text("512 MB").tag(512)
                    Text("1 GB").tag(1024)
                    Text("2 GB").tag(2048)
                }
                Button("settings.cache.clear") {
                    Task {
                        await playback.clearFragmentCache()
                        await refresh()
                    }
                }
                .disabled(cacheBytes == 0)
            }
            Section("settings.offline") {
                LabeledContent("settings.offline.downloaded") {
                    Text("settings.offline.songs \(offline.stats.count)")
                }
                LabeledContent("settings.offline.size", value: byteText(offline.stats.totalBytes))
                if offline.items.isEmpty {
                    Text("settings.offline.empty")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(offline.items) { item in
                        OfflineItemRow(item: item)
                            .swipeActions(edge: .trailing) {
                                Button("settings.offline.delete", role: .destructive) {
                                    Task { await offline.remove(trackID: item.trackID) }
                                }
                            }
                    }
                }
                Button("settings.offline.clearAll", role: .destructive) {
                    Task { await offline.clearAll() }
                }
                .disabled(offline.items.isEmpty)
            }
        }
        .navigationTitle("settings.title")
        .onChange(of: limitMB) { _, newValue in
            playback.setFragmentCacheLimit(Int64(newValue) * 1_048_576)
        }
        .onChange(of: playbackQuality) { _, newValue in
            playback.preferredBitrateKbps = Int(newValue)
        }
        .task {
            playback.setFragmentCacheLimit(Int64(limitMB) * 1_048_576)
            playback.preferredBitrateKbps = Int(playbackQuality)
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

    /// Applies the choice right away, saves it on the account, and reverts if saving fails.
    private var languageBinding: Binding<String> {
        Binding(
            get: { language },
            set: { next in
                guard next != language, !savingLanguage else { return }
                let previous = language
                language = next
                languageError = false
                savingLanguage = true
                Task {
                    defer { savingLanguage = false }
                    do {
                        let user = try await client.updateLanguage(next)
                        InterfaceLanguage.store(user.language)
                        language = InterfaceLanguage(preference: user.language).rawValue
                    } catch {
                        language = previous
                        languageError = true
                    }
                }
            }
        )
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
                return String(localized: "settings.offline.downloading \(percent)")
            }
            return String(localized: "settings.offline.downloadingIndeterminate")
        }
        return String(localized: "settings.offline.failed")
    }
}
