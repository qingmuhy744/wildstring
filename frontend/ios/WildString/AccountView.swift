import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct AccountView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let server: String
    let username: String
    let onLogout: () -> Void

    @State private var playlists: [Playlist] = []
    @State private var path = NavigationPath()
    @State private var isLoading = true
    @State private var message: String?
    @State private var showingCreate = false
    @State private var newName = ""
    @State private var renaming: Playlist?
    @State private var renameText = ""
    @State private var deleting: Playlist?
    @State private var unreadNotifications = 0

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section("音乐") {
                    NavigationLink {
                        FavoritesView(client: client, playback: playback)
                    } label: {
                        Label("我喜欢的音乐", systemImage: "heart.fill")
                            .foregroundStyle(.pink)
                    }
                }
                Section("歌单") {
                    ForEach(playlists) { playlist in
                        NavigationLink(value: playlist) {
                            PlaylistListRow(client: client, playlist: playlist)
                        }
                        .contextMenu {
                            if playlist.isEditable {
                                Button {
                                    renameText = playlist.name
                                    renaming = playlist
                                } label: {
                                    Label("重命名", systemImage: "pencil")
                                }
                                Button(role: .destructive) {
                                    deleting = playlist
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                        }
                    }
                    if isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    }
                    Button {
                        newName = ""
                        showingCreate = true
                    } label: {
                        Label("新建歌单", systemImage: "plus")
                    }
                }
                if let message {
                    Section {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                Section("动态") {
                    NavigationLink {
                        NotificationsView(client: client)
                    } label: {
                        HStack {
                            Label("通知", systemImage: "bell")
                            Spacer()
                            if unreadNotifications > 0 {
                                Text("\(unreadNotifications)")
                                    .font(.caption2.bold())
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.wildAccent, in: Capsule())
                            }
                        }
                    }
                }
                Section("账号") {
                    LabeledContent("用户名", value: username)
                    LabeledContent("服务器", value: server)
                }
                Section {
                    NavigationLink(value: SettingsMarker()) {
                        Label("设置", systemImage: "gearshape")
                    }
                    Button("退出登录", role: .destructive, action: onLogout)
                }
            }
            .navigationTitle("我的")
            .navigationDestination(for: Playlist.self) { playlist in
                PlaylistDetailView(client: client, playback: playback, playlist: playlist)
            }
            .navigationDestination(for: SettingsMarker.self) { _ in
                SettingsView(playback: playback, client: client)
            }
            .navigationDestination(for: AdminDestination.self) { destination in
                switch destination {
                case .scans:
                    ScansView(client: client)
                case .imports:
                    ImportsView(client: client)
                }
            }
            .miniPlayer(playback, client: client)
            .task {
                await load()
                unreadNotifications =
                    (try? await client.notifications(limit: 1))?.unreadCount ?? 0
            }
            .refreshable { await load() }
            .alert("新建歌单", isPresented: $showingCreate) {
                TextField("歌单名称", text: $newName)
                Button("创建") { Task { await create() } }
                Button("取消", role: .cancel) {}
            }
            .alert("重命名歌单", isPresented: renamingActive) {
                TextField("歌单名称", text: $renameText)
                Button("保存") { Task { await rename() } }
                Button("取消", role: .cancel) {}
            }
            .confirmationDialog(
                "删除「\(deleting?.name ?? "")」？",
                isPresented: deletingActive,
                titleVisibility: .visible
            ) {
                Button("删除", role: .destructive) { Task { await delete() } }
                Button("取消", role: .cancel) {}
            }
        }
    }

    private var renamingActive: Binding<Bool> {
        Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )
    }

    private var deletingActive: Binding<Bool> {
        Binding(
            get: { deleting != nil },
            set: { if !$0 { deleting = nil } }
        )
    }

    private func load() async {
        do {
            let page = try await client.playlists()
            playlists = page.items
            isLoading = false
            message = nil
            openDemoPlaylistIfNeeded()
        } catch {
            isLoading = false
            message = ErrorText.message(for: error)
        }
    }

    private func openDemoPlaylistIfNeeded() {
        #if DEBUG
            guard path.isEmpty else { return }
            let environment = ProcessInfo.processInfo.environment
            if environment["WILDSTRING_DEMO_OPEN_SETTINGS"] == "1" {
                path.append(SettingsMarker())
                return
            }
            if environment["WILDSTRING_DEMO_OPEN_SCANS"] == "1" {
                path.append(SettingsMarker())
                path.append(AdminDestination.scans)
                return
            }
            guard environment["WILDSTRING_DEMO_OPEN_PLAYLIST"] == "1",
                let first = playlists.first(where: \.isEditable)
            else { return }
            path.append(first)
        #endif
    }

    private func create() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        do {
            _ = try await client.createPlaylist(name: name)
            await load()
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func rename() async {
        guard let target = renaming else { return }
        let name = renameText.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        do {
            let fresh = try await client.playlist(id: target.id)
            _ = try await client.renamePlaylist(
                id: fresh.id,
                name: name,
                version: fresh.version,
                kind: fresh.kind
            )
            await load()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = "歌单已更新，已刷新列表，请重试"
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func delete() async {
        guard let target = deleting else { return }
        do {
            let fresh = try await client.playlist(id: target.id)
            try await client.deletePlaylist(playlistID: fresh.id, version: fresh.version)
            await load()
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = "歌单已更新，已刷新列表，请重试"
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}

private struct SettingsMarker: Hashable {}

private struct PlaylistListRow: View {
    let client: WildstringClient
    let playlist: Playlist

    var body: some View {
        HStack(spacing: 10) {
            CoverImage(
                client: client,
                trackID: playlist.coverTrackId,
                size: 40
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(playlist.name)
                    .lineLimit(1)
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var meta: String {
        var parts = ["\(playlist.trackCount) 首"]
        if playlist.isSmart {
            parts.append("规则")
        }
        return parts.joined(separator: " · ")
    }
}
