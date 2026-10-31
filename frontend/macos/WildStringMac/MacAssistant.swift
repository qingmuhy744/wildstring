import CoreNetwork
import CorePlayback
import SwiftUI

struct MacAssistantView: View {
    @Bindable var model: MacAssistantModel
    let playback: PlaybackService

    @State private var showHistory = false
    @State private var renaming: ConversationSummary?
    @State private var renameText = ""
    @State private var deleting: ConversationSummary?
    @State private var selectedDraft: String?
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            conversationHeader
            Divider()
            messages
            composer
        }
        .navigationTitle("音乐助手")
        .toolbar {
            Button {
                showHistory.toggle()
            } label: {
                Label("历史对话", systemImage: "clock.arrow.circlepath")
            }
            .popover(isPresented: $showHistory, arrowEdge: .bottom) { history }
            Button {
                model.newConversation()
                inputFocused = true
            } label: {
                Label("新对话", systemImage: "square.and.pencil")
            }
            .disabled(model.busy)
            Button {
                Task { await model.refresh() }
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .disabled(model.isLoading || model.isSending)
        }
        .task { await model.prepare() }
        .task(id: model.pollingID) { await model.poll() }
        .sheet(
            isPresented: Binding(
                get: { selectedDraft != nil }, set: { if !$0 { selectedDraft = nil } }
            )
        ) {
            if let selectedDraft {
                MacDraftPreview(client: model.client, playback: playback, draftID: selectedDraft)
            }
        }
        .sheet(item: $renaming) { item in
            VStack(alignment: .leading, spacing: 16) {
                Text("重命名对话").font(.headline)
                TextField("对话名称", text: $renameText).textFieldStyle(.roundedBorder)
                if let error = model.errorMessage { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Spacer()
                    Button("取消") { renaming = nil }.keyboardShortcut(.cancelAction)
                    Button("保存") {
                        Task {
                            if await model.rename(
                                item, title: renameText.trimmingCharacters(in: .whitespacesAndNewlines))
                            {
                                renaming = nil
                            }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(
                        model.busy || renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || renameText.count > 200)
                }
            }
            .padding(24)
            .frame(width: 380)
        }
        .confirmationDialog(
            "删除这段对话？",
            isPresented: Binding(
                get: { deleting != nil }, set: { if !$0 { deleting = nil } }
            ), titleVisibility: .visible
        ) {
            if let item = deleting {
                Button("删除对话", role: .destructive) { Task { await model.delete(item) } }
            }
        } message: {
            Text("对话记录无法恢复，已生成的草案与歌单会保留。")
        }
    }

    private var conversationHeader: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.detail?.title ?? "从想听的音乐开始")
                    .font(.title3.weight(.semibold))
                    .lineLimit(2)
                Text(model.connectionID == "local" ? "本地检索 · 使用歌名或艺人关键词" : "模型助手 · 找歌、整理与生成歌单草案")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Picker("检索方式", selection: $model.connectionID) {
                Text("本地检索 · 不使用模型").tag("local")
                ForEach(model.connections.filter { $0.enabled || $0.id == model.connectionID }) {
                    connection in
                    Text("\(connection.name) · \(connection.model)")
                        .tag(connection.id).disabled(!connection.enabled)
                }
                if model.connectionID != "local", model.selectedConnection == nil {
                    Text("之前的模型连接不可用").tag(model.connectionID)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 300)
            .disabled(model.busy)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    if model.detail?.messages.isEmpty != false, !model.isSending {
                        welcome
                    }
                    ForEach(model.detail?.messages ?? []) { message in
                        messageRow(message)
                    }
                    if model.pendingMessageVisible, let text = model.pendingText {
                        HStack {
                            Spacer(minLength: 60)
                            Text(text).padding(14)
                                .background(MacTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 14))
                        }
                    }
                    if !model.localResults.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Label("曲库中的匹配歌曲", systemImage: "music.note.list").font(.headline)
                            MacAssistantTracks(
                                client: model.client, playback: playback, tracks: model.localResults)
                        }
                    }
                    ForEach(model.draftIDs, id: \.self) { id in
                        MacAssistantDraftLink(client: model.client, draftID: id) { selectedDraft = id }
                    }
                    if model.isSending || model.running {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text(model.progressText).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    if let run = model.detail?.runs?.first,
                        run.status == "failed" || run.status == "interrupted"
                    {
                        Label(
                            "本次处理未完成\(run.errorCode.map { "：\($0)" } ?? "")",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.caption).foregroundStyle(.orange)
                    }
                    Color.clear.frame(height: 1).id("conversation-bottom")
                }
                .frame(maxWidth: 820, alignment: .leading)
                .padding(28)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: model.detail?.messages.count) { _, _ in
                Task { @MainActor in proxy.scrollTo("conversation-bottom", anchor: .bottom) }
            }
            .onChange(of: model.isSending) { _, _ in
                Task { @MainActor in proxy.scrollTo("conversation-bottom", anchor: .bottom) }
            }
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "sparkles")
                .font(.system(size: 32)).foregroundStyle(MacTheme.accentDeep)
            Text("今天想听什么？").font(.largeTitle.bold())
            Text(
                model.connectionID == "local"
                    ? "输入歌名、艺人或专辑，直接检索当前曲库。选择上方的模型连接后，可以用自然语言描述心情、场景或歌单要求。"
                    : "描述你的想法，助手会查找真实曲目并说明依据。生成的歌单可先试听，再确认保存。"
            )
            .font(.callout).foregroundStyle(.secondary).lineSpacing(5)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { suggestions }
                VStack(alignment: .leading, spacing: 10) { suggestions }
            }
        }
        .padding(.vertical, 42)
    }

    @ViewBuilder private var suggestions: some View {
        ForEach(
            model.connectionID == "local"
                ? ["周杰伦", "钢琴", "夜曲"]
                : [
                    "从曲库找几首适合散步的歌", "用我喜欢的歌生成一份歌单草案", "帮我找一张适合完整听完的专辑",
                ], id: \.self
        ) { suggestion in
            Button(suggestion) {
                model.input = suggestion
                inputFocused = true
            }.buttonStyle(.bordered)
        }
    }

    private func messageRow(_ message: AssistantMessage) -> some View {
        HStack(alignment: .top, spacing: 14) {
            if message.isUser { Spacer(minLength: 60) }
            VStack(alignment: .leading, spacing: 8) {
                Text(message.isUser ? "你" : "野弦助手").font(.caption.weight(.semibold)).foregroundStyle(
                    .secondary)
                if message.isUser {
                    Text(message.content).textSelection(.enabled)
                } else {
                    MacAssistantText(content: message.content.isEmpty ? "正在准备回答…" : message.content)
                }
                if message.partial == true {
                    Text("正在生成…").font(.caption).foregroundStyle(.secondary)
                }
                if let sources = message.sources, !sources.isEmpty {
                    ForEach(sources) { source in
                        if let url = URL(string: source.url), ["https", "http"].contains(url.scheme) {
                            Link(destination: url) {
                                Label(source.title, systemImage: "link").font(.caption)
                            }
                        }
                    }
                }
            }
            .padding(message.isUser ? 16 : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                message.isUser ? MacTheme.accent.opacity(0.12) : .clear,
                in: RoundedRectangle(cornerRadius: 14))
            if !message.isUser { Spacer(minLength: 30) }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = model.errorMessage ?? model.connectionError {
                HStack(alignment: .top) {
                    Label(error, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(
                        .orange)
                    Spacer()
                    Button("刷新") { Task { await model.refresh() } }.disabled(
                        model.isSending || model.isLoading)
                }
            }
            HStack(alignment: .bottom, spacing: 12) {
                TextField(
                    model.connectionID == "local" ? "输入歌名、艺人或专辑" : "描述想听的音乐，或让助手生成歌单", text: $model.input,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(2...5)
                .focused($inputFocused)
                .disabled(model.isSending || model.running)
                .padding(13)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator.opacity(0.5)))
                Button {
                    Task { await model.send() }
                } label: {
                    Label(model.isSending ? "处理中" : "发送", systemImage: "arrow.up")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!model.canSend)
                .padding(.bottom, 4)
            }
            HStack {
                Text(
                    model.connectionID == "local"
                        ? "本地检索不消耗模型额度"
                        : model.selectedConnection?.dailyCallsRemaining.map { "今日模型调用剩余 \($0) 次" } ?? "使用所选模型连接"
                )
                Spacer()
                Text(model.input.count > 8_000 ? "超过 8,000 字，请缩短内容" : "⌘ Return 发送 · Return 换行")
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: 820)
        .padding(.horizontal, 28)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("历史对话").font(.headline).padding(.horizontal, 16).padding(.top, 16)
            if let error = model.historyError {
                Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 16)
                Button("重新加载") { Task { await model.loadHistory() } }.padding(.horizontal, 16)
            }
            List(model.conversations) { item in
                HStack {
                    Button {
                        showHistory = false
                        Task { await model.open(item.id) }
                    } label: {
                        Label(
                            item.title,
                            systemImage: item.id == model.detail?.id ? "bubble.left.fill" : "bubble.left"
                        )
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    }.buttonStyle(.plain)
                    Menu {
                        Button("重命名") {
                            showHistory = false
                            renameText = item.title
                            renaming = item
                        }
                        Button("删除", role: .destructive) {
                            showHistory = false
                            deleting = item
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuStyle(.borderlessButton).frame(width: 24)
                }
                .padding(.vertical, 5)
                .disabled(model.busy)
            }
            .overlay {
                if model.conversations.isEmpty, model.historyError == nil {
                    Text("发送第一条消息后，对话会保存在这里").foregroundStyle(.secondary).padding()
                }
            }
            if model.conversations.count < model.historyTotal {
                Button("加载更多") { Task { await model.loadHistory(more: true) } }.padding(12)
            }
        }
        .frame(width: 350, height: 420)
    }
}

