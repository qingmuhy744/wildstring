import CoreNetwork
import SwiftUI

@MainActor
struct AssistantView: View {
    let client: WildstringClient

    @Environment(\.dismiss) private var dismiss
    @State private var conversation: ConversationDetail?
    @State private var input = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var showingDrafts = false
    @State private var pendingDrafts = 0

    var body: some View {
        NavigationStack {
            Group {
                if let conversation {
                    messageList(conversation)
                } else if let errorMessage {
                    ContentUnavailableView(
                        "无法打开助手",
                        systemImage: "sparkles",
                        description: Text(errorMessage)
                    )
                } else {
                    ProgressView("正在准备对话…")
                }
            }
            .navigationTitle("AI 找歌")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
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
            .safeAreaInset(edge: .bottom) { inputBar }
            .sheet(isPresented: $showingDrafts) {
                DraftsView(client: client)
            }
            .task { await prepare() }
        }
    }

    private func messageList(_ conversation: ConversationDetail) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if conversation.messages.isEmpty {
                        Text("试试：帮我找几首适合晚上听的歌")
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
                            Text("思考中…")
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
            TextField("想让助手找什么歌？", text: $input, axis: .vertical)
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
