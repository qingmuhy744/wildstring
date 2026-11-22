import CoreNetwork
import SwiftUI

@MainActor
struct AssistantMusicPreferencesView: View {
    let client: WildstringClient

    @Environment(\.dismiss) private var dismiss
    @State private var memories: [AssistantMemory] = []
    @State private var usesMemories: Bool?
    @State private var draft = ""
    @State private var editing: AssistantMemory?
    @State private var deleting: AssistantMemory?
    @State private var busy = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var editConflict = false

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var draftTooLong: Bool { trimmedDraft.unicodeScalars.count > 1000 }

    var body: some View {
        NavigationStack {
            Form {
                if let loadError {
                    Section {
                        Text(loadError).foregroundStyle(.secondary)
                        Button(L10n("assistantMusic.retry")) { Task { await load() } }
                            .disabled(busy)
                    }
                }
                if let usesMemories {
                    Section {
                        Toggle(L10n("assistantMusic.useSaved"), isOn: Binding(
                            get: { usesMemories },
                            set: { enabled in Task { await setUsage(enabled) } }
                        ))
                        .disabled(busy)
                    } footer: {
                        Text(L10n("assistantMusic.useHelp"))
                    }
                    editor
                    savedMemories
                } else if loadError == nil {
                    ProgressView(L10n("assistantMusic.loading"))
                }
            }
            .tint(.wildAccentText)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await load() }
            .navigationTitle(L10n("assistantMusic.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n("assistant.close")) { dismiss() }
                }
            }
            .task { await load() }
            .alert(
                L10n("assistantMusic.deleteConfirmation"),
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                presenting: deleting
            ) { memory in
                Button(L10n("assistantMusic.delete"), role: .destructive) {
                    Task { await delete(memory) }
                }
                Button(L10n("assistantMusic.cancel"), role: .cancel) {}
            } message: { memory in
                Text(memory.content)
            }
        }
    }

    private var editor: some View {
        Section(editing == nil ? L10n("assistantMusic.new") : L10n("assistantMusic.edit")) {
            ZStack(alignment: .topLeading) {
                if draft.isEmpty {
                    Text(L10n("assistantMusic.placeholder"))
                        .foregroundStyle(.secondary)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                TextField(
                    L10n("assistantMusic.title"),
                    text: $draft,
                    prompt: Text(verbatim: ""),
                    axis: .vertical
                )
                .accessibilityIdentifier("assistantMusic.editor")
                .accessibilityHint(L10n("assistantMusic.placeholder"))
                .lineLimit(3...7)
                .foregroundStyle(.primary)
                .disabled(busy)
            }
            if draftTooLong {
                Text(L10n("assistantMusic.tooLong")).foregroundStyle(.secondary)
            }
            if let actionError {
                Text(actionError).foregroundStyle(.secondary)
            }
            if editConflict {
                if let editing, let latest = memories.first(where: { $0.id == editing.id && $0.version != editing.version }) {
                    Text(latest.content).foregroundStyle(.secondary)
                    Button(L10n("assistantMusic.useLatestVersion")) {
                        self.editing = latest
                        editConflict = false
                        actionError = nil
                    }
                    .disabled(busy)
                } else {
                    Button(L10n("assistantMusic.retry")) { Task { await load() } }
                        .disabled(busy)
                }
            }
            Button(L10n("assistantMusic.save")) { Task { await save() } }
                .disabled(busy || trimmedDraft.isEmpty || draftTooLong || editConflict)
            if editing != nil {
                Button(L10n("assistantMusic.cancel")) { resetEditor() }
                    .disabled(busy)
            }
        }
    }

    private var savedMemories: some View {
        Section(L10n("assistantMusic.saved")) {
            if memories.isEmpty {
                Text(L10n("assistantMusic.empty")).foregroundStyle(.secondary)
            }
            ForEach(memories) { memory in
                Button {
                    editing = memory
                    draft = memory.content
                    editConflict = false
                    actionError = nil
                } label: {
                    Text(memory.content).foregroundStyle(.primary)
                }
                .disabled(busy)
                .swipeActions {
                    Button(role: .destructive) {
                        deleting = memory
                    } label: {
                        Label(L10n("assistantMusic.delete"), systemImage: "trash")
                    }
                    .disabled(busy)
                }
                .contextMenu {
                    Button(L10n("assistantMusic.delete"), role: .destructive) { deleting = memory }
                        .disabled(busy)
                }
            }
        }
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        loadError = nil
        defer { busy = false }
        do {
            async let usage = client.assistantUsesMemories()
            async let entries = client.assistantMemories()
            let result = try await (usage, entries)
            usesMemories = result.0
            memories = result.1
        } catch {
            if !Task.isCancelled { loadError = ErrorText.message(for: error) }
        }
    }

    private func setUsage(_ enabled: Bool) async {
        guard !busy else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            usesMemories = try await client.setAssistantUsesMemories(enabled)
        } catch {
            actionError = ErrorText.message(for: error)
        }
    }

    private func save() async {
        let content = trimmedDraft
        guard !busy, !content.isEmpty, !draftTooLong, !editConflict else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            let saved = try await client.saveAssistantMemory(content: content, replacing: editing)
            memories.removeAll { $0.id == saved.id }
            memories.insert(saved, at: 0)
            resetEditor()
        } catch let error as APIError where error.code == "memory_version_conflict" {
            editConflict = true
            actionError = L10n("assistantMusic.conflict")
        } catch let error as APIError where error.code == "memory_limit_reached" {
            actionError = L10n("assistantMusic.limit")
        } catch {
            actionError = ErrorText.message(for: error)
        }
    }

    private func delete(_ memory: AssistantMemory) async {
        guard !busy else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            try await client.deleteAssistantMemory(id: memory.id)
            memories.removeAll { $0.id == memory.id }
            if editing?.id == memory.id { resetEditor() }
        } catch {
            actionError = ErrorText.message(for: error)
        }
    }

    private func resetEditor() {
        draft = ""
        editing = nil
        actionError = nil
        editConflict = false
    }
}