private struct MacAssistantText: View {
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(content.components(separatedBy: "\n\n").enumerated()), id: \.offset) {
                _, paragraph in
                if let rows = tableRows(paragraph) {
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                                GridRow {
                                    ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                                        Text(markdown(cell)).fontWeight(index == 0 ? .semibold : .regular)
                                            .textSelection(.enabled)
                                    }
                                }
                                if index == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                            }
                        }.padding(16)
                    }
                    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                } else {
                    let heading =
                        paragraph.hasPrefix("# ") || paragraph.hasPrefix("## ") || paragraph.hasPrefix("### ")
                    let text = heading ? String(paragraph.drop(while: { $0 == "#" || $0 == " " })) : paragraph
                    Text(markdown(text))
                        .font(heading ? .headline : .body)
                        .lineSpacing(5)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }

    private func tableRows(_ paragraph: String) -> [[String]]? {
        let lines = paragraph.split(separator: "\n").map(String.init)
        guard lines.count >= 2, lines[0].contains("|") else { return nil }
        let rows = lines.map { line in
            var cells = line.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            if cells.first == "" { cells.removeFirst() }
            if cells.last == "" { cells.removeLast() }
            return cells
        }
        guard !rows[0].isEmpty, rows.allSatisfy({ $0.count == rows[0].count }),
            rows[1].allSatisfy({ cell in
                let rule = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
                return rule.count >= 3 && rule.allSatisfy { $0 == "-" }
            })
        else { return nil }
        return [rows[0]] + rows.dropFirst(2)
    }
}

