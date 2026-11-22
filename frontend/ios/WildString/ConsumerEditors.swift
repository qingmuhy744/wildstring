import CoreNetwork
import SwiftUI

struct AlbumTagsView: View {
    let client: WildstringClient
    let albumID: String
    let saved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var record: EditableAlbum?
    @State private var title = ""
    @State private var artists = ""
    @State private var release = ""
    @State private var label = ""
    @State private var catalog = ""
    @State private var notes = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if record != nil {
                    TextField(L10n("adminEdit.albumPlaceholder"), text: $title)
                    TextField(L10n("adminEdit.albumArtistsPlaceholder"), text: $artists)
                    TextField(L10n("consumer.releaseDate"), text: $release)
                    TextField(L10n("consumer.label"), text: $label)
                    TextField(L10n("consumer.catalogNumber"), text: $catalog)
                    TextField(L10n("adminEdit.descriptionSection"), text: $notes, axis: .vertical)
                } else if error == nil {
                    ProgressView()
                }
                if let error {
                    Text(error).foregroundStyle(.secondary)
                    Button(L10n("notifications.retry")) { Task { await load() } }
                }
            }
            .disabled(busy)
            .navigationTitle(L10n("consumer.editAlbum"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L10n("adminEdit.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n("adminEdit.save")) { Task { await save() } }
                        .disabled(busy || record == nil || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await client.editableAlbum(id: albumID)
            if record == nil || title == record?.title { title = result.title }
            if record == nil || artists == record?.artists.joined(separator: " / ") {
                artists = result.artists.joined(separator: " / ")
            }
            if record == nil || release == record?.releaseDate { release = result.releaseDate }
            if record == nil || label == record?.label { label = result.label }
            if record == nil || catalog == record?.catalogNumber { catalog = result.catalogNumber }
            if record == nil || notes == record?.description { notes = result.description }
            record = result
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func save() async {
        guard let record, !busy else { return }
        busy = true
        defer { busy = false }
        var edits = AlbumTagEdits()
        if title != record.title { edits.album = title.trimmingCharacters(in: .whitespacesAndNewlines) }
        let names = artists.split(separator: "/").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if artists != record.artists.joined(separator: " / ") { edits.albumArtists = names }
        if release != record.releaseDate { edits.releaseDate = release }
        if label != record.label { edits.label = label }
        if catalog != record.catalogNumber { edits.catalogNumber = catalog }
        if notes != record.description { edits.description = notes }
        do {
            let id = try await client.saveAlbum(record, edits: edits)
            saved(id)
            dismiss()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct PlaylistRulesView: View {
    let client: WildstringClient
    var playlist: Playlist?
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var record: Playlist?
    @State private var name = ""
    @State private var smart = false
    @State private var advanced = false
    @State private var rules = ""
    @State private var favoritesOnly = true
    @State private var artist = ""
    @State private var unplayedDays = "30"
    @State private var busy = false
    @State private var ready = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if ready {
                    TextField(L10n("trackAction.playlistName"), text: $name)
                    if playlist == nil {
                        Toggle(L10n("consumer.smartPlaylist"), isOn: $smart)
                    }
                    if smart {
                        Toggle(L10n("consumer.advancedRules"), isOn: $advanced)
                            .onChange(of: advanced) { _, enabled in
                                if enabled, rules.isEmpty { rules = (try? simpleRules()) ?? "" }
                            }
                        if advanced {
                            TextEditor(text: $rules)
                                .font(.body.monospaced())
                                .frame(minHeight: 160)
                                .autocorrectionDisabled()
                                .accessibilityLabel(L10n("consumer.advancedRules"))
                        } else {
                            Toggle(L10n("consumer.onlyFavorites"), isOn: $favoritesOnly)
                            TextField(L10n("consumer.artistContains"), text: $artist)
                            TextField(L10n("consumer.unplayedDays"), text: $unplayedDays)
                                .keyboardType(.numberPad)
                        }
                    }
                } else if error == nil {
                    ProgressView()
                }
                if let error {
                    Text(error).foregroundStyle(.secondary)
                    if !ready {
                        Button(L10n("notifications.retry")) { Task { await load() } }
                    }
                }
            }
            .disabled(busy)
            .navigationTitle(playlist == nil ? L10n("account.newPlaylist") : L10n("consumer.editPlaylist"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L10n("adminEdit.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n("adminEdit.save")) { Task { await save() } }
                        .disabled(!ready || busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        guard let playlist else { ready = true; return }
        do {
            let (current, definition) = try await client.playlistWithRules(id: playlist.id)
            record = current
            name = current.name
            smart = current.isSmart
            advanced = current.isSmart
            rules = definition ?? ""
            ready = true
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func save() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let definition: String?
            if !smart {
                definition = nil
            } else if advanced {
                let source = rules.isEmpty ? try simpleRules() : rules
                guard (try? JSONSerialization.jsonObject(with: Data(source.utf8))) is [String: Any] else {
                    error = L10n("consumer.invalidRules")
                    return
                }
                definition = source
            } else {
                definition = try simpleRules()
            }
            _ = try await client.saveUserPlaylist(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines), previous: record, rules: definition
            )
            saved()
            dismiss()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func simpleRules() throws -> String {
        var rules: [SmartRule] = []
        if favoritesOnly { rules.append(SmartRule(operator: "is", field: "loved", value: .bool(true))) }
        let text = artist.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { rules.append(SmartRule(operator: "contains", field: "artist", value: .string(text))) }
        if let days = Int(unplayedDays), days > 0 {
            rules.append(SmartRule(operator: "notInTheLast", field: "lastPlayed", value: .number(Double(days))))
        }
        guard !rules.isEmpty else { throw APIError(statusCode: 422, code: "invalid_playlist_rules") }
        let result = try JSONEncoder().encode(SmartDefinition(match: "all", rules: rules, sort: "lastPlayed", order: "asc", limit: 100))
        return String(decoding: result, as: UTF8.self)
    }
}

struct OnlineLyricsView: View {
    let client: WildstringClient
    let trackID: String
    let applied: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var result: OnlineLyricResults?
    @State private var selected: OnlineLyricCandidate?
    @State private var offset = "0"
    @State private var error: String?
    @State private var busy = false
    @State private var loading = true
    private var searching: Bool { result?.jobs.contains { ["queued", "running"].contains($0.status) } ?? false }

    var body: some View {
        NavigationStack {
            List {
                Button(L10n("consumer.searchLyrics"), systemImage: "magnifyingglass") {
                    Task { await search() }
                }
                .disabled(busy || searching)
                if loading || searching { ProgressView() }
                if !loading, result?.items.isEmpty == true, !searching {
                    ContentUnavailableView(L10n("consumer.noLyricsCandidates"), systemImage: "text.quote")
                }
                if let error {
                    Text(error).foregroundStyle(.secondary)
                    Button(L10n("notifications.retry")) { Task { await load() } }
                } else if let failure = result?.jobs.first(where: { $0.status == "failed" })?.error,
                          !failure.isEmpty {
                    Text(failure).foregroundStyle(.secondary)
                }
                ForEach(result?.items ?? []) { candidate in
                    Button {
                        offset = "0"
                        selected = candidate
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(candidate.provider ?? L10n("consumer.preview"))
                            Text(candidate.normalized.lines.first?.text ?? "")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle(L10n("consumer.searchLyrics"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L10n("queueView.close")) { dismiss() } }
            }
            .task { await load() }
            .task(id: searching) {
                while searching, !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                    await load()
                }
            }
            .sheet(item: $selected) { candidate in
                NavigationStack {
                    List {
                        TextField(L10n("consumer.lyricOffset"), text: $offset).keyboardType(.numbersAndPunctuation)
                        if let error { Text(error).foregroundStyle(.secondary) }
                        ForEach(Array(candidate.normalized.lines.enumerated()), id: \.offset) { _, line in
                            VStack(alignment: .leading) {
                                Text(line.text)
                                if let translation = line.translation { Text(translation).foregroundStyle(.secondary) }
                                if let romanization = line.romanization { Text(romanization).foregroundStyle(.secondary) }
                            }
                        }
                    }
                    .navigationTitle(L10n("consumer.preview"))
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button(L10n("adminEdit.cancel")) { selected = nil } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button(L10n("consumer.useLyrics")) {
                                Task { await apply(candidate) }
                            }
                            .disabled(busy || Int(offset).map { !(-60000...60000).contains($0) } != false)
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        defer { loading = false }
        do {
            result = try await client.onlineLyrics(trackID: trackID)
            error = nil
        } catch {
            if !Task.isCancelled { self.error = ErrorText.message(for: error) }
        }
    }

    private func search() async {
        busy = true
        defer { busy = false }
        do {
            try await client.searchOnlineLyrics(trackID: trackID)
            await load()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func apply(_ candidate: OnlineLyricCandidate) async {
        guard let value = Int(offset), !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.applyOnlineLyrics(candidate, offset: value)
            applied()
            selected = nil
            dismiss()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}
