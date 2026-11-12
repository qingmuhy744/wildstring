import CoreNetwork
import SwiftUI

struct MacManageView: View {
    let client: WildstringClient

    @State private var scans: [ScanRecord] = []
    @State private var imports: [ImportRecord] = []
    @State private var message: String?
    @State private var loading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L10n("macManage.title")).font(.title2.bold())
                        Text(L10n("macManage.subtitle"))
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Link(destination: client.server.url) {
                        Label(L10n("macManage.openWeb"), systemImage: "arrow.up.right.square")
                    }.buttonStyle(.bordered)
                }
                if let message {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                }
                if loading, imports.isEmpty, scans.isEmpty {
                    ProgressView(L10n("macManage.loadingRecords")).frame(maxWidth: .infinity).padding(24)
                } else {
                    recordSection(L10n("macManage.importRecords"), count: imports.count) {
                        ForEach(imports) { record in
                            MacTaskRecordCard(status: record.status ?? "unknown", startedAt: record.startedAt,
                                summary: importSummary(record.counts ?? [:]), errors: record.errors ?? [])
                        }
                    }
                    recordSection(L10n("macManage.scanRecords"), count: scans.count) {
                        ForEach(scans) { record in
                            MacTaskRecordCard(status: record.status, startedAt: record.startedAt,
                                summary: record.counts.map(scanSummary) ?? L10n("macManage.noStats"), errors: record.errors ?? [])
                        }
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .navigationTitle(L10n("macManage.navTitle"))
        .toolbar {
            MacToolbarIconButton(systemImage: "arrow.clockwise", help: L10n("macManage.refreshRecords"), isDisabled: loading) { Task { await load() } }
        }
        .task { await load() }
    }

    private func recordSection<Content: View>(_ title: String, count: Int, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.headline)
                Text(L10n("macManage.recentItems", count)).font(.caption).foregroundStyle(.secondary)
            }
            if count == 0 {
                Text(message == nil ? L10n("macManage.noRecordsYet") : L10n("macManage.recordsUnavailable"))
                    .font(.callout).foregroundStyle(.secondary).padding(.vertical, 12)
            }
            content()
        }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            async let newImports = client.imports(limit: 20)
            async let newScans = client.scans(limit: 20)
            (imports, scans) = try await (newImports, newScans)
            message = nil
        } catch {
            message = MacErrorText.message(for: error)
        }
    }

    private func scanSummary(_ counts: ScanCounts) -> String {
        var parts: [String] = []
        if let visited = counts.visited { parts.append(L10n("macManage.scanVisited", visited)) }
        if let added = counts.added, added > 0 { parts.append(L10n("macManage.scanAdded", added)) }
        if let updated = counts.updated, updated > 0 { parts.append(L10n("macManage.scanUpdated", updated)) }
        if let unchanged = counts.unchanged, unchanged > 0 { parts.append(L10n("macManage.scanUnchanged", unchanged)) }
        if let missing = counts.missing, missing > 0 { parts.append(L10n("macManage.scanMissing", missing)) }
        if let skipped = counts.skipped, skipped > 0 { parts.append(L10n("macManage.scanSkipped", skipped)) }
        if let errors = counts.errors, errors > 0 { parts.append(L10n("macManage.scanErrors", errors)) }
        return parts.isEmpty ? L10n("macManage.noTrackChanges") : parts.joined(separator: " · ")
    }

    private func importSummary(_ counts: [String: Int]) -> String {
        let labels = [("copied", L10n("macManage.importCopied")), ("converted", L10n("macManage.importConverted")), ("unchanged", L10n("macManage.importUnchanged")),
            ("duplicates", L10n("macManage.importDuplicates")), ("assets_copied", L10n("macManage.importAssetsCopied")), ("review", L10n("macManage.importReview")),
            ("waiting", L10n("macManage.importWaiting")), ("skipped", L10n("macManage.importSkipped")), ("conflicts", L10n("macManage.importConflicts")), ("errors", L10n("macManage.importErrors"))]
        let parts = labels.compactMap { key, label -> String? in
            guard let value = counts[key], value > 0 else { return nil }
            return "\(label) \(value)"
        }
        return parts.isEmpty ? L10n("macManage.noFileChanges") : parts.joined(separator: " · ")
    }
}

