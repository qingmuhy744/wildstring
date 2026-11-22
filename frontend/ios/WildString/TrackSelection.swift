import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
@Observable
final class TrackSelection {
    private(set) var isActive = false
    private(set) var tracks: [Track] = []
    private(set) var ids: Set<String> = []
    private var revision = 0

    func start() { isActive = true }

    func toggle(_ track: Track) {
        guard track.isAvailable else { return }
        start()
        if ids.remove(track.id) != nil {
            tracks.removeAll { $0.id == track.id }
        } else {
            ids.insert(track.id)
            tracks.append(track)
        }
    }

    func selectAll(using load: () async throws -> [Track]) async throws {
        let revision = self.revision
        let loaded = try await load()
        guard revision == self.revision, isActive else { return }
        var seen = Set<String>()
        tracks = loaded.filter { $0.isAvailable && seen.insert($0.id).inserted }
        ids = seen
    }

    func finish() {
        revision += 1
        isActive = false
        tracks = []
        ids = []
    }
}

private struct TrackSelectionKey: EnvironmentKey {
    static let defaultValue: TrackSelection? = nil
}

extension EnvironmentValues {
    var trackSelection: TrackSelection? {
        get { self[TrackSelectionKey.self] }
        set { self[TrackSelectionKey.self] = newValue }
    }
}

struct TrackSelectionControls: ViewModifier {
    let client: WildstringClient
    let selection: TrackSelection
    let loadAll: () async throws -> [Track]

    @Environment(OfflineModel.self) private var offline
    @State private var busy = false
    @State private var showingPlaylists = false
    @State private var confirmationCount: Int?
    @State private var error: String?

    func body(content: Content) -> some View {
        content
            .environment(\.trackSelection, selection)
            .safeAreaInset(edge: .top, spacing: 0) {
                if selection.isActive {
                    HStack(spacing: 8) {
                        Button {
                            selection.finish()
                        } label: {
                            Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
                        }
                        .accessibilityLabel(L10n("trackAction.cancel"))
                        Text(L10n("bulk.selected", selection.ids.count))
                            .monospacedDigit()
                        Spacer()
                        if busy { ProgressView() }
                        Menu(L10n("bulk.actions"), systemImage: "ellipsis.circle") {
                            Button(L10n("bulk.selectAll"), systemImage: "checkmark.circle") {
                                Task { await selectAll() }
                            }
                            Button(L10n("trackAction.addToPlaylist"), systemImage: "text.badge.plus") {
                                showingPlaylists = true
                            }
                            .disabled(selection.ids.isEmpty)
                            Button(L10n("trackAction.download"), systemImage: "arrow.down.circle") {
                                Task { await saveOffline(confirmed: false) }
                            }
                            .disabled(selection.ids.isEmpty)
                        }
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(busy)
                    }
                    .padding(.horizontal)
                    .tint(.wildAccentText)
                    .background(.bar)
                }
            }
            .sheet(isPresented: $showingPlaylists) {
                AddToPlaylistSheet(client: client, trackIDs: selection.tracks.map(\.id)) {
                    selection.finish()
                }
            }
            .alert(
                L10n("bulk.confirm", confirmationCount ?? 0),
                isPresented: Binding(get: { confirmationCount != nil }, set: { if !$0 { confirmationCount = nil } })
            ) {
                Button(L10n("trackAction.download")) { Task { await saveOffline(confirmed: true) } }
                Button(L10n("trackAction.cancel"), role: .cancel) {}
            }
            .alert(L10n("bulk.actionFailed"), isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button(L10n("queueView.close"), role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
    }

    private func selectAll() async {
        busy = true
        defer { busy = false }
        do {
            try await selection.selectAll(using: loadAll)
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func saveOffline(confirmed: Bool) async {
        busy = true
        defer { busy = false }
        do {
            switch try await offline.download(selection.tracks, confirmed: confirmed) {
            case .started:
                selection.finish()
            case .confirmationRequired(let count):
                confirmationCount = count
            }
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}
