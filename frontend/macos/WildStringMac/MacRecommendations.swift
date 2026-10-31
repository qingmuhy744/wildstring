import CoreNetwork
import CorePlayback
import SwiftUI

struct MacDiscoverView: View {
  let client: WildstringClient
  let playback: PlaybackService
  var favorites: MacFavorites?

  @State private var daily: DailyRecommendations?
  @State private var rejected: Set<String> = []
  @State private var rankings: [RankingRow] = []
  @State private var section = "daily"
  @State private var scope = "personal"
  @State private var period = "30d"
  @State private var loading = true
  @State private var refreshing = false
  @State private var message: String?
  @State private var saving = false

  private var tracks: [Track] {
    section == "daily"
      ? daily?.items.map(\.track).filter { !rejected.contains($0.id) } ?? [] : rankings.map(\.track)
  }

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 14) {
        Picker("发现分类", selection: $section) {
          Text("每日推荐").tag("daily")
          Text("收听排行").tag("rankings")
        }.pickerStyle(.segmented).frame(width: 260)
        HStack(alignment: .top) {
          VStack(alignment: .leading, spacing: 6) {
            Text(section == "daily" ? "今天，听点喜欢的" : "常听的声音").font(.title.bold())
            Text(
              section == "daily"
                ? "\(daily?.date ?? "") · \(tracks.count) 首" : "\(tracks.count) 首 · 实际收听排行"
            )
            .font(.callout).foregroundStyle(.secondary)
          }
          Spacer()
          Button("播放推荐", systemImage: "play.fill") {
            if let first = tracks.first {
              MacPlayback.play(tracks, startingAt: first, playback: playback)
            }
          }.disabled(tracks.isEmpty).buttonStyle(.borderedProminent)
          Button("保存歌单…") { saving = true }.disabled(tracks.isEmpty)
        }
        if section == "rankings" {
          HStack {
            Picker("范围", selection: $scope) {
              Text("我的").tag("personal")
              Text("大家").tag("community")
            }.frame(width: 180)
            Picker("时间", selection: $period) {
              Text("7 天").tag("7d")
              Text("30 天").tag("30d")
              Text("全部").tag("all")
            }.frame(width: 180)
          }
        }
        if let message {
          Text(message).font(.callout).foregroundStyle(.orange).textSelection(.enabled)
        }
        if section == "daily", daily?.degraded == true {
          Text("部分来源暂不可用，已保留可用推荐。").font(.caption).foregroundStyle(.secondary)
        }
      }.padding(20)
      Divider()
      MacPlayableTracks(
        client: client, playback: playback, favorites: favorites, tracks: tracks,
        emptyTitle: message == nil ? "还没有推荐" : "暂时无法读取推荐",
        emptyDetail: message, isLoading: loading, allowsSelection: true,
        onRecommendationFeedback: section == "daily"
          ? { track, action in await feedback(track, action: action) } : nil
      )
      .id(section == "daily" ? daily?.id ?? "daily" : "rankings")
    }
    .navigationTitle("每日推荐")
    .toolbar {
      Button(refreshing ? "正在生成…" : "换一批") { Task { await refresh() } }
        .disabled(refreshing || section != "daily")
      Button("刷新", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(loading)
    }
    .sheet(isPresented: $saving) {
      MacAddToPlaylistSheet(client: client, tracks: tracks) { message = $0 }
    }
    .task { await load() }
    .task(id: "\(scope)-\(period)") { await loadRankings() }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      daily = try await client.dailyRecommendations()
      rejected = []
      message = nil
    } catch { message = MacErrorText.message(for: error) }
  }
  private func refresh() async {
    refreshing = true
    defer { refreshing = false }
    do {
      daily = try await client.refreshDailyRecommendations()
      rejected = []
      message = nil
    } catch { message = MacErrorText.message(for: error) }
  }
  private func loadRankings() async {
    do {
      rankings = try await client.rankings(scope: scope, period: period, metric: "plays").items
    } catch { message = MacErrorText.message(for: error) }
  }
  private func feedback(_ track: Track, action: String) async {
    do {
      try await client.recommendationFeedback(trackID: track.id, action: action)
      rejected.insert(track.id)
      message = "已记录你的偏好"
    } catch { message = MacErrorText.message(for: error) }
  }
}

struct MacPlaylistSelection: Identifiable {
  let id = UUID()
  let tracks: [Track]
}

struct MacAddToPlaylistSheet: View {
  let client: WildstringClient
  let tracks: [Track]
  var onSaved: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var playlists: [Playlist] = []
  @State private var target = "new"
  @State private var name = ""
  @State private var created: Playlist?
  @State private var busy = false
  @State private var loading = true
  @State private var message: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("加入歌单").font(.title2.bold())
      Text("已选 \(tracks.count) 首 · 按列表顺序保存").foregroundStyle(.secondary)
      Picker("目标歌单", selection: $target) {
        Text("新建歌单…").tag("new")
        ForEach(playlists) { Text($0.name).tag($0.id) }
      }.disabled(busy || created != nil || loading)
      if target == "new" { TextField("歌单名称", text: $name).disabled(busy || created != nil) }
      if loading { ProgressView() }
      if let message { Text(message).font(.callout).foregroundStyle(.orange) }
      HStack {
        Spacer()
        Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
        Button(busy ? "正在加入…" : "确认加入") { Task { await save() } }
          .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
          .disabled(
            tracks.isEmpty || busy || loading
              || (target == "new" && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
      }
    }.padding(24).frame(width: 420)
      .interactiveDismissDisabled(busy)
      .task {
        do { playlists = try await MacPages.playlists(client: client).filter(\.isEditable) } catch {
          message = MacErrorText.message(for: error)
        }
        loading = false
      }
  }

  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let playlist: Playlist
      if let created {
        playlist = try await client.playlist(id: created.id)
      } else if target == "new" {
        playlist = try await client.createPlaylist(
          name: name.trimmingCharacters(in: .whitespacesAndNewlines))
        created = playlist
      } else {
        playlist = try await client.playlist(id: target)
      }
      try await client.addTracks(
        playlistID: playlist.id, trackIDs: tracks.map(\.id), version: playlist.version)
      onSaved("已加入「\(playlist.name)」")
      dismiss()
    } catch {
      message = (created == nil ? "" : "歌单已创建，曲目尚未确认加入。") + MacErrorText.message(for: error)
    }
  }
}

struct MacLyricsPreview: View {
  let client: WildstringClient
  let track: Track
  @Environment(\.dismiss) private var dismiss
  @State private var lyrics: Lyrics?
  @State private var message: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text(track.title).font(.title2.bold())
        Spacer()
        Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      Text("\(track.artists.joined(separator: " / ")) · 歌词预览").foregroundStyle(.secondary)
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if let message {
            Text(message).foregroundStyle(.orange)
          } else if let lyrics {
            if lyrics.lines.isEmpty { Text("这首歌还没有歌词") }
            ForEach(Array(lyrics.lines.enumerated()), id: \.offset) { _, line in
              Text(line.text).textSelection(.enabled)
            }
          } else {
            ProgressView("正在读取歌词…")
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }.padding(24).frame(width: 480, height: 520)
      .task {
        do { lyrics = try await client.lyrics(trackID: track.id) } catch {
          message = MacErrorText.message(for: error)
        }
      }
  }
}
