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
                            .background(MacTheme.hover, in: Circle())
                    }.buttonStyle(.plain).help(L10n("macPodcastPlayer.backToPodcastsHelp")).accessibilityLabel(L10n("macPodcastPlayer.dismissPlayer"))
                    Spacer()
                    Label(playback.isBuffering ? L10n("macPodcastPlayer.buffering") : playback.isPlaying ? L10n("macPodcastPlayer.listening") : L10n("macPodcastPlayer.paused"),
                        systemImage: "antenna.radiowaves.left.and.right")
                        .font(.callout).foregroundStyle(MacTheme.muted)
                    Spacer()
                    MacToolbarTextButton(title: showQueue ? L10n("macPodcastPlayer.showNotes") : L10n("macPodcastPlayer.playQueue"), systemImage: showQueue ? "doc.text" : "list.number", accent: true) { showQueue.toggle() }
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
                    .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: MacTheme.panelRadius, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: MacTheme.panelRadius, style: .continuous).strokeBorder(MacTheme.border, lineWidth: 1))
                }
                .frame(maxWidth: 1160, maxHeight: .infinity)
            }
            .padding(28)
            .frame(width: geo.size.width, height: geo.size.height)
            .background(MacTheme.canvas)
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
                    Text(show?.title ?? playback.currentItem?.album ?? L10n("macPodcastPlayer.defaultPodcastTitle"))
                        .font(.headline).fixedSize(horizontal: false, vertical: true)
                    Text(show?.author ?? playback.currentItem?.artist ?? "")
                        .font(.caption).foregroundStyle(MacTheme.muted)
                }
            }
            Text(playback.currentItem?.title ?? L10n("macPodcastPlayer.selectAnEpisode"))
                .font(.system(size: 25, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            if let episode {
                Text("\(macPodcastDate(episode.pubDate)) · \(macPodcastClock(episode.durationSeconds))")
                    .font(.caption).foregroundStyle(MacTheme.muted)
            }
            VStack(spacing: 7) {
                PlaybackSlider(playback: playback)
                HStack {
                    Text(macPlaybackClock(playback.currentTime))
                    Spacer()
                    Text(playback.duration > 0 ? L10n("macPodcastPlayer.remainingTime", macPlaybackClock(max(0, playback.duration - playback.currentTime))) : L10n("macPodcastPlayer.durationLoading"))
                }.font(.caption.monospacedDigit()).foregroundStyle(MacTheme.muted)
            }
            HStack(spacing: 14) {
                MacPlaybackRateMenu(playback: playback)
                Spacer(minLength: 8)
                Button { playback.skipPodcastEpisode(.previous) } label: {
                    Image(systemName: "backward.end.fill").font(.title3)
                }.help(L10n("macPodcastPlayer.previousEpisode")).accessibilityLabel(L10n("macPodcastPlayer.previousEpisode"))
                Button { playback.seek(to: max(0, playback.currentTime - 15)) } label: {
                    Image(systemName: "gobackward.15").font(.title2)
                }.help(L10n("macPodcastPlayer.skipBackward15")).accessibilityLabel(L10n("macPodcastPlayer.skipBackward15"))
                Button { playback.togglePlayPause() } label: {
                    Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2).foregroundStyle(MacTheme.onAccent).frame(width: 54, height: 54)
                        .background(MacTheme.accentDeep, in: Circle())
                }.help(playback.isPlaying ? L10n("macPodcastPlayer.pause") : L10n("macPodcastPlayer.resume"))
                    .accessibilityLabel(playback.isPlaying ? L10n("macPodcastPlayer.pause") : L10n("macPodcastPlayer.resume"))
                Button { playback.seek(to: playback.currentTime + 30) } label: {
                    Image(systemName: "goforward.30").font(.title2)
                }.help(L10n("macPodcastPlayer.skipForward30")).accessibilityLabel(L10n("macPodcastPlayer.skipForward30"))
                Button { playback.skipPodcastEpisode(.next) } label: {
                    Image(systemName: "forward.end.fill").font(.title3)
                }.help(L10n("macPodcastPlayer.nextEpisode")).accessibilityLabel(L10n("macPodcastPlayer.nextEpisode"))
                Spacer(minLength: 8)
            }.buttonStyle(.plain)
            MacSleepMenu(playback: playback, podcast: true)
            if let message = actionError ?? playback.errorMessage {
                Text(message).font(.caption).foregroundStyle(MacTheme.danger).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            if let cloud {
                PodcastCloudStatus(cloud: cloud)
            }
            HStack {
                Text(L10n("macPodcastPlayer.upNextHeading")).font(MacTheme.section(13))
                Spacer()
                Text(L10n("macPodcastPlayer.episodeCount", queuedUpcoming.count))
                    .font(MacTheme.mono(11)).foregroundStyle(MacTheme.faint)
            }
            if let cloud, cloud.loading, cloud.items.isEmpty, queuedUpcoming.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L10n("macPodcastPlayer.syncingQueue")).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                }
            } else if queuedUpcoming.isEmpty {
                Text(playback.podcastAutoContinueEnabled ? L10n("macPodcastPlayer.autoContinueOn") : L10n("macPodcastPlayer.autoContinueOff"))
                    .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(queuedUpcoming.prefix(3).enumerated()), id: \.element.id) { position, item in
                        Button { Task { await playQueued(item.episodeId) } } label: {
                            HStack(spacing: 8) {
                                Text(String(format: "%02d", position + 1))
                                    .font(MacTheme.mono(10)).foregroundStyle(MacTheme.faint)
                                    .frame(width: 18, alignment: .leading)
                                Text(cloud?.title(for: item.episodeId) ?? item.episodeId)
                                    .font(MacTheme.caption).foregroundStyle(MacTheme.ink)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                            .padding(.vertical, 2)
                        }
                        .buttonStyle(.plain)
                        .help(cloud?.title(for: item.episodeId) ?? item.episodeId)
                    }
                }
                Button { showQueue = true } label: {
                    HStack(spacing: 6) {
                        Text(L10n("macPodcastPlayer.viewAndEditQueue"))
                            .font(MacTheme.caption).foregroundStyle(MacTheme.accentDeep)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(MacTheme.faint)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if !autoPreview.isEmpty {
                Text(L10n("macPodcastPlayer.autoContinueSection")).font(MacTheme.micro).foregroundStyle(MacTheme.muted)
                Text(L10n("macPodcastPlayer.wontWriteToQueue")).font(MacTheme.micro).foregroundStyle(MacTheme.faint)
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(autoPreview) { item in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.title).font(.callout).foregroundStyle(MacTheme.muted)
                                .lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            Button(L10n("macPodcastPlayer.addToQueue")) {
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
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(L10n("macPodcastPlayer.queueTitle")).font(MacTheme.section(15))
                if let count = cloud?.items.count, count > 0 {
                    Text(L10n("macPodcastPlayer.episodeCount", count))
                        .font(MacTheme.mono(11)).foregroundStyle(MacTheme.faint)
                }
                Spacer(minLength: 8)
                if let cloud, !cloud.items.isEmpty {
                    Button { Task { await playFirstQueued() } } label: {
                        Label(L10n("macPodcastPlayer.playAll"), systemImage: "play.fill")
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.accentDeep)
                    }
                    .buttonStyle(.plain)
                    .help(L10n("macPodcastPlayer.playAll"))
                }
            }
            if let cloud {
                PodcastCloudStatus(cloud: cloud)
                    .padding(.top, 4)
                if cloud.loading, cloud.items.isEmpty {
                    queueSkeleton
                } else if cloud.items.isEmpty {
                    ContentUnavailableView(L10n("macQueue.emptyTitle"),
                        systemImage: "text.line.first.and.arrowtriangle.forward",
                        description: Text(L10n("macQueue.emptyDescPodcasts")))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    if cloud.items.count > 1 {
                        Text(L10n("macQueue.dragToReorder"))
                            .font(MacTheme.micro).foregroundStyle(MacTheme.faint)
                            .padding(.top, 8)
                    }
                    // No native List selection: its square grey highlight ignores the row's rounded shape.
                    List {
                        ForEach(Array(cloud.items.enumerated()), id: \.element.id) { position, item in
                            queueRow(item, position: position, cloud: cloud)
                                .id(item.id)
                                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                        }
                        .onMove { cloud.moveItems(from: $0, to: $1) }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }

    private func queueRow(_ item: PodcastQueueItem, position: Int, cloud: PodcastCloudQueue) -> some View {
        let isCurrent = item.episodeId == currentEpisodeID
        let episode = cloud.episodes[item.episodeId]
        let title = cloud.title(for: item.episodeId)
        return HStack(spacing: 10) {
            Text(String(format: "%02d", position + 1))
                .font(MacTheme.mono(10)).foregroundStyle(MacTheme.faint)
                .frame(width: 20, alignment: .leading)
            MacPodcastArtwork(url: episode?.podcastId == show?.id ? show?.coverURL : nil, side: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13, weight: isCurrent ? .semibold : .regular))
                    .foregroundStyle(isCurrent ? MacTheme.accentDeep : MacTheme.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let episode {
                    Text("\(macPodcastDate(episode.pubDate)) · \(macPodcastClock(episode.durationSeconds))")
                        .font(MacTheme.mono(9))
                        .foregroundStyle(MacTheme.faint)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if isCurrent {
                Text(L10n("macPodcastPlayer.listeningBadge"))
                    .font(MacTheme.micro).foregroundStyle(MacTheme.accentDeep)
            }
            Menu {
                Button(L10n("macQueue.playNow")) { Task { await playQueued(item.episodeId) } }
                Button(L10n("macQueue.removeFromQueue"), role: .destructive) { cloud.removeEpisode(item.episodeId) }
                    .disabled(isCurrent)
            } label: {
                Image(systemName: "ellipsis").frame(width: 22, height: 26)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel(L10n("macQueue.trackActions", title))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(isCurrent ? MacTheme.accentSoft : Color.clear,
            in: RoundedRectangle(cornerRadius: MacTheme.rowRadius, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { Task { await playQueued(item.episodeId) } }
        .contextMenu {
            Button(L10n("macQueue.playNow")) { Task { await playQueued(item.episodeId) } }
            Button(L10n("macQueue.removeFromQueue"), role: .destructive) { cloud.removeEpisode(item.episodeId) }
                .disabled(isCurrent)
        }
        .help(title)
    }

    private var queueSkeleton: some View {
        VStack(spacing: 10) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 3).fill(MacTheme.sidebar).frame(width: 20, height: 10)
                    RoundedRectangle(cornerRadius: 8).fill(MacTheme.sidebar).frame(width: 38, height: 38)
                    VStack(alignment: .leading, spacing: 5) {
                        RoundedRectangle(cornerRadius: 3).fill(MacTheme.sidebar).frame(height: 10).frame(maxWidth: .infinity, alignment: .leading)
                        RoundedRectangle(cornerRadius: 3).fill(MacTheme.sidebar).frame(width: 132, height: 8)
                    }
                }
                .padding(.vertical, 3)
            }
        }
        .padding(.top, 14)
        .accessibilityHidden(true)
    }

    private func playFirstQueued() async {
        guard let cloud else { return }
        let next = cloud.upcoming(after: currentEpisodeID).first ?? cloud.items.first
        guard let episodeId = next?.episodeId else { return }
        await playQueued(episodeId)
    }

    private func playQueued(_ episodeID: String) async {
        guard let item = await cloud?.playbackItem(for: episodeID) else {
            actionError = L10n("macPodcastPlayer.cannotOpenEpisode")
            return
        }
        actionError = nil
        playback.playPodcastEpisode(item, line: .queue)
    }

    private var articlePane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Label(L10n("macPodcastPlayer.showNotes"), systemImage: "doc.text").font(.callout.weight(.medium))
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
                    ProgressView(L10n("macPodcastPlayer.loadingEpisodeContent"))
                } else if error == nil {
                    Text(L10n("macPodcastPlayer.noArticleContent")).foregroundStyle(MacTheme.muted)
                }
                if let error {
                    Text(error).font(.callout).foregroundStyle(MacTheme.muted)
                    Button(L10n("macPodcastPlayer.reload")) { Task { await load() } }
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
            let artist = detail.podcast.author.isEmpty ? L10n("macPodcastPlayer.defaultArtist") : detail.podcast.author
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
        if cloud.conflict != nil || cloud.syncError != nil || cloud.queueFullNotice != nil {
            VStack(alignment: .leading, spacing: 8) {
                if cloud.conflict != nil {
                    Text(PodcastCloudQueue.conflictMessage)
                        .font(.callout)
                        .foregroundStyle(MacTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .leading, spacing: 8) {
                        Button(L10n("macPodcastPlayer.adoptServerQueue")) { cloud.adoptServerQueue() }
                        Button(L10n("macPodcastPlayer.overwriteWithLocal")) { cloud.overwriteWithLocal() }
                        Button(L10n("macPodcastPlayer.keepLocalQueue")) { cloud.keepLocalWithoutOverwrite() }
                    }
                } else if let syncError = cloud.syncError {
                    Text(syncError)
                        .font(.callout)
                        .foregroundStyle(MacTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L10n("macPodcastPlayer.retry")) { Task { await cloud.retrySync() } }
                }
                if let notice = cloud.queueFullNotice {
                    Text(notice)
                        .font(.callout)
                        .foregroundStyle(MacTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
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
                Text(L10n("macPodcastPlayer.playbackRate", playback.podcastPlaybackRate.formatted()))
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
        .help(L10n("macPodcastPlayer.playbackSpeed"))
        .accessibilityLabel(L10n("macPodcastPlayer.playbackSpeed"))
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
                Button(L10n("macPodcastPlayer.sleepTimerMinutes", minutes)) { playback.setSleepTimer(minutes: minutes) }
            }
            Button(podcast ? L10n("macPodcastPlayer.sleepAfterEpisode") : L10n("macPodcastPlayer.sleepAfterTrack")) { playback.sleepAfterCurrentTrack() }
            Button(L10n("macPodcastPlayer.cancelSleepTimer")) { playback.cancelSleepTimer() }
        } label: {
            if iconOnly {
                Image(systemName: isActive ? "moon.fill" : "moon.zzz")
                    .font(.system(size: 15))
                    .foregroundStyle(isActive ? MacTheme.accentDeep : MacTheme.muted)
                    .frame(width: 28, height: 30)
            } else {
                Label {
                    if let end = playback.sleepTimerEnd {
                        Text(L10n("macPodcastPlayer.sleepAtTime", end.formatted(date: .omitted, time: .shortened)))
                    } else {
                        Text(playback.pauseAfterCurrentTrack ? (podcast ? L10n("macPodcastPlayer.sleepAfterEpisodeEnd") : L10n("macPodcastPlayer.sleepAfterTrackEnd")) : L10n("macPodcastPlayer.sleepTimerDefault"))
                    }
                } icon: {
                    Image(systemName: isActive ? "moon.fill" : "moon")
                }
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(L10n("macPodcastPlayer.sleepTimer"))
        .accessibilityLabel(L10n("macPodcastPlayer.sleepTimer"))
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