private struct MacTaskRecordCard: View {
    let status: String
    let startedAt: String?
    let summary: String
    let errors: [ScanErrorDetail]

    private var statusText: String {
        let labels = [
            "completed": L10n("macManage.statusCompleted"),
            "completed_with_errors": L10n("macManage.statusCompletedWithErrors"),
            "failed": L10n("macManage.statusFailed"),
            "running": L10n("macManage.statusRunning"),
            "queued": L10n("macManage.statusQueued"),
            "interrupted": L10n("macManage.statusInterrupted"),
            "cancelled": L10n("macManage.statusCancelled")
        ]
        return labels[status] ?? status
    }

    private var statusColor: Color {
        if status == "completed" { return .secondary }
        if status == "running" || status == "queued" { return MacTheme.accentDeep }
        return .orange
    }

    private var dateText: String {
        guard let startedAt else { return L10n("macManage.timeNotProvided") }
        let formatter = ISO8601DateFormatter()
        var date = formatter.date(from: startedAt)
        if date == nil {
            formatter.formatOptions.insert(.withFractionalSeconds)
            date = formatter.date(from: startedAt)
        }
        return date?.formatted(date: .abbreviated, time: .shortened) ?? startedAt
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(statusText).font(.callout.weight(.semibold)).foregroundStyle(statusColor)
                Spacer()
                Text(dateText).font(.caption).foregroundStyle(.secondary)
            }
            Text(summary).font(.callout).foregroundStyle(.secondary)
            if !errors.isEmpty {
                DisclosureGroup(L10n("macManage.viewErrors", errors.count)) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(error.message ?? error.code ?? L10n("macManage.processingFailed"))
                                if let path = error.path { Text(path).foregroundStyle(.secondary) }
                            }.font(.caption).textSelection(.enabled)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                }.font(.caption)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct MacMetadataSheet: View {
    let client: WildstringClient
    let track: Track

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var artists = ""
    @State private var album = ""
    @State private var version = 0
    @State private var ready = false
    @State private var saving = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("macManage.trackInfo"))
                .font(.title3.bold())
            Text(L10n("macManage.trackInfoNote"))
                .font(.callout)
                .foregroundStyle(.secondary)
            TextField(L10n("macManage.fieldTitle"), text: $title)
                .textFieldStyle(.roundedBorder)
            TextField(L10n("macManage.fieldArtists"), text: $artists)
                .textFieldStyle(.roundedBorder)
            TextField(L10n("macManage.fieldAlbum"), text: $album)
                .textFieldStyle(.roundedBorder)
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button(L10n("macManage.cancel"), role: .cancel) { dismiss() }
                Button(saving ? L10n("macManage.saving") : L10n("macManage.save")) { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .tint(MacTheme.accentDeep)
                    .disabled(!ready || saving || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 440)
        .task { await load() }
    }

    private func load() async {
        do {
            let metadata = try await client.manageMetadata(trackID: track.id)
            let fields = metadata.effective
            title = fields.title ?? track.title
            artists = (fields.artists ?? track.artists).joined(separator: " / ")
            album = fields.album ?? track.album ?? ""
            version = metadata.version
            ready = true
            message = nil
        } catch {
            message = MacErrorText.message(for: error)
        }
    }

    private func save() async {
        guard ready, !saving else { return }
        saving = true
        defer { saving = false }
        var overrides = MetadataOverrides()
        overrides.title = title.trimmingCharacters(in: .whitespaces)
        overrides.artists = artists
            .split(separator: "/")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        overrides.album = album.trimmingCharacters(in: .whitespaces)
        do {
            _ = try await client.updateMetadata(trackID: track.id, version: version, overrides: overrides)
            dismiss()
        } catch {
            message = MacErrorText.message(for: error)
        }
    }
}
