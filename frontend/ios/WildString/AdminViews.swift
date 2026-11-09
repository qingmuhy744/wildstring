import CoreNetwork
import SwiftUI

@MainActor
struct ScansView: View {
    let client: WildstringClient

    @State private var scans: [ScanRecord] = []
    @State private var isLoading = true
    @State private var message: String?

    var body: some View {
        List {
            ForEach(scans) { scan in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(String(scan.id.prefix(8)) + "…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(statusText(scan.status))
                            .font(.caption.bold())
                            .foregroundStyle(statusColor(scan.status))
                    }
                    if let counts = scan.counts {
                        Text(countsText(counts))
                            .font(.caption)
                    }
                    if let started = scan.startedAt {
                        Text(started)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let errors = scan.errors, !errors.isEmpty {
                        Text(L10n("adminView.errorCount", errors.count))
                            .font(.caption)
                            .foregroundStyle(.red)
                        ForEach(Array(errors.prefix(3).enumerated()), id: \.offset) { _, error in
                            Text("· \(error.path ?? error.code ?? error.message ?? L10n("adminView.errorFallback"))")
                                .font(.caption2)
                                .foregroundStyle(.red)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            } else if scans.isEmpty {
                Text(L10n("adminView.noScans"))
                    .foregroundStyle(.secondary)
            }
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .listStyle(.plain)
        .navigationTitle(L10n("adminView.scansTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            scans = try await client.scans()
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }

    private func countsText(_ counts: ScanCounts) -> String {
        var parts: [String] = []
        if let value = counts.visited { parts.append(L10n("adminView.countsVisited", value)) }
        if let value = counts.added { parts.append(L10n("adminView.countsAdded", value)) }
        if let value = counts.updated { parts.append(L10n("adminView.countsUpdated", value)) }
        if let value = counts.missing { parts.append(L10n("adminView.countsMissing", value)) }
        if let value = counts.skipped { parts.append(L10n("adminView.countsSkipped", value)) }
        if let value = counts.errors, value > 0 { parts.append(L10n("adminView.countsErrors", value)) }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    private func statusText(_ status: String) -> String {
        switch status {
        case "running": return L10n("adminView.statusRunning")
        case "completed": return L10n("adminView.statusCompleted")
        case "completed_with_errors": return L10n("adminView.statusCompletedWithErrors")
        case "failed": return L10n("adminView.statusFailed")
        case "interrupted": return L10n("adminView.statusInterrupted")
        default: return status
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "completed": return .green
        case "running": return .blue
        case "completed_with_errors": return .orange
        default: return .red
        }
    }
}

@MainActor
struct ImportsView: View {
    let client: WildstringClient

    @State private var imports: [ImportRecord] = []
    @State private var isLoading = true
    @State private var message: String?

    var body: some View {
        List {
            ForEach(imports) { record in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(String(record.id.prefix(8)) + "…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        if let status = record.status {
                            Text(status)
                                .font(.caption.bold())
                                .foregroundStyle(status == "completed" ? .green : .orange)
                        }
                    }
                    if let counts = record.counts, !counts.isEmpty {
                        Text(
                            counts.sorted { $0.key < $1.key }
                                .map { "\($0.key) \($0.value)" }
                                .joined(separator: " · ")
                        )
                        .font(.caption)
                    }
                    if let started = record.startedAt {
                        Text(started)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let errors = record.errors, !errors.isEmpty {
                        Text(L10n("adminView.errorCount", errors.count))
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.vertical, 2)
            }
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            } else if imports.isEmpty {
                Text(L10n("adminView.noImports"))
                    .foregroundStyle(.secondary)
            }
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .listStyle(.plain)
        .navigationTitle(L10n("adminView.importsTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            imports = try await client.imports()
            message = nil
        } catch {
            message = ErrorText.message(for: error)
        }
    }
}
