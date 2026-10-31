import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
@Observable
final class MacFavorites {
  private(set) var ids: Set<String> = []
  private let client: WildstringClient

  init(client: WildstringClient) {
    self.client = client
  }

  func load() async {
    if let loaded = try? await client.favoriteIDs() {
      ids = loaded
    }
  }

  func isFavorite(_ trackID: String) -> Bool {
    ids.contains(trackID)
  }

  func toggle(_ trackID: String) async {
    let loved = !ids.contains(trackID)
    if loved {
      ids.insert(trackID)
    } else {
      ids.remove(trackID)
    }
    do {
      try await client.setFavorite(trackID: trackID, loved: loved)
    } catch {
      if loved {
        ids.remove(trackID)
      } else {
        ids.insert(trackID)
      }
    }
  }
}

@MainActor
enum MacPlayback {
  static func item(_ track: Track) -> PlaybackService.Item {
    PlaybackService.Item(
      trackID: track.id,
      title: track.title,
      artist: track.artists.joined(separator: " / "),
      album: track.album,
      hasCover: track.hasCover,
      streamPath: "api/v1/tracks/\(track.id)/stream"
    )
  }

  static func play(_ tracks: [Track], startingAt track: Track, playback: PlaybackService) {
    guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
    playback.play(items: tracks.map(item), startingAt: index)
  }
}

