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
      streamPath: "api/v1/tracks/\(track.id)/stream",
      unavailableReason: track.unavailableReason
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
  var externalSelecting: Binding<Bool>?
  var trackBadge: ((Track) -> String?)?
  var trackReason: ((Track) -> String?)?
  var onRecommendationFeedback: ((Track, String) async -> Void)?
  @Environment(\.navigateToTrackCollection) private var navigate

  @State private var selecting = false
  @State private var selected: Set<String> = []
  @State private var playlistSelection: MacPlaylistSelection?
  @State private var lyricTrack: Track?
  @State private var editing: Track?
  @State private var notice: String?
  @State private var hoveredTrackID: String?

  private var isSelecting: Bool {
    externalSelecting?.wrappedValue ?? selecting
  }

  private func setSelecting(_ value: Bool) {
    selecting = value
    externalSelecting?.wrappedValue = value
  }

  var body: some View {
    GeometryReader { geometry in
      let wide = geometry.size.width >= 680
      let artistWidth = (geometry.size.width - 36) * 0.21
      let albumWidth = (geometry.size.width - 36) * 0.24
      VStack(spacing: 0) {
        if wide {
          HStack(spacing: 16) {
            if isSelecting { Color.clear.frame(width: 18, height: 1) }
            Text("#").frame(width: 28, alignment: .trailing)
            Text("歌曲标题")
              .padding(.leading, 52)
              .frame(maxWidth: .infinity, alignment: .leading)
            Text("艺人").frame(width: artistWidth, alignment: .leading)
            Text("专辑").frame(width: albumWidth, alignment: .leading)
            Color.clear.frame(width: 32, height: 1)
            Text("时长").frame(width: 48, alignment: .trailing)
            Color.clear.frame(width: 26, height: 1)
          }
          .font(MacTheme.micro)
          .foregroundStyle(MacTheme.faint)
          .padding(.horizontal, 18)
          .padding(.vertical, 10)
          .overlay(alignment: .bottom) {
            Rectangle().fill(MacTheme.border).frame(height: 1)
          }
        }
        List {
          ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
            trackRow(
              track, number: index + 1, wide: wide,
              artistWidth: artistWidth, albumWidth: albumWidth
            )
            .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(MacTheme.canvas)
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
        setSelecting(false)
        scheduleNoticeClear()
      }
    }
    .sheet(item: $lyricTrack) { track in MacLyricsPreview(client: client, track: track) }
    .safeAreaInset(edge: .top, spacing: 0) {
      if allowsSelection && (isSelecting || externalSelecting == nil) {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(isSelecting ? "已选 \(selectedTracks.count) 首" : "挑几首，放进自己的播放队列")
              .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
            Spacer()
            if isSelecting {
              HStack(spacing: 8) {
                Button(selectedTracks.count == tracks.count ? "取消全选" : "全选") {
                  selected = selectedTracks.count == tracks.count ? [] : Set(tracks.map(\.id))
                }
                Button("下一首播放所选") { enqueue(selectedTracks, next: true) }
                  .disabled(selectedTracks.isEmpty)
                Button("加入播放队列") { enqueue(selectedTracks) }
                  .disabled(selectedTracks.isEmpty)
                Button("加入歌单…") { playlistSelection = MacPlaylistSelection(tracks: selectedTracks) }
                  .disabled(selectedTracks.isEmpty)
              }.controlSize(.small)
            }
            Button(isSelecting ? "完成挑选" : "挑选歌曲") {
              setSelecting(!isSelecting)
              selected = []
            }
            .controlSize(.small)
            .disabled(tracks.isEmpty && !isSelecting)
          }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 10)
        .background(MacTheme.panel)
        .overlay(alignment: .bottom) {
          Rectangle().fill(MacTheme.border).frame(height: 1)
        }
      }
    }
    .onChange(of: tracks.map(\.id)) { _, ids in selected.formIntersection(Set(ids)) }
  }

  private func trackRow(
    _ track: Track,
    number: Int,
    wide: Bool,
    artistWidth: CGFloat,
    albumWidth: CGFloat
  ) -> some View {
    let current = playback.currentItem?.trackID == track.id
    let numberText = trackBadge?(track) ?? String(format: "%02d", number)
    let reason = trackReason?(track)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let isHovered = hoveredTrackID == track.id
    return HStack(spacing: 16) {
      if isSelecting {
        Toggle("选择 \(track.title)", isOn: Binding(
          get: { selected.contains(track.id) },
          set: { if $0 { selected.insert(track.id) } else { selected.remove(track.id) } }
        )).toggleStyle(.checkbox).labelsHidden().frame(width: 18)
      }
      if wide {
        Text(numberText)
          .font(MacTheme.mono(12))
          .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.faint)
          .frame(width: 28, alignment: .trailing)
      } else if let badge = trackBadge?(track) {
        Text(badge)
          .font(MacTheme.mono(12))
          .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.faint)
          .frame(width: 28, alignment: .trailing)
      }
      HStack(spacing: 10) {
        Button {
          if isSelecting {
            if selected.contains(track.id) { selected.remove(track.id) }
            else { selected.insert(track.id) }
          } else {
            MacPlayback.play(tracks, startingAt: track, playback: playback)
          }
        } label: {
          MacCover(client: client, trackID: track.hasCover ? track.id : nil, side: 42)
        }
        .buttonStyle(.plain)
        .help("播放 \(track.title)")

        VStack(alignment: .leading, spacing: 3) {
          Button {
            if isSelecting {
              if selected.contains(track.id) { selected.remove(track.id) }
              else { selected.insert(track.id) }
            } else {
              MacPlayback.play(tracks, startingAt: track, playback: playback)
            }
          } label: {
            Text(track.title)
              .font(.system(size: 13, weight: current ? .semibold : .medium))
              .foregroundStyle(!track.isAvailable ? MacTheme.muted : current ? MacTheme.accentDeep : MacTheme.ink)
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)

          if let reason = track.unavailableReason {
            Label(reason, systemImage: "exclamationmark.circle")
              .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
              .help("恢复文件并重新扫描后，刷新列表重试")
          } else if current {
            Text(playback.isPlaying ? "正在播放" : "已暂停")
              .font(.system(size: 11))
              .foregroundStyle(MacTheme.accentDeep)
              .lineLimit(1)
          } else if !wide {
            HStack(spacing: 4) {
              artistLink(track)
              if track.albumId != nil || !(track.album ?? "").isEmpty {
                Text("·").foregroundStyle(MacTheme.faint)
                albumLink(track)
              }
            }
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            .lineLimit(1)
          }

          if let reason, !reason.isEmpty {
            Text(reason)
              .font(.system(size: 11))
              .foregroundStyle(MacTheme.olive)
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if wide {
        artistLink(track)
          .font(MacTheme.caption)
          .frame(width: artistWidth, alignment: .leading)
        albumLink(track)
          .font(MacTheme.caption)
          .frame(width: albumWidth, alignment: .leading)
      }

      HStack(spacing: 5) {
        if favorites?.isFavorite(track.id) == true {
          Image(systemName: "heart.fill")
        }
        if current {
          Image(systemName: playback.isPlaying ? "speaker.wave.2.fill" : "pause.fill")
        }
      }
      .font(.caption)
      .foregroundStyle(MacTheme.accentDeep)
      .frame(width: 32, alignment: .trailing)

      Text(macClock(milliseconds: track.durationMs))
        .font(MacTheme.mono())
        .foregroundStyle(current ? MacTheme.accentDeep : MacTheme.faint)
        .frame(width: 48, alignment: .trailing)

      Menu { trackMenu(track) } label: {
        Image(systemName: "ellipsis").frame(width: 26, height: 28).contentShape(Rectangle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("\(track.title)的更多操作")
      .help("\(track.title)的更多操作")
    }
    .padding(.vertical, 10)
    .background(
      current
        ? MacTheme.accent.opacity(0.10)
        : (isHovered ? MacTheme.panel.opacity(0.55) : Color.clear)
    )
    .overlay(alignment: .bottom) {
      Rectangle().fill(MacTheme.border.opacity(0.55)).frame(height: 1)
    }
    .overlay(alignment: .leading) {
      if current {
        Capsule()
          .fill(MacTheme.accent)
          .frame(width: 3)
          .padding(.vertical, 12)
      }
    }
    .onHover { hovering in
      guard !isSelecting else { return }
      if hovering {
        hoveredTrackID = track.id
      } else if hoveredTrackID == track.id {
        hoveredTrackID = nil
      }
    }
    .contextMenu { trackMenu(track) }
  }

  @ViewBuilder
  private func artistLink(_ track: Track) -> some View {
    if track.artists.count == 1, let name = track.artists.first {
      Button { navigate(.artist(name: name)) } label: {
        Text(name).lineLimit(1)
      }.buttonStyle(.plain).foregroundStyle(MacTheme.muted).help("查看艺人：\(name)")
    } else if track.artists.count > 1 {
      Menu {
        ForEach(track.artists, id: \.self) { name in
          Button(name) { navigate(.artist(name: name)) }
        }
      } label: {
        Text(track.artists.joined(separator: " / ")).lineLimit(1)
      }.menuStyle(.borderlessButton).menuIndicator(.hidden)
        .foregroundStyle(MacTheme.muted).help("选择艺人")
    } else {
      Text("—").foregroundStyle(MacTheme.faint)
    }
  }

  @ViewBuilder
  private func albumLink(_ track: Track) -> some View {
    if let id = track.albumId, let title = track.album, !title.isEmpty {
      Button { navigate(.album(id: id, title: title)) } label: {
        Text(title).lineLimit(1)
      }.buttonStyle(.plain).foregroundStyle(MacTheme.muted).help("查看专辑：\(title)")
    } else if let title = track.album, !title.isEmpty {
      Text(title).lineLimit(1).foregroundStyle(MacTheme.muted)
    } else {
      Text("—").foregroundStyle(MacTheme.faint)
    }
  }

  private var selectedTracks: [Track] { tracks.filter { selected.contains($0.id) } }

  private func enqueue(_ tracks: [Track], next: Bool = false) {
    if playback.enqueue(items: tracks.map(MacPlayback.item), next: next) {
      notice = "已将 \(tracks.count) 首\(next ? "安排为接下来播放" : "加入播放队列")"
      selected = []
      setSelecting(false)
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
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: album.title,
        subtitle: "\(album.trackCount) 首",
        symbol: "square.stack",
        canPlay: !tracks.isEmpty
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
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
    }
    .navigationTitle(album.title)
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
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
    @AppStorage("macArtistRole") private var role = "album_artist"

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
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: artist.name,
        subtitle: "\(artist.trackCount) 首",
        symbol: "person.2",
        canPlay: !tracks.isEmpty
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
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
    }
    .navigationTitle(artist.name)
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
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
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: playlist.name,
        subtitle: "\(tracks.count) 首",
        symbol: "music.note.list",
        canPlay: !tracks.isEmpty
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
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
    }
    .navigationTitle(playlist.name)
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
    VStack(spacing: 0) {
      MacCollectionHeading(
        title: "我喜欢",
        subtitle: loading && tracks.isEmpty
          ? "正在读取"
          : "\(tracks.count) 首歌曲 · 总时长 \(macTotalDurationText(tracks))",
        symbol: "heart.fill",
        canPlay: !tracks.isEmpty,
        tileSymbol: "heart",
        badge: "收藏歌单",
        onShuffle: {
          guard let pick = tracks.randomElement() else { return }
          if !playback.isShuffled { playback.toggleShuffle() }
          MacPlayback.play(tracks, startingAt: pick, playback: playback)
        }
      ) {
        guard let first = tracks.first(where: \.isAvailable) ?? tracks.first else { return }
        MacPlayback.play(tracks, startingAt: first, playback: playback)
      }
      MacPlayableTracks(
        client: client,
        playback: playback,
        favorites: favorites,
        tracks: tracks,
        emptyTitle: message == nil ? "还没有红心歌曲" : "无法加载红心",
        emptyDetail: message,
        emptyIcon: "heart",
        canManage: canManage,
        onReload: { await load() },
        isLoading: loading
      )
    }
    .navigationTitle("我喜欢")
    .toolbar {
      Button("刷新", systemImage: "arrow.clockwise") { Task { await load() } }
        .disabled(loading)
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
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
    .toolbar {
      Button("刷新", systemImage: "arrow.clockwise") { Task { await load() } }
        .disabled(loading)
    }
    .task { await load() }
  }

  private func load() async {
    loading = tracks.isEmpty
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
    Group {
      if let page {
        VStack(spacing: 0) {
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("通知")
              .font(MacTheme.section(18))
              .foregroundStyle(MacTheme.ink)
            Text(
              page.unreadCount > 0
                ? "\(page.unreadCount) 条未读 · 共 \(page.items.count) 条"
                : "共 \(page.items.count) 条 · 都已读完"
            )
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            Spacer()
            Button("全部标为已读") {
              Task { await markAll(page.highWatermark) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(page.unreadCount == 0)
          }
          .padding(.horizontal, 24)
          .padding(.top, 20)
          .padding(.bottom, 12)
          Rectangle().fill(MacTheme.border).frame(height: 1)
          ScrollView {
            LazyVStack(spacing: 0) {
              ForEach(page.items) { item in
                notificationRow(item)
              }
            }
          }
        }
      } else if let message {
        ContentUnavailableView("无法加载通知", systemImage: "bell", description: Text(message))
      } else {
        ProgressView()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MacTheme.canvas)
    .navigationTitle("通知")
    .overlay {
      if page?.items.isEmpty == true {
        ContentUnavailableView("没有通知", systemImage: "bell")
      }
    }
    .task { await load() }
  }

  private func notificationRow(_ item: AppNotification) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Circle()
        .fill(item.isUnread ? MacTheme.accent : MacTheme.border.opacity(0.6))
        .frame(width: 7, height: 7)
        .padding(.top, 5)
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text(item.title)
            .font(.system(size: 13, weight: item.isUnread ? .semibold : .regular))
            .foregroundStyle(item.isUnread ? MacTheme.ink : MacTheme.muted)
            .lineLimit(1)
          Spacer(minLength: 12)
          Text(macRelativeTime(item.createdAt) ?? "")
            .font(MacTheme.micro)
            .foregroundStyle(MacTheme.faint)
        }
        if !item.summary.isEmpty {
          Text(item.summary)
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 12)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(MacTheme.border.opacity(0.55))
        .frame(height: 1)
        .padding(.horizontal, 24)
    }
    .task {
      if item.isUnread {
        try? await client.markNotificationsRead(ids: [item.id])
      }
    }
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
