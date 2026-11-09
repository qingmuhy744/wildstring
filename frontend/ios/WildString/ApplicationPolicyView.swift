import CoreNetwork
import SwiftUI

/// Per-account application policy shared by the assistant, inspections and MCP.
@MainActor
struct ApplicationPolicyView: View {
    let client: WildstringClient

    @State private var policy: ApplicationPolicy?
    @State private var mode = "manual"
    @State private var kinds: Set<String> = []
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var message: String?
    @State private var messageIsError = false

    private static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "playlist": return L10n("appPolicy.kindPlaylist")
        case "metadata": return L10n("appPolicy.kindMetadata")
        case "metadata_batch": return L10n("appPolicy.kindMetadataBatch")
        case "cover": return L10n("appPolicy.kindCover")
        case "lyrics": return L10n("appPolicy.kindLyrics")
        case "intake": return L10n("appPolicy.kindIntake")
        default: return kind
        }
    }

    var body: some View {
        Form {
            Section {
                Picker(L10n("appPolicy.organizeMode"), selection: $mode) {
                    Text(L10n("appPolicy.modeManual")).tag("manual")
                    Text(L10n("appPolicy.modeAutomatic")).tag("automatic")
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .disabled(isSaving || policy == nil)
                Text(
                    mode == "manual"
                        ? L10n("appPolicy.modeManualHint")
                        : L10n("appPolicy.modeAutomaticHint")
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            } header: {
                Text(L10n("appPolicy.organizeMode"))
            } footer: {
                Text(L10n("appPolicy.modeFooter"))
            }

            if let policy {
                Section(L10n("appPolicy.autoScopeSection")) {
                    ForEach(policy.allowedKinds, id: \.self) { kind in
                        Toggle(
                            Self.kindLabel(kind),
                            isOn: Binding(
                                get: { kinds.contains(kind) },
                                set: { enabled in
                                    if enabled { kinds.insert(kind) } else { kinds.remove(kind) }
                                }
                            )
                        )
                        .disabled(isSaving || mode == "manual")
                    }
                }
                Section {
                    Button(L10n("appPolicy.saveButton")) {
                        Task { await save() }
                    }
                    .disabled(
                        isSaving || policy == nil
                            || (mode == "automatic" && kinds.isEmpty)
                    )
                    if let message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(messageIsError ? .red : .green)
                    }
                } footer: {
                    Text(L10n("appPolicy.saveFooter"))
                }
            } else if isLoading {
                ProgressView()
            }
        }
        .navigationTitle(L10n("appPolicy.title"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await client.applicationPolicy())
            message = nil
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func save() async {
        guard let policy, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            apply(
                try await client.saveApplicationPolicy(
                    mode: mode,
                    kinds: Array(kinds).sorted(),
                    version: policy.version
                )
            )
            message = L10n("appPolicy.savedSuccess")
            messageIsError = false
        } catch let error as APIError where error.statusCode == 409 {
            await load()
            message = L10n("appPolicy.conflictNotice")
            messageIsError = true
        } catch {
            message = ErrorText.message(for: error)
            messageIsError = true
        }
    }

    private func apply(_ saved: ApplicationPolicy) {
        policy = saved
        mode = saved.mode
        kinds = Set(saved.kinds)
    }
}
