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
                    Section("曲目") {
                        TextField("标题", text: $title)
                        TextField("艺人（用「、」分隔）", text: $artists)
                        TextField("专辑", text: $album)
                        TextField("专辑艺人（用「、」分隔）", text: $albumArtists)
                    }
                    Section("编号") {
                        TextField("音轨号", text: $trackNumber)
                            .keyboardType(.numberPad)
                        TextField("碟号", text: $discNumber)
                            .keyboardType(.numberPad)
                    }
                    Section("简介") {
                        TextField("简介", text: $description, axis: .vertical)
                            .lineLimit(2...6)
                    }
                    if let message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(messageIsError ? .red : .green)
                    }
                    Section {
                        Text("修改只保存到服务端数据库，不写入音频文件与导入源。")
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
            .navigationTitle("编辑元数据")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { Task { await save() } }
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
            artists = (fields.artists ?? []).joined(separator: "、")
            album = fields.album ?? ""
            albumArtists = (fields.albumArtists ?? []).joined(separator: "、")
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
            message = "已保存"
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = "元数据已在别处更新，已刷新，请重试"
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
            .navigationTitle("编辑歌词")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("保存") {
                        Button("保存当前内容") { Task { await save(text: text) } }
                        Button("恢复为文件歌词", role: .destructive) {
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
            message = value == nil ? "已恢复为文件歌词" : "已保存"
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = "歌词已在别处更新，已刷新，请重试"
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }
}
