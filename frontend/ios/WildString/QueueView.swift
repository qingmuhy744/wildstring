import CoreNetwork
import CorePlayback
import SwiftUI

/// Current playback queue with jump, drag reorder and swipe removal.
@MainActor
struct QueueView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(playback.items.enumerated()), id: \.element.id) { index, item in
                    Button {
                        Haptics.tap()
                        playback.playQueueEntry(at: index)
                    } label: {
                        HStack(spacing: 10) {
                            CoverImage(client: client, trackID: item.trackID, size: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title)
                                    .font(.subheadline)
                                    .lineLimit(1)
                                    .foregroundStyle(
                                        playback.currentIndex == index
                                            ? Color.wildAccent : Color.primary
                                    )
                                Text(item.artist)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            if playback.currentIndex == index {
                                Image(systemName: "speaker.wave.2.fill")
                                    .font(.caption)
                                    .foregroundStyle(Color.wildAccent)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
                .onMove { offsets, destination in
                    playback.moveQueueEntries(fromOffsets: offsets, toOffset: destination)
                }
                .onDelete { offsets in
                    for index in offsets.sorted(by: >) where index != playback.currentIndex {
                        playback.removeQueueEntry(at: index)
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("播放队列")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    EditButton()
                }
            }
        }
    }
}
