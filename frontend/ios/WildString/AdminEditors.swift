import CoreNetwork
import SwiftUI

@MainActor
struct MetadataEditView: View {
    let client: WildstringClient
    let track: Track

    @Environment(\.dismiss) private var dismiss
    @State private var metadata: ManagedMetadata?
    @State private var title = ""
    @State private var artists = ""
    @State private var album = ""
    @State private var albumArtists = ""
    @State private var trackNumber = ""
    @State private var discNumber = ""
    @State private var description = ""
    @State private var isSaving = false
    @State private var message: String?
    @State private var messageIsError = false

    var body: some View {
        NavigationStack {
            Form {
                if metadata != nil {
                    Section(L10n("adminEdit.trackSection")) {
                        TextField(L10n("adminEdit.titlePlaceholder"), text: $title)
                        TextField(L10n("adminEdit.artistsPlaceholder"), text: $artists)
                        TextField(L10n("adminEdit.albumPlaceholder"), text: $album)
                        TextField(L10n("adminEdit.albumArtistsPlaceholder"), text: $albumArtists)
                    }
                    Section(L10n("adminEdit.numberingSection")) {
                        TextField(L10n("adminEdit.trackNumberPlaceholder"), text: $trackNumber)
                            .keyboardType(.numberPad)
                        TextField(L10n("adminEdit.discNumberPlaceholder"), text: $discNumber)
                            .keyboardType(.numberPad)
                    }
                    Section(L10n("adminEdit.descriptionSection")) {
                        TextField(L10n("adminEdit.descriptionPlaceholder"), text: $description, axis: .vertical)
                            .lineLimit(2...6)
                    }
                    if let message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(messageIsError ? .red : .green)
                    }
                    Section {
                        Text(L10n("adminEdit.metadataNotice"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else if let message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(L10n("adminEdit.metadataTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n("adminEdit.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n("adminEdit.save")) { Task { await save() } }
                        .disabled(metadata == nil || isSaving)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            let loaded = try await client.manageMetadata(trackID: track.id)
            metadata = loaded
            let fields = loaded.observed
            title = fields.title ?? ""
            artists = (fields.artists ?? []).joined(separator: L10n("adminEdit.listSeparator"))
            album = fields.album ?? ""
            albumArtists = (fields.albumArtists ?? []).joined(separator: L10n("adminEdit.listSeparator"))
            trackNumber = fields.trackNumber.map(String.init) ?? ""
            discNumber = fields.discNumber.map(String.init) ?? ""
            description = fields.description ?? ""
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func save() async {
        guard let current = metadata, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        var overrides = MetadataOverrides()
        if title != (current.observed.title ?? ""), !title.isEmpty {
            overrides.title = title
        }
        let artistList = splitList(artists)
        if !artistList.isEmpty, artistList != (current.observed.artists ?? []) {
            overrides.artists = artistList
        }
        if album != (current.observed.album ?? ""), !album.isEmpty {
            overrides.album = album
        }
        let albumArtistList = splitList(albumArtists)
        if !albumArtistList.isEmpty, albumArtistList != (current.observed.albumArtists ?? []) {
            overrides.albumArtists = albumArtistList
        }
        if let number = Int(trackNumber), number != current.observed.trackNumber {
            overrides.trackNumber = number
        }
        if let number = Int(discNumber), number != current.observed.discNumber {
            overrides.discNumber = number
        }
        if description != (current.observed.description ?? "") {
            overrides.description = description
        }
        do {
            let updated = try await client.updateMetadata(
                trackID: track.id,
                version: current.version,
                overrides: overrides
            )
            metadata = updated
            message = L10n("adminEdit.savedMessage")
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = L10n("adminEdit.metadataConflictMessage")
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func splitList(_ text: String) -> [String] {
        text.split(whereSeparator: { "、,，/".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

@MainActor
struct LyricsEditView: View {
    let client: WildstringClient
    let track: Track

    @Environment(\.dismiss) private var dismiss
    @State private var record: ManagedLyrics?
    @State private var text = ""
    @State private var isSaving = false
    @State private var message: String?
    @State private var messageIsError = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if record != nil {
                    TextEditor(text: $text)
                        .font(.system(.footnote, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    if let message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(messageIsError ? .red : .green)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 6)
                            .background(.bar)
                    }
                } else if let message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(16)
                    Spacer()
                } else {
                    ProgressView()
                    Spacer()
                }
            }
            .navigationTitle(L10n("adminEdit.lyricsTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n("adminEdit.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu(L10n("adminEdit.save")) {
                        Button(L10n("adminEdit.saveCurrentLyrics")) { Task { await save(text: text) } }
                        Button(L10n("adminEdit.revertToFileLyrics"), role: .destructive) {
                            Task { await save(text: nil) }
                        }
                    }
                    .disabled(record == nil || isSaving)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            let loaded = try await client.managedLyrics(trackID: track.id)
            record = loaded
            text = loaded.override ?? loaded.observedText
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func save(text value: String?) async {
        guard let current = record, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await client.saveLyrics(
                trackID: track.id,
                text: value,
                version: current.version,
                fileVersion: current.fileVersion
            )
            record = updated
            text = updated.override ?? updated.observedText
            message = value == nil ? L10n("adminEdit.revertedMessage") : L10n("adminEdit.savedMessage")
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = L10n("adminEdit.lyricsConflictMessage")
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }
}