struct MacPlayableTracks: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let tracks: [Track]
  var emptyTitle: String
  var emptyDetail: String?
  var emptyIcon: String = "music.note"
  var canManage = false
  var playlist: Playlist?
  var onReload: (@MainActor () async -> Void)?
  var isLoading = false
  var allowsSelection = false
  var onRecommendationFeedback: ((Track, String) async -> Void)?
  @Environment(\.navigateToTrackCollection) private var navigate

  @State private var selecting = false
  @State private var selected: Set<String> = []
  @State private var playlistSelection: MacPlaylistSelection?
  @State private var lyricTrack: Track?
  @State private var editing: Track?
  @State private var notice: String?

  var body: some View {
    GeometryReader { geometry in
      let wide = geometry.size.width >= 820
      let artistWidth = (geometry.size.width - 32) * 0.22
      let albumWidth = (geometry.size.width - 32) * 0.25
      VStack(spacing: 0) {
        if wide {
          HStack(spacing: 16) {
            if selecting { Color.clear.frame(width: 20, height: 1) }
            Text("歌曲").padding(.leading, 50).frame(maxWidth: .infinity, alignment: .leading)
            Text("艺人").frame(width: artistWidth, alignment: .leading)
            Text("专辑").frame(width: albumWidth, alignment: .leading)
            Color.clear.frame(width: 36, height: 1)
            Text("时长").frame(width: 48, alignment: .trailing)
            Color.clear.frame(width: 28, height: 1)
          }
          .font(.caption.weight(.medium)).foregroundStyle(.secondary)
          .padding(.horizontal, 16).padding(.vertical, 10)
          .background(.bar)
          Divider()
        }
        List(tracks) { track in
          HStack(spacing: 16) {
            if selecting {
              Toggle("选择 \(track.title)", isOn: Binding(
                get: { selected.contains(track.id) },
                set: { if $0 { selected.insert(track.id) } else { selected.remove(track.id) } }
              )).toggleStyle(.checkbox).labelsHidden().frame(width: 20)
            }
            HStack(spacing: 10) {
              Button {
                if selecting {
                  if selected.contains(track.id) { selected.remove(track.id) }
                  else { selected.insert(track.id) }
                } else {
                  MacPlayback.play(tracks, startingAt: track, playback: playback)
                }
              } label: {
                MacCover(client: client, trackID: track.hasCover ? track.id : nil, side: 40)
              }.buttonStyle(.plain).help("播放 \(track.title)")
              VStack(alignment: .leading, spacing: 4) {
                Button {
                  if selecting {
                    if selected.contains(track.id) { selected.remove(track.id) }
                    else { selected.insert(track.id) }
                  } else {
                    MacPlayback.play(tracks, startingAt: track, playback: playback)
                  }
                } label: {
                  Text(track.title)
                    .fontWeight(playback.currentItem?.trackID == track.id ? .semibold : .regular)
                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
                if !wide {
                  HStack(spacing: 5) {
                    artistLink(track)
                    if track.albumId != nil {
                      Text("·").foregroundStyle(.tertiary)
                      albumLink(track)
                    }
                  }.font(.caption)
                }
              }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if wide {
              artistLink(track).frame(width: artistWidth, alignment: .leading)
              albumLink(track).frame(width: albumWidth, alignment: .leading)
            }
            HStack(spacing: 5) {
              if favorites?.isFavorite(track.id) == true { Image(systemName: "heart.fill") }
              if playback.currentItem?.trackID == track.id {
                Image(systemName: playback.isPlaying ? "speaker.wave.2.fill" : "pause.fill")
              }
            }.font(.caption).foregroundStyle(MacTheme.accentDeep).frame(width: 36)
            Text(macClock(milliseconds: track.durationMs))
              .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
              .frame(width: 48, alignment: .trailing)
            Menu { trackMenu(track) } label: {
              Image(systemName: "ellipsis").frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("\(track.title)的更多操作").help("\(track.title)的更多操作")
          }
          .contextMenu { trackMenu(track) }
          .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
          .listRowBackground(playback.currentItem?.trackID == track.id ? MacTheme.accent.opacity(0.12) : Color.clear)
        }.listStyle(.plain)
      }
    }
    .overlay {
      if tracks.isEmpty {
        if isLoading {
          ProgressView()
        } else if let emptyDetail {
          ContentUnavailableView(emptyTitle, systemImage: emptyIcon, description: Text(emptyDetail))
        } else {
          ContentUnavailableView(emptyTitle, systemImage: emptyIcon)
        }
      }
    }
    .overlay(alignment: .bottom) {
      if let notice {
        Text(notice)
          .font(.callout)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(.regularMaterial, in: Capsule())
          .padding(.bottom, 12)
      }
    }
    .sheet(item: $editing) { track in
      MacMetadataSheet(client: client, track: track)
    }
    .sheet(item: $playlistSelection) { selection in
      MacAddToPlaylistSheet(client: client, tracks: selection.tracks) { message in
        notice = message
        selected = []
        selecting = false
        scheduleNoticeClear()
      }
    }
    .sheet(item: $lyricTrack) { track in MacLyricsPreview(client: client, track: track) }
    .safeAreaInset(edge: .top, spacing: 0) {
      if allowsSelection {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(selecting ? "已选 \(selectedTracks.count) 首" : "挑几首，放进自己的播放队列")
              .font(.callout).foregroundStyle(.secondary)
            Spacer()
            Button(selecting ? "完成挑选" : "挑选歌曲") {
              selecting.toggle()
              selected = []
            }
            .disabled(tracks.isEmpty && !selecting)
          }
          if selecting {
            HStack {
              Button(selectedTracks.count == tracks.count ? "取消全选" : "全选") {
                selected = selectedTracks.count == tracks.count ? [] : Set(tracks.map(\.id))
              }
              Button("下一首播放所选") { enqueue(selectedTracks, next: true) }.disabled(
                selectedTracks.isEmpty)
              Button("加入播放队列") { enqueue(selectedTracks) }.disabled(selectedTracks.isEmpty)
              Button("加入歌单…") { playlistSelection = MacPlaylistSelection(tracks: selectedTracks) }
                .disabled(selectedTracks.isEmpty)
            }.controlSize(.small)
          }
        }.padding(12).background(.bar)
      }
    }
    .onChange(of: tracks.map(\.id)) { _, ids in selected.formIntersection(Set(ids)) }
  }

  @ViewBuilder
  private func artistLink(_ track: Track) -> some View {
    if track.artists.count == 1, let name = track.artists.first {
      Button { navigate(.artist(name: name)) } label: {
        Text(name).lineLimit(1)
      }.buttonStyle(.plain).foregroundStyle(.secondary).help("查看艺人：\(name)")
    } else if track.artists.count > 1 {
      Menu {
        ForEach(track.artists, id: \.self) { name in
          Button(name) { navigate(.artist(name: name)) }
        }
      } label: {
        Text(track.artists.joined(separator: " / ")).lineLimit(1)
      }.menuStyle(.borderlessButton).menuIndicator(.hidden)
        .foregroundStyle(.secondary).help("选择艺人")
    } else {
      Text("—").foregroundStyle(.secondary)
    }
  }

  @ViewBuilder
  private func albumLink(_ track: Track) -> some View {
    if let id = track.albumId, let title = track.album {
      Button { navigate(.album(id: id, title: title)) } label: {
        Text(title).lineLimit(1)
      }.buttonStyle(.plain).foregroundStyle(.secondary).help("查看专辑：\(title)")
    } else {
      Text(track.album ?? "—").lineLimit(1).foregroundStyle(.secondary)
    }
  }

  private var selectedTracks: [Track] { tracks.filter { selected.contains($0.id) } }

  private func enqueue(_ tracks: [Track], next: Bool = false) {
    if playback.enqueue(items: tracks.map(MacPlayback.item), next: next) {
      notice = "已将 \(tracks.count) 首\(next ? "安排为接下来播放" : "加入播放队列")"
      selected = []
      selecting = false
    } else {
      notice = playback.errorMessage
    }
    scheduleNoticeClear()
  }

  @ViewBuilder
  private func trackMenu(_ track: Track) -> some View {
    Button("下一首播放") { enqueue([track], next: true) }
    Button("加入播放队列") { enqueue([track]) }
    Button("加入歌单…") { playlistSelection = MacPlaylistSelection(tracks: [track]) }
    Button("查看歌词") { lyricTrack = track }
    if let id = track.albumId, let title = track.album {
      Button("查看专辑") { navigate(.album(id: id, title: title)) }
    }
    ForEach(track.artists, id: \.self) { name in
      Button("查看艺人：\(name)") { navigate(.artist(name: name)) }
    }
    Divider()
    if let favorites {
      Button(favorites.isFavorite(track.id) ? "取消红心" : "红心") {
        Task { await favorites.toggle(track.id) }
      }
    }
    if let playlist, playlist.isEditable {
      Button("从歌单移除", role: .destructive) {
        Task { await remove(track, from: playlist) }
      }
    }
    if canManage {
      Button("编辑歌曲信息") { editing = track }
    }
    if let onRecommendationFeedback {
      Divider()
      Button("不感兴趣") { Task { await onRecommendationFeedback(track, "dismiss_track") } }
      Button("少推荐此艺人") { Task { await onRecommendationFeedback(track, "less_artist") } }
    }
  }

  private func remove(_ track: Track, from playlist: Playlist) async {
    do {
      let fresh = try await client.playlist(id: playlist.id)
      try await client.removeTrack(playlistID: fresh.id, trackID: track.id, version: fresh.version)
      notice = "已从「\(fresh.name)」移除"
      await onReload?()
    } catch {
      notice = MacErrorText.message(for: error)
    }
    scheduleNoticeClear()
  }

  private func scheduleNoticeClear() {
    Task {
      try? await Task.sleep(for: .seconds(2))
      notice = nil
    }
  }
}

