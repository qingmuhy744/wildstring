import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI

struct MacPodcastPlayer: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService
    @State private var episode: PodcastEpisode?
    @State private var show: PodcastSummary?
    @State private var article = AttributedString()
    @State private var loading = true
    @State private var error: String?
    @State private var showQueue = false
    @State private var actionError: String?
    @Environment(\.colorScheme) private var colorScheme

    private var cloud: PodcastCloudQueue? { playback.podcastCloud }

    private var currentEpisodeID: String? {
        guard let trackID = playback.currentItem?.trackID else { return nil }
        return PlaybackService.podcastEpisodeID(trackID)
    }

    private var queuedUpcoming: [PodcastQueueItem] {
        cloud?.upcoming(after: currentEpisodeID) ?? []
    }

    private var autoPreview: [PlaybackService.Item] {
        let anchor: String?
        if let last = queuedUpcoming.last {
            anchor = "podcast_ep_\(last.episodeId)"
        } else {
            anchor = playback.currentItem?.trackID
        }
        return playback.podcastAutoPreview(limit: 3, anchorTrackID: anchor)
    }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 22) {
                HStack {
                    Button { session.showFullscreen = false } label: {
                        Image(systemName: "chevron.down").frame(width: 32, height: 32)
                            .background(.primary.opacity(0.06), in: Circle())
                    }.buttonStyle(.plain).help("返回电台（Esc）").accessibilityLabel("收起播客播放")
                    Spacer()
                    Label(playback.isBuffering ? "正在缓冲" : playback.isPlaying ? "正在收听" : "已暂停",
                        systemImage: "antenna.radiowaves.left.and.right")
                        .font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button { showQueue.toggle() } label: {
                        Label(showQueue ? "本期内容" : "播放队列", systemImage: showQueue ? "doc.text" : "list.number")
                    }.buttonStyle(.bordered)
                }
                HStack(alignment: .top, spacing: 36) {
                    ScrollView {
                        listeningCard
                    }.scrollIndicators(.hidden).frame(width: geo.size.width < 1250 ? 290 : 340)
                    Group {
                        if showQueue {
                            queuePane
                        } else {
                            articlePane
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(nsColor: .textBackgroundColor).opacity(colorScheme == .dark ? 0.45 : 0.85),
                        in: RoundedRectangle(cornerRadius: 20))
                }
                .frame(maxWidth: 1160, maxHeight: .infinity)
            }
            .padding(28)
            .frame(width: geo.size.width, height: geo.size.height)
            .background(colorScheme == .dark ? Color(red: 0.095, green: 0.10, blue: 0.10) :
                Color(red: 0.96, green: 0.95, blue: 0.93))
        }
        .tint(MacTheme.accentDeep)
        .onExitCommand { session.showFullscreen = false }
        .task(id: playback.currentItem?.trackID) { await load() }
        .task { await cloud?.refreshQueue() }
    }

    private var listeningCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 14) {
                MacPodcastArtwork(url: show?.coverURL, side: 76)
                VStack(alignment: .leading, spacing: 6) {
                    Text(show?.title ?? playback.currentItem?.album ?? "播客")
                        .font(.headline).fixedSize(horizontal: false, vertical: true)
                    Text(show?.author ?? playback.currentItem?.artist ?? "")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(playback.currentItem?.title ?? "选择一期节目")
                .font(.system(size: 25, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            if let episode {
                Text("\(macPodcastDate(episode.pubDate)) · \(macPodcastClock(episode.durationSeconds))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            VStack(spacing: 7) {
                PlaybackSlider(playback: playback)
                HStack {
                    Text(macPlaybackClock(playback.currentTime))
                    Spacer()
                    Text(playback.duration > 0 ? "剩余 \(macPlaybackClock(max(0, playback.duration - playback.currentTime)))" : "时长加载中")
                }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            HStack(spacing: 14) {
                MacPlaybackRateMenu(playback: playback)
                Spacer(minLength: 8)
                Button { playback.skipPodcastEpisode(.previous) } label: {
                    Image(systemName: "backward.end.fill").font(.title3)
                }.help("上一集").accessibilityLabel("上一集")
                Button { playback.seek(to: max(0, playback.currentTime - 15)) } label: {
                    Image(systemName: "gobackward.15").font(.title2)
                }.help("后退 15 秒").accessibilityLabel("后退 15 秒")
                Button { playback.togglePlayPause() } label: {
                    Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2).foregroundStyle(.white).frame(width: 54, height: 54)
                        .background(MacTheme.accentDeep, in: Circle())
                }.help(playback.isPlaying ? "暂停" : "继续收听")
                    .accessibilityLabel(playback.isPlaying ? "暂停" : "继续收听")
                Button { playback.seek(to: playback.currentTime + 30) } label: {
                    Image(systemName: "goforward.30").font(.title2)
                }.help("前进 30 秒").accessibilityLabel("前进 30 秒")
                Button { playback.skipPodcastEpisode(.next) } label: {
                    Image(systemName: "forward.end.fill").font(.title3)
                }.help("下一集").accessibilityLabel("下一集")
                Spacer(minLength: 8)
            }.buttonStyle(.plain)
            MacSleepMenu(playback: playback, podcast: true)
            if let message = actionError ?? playback.errorMessage ?? playback.podcastProgressMessage {
                Text(message).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            if let cloud {
                PodcastCloudStatus(cloud: cloud)
            }
            HStack {
                Text("接下来").font(.headline)
                Spacer()
                Text("\(queuedUpcoming.count) 集")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if cloud?.loading == true, queuedUpcoming.isEmpty, cloud?.items.isEmpty != false {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在同步待播队列…").font(.callout).foregroundStyle(.secondary)
                }
            } else if queuedUpcoming.isEmpty {
                Text(playback.podcastAutoContinueEnabled ? "播完会接下一集" : "已关闭，播完即停")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Button("查看与调整队列") { showQueue = true }.buttonStyle(.plain)
                    .font(.caption).foregroundStyle(MacTheme.accentDeep)
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(queuedUpcoming) { item in
                        Button { Task { await playQueued(item.episodeId) } } label: {
                            HStack(alignment: .top, spacing: 9) {
                                Image(systemName: "play.circle").foregroundStyle(MacTheme.accentDeep)
                                Text(cloud?.title(for: item.episodeId) ?? item.episodeId)
                                    .font(.callout).lineLimit(3).multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }
                        }.buttonStyle(.plain)
                    }
                }
            }
            if !autoPreview.isEmpty {
                Text("自动续播").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                Text("不会写入待播队列").font(.caption2).foregroundStyle(.tertiary)
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(autoPreview) { item in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.title).font(.callout).foregroundStyle(.secondary)
                                .lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            Button("加入待播") {
                                guard let episodeID = PlaybackService.podcastEpisodeID(item.trackID) else { return }
                                cloud?.enqueueEpisode(episodeID, next: false, currentEpisodeID: currentEpisodeID)
                            }
                            .buttonStyle(.plain)
                            .font(.caption)
                            .foregroundStyle(MacTheme.accentDeep)
                        }
                    }
                }
            }
        }.padding(.vertical, 12)
    }

    private var queuePane: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("待播队列").font(.headline)
            if let cloud {
                PodcastCloudStatus(cloud: cloud)
                if cloud.loading, cloud.items.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("正在同步待播队列…").font(.callout).foregroundStyle(.secondary)
                    }
                } else if cloud.items.isEmpty {
                    Text(playback.podcastAutoContinueEnabled ? "播完会接下一集" : "已关闭，播完即停")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    List {
                        ForEach(cloud.items) { item in
                            HStack(spacing: 8) {
                                Text(cloud.title(for: item.episodeId))
                                    .lineLimit(2)
                                Spacer(minLength: 8)
                                if item.episodeId == currentEpisodeID {
                                    Text("正在收听").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .onMove { cloud.moveItems(from: $0, to: $1) }
                    }
                    .frame(minHeight: 180)
                }
            }
            if !autoPreview.isEmpty {
                Text("自动续播").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                ForEach(autoPreview) { item in
                    Text(item.title).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(24)
    }

    private func playQueued(_ episodeID: String) async {
        guard let item = await cloud?.playbackItem(for: episodeID) else {
            actionError = "这集暂时打不开。待播队列还在，可以重试。"
            return
        }
        actionError = nil
        playback.playPodcastEpisode(item)
    }

    private var articlePane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Label("本期内容", systemImage: "doc.text").font(.callout.weight(.medium))
                    .foregroundStyle(MacTheme.accentDeep)
                Text(playback.currentItem?.title ?? "")
                    .font(.system(size: 27, weight: .semibold, design: .serif))
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                Divider()
                if !article.characters.isEmpty {
                    Text(article).font(.system(size: 17)).lineSpacing(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .environment(\.openURL, OpenURLAction { url in
                            if url.scheme == "wildstring-time", let time = Double(url.host ?? "") {
                                playback.seek(to: time)
                                return .handled
                            }
                            return ["https", "http"].contains(url.scheme) ? .systemAction : .discarded
                        })
                } else if loading {
                    ProgressView("正在加载单集内容…")
                } else if error == nil {
                    Text("这期节目还没有提供文字内容。").foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).font(.callout).foregroundStyle(.secondary)
                    Button("重新加载") { Task { await load() } }
                }
            }.frame(maxWidth: 720, alignment: .leading).padding(32)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }.id(playback.currentItem?.trackID)
    }

    private func load() async {
        guard let trackID = playback.currentItem?.trackID, trackID.hasPrefix("podcast_ep_") else { return }
        episode = nil
        show = nil
        article = AttributedString()
        error = nil
        loading = true
        defer { if playback.currentItem?.trackID == trackID { loading = false } }
        do {
            let loaded = try await client.podcastEpisode(id: String(trackID.dropFirst("podcast_ep_".count)))
            guard !Task.isCancelled, playback.currentItem?.trackID == trackID else { return }
            episode = loaded
            article = MacPodcastArticle.render(loaded.description, duration: loaded.durationSeconds)
            let detail = try await client.podcast(id: loaded.podcastId)
            guard !Task.isCancelled, playback.currentItem?.trackID == trackID else { return }
            show = detail.podcast
            let artist = detail.podcast.author.isEmpty ? "电台" : detail.podcast.author
            let refs = detail.episodes.enumerated().map { index, ep in
                PodcastContinuation.Episode(
                    id: ep.id,
                    title: ep.title,
                    artist: artist,
                    album: detail.podcast.title,
                    chronologicalIndex: detail.episodes.count - 1 - index,
                    isCompleted: ep.positionSeconds > 0 && ep.durationSeconds > 0
                        && ep.positionSeconds >= ep.durationSeconds
                )
            }
            let pref = cloud?.showPreference(detail.podcast.id).continuation
                ?? PodcastContinuation.Preference(autoContinue: playback.podcastAutoContinueEnabled)
            playback.configurePodcastContinuation(
                podcastID: detail.podcast.id,
                episodes: refs,
                preference: pref
            )
        } catch {
            guard !Task.isCancelled, playback.currentItem?.trackID == trackID else { return }
            self.error = MacErrorText.message(for: error)
        }
    }
}

