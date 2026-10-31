import CoreNetwork
import Foundation
import Observation

/// Owned by the signed-in session so navigating to music does not discard a reply or draft input.
@MainActor
@Observable
final class MacAssistantModel {
    let client: WildstringClient
    private(set) var conversations: [ConversationSummary] = []
    private(set) var historyTotal = 0
    private(set) var connections: [AssistantConnection] = []
    private(set) var detail: ConversationDetail?
    private(set) var isLoading = false
    private(set) var isSending = false
    private(set) var historyError: String?
    private(set) var connectionError: String?
    private(set) var localResults: [Track] = []
    private(set) var pendingText: String?
    var input = ""
    var connectionID = "local"
    var errorMessage: String?
    private var prepared = false
    private var previousMessageIDs = Set<String>()

    init(client: WildstringClient) { self.client = client }

    var running: Bool { detail?.runs?.contains { $0.status == "running" } == true }
    var busy: Bool { isLoading || isSending || running }
    var pollingID: String? { isSending || running ? detail?.id : nil }
    var selectedConnection: AssistantConnection? { connections.first { $0.id == connectionID } }
    var canSend: Bool {
        !busy && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && input.count <= 8_000
            && (connectionID == "local" || selectedConnection?.enabled == true)
    }
    var pendingMessageVisible: Bool {
        guard let pendingText else { return false }
        return detail?.messages.contains {
            $0.isUser && !previousMessageIDs.contains($0.id) && $0.content == pendingText
        } != true
    }
    var draftIDs: [String] {
        var seen = Set<String>()
        return (detail?.runs ?? []).flatMap(\.draftIDs).filter { seen.insert($0).inserted }
    }
    var progressText: String {
        switch detail?.runs?.first(where: { $0.status == "running" })?.stage {
        case "tools": return "正在查询曲库与整理结果…"
        case "search": return "正在检索资料…"
        case "summary": return "正在整理对话上下文…"
        case "writing": return "正在生成回答…"
        default: return connectionID == "local" ? "正在检索曲库…" : "助手正在思考与生成回答…"
        }
    }

    func prepare() async {
        guard !prepared else { return }
        prepared = true
        await refresh()
    }

    func refresh() async {
        guard !isLoading, !isSending else { return }
        isLoading = true
        defer { isLoading = false }
        async let history: Void = loadHistory()
        async let models: Void = loadConnections()
        if let id = detail?.id {
            do {
                detail = try await client.conversation(id: id)
                errorMessage = nil
                await loadLocalResults()
            } catch {
                errorMessage = MacErrorText.message(for: error)
            }
        }
        _ = await (history, models)
    }

    func loadHistory(more: Bool = false) async {
        do {
            let page = try await client.conversations(limit: 100, offset: more ? conversations.count : 0)
            conversations = more ? conversations + page.items : page.items
            historyTotal = page.total
            historyError = nil
        } catch {
            historyError = MacErrorText.message(for: error)
        }
    }

    private func loadConnections() async {
        do {
            var items: [AssistantConnection] = []
            var total = 1
            while items.count < total {
                let page = try await client.assistantConnections(offset: items.count)
                items += page.items
                total = page.total
                if page.items.isEmpty { break }
            }
            connections = items
            connectionError = nil
        } catch {
            connectionError = "模型连接暂时无法加载：\(MacErrorText.message(for: error))"
        }
    }

    func newConversation() {
        guard !busy else { return }
        detail = nil
        localResults = []
        input = ""
        errorMessage = nil
    }

    func open(_ id: String) async {
        guard !busy else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let value = try await client.conversation(id: id)
            detail = value
            connectionID = value.connectionID ?? "local"
            input = ""
            errorMessage = nil
            await loadLocalResults()
        } catch {
            errorMessage = MacErrorText.message(for: error)
        }
    }

    func send() async {
        guard canSend else { return }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = connectionID
        previousMessageIDs = Set(detail?.messages.map(\.id) ?? [])
        pendingText = text
        localResults = []
        errorMessage = nil
        isSending = true
        defer {
            isSending = false
            pendingText = nil
        }
        do {
            if detail == nil {
                detail = try await client.createConversation(
                    title: String(text.prefix(80)), connectionID: selected
                )
            }
            guard let id = detail?.id else { return }
            detail = try await client.sendMessage(
                conversationID: id, content: text, connectionID: selected
            )
            input = ""
            await loadLocalResults()
        } catch {
            errorMessage = "\(MacErrorText.message(for: error))。输入已保留；可刷新对话检查服务器是否已收到。"
            // A timeout can happen after the server accepted the message. Recover saved
            // state before offering a resend, so a retry does not duplicate the turn.
            if let id = detail?.id, let recovered = try? await client.conversation(id: id) {
                detail = recovered
                if recovered.messages.contains(where: {
                    $0.isUser && !previousMessageIDs.contains($0.id) && $0.content == text
                }) {
                    input = ""
                    errorMessage =
                        running
                        ? "消息已收到，服务器仍在处理，正在恢复结果…"
                        : "消息已收到，已恢复服务器保存的结果。"
                    await loadLocalResults()
                }
            }
        }
        await loadHistory()
        await loadConnections()
    }

    /// The view cancels polling when hidden; the send itself continues in this model.
    func poll() async {
        guard let id = pollingID else { return }
        while !Task.isCancelled, pollingID == id {
            do {
                try await Task.sleep(for: .milliseconds(800))
                let value = try await client.conversation(id: id)
                guard !Task.isCancelled, pollingID == id else { return }
                // A progress request started before the POST completed can arrive after
                // its final response. Do not replace a completed run with that snapshot.
                if value.runs?.contains(where: { incoming in
                    incoming.status == "running"
                        && detail?.runs?.contains {
                            $0.id == incoming.id && $0.status != "running"
                        } == true
                }) == true {
                    continue
                }
                detail = value
            } catch {
                if Task.isCancelled { return }
                // The send reports transport failures and refresh can recover saved replies.
                // A failed progress read must not abort an otherwise healthy request.
            }
        }
    }

    private func loadLocalResults() async {
        localResults = []
        guard detail?.runs?.first?.status == "local_fallback",
            let prompt = detail?.messages.last(where: \.isUser)?.content
        else { return }
        do {
            localResults = try await client.tracks(limit: 10, query: String(prompt.prefix(256))).items
        } catch {
            errorMessage = "对话已加载，但试听结果暂时不可用：\(MacErrorText.message(for: error))"
        }
    }

    func rename(_ item: ConversationSummary, title: String) async -> Bool {
        guard !busy else { return false }
        isLoading = true
        defer { isLoading = false }
        do {
            let value = try await client.renameConversation(id: item.id, title: title)
            if detail?.id == value.id { detail = value }
            await loadHistory()
            errorMessage = nil
            return true
        } catch {
            errorMessage = MacErrorText.message(for: error)
            return false
        }
    }

    func delete(_ item: ConversationSummary) async {
        guard !busy else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            try await client.deleteConversation(id: item.id)
            if detail?.id == item.id {
                detail = nil
                input = ""
                localResults = []
            }
            await loadHistory()
            errorMessage = nil
        } catch {
            errorMessage = MacErrorText.message(for: error)
        }
    }
}
