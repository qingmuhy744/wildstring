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
    @Environment(\.colorScheme) private var colorScheme

    private var upcoming: [PlaybackService.Item] {
        let entries = playback.playbackItems
        guard let index = entries.firstIndex(where: { $0.id == playback.currentItem?.id }) else { return [] }
        return Array(entries.dropFirst(index + 1))
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
                            MacQueueView(client: client, playback: playback)
                                .padding(24)
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
            HStack {
                MacPlaybackRateMenu(playback: playback)
                Spacer()
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
                Spacer()
            }.buttonStyle(.plain)
            MacSleepMenu(playback: playback, podcast: true)
            if let message = playback.errorMessage ?? playback.podcastProgressMessage {
                Text(message).font(.caption).foregroundStyle(.orange)
            }
            Divider()
            HStack {
                Text("接下来").font(.headline)
                Spacer()
                Text("\(upcoming.count) \(upcoming.allSatisfy { $0.trackID.hasPrefix("podcast_ep_") } ? "集" : "项")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if upcoming.isEmpty {
                Text("本集结束后停止。可以从单集列表安排下一集。")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(upcoming.prefix(3)) { item in
                    Button {
                        if let index = playback.items.firstIndex(where: { $0.id == item.id }) {
                            playback.playQueueEntry(at: index)
                        }
                    } label: {
                        HStack(alignment: .top, spacing: 9) {
                            Image(systemName: "play.circle").foregroundStyle(MacTheme.accentDeep)
                            Text(item.title).font(.callout).lineLimit(3).multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                    }.buttonStyle(.plain)
                }
                Button("查看与调整队列") { showQueue = true }.buttonStyle(.plain)
                    .font(.caption).foregroundStyle(MacTheme.accentDeep)
            }
        }.padding(.vertical, 12)
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
        } catch {
            guard !Task.isCancelled, playback.currentItem?.trackID == trackID else { return }
            self.error = MacErrorText.message(for: error)
        }
    }
}

struct MacPlaybackRateMenu: View {
    let playback: PlaybackService
    @AppStorage("podcastPlaybackRate") private var savedRate = 1.0
    var body: some View {
        Menu {
            ForEach([0.75, 1.0, 1.25, 1.5, 1.75, 2.0], id: \.self) { rate in
                Button("\(rate.formatted())×") {
                    savedRate = rate
                    playback.setPodcastPlaybackRate(Float(rate))
                }
            }
        } label: {
            Text("\(playback.podcastPlaybackRate.formatted())×").font(.callout.monospacedDigit())
        }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("播放速度").accessibilityLabel("播放速度")
    }
}

struct MacSleepMenu: View {
    let playback: PlaybackService
    var podcast = false
    var body: some View {
        Menu {
            ForEach([15, 30, 60], id: \.self) { minutes in
                Button("\(minutes) 分钟后暂停") { playback.setSleepTimer(minutes: minutes) }
            }
            Button(podcast ? "本集播完后暂停" : "这首播完后暂停") { playback.sleepAfterCurrentTrack() }
            Button("取消定时") { playback.cancelSleepTimer() }
        } label: {
            Label {
                if let end = playback.sleepTimerEnd {
                    Text("\(end, style: .time) 暂停")
                } else {
                    Text(playback.pauseAfterCurrentTrack ? (podcast ? "本集结束后暂停" : "本曲结束后暂停") : "定时暂停")
                }
            } icon: { Image(systemName: "moon") }
        }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
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