struct MacAssistantTracks: View {
    let client: WildstringClient
    let playback: PlaybackService
    let tracks: [Track]

    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
                Button {
                    playback.play(
                        items: tracks.map {
                            PlaybackService.Item(
                                trackID: $0.id, title: $0.title,
                                artist: $0.artists.joined(separator: " / "), album: $0.album,
                                hasCover: $0.hasCover, streamPath: "api/v1/tracks/\($0.id)/stream")
                        }, startingAt: index)
                } label: {
                    HStack(spacing: 12) {
                        MacCover(client: client, trackID: track.hasCover ? track.id : nil, side: 36)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(track.title).font(.callout.weight(.medium)).lineLimit(1)
                            Text(track.artists.joined(separator: " / ")).font(.caption).foregroundStyle(
                                .secondary
                            ).lineLimit(1)
                        }
                        Spacer()
                        Text(macClock(milliseconds: track.durationMs)).font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        Image(
                            systemName: playback.currentItem?.trackID == track.id && playback.isPlaying
                                ? "waveform" : "play.circle"
                        )
                        .foregroundStyle(MacTheme.accentDeep)
                    }.padding(.vertical, 8).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("播放 \(track.title)，\(track.artists.joined(separator: " / "))")
                if index < tracks.count - 1 { Divider() }
            }
        }
    }
}

private struct MacAssistantDraftLink: View {
    let client: WildstringClient
    let draftID: String
    var open: () -> Void
    @State private var draft: Draft?

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: "music.note.list").font(.title2).foregroundStyle(MacTheme.accentDeep)
                VStack(alignment: .leading, spacing: 5) {
                    Text(draft?.title ?? "查看助手草案").font(.headline)
                    Text(draft?.isApplied == true ? "已应用 · 查看结果" : "预览内容与依据，再确认保存").font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }.padding(16).background(MacTheme.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .task(id: draftID) { draft = try? await client.draft(id: draftID) }
    }
}
