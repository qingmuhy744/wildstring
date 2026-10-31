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

struct MacLyricScroll: View {
    let playback: PlaybackService
    let timeline: LyricTimeline?
    var empty: String
    var prominent = false
    @AppStorage("lyricsShowTranslation") private var showTranslation = true
    @AppStorage("lyricsShowRomanization") private var showRomanization = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !playback.isPlaying)) { _ in
            lyrics(at: playback.lyricTime)
        }
    }

    private func lyrics(at time: Double) -> some View {
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: prominent ? .center : .leading, spacing: prominent ? 28 : 20) {
                        if let timeline, !timeline.isEmpty {
                            let current = timeline.currentIndex(at: time)
                            ForEach(Array(timeline.lines.enumerated()), id: \.offset) { index, line in
                                Button {
                                    if let time = line.time { playback.seek(to: time) }
                                } label: {
                                    VStack(alignment: prominent ? .center : .leading, spacing: 9) {
                                        MacTimedLyricText(
                                            line: line, time: time, active: index == current,
                                            font: prominent ? .system(size: 30, weight: .semibold) : .system(size: 18, weight: .medium),
                                            highlight: prominent ? .primary : MacTheme.accentDeep,
                                            inactive: prominent ? .primary.opacity(index == current ? 0.48 : 0.42) : .secondary,
                                            centered: prominent
                                        )
                                        if showTranslation, let text = line.translation, !text.isEmpty {
                                            Text(text).font(prominent ? .body : .caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        if showRomanization, let text = line.romanization, !text.isEmpty {
                                            Text(text).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    .multilineTextAlignment(prominent ? .center : .leading)
                                    .frame(maxWidth: .infinity, alignment: prominent ? .center : .leading)
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
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, prominent ? 28 : 20)
                    .padding(.bottom, prominent ? max(40, geo.size.height / 2 - 35) : 20)
                    .padding(.horizontal, prominent ? 20 : 0)
                }
                .scrollIndicators(.hidden)
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
                .task(id: timeline?.lines.count) {
                    if let index = timeline?.currentIndex(at: time) {
                        await Task.yield()
                        proxy.scrollTo(index < 3 ? 0 : index, anchor: index < 3 ? .top : .center)
                    }
                }
                .onChange(of: timeline?.currentIndex(at: time)) { _, index in
                    guard let index else { return }
                    Task { @MainActor in
                        withAnimation(.easeOut(duration: 0.35)) {
                            proxy.scrollTo(index < 3 ? 0 : index, anchor: index < 3 ? .top : .center)
                        }
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}
