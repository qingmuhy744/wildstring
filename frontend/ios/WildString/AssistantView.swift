import CoreNetwork
import SwiftUI

@MainActor
struct AssistantView: View {
    let client: WildstringClient
    var showsDismiss = true

    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dismiss) private var dismiss
    @State private var showingHistory = false
    @State private var history: [ConversationSummary] = []
    @State private var historyTotal = 0
    @State private var historyError: String?
    @State private var historyLoading = false
    @State private var conversation: ConversationDetail?
    @State private var input = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var showingMusicPreferences = false
    @State private var showingDrafts = false
    @State private var pendingDrafts = 0

    var body: some View {
        NavigationStack {
            HStack(spacing: 0) {
                if sizeClass == .regular {
                    conversationHistory
                        .frame(width: 240)
                    Divider()
                }
                chat
                    .safeAreaInset(edge: .bottom) { inputBar }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .navigationTitle(L10n("assistant.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarLeading) {
                    if showsDismiss {
                        Button(L10n("assistant.close")) { dismiss() }
                    }
                    if sizeClass != .regular {
                        Button(L10n("consumer.conversationHistory"), systemImage: "list.bullet") { showingHistory = true }
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        showingMusicPreferences = true
                    } label: {
                        Label(L10n("assistantMusic.title"), systemImage: "slider.horizontal.3")
                    }
                    Button {
                        Task { await newConversation() }
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(isSending)
                    Button {
                        showingDrafts = true
                    } label: {
                        Image(systemName: "checklist")
                            .overlay(alignment: .topTrailing) {
                                if pendingDrafts > 0 {
                                    Circle()
                                        .fill(.red)
                                        .frame(width: 8, height: 8)
                                        .offset(x: 2, y: -2)
                                }
                            }
                    }
                }
            }
            .sheet(isPresented: $showingHistory) {
                NavigationStack {
                    conversationHistory
                        .navigationTitle(L10n("consumer.conversationHistory"))
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button(L10n("queueView.close")) { showingHistory = false }
                            }
                        }
                }
            }
            .sheet(isPresented: $showingDrafts) {
                DraftsView(client: client)
            }
            .sheet(isPresented: $showingMusicPreferences) {
                AssistantMusicPreferencesView(client: client)
            }
            .task { await prepare() }
        }
    }

    private var chat: some View {
        Group {
                if let conversation {
                    messageList(conversation)
                } else if let errorMessage {
                    ContentUnavailableView(
                        L10n("assistant.unavailableTitle"),
                        systemImage: "sparkles",
                        description: Text(errorMessage)
                    )
                } else {
                    ProgressView(L10n("assistant.preparingConversation"))
                }
            }
    }

    private var conversationHistory: some View {
        List {
            ForEach(history) { item in
                Button {
                    Task { await openConversation(item.id) }
                } label: {
                    HStack {
                        Text(item.title).lineLimit(2)
                        Spacer()
                        if conversation?.id == item.id { Image(systemName: "checkmark") }
                    }
                }
                .disabled(isSending)
                .accessibilityAddTraits(conversation?.id == item.id ? .isSelected : [])
            }
            if let historyError {
                Text(historyError).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await loadHistory() } }
            } else if historyLoading {
                ProgressView()
            } else if history.count < historyTotal {
                Button(L10n("consumer.loadMore")) { Task { await loadHistory(more: true) } }
            } else if history.isEmpty {
                Text(L10n("consumer.noConversations")).foregroundStyle(.secondary)
            }
        }
        .listStyle(.plain)
        .task { await loadHistory() }
        .refreshable { await loadHistory() }
    }

    private func loadHistory(more: Bool = false) async {
        guard !historyLoading else { return }
        historyLoading = true
        defer { historyLoading = false }
        do {
            let page = try await client.conversations(offset: more ? history.count : 0)
            if !more { history = [] }
            var seen = Set(history.map(\.id))
            history.append(contentsOf: page.items.filter { seen.insert($0.id).inserted })
            historyTotal = page.total
            historyError = nil
        } catch {
            if !Task.isCancelled { historyError = ErrorText.message(for: error) }
        }
    }

    private func openConversation(_ id: String) async {
        guard !isSending else { return }
        isSending = true
        defer { isSending = false }
        do {
            conversation = try await client.conversation(id: id)
            showingHistory = false
            errorMessage = nil
        } catch {
            historyError = ErrorText.message(for: error)
        }
    }

    private func messageList(_ conversation: ConversationDetail) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if conversation.messages.isEmpty {
                        Text(L10n("assistant.examplePrompt"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                    }
                    ForEach(conversation.messages) { message in
                        HStack {
                            if message.isUser { Spacer(minLength: 48) }
                            Text(message.content)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(
                                    message.isUser
                                        ? AnyShapeStyle(Color.accentColor.opacity(0.18))
                                        : AnyShapeStyle(Color(.secondarySystemBackground)),
                                    in: RoundedRectangle(cornerRadius: 14)
                                )
                                .id(message.id)
                            if !message.isUser { Spacer(minLength: 48) }
                        }
                    }
                    if isSending {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text(L10n("assistant.thinking"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding(16)
            }
            .onChange(of: conversation.messages.count) { _, _ in
                if let last = conversation.messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField(L10n("assistant.inputPlaceholder"), text: $input, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
            Button {
                Task { await send() }
            } label: {
                Image(systemName: "paperplane.fill")
            }
            .disabled(isSending || input.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func prepare() async {
        do {
            let page = try await client.conversations(limit: 1)
            if let latest = page.items.first {
                conversation = try await client.conversation(id: latest.id)
            } else {
                conversation = try await client.createConversation()
            }
            await refreshDraftCount()
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
        #if DEBUG
            if ProcessInfo.processInfo.environment["WILDSTRING_DEMO_OPEN_DRAFTS"] == "1" {
                showingDrafts = true
            }
        #endif
        await runDemoPromptIfNeeded()
    }

    private func newConversation() async {
        do {
            conversation = try await client.createConversation()
            await loadHistory()
            errorMessage = nil
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    private func send() async {
        guard let current = conversation, !isSending else { return }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            conversation = try await client.sendMessage(
                conversationID: current.id,
                content: text
            )
            await refreshDraftCount()
        } catch {
            errorMessage = ErrorText.message(for: error)
            input = text
        }
    }

    private func refreshDraftCount() async {
        pendingDrafts = (try? await client.drafts())?.items.filter(\.isPending).count ?? 0
    }

    private func runDemoPromptIfNeeded() async {
        #if DEBUG
            guard
                let prompt = ProcessInfo.processInfo.environment[
                    "WILDSTRING_DEMO_ASSISTANT_PROMPT"
                ],
                !prompt.isEmpty, conversation?.messages.isEmpty == true
            else { return }
            input = prompt
            await send()
        #endif
    }
}
