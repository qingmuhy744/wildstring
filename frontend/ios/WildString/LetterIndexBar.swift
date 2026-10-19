import CoreNetwork
import SwiftUI

/// Right-edge alphabetical index with drag tracking and selection haptics.
struct LetterIndexBar: View {
    let groups: [BrowseGroup]
    let onSelect: (BrowseGroup) -> Void

    @State private var activeIndex: Int?

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
                    Text(group.key)
                        .font(.system(size: 9, weight: index == activeIndex ? .bold : .regular))
                        .foregroundStyle(color(for: group, active: index == activeIndex))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard !groups.isEmpty else { return }
                        let rowHeight = geometry.size.height / CGFloat(groups.count)
                        let index = min(
                            max(0, Int(value.location.y / rowHeight)),
                            groups.count - 1
                        )
                        if index != activeIndex {
                            activeIndex = index
                            if groups[index].offset != nil {
                                Haptics.selection()
                            }
                        }
                    }
                    .onEnded { _ in
                        defer { activeIndex = nil }
                        guard let index = activeIndex, groups.indices.contains(index) else {
                            return
                        }
                        let group = groups[index]
                        guard group.offset != nil else { return }
                        onSelect(group)
                    }
            )
        }
        .frame(width: 22)
        .padding(.vertical, 8)
    }

    private func color(for group: BrowseGroup, active: Bool) -> Color {
        if group.offset == nil { return .secondary.opacity(0.35) }
        return active ? .accentColor : .secondary
    }
}