struct MacAlbumsView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var query = ""
  @State private var albums: [Album] = []
  @State private var total = 0
  @State private var message: String?
  @State private var loading = true

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 168, maximum: 210), spacing: 18)]
  }

  var body: some View {
    ScrollView {
      LazyVGrid(columns: columns, spacing: 22) {
        ForEach(albums) { album in
          MacCatalogCard(
            client: client,
            value: album,
            title: album.title,
            subtitle: album.artists.joined(separator: " / "),
            cover: album.coverTrackId
          )
        }
      }
      .padding(24)
      if albums.count < total {
        Button("还有 \(total - albums.count) 张专辑") { Task { await load(reset: false) } }
          .buttonStyle(.bordered)
          .padding(.bottom, 24)
      }
    }
    .navigationTitle("专辑")
    .searchable(text: $query, prompt: "搜索专辑")
    .navigationDestination(for: Album.self) { album in
      MacAlbumDetail(
        client: client,
        playback: playback,
        favorites: favorites,
        album: album,
        canManage: canManage
      )
    }
    .overlay {
      if albums.isEmpty {
        if loading {
          ProgressView()
        } else if let message {
          ContentUnavailableView("无法加载专辑", systemImage: "square.stack", description: Text(message))
        } else {
          ContentUnavailableView("没有匹配的专辑", systemImage: "square.stack")
        }
      }
    }
    .task(id: query) { await load(reset: true) }
  }

  private func load(reset: Bool) async {
    if reset { loading = albums.isEmpty }
    do {
      let text = query.trimmingCharacters(in: .whitespaces)
      if reset, !text.isEmpty {
        try await Task.sleep(for: .milliseconds(280))
        guard !Task.isCancelled else { return }
      }
      let page = try await client.albums(
        limit: 100,
        offset: reset ? 0 : albums.count,
        query: text.isEmpty ? nil : text
      )
      guard !Task.isCancelled else { return }
      albums = reset ? page.items : albums + page.items
      total = page.total
      message = nil
    } catch is CancellationError {
      return
    } catch {
      if reset { albums = [] }
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

private struct MacAlbumDetail: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let album: Album
  var canManage = false

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    MacPlayableTracks(
      client: client,
      playback: playback,
      favorites: favorites,
      tracks: tracks,
      emptyTitle: message == nil ? "这张专辑还没有歌曲" : "无法加载专辑",
      emptyDetail: message,
      canManage: canManage,
      isLoading: loading
    )
    .navigationTitle(album.title)
    .safeAreaInset(edge: .top, spacing: 0) {
      MacCollectionHeading(
        title: album.title,
        subtitle: "\(album.trackCount) 首",
        symbol: "square.stack",
        canPlay: !tracks.isEmpty
      ) {
        guard let first = tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = true
    do {
      tracks = try await MacPages.albumTracks(client: client, albumId: album.id)
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacArtistsView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var query = ""
  @State private var artists: [Artist] = []
  @State private var total = 0
  @State private var message: String?
  @State private var loading = true
  @AppStorage("macArtistRole") private var role = "artist"

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 168, maximum: 210), spacing: 18)]
  }

  var body: some View {
    ScrollView {
      LazyVGrid(columns: columns, spacing: 22) {
        ForEach(artists) { artist in
          MacCatalogCard(
            client: client,
            value: artist,
            title: artist.name,
            subtitle: "\(artist.albumCount) 张专辑 · \(artist.trackCount) 首",
            cover: artist.coverTrackId
          )
        }
      }
      .padding(24)
      if artists.count < total {
        Button("还有 \(total - artists.count) 位艺人") { Task { await load(reset: false) } }
          .buttonStyle(.bordered)
          .padding(.bottom, 24)
      }
    }
    .navigationTitle("艺人")
    .toolbar {
      Picker("参与角色", selection: $role) {
        Text("歌曲艺人").tag("artist")
        Text("专辑艺人").tag("album_artist")
        Text("全部角色").tag("")
        Divider()
        Text("演唱").tag("vocalist")
        Text("作词").tag("lyricist")
        Text("作曲").tag("composer")
        Text("编曲").tag("arranger")
      }.pickerStyle(.menu).help("按在歌曲中的参与角色筛选艺人")
    }
    .searchable(text: $query, prompt: "搜索艺人")
    .navigationDestination(for: Artist.self) { artist in
      MacArtistDetail(
        client: client,
        playback: playback,
        favorites: favorites,
        artist: artist,
        canManage: canManage
      )
    }
    .overlay {
      if artists.isEmpty {
        if loading {
          ProgressView()
        } else if let message {
          ContentUnavailableView("无法加载艺人", systemImage: "person.2", description: Text(message))
        } else {
          ContentUnavailableView("没有匹配的艺人", systemImage: "person.2")
        }
      }
    }
    .task(id: "\(role)|\(query)") { await load(reset: true) }
  }

  private func load(reset: Bool) async {
    if reset { loading = artists.isEmpty }
    do {
      let text = query.trimmingCharacters(in: .whitespaces)
      if reset, !text.isEmpty {
        try await Task.sleep(for: .milliseconds(280))
        guard !Task.isCancelled else { return }
      }
      let page = try await client.artists(
        limit: 100,
        offset: reset ? 0 : artists.count,
        query: text.isEmpty ? nil : text,
        role: role.isEmpty ? nil : role
      )
      guard !Task.isCancelled else { return }
      artists = reset ? page.items : artists + page.items
      total = page.total
      message = nil
    } catch is CancellationError {
      return
    } catch {
      if reset { artists = [] }
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

private struct MacArtistDetail: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let artist: Artist
  var canManage = false

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    MacPlayableTracks(
      client: client,
      playback: playback,
      favorites: favorites,
      tracks: tracks,
      emptyTitle: message == nil ? "这个艺人还没有歌曲" : "无法加载艺人",
      emptyDetail: message,
      canManage: canManage,
      isLoading: loading
    )
    .navigationTitle(artist.name)
    .safeAreaInset(edge: .top, spacing: 0) {
      MacCollectionHeading(
        title: artist.name,
        subtitle: "\(artist.trackCount) 首",
        symbol: "person.2",
        canPlay: !tracks.isEmpty
      ) {
        guard let first = tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = true
    do {
      tracks = try await MacPages.artistTracks(client: client, artistId: artist.id)
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacPlaylistsView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var playlists: [Playlist] = []
  @State private var message: String?
  @State private var failure: String?
  @State private var newName = ""
  @State private var creating = false
  @State private var renaming: Playlist?
  @State private var renameText = ""
  @State private var loading = true

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: 168, maximum: 210), spacing: 18)]
  }

  private var manuals: [Playlist] { playlists.filter { !$0.isFavorites } }

  var body: some View {
    ScrollView {
      LazyVGrid(columns: columns, spacing: 22) {
        ForEach(manuals) { playlist in
          MacCatalogCard(
            client: client,
            value: playlist,
            title: playlist.name,
            subtitle: "\(playlist.trackCount) 首",
            cover: playlist.coverTrackId
          )
          .contextMenu {
            if playlist.isEditable {
              Button("重命名") {
                renameText = playlist.name
                renaming = playlist
              }
              Button("删除", role: .destructive) { Task { await delete(playlist) } }
            }
          }
        }
      }
      .padding(24)
    }
    .navigationTitle("歌单")
    .toolbar {
      Button("新建歌单") { creating = true }
    }
    .navigationDestination(for: Playlist.self) { playlist in
      MacPlaylistDetail(
        client: client,
        playback: playback,
        favorites: favorites,
        playlist: playlist,
        canManage: canManage
      )
    }
    .overlay {
      if manuals.isEmpty {
        if loading {
          ProgressView()
        } else if let message {
          ContentUnavailableView(
            "无法加载歌单", systemImage: "music.note.list", description: Text(message))
        } else {
          ContentUnavailableView("还没有自己的歌单", systemImage: "music.note.list")
        }
      }
    }
    .alert("新建歌单", isPresented: $creating) {
      TextField("名称", text: $newName)
      Button("创建") { Task { await create() } }
      Button("取消", role: .cancel) { newName = "" }
    }
    .alert(
      "重命名歌单",
      isPresented: Binding(
        get: { renaming != nil },
        set: { if !$0 { renaming = nil } }
      )
    ) {
      TextField("名称", text: $renameText)
      Button("保存") { Task { await rename() } }
      Button("取消", role: .cancel) { renaming = nil }
    }
    .alert(
      "没有完成",
      isPresented: Binding(
        get: { failure != nil },
        set: { if !$0 { failure = nil } }
      )
    ) {
      Button("好") { failure = nil }
    } message: {
      Text(failure ?? "")
    }
    .task { await load() }
  }

  private func load() async {
    loading = playlists.isEmpty
    do {
      playlists = try await MacPages.playlists(client: client)
      message = nil
    } catch {
      message = MacErrorText.message(for: error)
    }
    loading = false
  }

  private func create() async {
    let name = newName.trimmingCharacters(in: .whitespaces)
    newName = ""
    guard !name.isEmpty else { return }
    do {
      _ = try await client.createPlaylist(name: name)
      await load()
    } catch {
      failure = MacErrorText.message(for: error)
    }
  }

  private func rename() async {
    guard let playlist = renaming else { return }
    renaming = nil
    let name = renameText.trimmingCharacters(in: .whitespaces)
    guard !name.isEmpty else { return }
    do {
      let fresh = try await client.playlist(id: playlist.id)
      _ = try await client.renamePlaylist(
        id: fresh.id, name: name, version: fresh.version, kind: fresh.kind)
      await load()
    } catch {
      failure = MacErrorText.message(for: error)
    }
  }

  private func delete(_ playlist: Playlist) async {
    do {
      let fresh = try await client.playlist(id: playlist.id)
      try await client.deletePlaylist(playlistID: fresh.id, version: fresh.version)
      await load()
    } catch {
      failure = MacErrorText.message(for: error)
    }
  }
}

private struct MacPlaylistDetail: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  let playlist: Playlist
  var canManage = false

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    MacPlayableTracks(
      client: client,
      playback: playback,
      favorites: favorites,
      tracks: tracks,
      emptyTitle: message == nil ? "这个歌单还是空的" : "无法加载歌单",
      emptyDetail: message,
      canManage: canManage,
      playlist: playlist,
      onReload: { await load() },
      isLoading: loading
    )
    .navigationTitle(playlist.name)
    .safeAreaInset(edge: .top, spacing: 0) {
      MacCollectionHeading(
        title: playlist.name,
        subtitle: "\(tracks.count) 首",
        symbol: "music.note.list",
        canPlay: !tracks.isEmpty
      ) {
        guard let first = tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
    do {
      tracks = try await MacPages.playlistTracks(client: client, playlistID: playlist.id)
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacFavoritesView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    MacPlayableTracks(
      client: client,
      playback: playback,
      favorites: favorites,
      tracks: tracks,
      emptyTitle: message == nil ? "还没有红心歌曲" : "无法加载红心",
      emptyDetail: message,
      emptyIcon: "heart",
      canManage: canManage,
      isLoading: loading
    )
    .navigationTitle("我喜欢")
    .safeAreaInset(edge: .top, spacing: 0) {
      MacCollectionHeading(
        title: "我喜欢",
        subtitle: loading && tracks.isEmpty ? "正在读取" : "\(tracks.count) 首",
        symbol: "heart.fill",
        canPlay: !tracks.isEmpty
      ) {
        guard let first = tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = true
    do {
      guard let playlist = try await MacPages.favoritesPlaylist(client: client) else {
        message = "服务器上还没有「我喜欢」歌单"
        tracks = []
        loading = false
        return
      }
      tracks = try await MacPages.playlistTracks(client: client, playlistID: playlist.id)
      message = nil
      await favorites?.load()
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacListeningView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?
  var canManage = false

  @State private var tracks: [Track] = []
  @State private var message: String?
  @State private var loading = true

  var body: some View {
    MacPlayableTracks(
      client: client,
      playback: playback,
      favorites: favorites,
      tracks: tracks,
      emptyTitle: message == nil ? "还没有收听记录" : "无法加载收听记录",
      emptyDetail: message,
      emptyIcon: "clock",
      canManage: canManage,
      isLoading: loading
    )
    .navigationTitle("收听记录")
    .task { await load() }
  }

  private func load() async {
    loading = true
    do {
      tracks = try await MacPages.collect { offset in
        try await client.tracks(
          limit: 200,
          offset: offset,
          sort: .lastPlayed,
          order: .desc,
          playedOnly: true
        )
      }
      message = nil
    } catch {
      tracks = []
      message = MacErrorText.message(for: error)
    }
    loading = false
  }
}

struct MacNotificationsView: View {
  let client: WildstringClient

  @State private var page: NotificationPage?
  @State private var message: String?

  var body: some View {
    List {
      if let page {
        Section {
          Button("全部标为已读") {
            Task { await markAll(page.highWatermark) }
          }
          .disabled(page.unreadCount == 0)
        }
        ForEach(page.items) { item in
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Text(item.title).font(.headline)
              if item.isUnread {
                Text("未读").font(.caption).foregroundStyle(.orange)
              }
            }
            Text(item.summary)
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          .task {
            if item.isUnread {
              try? await client.markNotificationsRead(ids: [item.id])
            }
          }
        }
      }
    }
    .navigationTitle("通知")
    .overlay {
      if page == nil, let message {
        ContentUnavailableView("无法加载通知", systemImage: "bell", description: Text(message))
      } else if page?.items.isEmpty == true {
        ContentUnavailableView("没有通知", systemImage: "bell")
      }
    }
    .task { await load() }
  }

  private func load() async {
    do {
      page = try await client.notifications()
      message = nil
    } catch {
      message = "通知暂时无法加载"
    }
  }

  private func markAll(_ watermark: Int) async {
    try? await client.markAllNotificationsRead(highWatermark: watermark)
    await load()
  }
}
