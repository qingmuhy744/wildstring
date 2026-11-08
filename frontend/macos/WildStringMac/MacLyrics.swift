import CorePlayback
import SwiftUI

/// A word keeps its own timing and mask; the flow layout wraps long lyric lines.
struct MacTimedLyricText: View {
    let line: LyricTimeline.Line
    let time: Double
    var active = true
    var font: Font = .title3
    var highlight = MacTheme.accent
    var inactive = Color.secondary
    var centered = false
    @AppStorage("lyricsWordHighlight") private var wordHighlight = true

    var body: some View {
        Group {
            if line.words.isEmpty || !wordHighlight {
                Text(line.text.isEmpty ? "♪" : line.text)
                    .foregroundStyle(active ? highlight : inactive)
                    .multilineTextAlignment(centered ? .center : .leading)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                MacLyricFlow(centered: centered) {
                    ForEach(Array(line.words.enumerated()), id: \.offset) { _, word in
                        Text(word.text)
                            .multilineTextAlignment(centered ? .center : .leading)
                            .foregroundStyle(inactive)
                            .overlay(alignment: .leading) {
                                if active {
                                    Text(word.text)
                                        .multilineTextAlignment(centered ? .center : .leading)
                                        .foregroundStyle(highlight)
                                        .mask {
                                            GeometryReader { geo in
                                                Rectangle().frame(width: geo.size.width * word.progress(at: time))
                                            }
                                        }
                                }
                            }
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .font(font)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.text)
    }
}

private struct MacLyricFlow: Layout {
    var centered: Bool
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width }
        let rows = rows(subviews, width: width)
        let height = rows.reduce(0) { $0 + $1.height } + CGFloat(max(0, rows.count - 1)) * lineSpacing
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            var x = bounds.minX + (centered ? max(0, (bounds.width - row.width) / 2) : 0)
            for index in row.indices {
                let size = subviews[index].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var result: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
            if !row.indices.isEmpty, row.width + size.width > width {
                result.append(row)
                row = Row()
            }
            row.indices.append(index)
            row.width += size.width
            row.height = max(row.height, size.height)
        }
        if !row.indices.isEmpty { result.append(row) }
        return result
    }
}

enum LyricPhase: Equatable {
    case loading
    case ready
    case failed
}

struct MacLyricScroll: View {
    let playback: PlaybackService
    let timeline: LyricTimeline?
    var empty: String
    var prominent = false
    var phase: LyricPhase = .ready
    var onRetry: () -> Void = {}
    @AppStorage("lyricsShowTranslation") private var showTranslation = true
    @AppStorage("lyricsShowRomanization") private var showRomanization = false
    @State private var isFollowing = true
    @State private var browsing = false
    @State private var browseToken = 0
    @State private var contentHeight: CGFloat = 0
    @State private var programmaticUntil = Date.distantPast

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !playback.isPlaying)) { _ in
            lyrics(at: playback.lyricTime)
        }
        .task(id: "\(browseToken)-\(playback.isPlaying)-\(isFollowing)-\(browsing)") {
            guard !isFollowing, !browsing, playback.isPlaying, timeline?.isSynced == true else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            isFollowing = true
        }
        .onChange(of: playback.currentItem?.id) { _, _ in
            isFollowing = true
            browseToken += 1
        }
    }

    private func pauseFollow() {
        guard timeline?.isSynced == true else { return }
        if Date() < programmaticUntil { return }
        isFollowing = false
        browsing = true
        browseToken += 1
    }

    private func settleFollow() {
        browsing = false
        browseToken += 1
    }

    private func reveal(_ index: Int, proxy: ScrollViewProxy, animated: Bool) {
        programmaticUntil = Date().addingTimeInterval(animated ? 0.45 : 0.05)
        let action = { proxy.scrollTo(index, anchor: UnitPoint.center) }
        if animated {
            withAnimation(.easeOut(duration: 0.35), action)
        } else {
            action()
        }
    }

    private func lyrics(at time: Double) -> some View {
        GeometryReader { geo in
            let viewport = geo.size.height
            let topMin: CGFloat = 24
            let short = contentHeight > 0 && contentHeight <= viewport - topMin * 2
            let pad = short ? max(topMin, (viewport - contentHeight) / 2) : topMin
            let current = timeline?.currentIndex(at: time)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .center, spacing: prominent ? 26 : 22) {
                        if phase == .loading {
                            ProgressView("正在读取歌词")
                                .frame(maxWidth: .infinity)
                        } else if phase == .failed {
                            VStack(spacing: 12) {
                                Text("暂时无法读取歌词。网络恢复后可以重试。")
                                    .font(.callout)
                                    .multilineTextAlignment(.center)
                                Button("重新读取", action: onRetry)
                            }
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                        } else if let timeline, !timeline.isEmpty {
                            ForEach(Array(timeline.lines.enumerated()), id: \.offset) { index, line in
                                Button {
                                    if let time = line.time {
                                        playback.seek(to: time)
                                        isFollowing = true
                                    }
                                } label: {
                                    VStack(alignment: .center, spacing: 7) {
                                        MacTimedLyricText(
                                            line: line, time: time, active: index == current,
                                            font: .system(size: prominent ? min(27, max(22, geo.size.width * 0.045)) : 16, weight: .medium),
                                            highlight: prominent ? .primary : MacTheme.accentDeep,
                                            inactive: .secondary,
                                            centered: true
                                        )
                                        if showTranslation, let text = line.translation, !text.isEmpty {
                                            Text(text).font(.system(size: prominent ? 17 : 13))
                                                .foregroundStyle(.secondary)
                                        }
                                        if showRomanization, let text = line.romanization, !text.isEmpty {
                                            Text(text).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    .multilineTextAlignment(.center)
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(line.time == nil)
                                .id(index)
                            }
                        } else {
                            VStack(spacing: 12) {
                                Image(systemName: "quote.bubble").font(.largeTitle)
                                Text(empty).font(.callout)
                            }
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                        }
                    }
                    .background {
                        GeometryReader { content in
                            Color.clear.preference(key: LyricContentHeightKey.self, value: content.size.height)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, pad)
                    .padding(.bottom, short ? pad : viewport / 2)
                    .padding(.horizontal, prominent ? 20 : 0)
                    .background {
                        MacLyricScrollWatch(onBegan: pauseFollow, onEnded: settleFollow)
                    }
                }
                .scrollIndicators(.hidden)
                .onPreferenceChange(LyricContentHeightKey.self) { contentHeight = $0 }
                .mask {
                    if prominent {
                        LinearGradient(stops: [
                            .init(color: .black, location: 0),
                            .init(color: .black, location: 0.86),
                            .init(color: .clear, location: 1)
                        ], startPoint: .top, endPoint: .bottom)
                    } else {
                        Rectangle()
                    }
                }
                .overlay(alignment: .bottom) {
                    if !isFollowing, timeline?.isSynced == true, phase == .ready {
                        Button("回到当前歌词") {
                            isFollowing = true
                            if let current { reveal(current, proxy: proxy, animated: true) }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .padding(.bottom, 12)
                    }
                }
                .task(id: timeline?.lines.count) {
                    guard isFollowing, let index = current, !short else { return }
                    await Task.yield()
                    reveal(index, proxy: proxy, animated: false)
                }
                .onChange(of: current) { _, index in
                    guard isFollowing, let index, !short else { return }
                    reveal(index, proxy: proxy, animated: true)
                }
                .onChange(of: isFollowing) { _, following in
                    guard following, let index = current, !short else { return }
                    reveal(index, proxy: proxy, animated: true)
                }
                .onChange(of: showTranslation) { _, _ in
                    guard isFollowing, let index = current, !short else { return }
                    reveal(index, proxy: proxy, animated: false)
                }
                .onChange(of: showRomanization) { _, _ in
                    guard isFollowing, let index = current, !short else { return }
                    reveal(index, proxy: proxy, animated: false)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

private struct LyricContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// User trackpad and scroll-wheel movement. Programmatic `scrollTo` does not post live-scroll notifications.
private struct MacLyricScrollWatch: NSViewRepresentable {
    var onBegan: () -> Void
    var onEnded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onBegan: onBegan, onEnded: onEnded) }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        context.coordinator.attach(view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onBegan = onBegan
        context.coordinator.onEnded = onEnded
        context.coordinator.attach(nsView)
    }

    @MainActor
    final class Coordinator: NSObject {
        var onBegan: () -> Void
        var onEnded: () -> Void
        private weak var scroll: NSScrollView?

        init(onBegan: @escaping () -> Void, onEnded: @escaping () -> Void) {
            self.onBegan = onBegan
            self.onEnded = onEnded
        }

        deinit { NotificationCenter.default.removeObserver(self) }

        func attach(_ view: NSView) {
            bind(view)
            guard view.enclosingScrollView == nil else { return }
            DispatchQueue.main.async { [weak self, weak view] in
                self?.bind(view)
            }
        }

        private func bind(_ view: NSView?) {
            guard let scroll = view?.enclosingScrollView, scroll !== self.scroll else { return }
            if let previous = self.scroll {
                NotificationCenter.default.removeObserver(
                    self, name: NSScrollView.willStartLiveScrollNotification, object: previous
                )
                NotificationCenter.default.removeObserver(
                    self, name: NSScrollView.didEndLiveScrollNotification, object: previous
                )
            }
            self.scroll = scroll
            NotificationCenter.default.addObserver(
                self, selector: #selector(self.began(_:)),
                name: NSScrollView.willStartLiveScrollNotification, object: scroll
            )
            NotificationCenter.default.addObserver(
                self, selector: #selector(self.ended(_:)),
                name: NSScrollView.didEndLiveScrollNotification, object: scroll
            )
        }

        @objc private func began(_ notification: Notification) { onBegan() }
        @objc private func ended(_ notification: Notification) { onEnded() }
    }
}
