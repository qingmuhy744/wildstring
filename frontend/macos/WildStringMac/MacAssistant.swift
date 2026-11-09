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
            messages
            composer
        }
        .background(MacTheme.canvas)
        .navigationTitle(model.detail?.title ?? L10n("macAssistant.title"))
        .toolbar { conversationActions }
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
                Text(L10n("macAssistant.renameConversation")).font(.headline)
                TextField(L10n("macAssistant.conversationName"), text: $renameText).textFieldStyle(.roundedBorder)
                if let error = model.errorMessage { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Spacer()
                    Button(L10n("macAssistant.cancel")) { renaming = nil }.keyboardShortcut(.cancelAction)
                    Button(L10n("macAssistant.save")) {
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
            L10n("macAssistant.deleteConfirmTitle"),
            isPresented: Binding(
                get: { deleting != nil }, set: { if !$0 { deleting = nil } }
            ), titleVisibility: .visible
        ) {
            if let item = deleting {
                Button(L10n("macAssistant.deleteConversation"), role: .destructive) { Task { await model.delete(item) } }
            }
        } message: {
            Text(L10n("macAssistant.deleteConfirmMessage"))
        }
    }

    @ToolbarContentBuilder private var conversationActions: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button { showHistory.toggle() } label: {
                Label(L10n("macAssistant.history"), systemImage: "clock.arrow.circlepath")
            }
            .help(L10n("macAssistant.history"))
            .popover(isPresented: $showHistory, arrowEdge: .bottom) { history }
            Button {
                model.newConversation()
                inputFocused = true
            } label: {
                Label(L10n("macAssistant.newConversation"), systemImage: "square.and.pencil")
            }
            .disabled(model.busy).help(L10n("macAssistant.newConversation"))
            Button { Task { await model.refresh() } } label: {
                Label(L10n("macAssistant.refresh"), systemImage: "arrow.clockwise")
            }
            .disabled(model.isLoading || model.isSending).help(L10n("macAssistant.refresh"))
        }
    }

    /// Retrieval mode lives in the composer so the mode and its input read as one unit.
    private var retrievalPicker: some View {
        Menu {
            Picker(L10n("macAssistant.retrievalMode"), selection: $model.connectionID) {
                Text(L10n("macAssistant.localRetrieval")).tag("local")
                ForEach(model.connections.filter { $0.enabled || $0.id == model.connectionID }) {
                    connection in
                    Text("\(connection.name) · \(connection.model)")
                        .tag(connection.id).disabled(!connection.enabled)
                }
                if model.connectionID != "local", model.selectedConnection == nil {
                    Text(L10n("macAssistant.previousConnectionUnavailable")).tag(model.connectionID)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            // Explicit label colours: system menu styles tint text with the accent colour.
            HStack(spacing: 4) {
                Text(retrievalTitle).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9))
            }
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.busy)
        .help(model.connectionID == "local" ? L10n("macAssistant.localNoQuota") : L10n("macAssistant.retrievalMode"))
        .accessibilityLabel(L10n("macAssistant.retrievalMode"))
        .accessibilityValue(retrievalTitle)
    }

    private var retrievalTitle: String {
        if model.connectionID == "local" { return L10n("macAssistant.localRetrieval") }
        if let connection = model.selectedConnection { return "\(connection.name) · \(connection.model)" }
        return L10n("macAssistant.previousConnectionUnavailable")
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
                            Label(L10n("macAssistant.matchedTracks"), systemImage: "music.note.list").font(.headline)
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
                            run.errorCode.map { L10n("macAssistant.runIncompleteWithCode", $0) } ?? L10n("macAssistant.runIncomplete"),
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
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(MacTheme.accentDeep)
                .frame(width: 44, height: 44)
                .background(MacTheme.accentSoft, in: Circle())
            Text(L10n("macAssistant.welcomeTitle"))
                .font(MacTheme.display(32))
                .foregroundStyle(MacTheme.ink)
            Text(
                model.connectionID == "local"
                    ? L10n("macAssistant.welcomeLocal")
                    : L10n("macAssistant.welcomeModel")
            )
            .font(MacTheme.caption).foregroundStyle(MacTheme.muted).lineSpacing(5)
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
                ? [L10n("macAssistant.suggestLocal1"), L10n("macAssistant.suggestLocal2"), L10n("macAssistant.suggestLocal3")]
                : [
                    L10n("macAssistant.suggestModel1"), L10n("macAssistant.suggestModel2"), L10n("macAssistant.suggestModel3"),
                ], id: \.self
        ) { suggestion in
            Button(suggestion) {
                model.input = suggestion
                inputFocused = true
            }.buttonStyle(MacSuggestionChipStyle())
        }
    }

    private func messageRow(_ message: AssistantMessage) -> some View {
        HStack(alignment: .top, spacing: 14) {
            if message.isUser { Spacer(minLength: 60) }
            VStack(alignment: .leading, spacing: 8) {
                Text(message.isUser ? L10n("macAssistant.user") : L10n("macAssistant.assistant")).font(.caption.weight(.semibold)).foregroundStyle(
                    .secondary)
                if message.isUser {
                    Text(message.content).textSelection(.enabled)
                } else {
                    MacAssistantText(content: message.content.isEmpty ? L10n("macAssistant.preparingAnswer") : message.content)
                }
                if message.partial == true {
                    Text(L10n("macAssistant.generating")).font(.caption).foregroundStyle(.secondary)
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
                message.isUser ? MacTheme.accentSoft : .clear,
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
                    Button(L10n("macAssistant.refresh")) { Task { await model.refresh() } }.disabled(
                        model.isSending || model.isLoading)
                }
            }
            VStack(alignment: .leading, spacing: 14) {
                TextField(
                    model.connectionID == "local" ? L10n("macAssistant.inputPlaceholderLocal") : L10n("macAssistant.inputPlaceholderModel"), text: $model.input,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(2...5)
                .focused($inputFocused)
                .disabled(model.isSending || model.running)
                .padding(2)
                HStack(spacing: 6) {
                    Image(systemName: model.connectionID == "local" ? "magnifyingglass" : "sparkles")
                        .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                        .accessibilityHidden(true)
                    retrievalPicker
                    Spacer()
                    Button {
                        Task { await model.send() }
                    } label: {
                        Label(model.isSending ? L10n("macAssistant.sending") : L10n("macAssistant.send"), systemImage: "arrow.up")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(MacTheme.onAccent)
                            .frame(width: 32, height: 32)
                            .background(model.canSend ? MacTheme.accent : MacTheme.faint, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.canSend)
                    .help(L10n("macAssistant.sendShortcutHelp"))
                }
            }
            .macPanel(padding: 16, radius: 18, fill: MacTheme.raised)
            .shadow(color: .black.opacity(0.03), radius: 10, y: 4)
            HStack {
                if model.connectionID != "local",
                    let remaining = model.selectedConnection?.dailyCallsRemaining
                {
                    Text(L10n("macAssistant.dailyCallsRemaining", remaining))
                }
                Spacer()
                Text(model.input.count > 8_000 ? L10n("macAssistant.inputTooLong") : L10n("macAssistant.shortcutHint"))
            }
            .font(MacTheme.micro).foregroundStyle(MacTheme.faint)
            .padding(.horizontal, 4)
        }
        .frame(maxWidth: 820)
        .padding(.horizontal, 28)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
        .background(MacTheme.canvas)
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("macAssistant.history")).font(.headline).padding(.horizontal, 16).padding(.top, 16)
            if let error = model.historyError {
                Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 16)
                Button(L10n("macAssistant.reload")) { Task { await model.loadHistory() } }.padding(.horizontal, 16)
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
                        Button(L10n("macAssistant.rename")) {
                            showHistory = false
                            renameText = item.title
                            renaming = item
                        }
                        Button(L10n("macAssistant.delete"), role: .destructive) {
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
                    Text(L10n("macAssistant.historyEmptyHint")).foregroundStyle(.secondary).padding()
                }
            }
            if model.conversations.count < model.historyTotal {
                Button(L10n("macAssistant.loadMore")) { Task { await model.loadHistory(more: true) } }.padding(12)
            }
        }
        .frame(width: 350, height: 420)
    }
}

/// Neutral capsule for starter prompts; accent colour stays reserved for primary actions.
private struct MacSuggestionChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.ink)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(MacTheme.raised, in: Capsule())
            .overlay(Capsule().strokeBorder(MacTheme.border))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
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
                        MacCover(client: client, trackID: track.hasCover ? track.id : (track.album != nil ? track.id : nil), side: 36)
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
                .accessibilityLabel(L10n("macAssistant.playTrackBy", track.title, track.artists.joined(separator: " / ")))
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
                    Text(draft?.title ?? L10n("macAssistant.viewDraft")).font(.headline)
                    Text(draft?.isApplied == true ? L10n("macAssistant.draftApplied") : L10n("macAssistant.draftPreview")).font(.caption)
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