struct PodcastCloudStatus: View {
    let cloud: PodcastCloudQueue

    var body: some View {
        if cloud.conflict != nil {
            VStack(alignment: .leading, spacing: 8) {
                Text(PodcastCloudQueue.conflictMessage)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button("使用服务器上的队列") { cloud.adoptServerQueue() }
                    Button("用本机覆盖") { cloud.overwriteWithLocal() }
                }
            }
        } else if let syncError = cloud.syncError {
            VStack(alignment: .leading, spacing: 8) {
                Text(syncError)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Button("重试") { Task { await cloud.retrySync() } }
            }
        }
    }
}

struct MacPlaybackRateMenu: View {
    let playback: PlaybackService
    @AppStorage("podcastPlaybackRate") private var savedRate = 1.0
    var body: some View {
        Menu {
            ForEach([0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0], id: \.self) { rate in
                Button {
                    savedRate = rate
                    playback.setPodcastPlaybackRate(Float(rate))
                } label: {
                    if Float(rate) == playback.podcastPlaybackRate {
                        Label("\(rate.formatted())×", systemImage: "checkmark")
                    } else {
                        Text("\(rate.formatted())×")
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text("倍速 \(playback.podcastPlaybackRate.formatted())×")
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
                .font(.system(size: 11, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(MacTheme.accentDeep)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(
                    Capsule()
                        .fill(MacTheme.accent.opacity(0.10))
                )
                .overlay(
                    Capsule()
                        .strokeBorder(MacTheme.accent.opacity(0.55), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("播放速度")
        .accessibilityLabel("播放速度")
    }
}

struct MacSleepMenu: View {
    let playback: PlaybackService
    var podcast = false
    var iconOnly = false

    private var isActive: Bool {
        playback.sleepTimerEnd != nil || playback.pauseAfterCurrentTrack
    }

    var body: some View {
        Menu {
            ForEach([15, 30, 60], id: \.self) { minutes in
                Button("\(minutes) 分钟后暂停") { playback.setSleepTimer(minutes: minutes) }
            }
            Button(podcast ? "本集播完后暂停" : "这首播完后暂停") { playback.sleepAfterCurrentTrack() }
            Button("取消定时") { playback.cancelSleepTimer() }
        } label: {
            if iconOnly {
                Image(systemName: isActive ? "moon.fill" : "moon.zzz")
                    .font(.system(size: 15))
                    .foregroundStyle(isActive ? MacTheme.accentDeep : MacTheme.muted)
                    .frame(width: 28, height: 30)
            } else {
                Label {
                    if let end = playback.sleepTimerEnd {
                        Text("\(end, style: .time) 暂停")
                    } else {
                        Text(playback.pauseAfterCurrentTrack ? (podcast ? "本集结束后暂停" : "本曲结束后暂停") : "定时暂停")
                    }
                } icon: {
                    Image(systemName: isActive ? "moon.fill" : "moon")
                }
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("睡眠定时")
        .accessibilityLabel("睡眠定时")
    }
}

/// Display RSS as text, without a web view, scripts, images or automatic network requests.
enum MacPodcastArticle {
    static func render(_ raw: String, duration: Int) -> AttributedString {
        var text = raw.replacingOccurrences(of: #"(?is)<(script|style)\b[^>]*>.*?</\1\s*>"#, with: "", options: .regularExpression)
        // Keep named RSS links while rendering the remaining markup as plain text.
        let anchors = try! NSRegularExpression(pattern: #"(?is)<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>(.*?)</a\s*>"#)
        var destinations: [URL] = []
        for match in anchors.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let source = text as NSString
            let href = source.substring(with: match.range(at: 2)).replacingOccurrences(of: "&amp;", with: "&")
            guard let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  let range = Range(match.range, in: text) else { continue }
            let label = source.substring(with: match.range(at: 3))
            text.replaceSubrange(range, with: "\u{E000}\(destinations.count)\u{E001}\(label)\u{E002}")
            destinations.append(url)
        }
        text = text.replacingOccurrences(of: #"(?i)<br\s*/?>|</(?:p|div|h[1-6]|li|blockquote)\s*>"#, with: "\n\n", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)<li\b[^>]*>"#, with: "• ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^>]*>"#, with: "", options: .regularExpression)
        for (entity, value) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: value)
        }
        text = text.replacingOccurrences(of: #"\n[ \t]*\n(?:[ \t]*\n)+"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var rich = AttributedString()
        let marked = try! NSRegularExpression(pattern: "\u{E000}(\\d+)\u{E001}([\\s\\S]*?)\u{E002}")
        let source = text as NSString
        var cursor = 0
        for match in marked.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            rich += AttributedString(source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            var label = AttributedString(source.substring(with: match.range(at: 2)))
            if let index = Int(source.substring(with: match.range(at: 1))), destinations.indices.contains(index) {
                label.link = destinations[index]
            }
            rich += label
            cursor = NSMaxRange(match.range)
        }
        rich += AttributedString(source.substring(from: cursor))
        text = String(rich.characters)
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        let links = (try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue))?
            .matches(in: text, range: fullRange) ?? []
        for link in links {
            guard let url = link.url, ["http", "https"].contains(url.scheme),
                  let range = Range(link.range, in: text),
                  let attributedRange = Range(range, in: rich) else { continue }
            if rich[attributedRange].runs.contains(where: { $0.link != nil }) { continue }
            rich[attributedRange].link = url
        }
        let pattern = try! NSRegularExpression(pattern: #"(?<![\w:])(?:\d{1,2}:)?\d{1,3}:[0-5]\d(?![\d:])"#)
        for match in pattern.matches(in: text, range: fullRange) {
            if links.contains(where: { NSIntersectionRange($0.range, match.range).length > 0 }) { continue }
            let parts = nsText.substring(with: match.range).split(separator: ":").compactMap { Int($0) }
            if parts.count == 3, parts[1] >= 60 { continue }
            let seconds = parts.reduce(0) { $0 * 60 + $1 }
            guard duration > 0, seconds <= duration,
                  let range = Range(match.range, in: text),
                  let attributedRange = Range(range, in: rich) else { continue }
            rich[attributedRange].link = URL(string: "wildstring-time://\(seconds)")
            rich[attributedRange].font = .body.monospacedDigit().bold()
        }
        return rich
    }
}
