import CoreNetwork
import CorePlayback
import SwiftUI

struct RecommendationPreferencesView: View {
    let client: WildstringClient
    @State private var value: RecommendationPreferences?
    @State private var connections: [AssistantConnection] = []
    @State private var tags = ""
    @State private var busy = false
    @State private var error: String?
    @State private var saved = false

    var body: some View {
        Form {
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            } else if saved {
                Label(L10n("adminEdit.savedMessage"), systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            }
            if let binding = Binding($value) {
                Section(L10n("dailyRec.title")) {
                    Stepper(L10n("consumer.recommendationCount", binding.wrappedValue.count), value: binding.count, in: 1...50)
                    Toggle(L10n("consumer.recommendationAi"), isOn: binding.useAi)
                    if binding.wrappedValue.useAi {
                        Picker(L10n("consumer.modelConnection"), selection: binding.connectionId) {
                            Text(L10n("consumer.defaultConnection")).tag(String?.none)
                            Text(L10n("consumer.localRecommendations")).tag(Optional("local"))
                            ForEach(connections) { connection in
                                Text(connection.name).tag(Optional(connection.id))
                            }
                        }
                    }
                    Toggle(L10n("consumer.lastfmRecommendations"), isOn: binding.useLastfm)
                    TextField(L10n("consumer.recommendationTags"), text: $tags)
                    Toggle(L10n("consumer.scheduledRecommendations"), isOn: binding.dailyEnabled)
                    if binding.wrappedValue.dailyEnabled {
                        TextField(L10n("consumer.dailyTime"), text: binding.dailyTime)
                            .keyboardType(.numbersAndPunctuation)
                    }
                }
                Section(L10n("consumer.recommendationSources")) {
                    ForEach(["personal", "community", "discovery", "revisit", "lastfm_similar", "lastfm_charts", "lastfm_tags"], id: \.self) { source in
                        sourceToggle(source, values: binding.sources)
                    }
                }
                Section(L10n("consumer.externalMusic")) {
                    Toggle(L10n("consumer.enableExternal"), isOn: binding.externalEnabled)
                    if binding.wrappedValue.externalEnabled {
                        Picker(L10n("consumer.externalInterval"), selection: binding.externalRefreshDays) {
                            Text(L10n("consumer.refreshManually")).tag(0)
                            ForEach([1, 3, 7, 14, 30], id: \.self) { days in
                                Text(L10n("consumer.intervalDays", days)).tag(days)
                            }
                        }
                        ForEach(["lastfm_similar", "lastfm_charts", "lastfm_tags", "lastfm_artists"], id: \.self) { source in
                            sourceToggle(source, values: binding.externalSources)
                        }
                        Toggle(L10n("consumer.recommendationAi"), isOn: binding.externalUseAi)
                        if binding.wrappedValue.externalUseAi {
                            Stepper(L10n("consumer.externalCalls", binding.wrappedValue.externalCallLimit), value: binding.externalCallLimit, in: 1...8)
                        }
                    }
                }
            } else if error == nil { ProgressView() }
        }
        .disabled(busy)
        .navigationTitle(L10n("consumer.recommendationPreferences"))
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(L10n("adminEdit.save")) { Task { await save() } }
                    .disabled(value == nil || busy)
            }
        }
        .task { await load() }
    }

    private func sourceToggle(_ source: String, values: Binding<[String]>) -> some View {
        Toggle(L10n("consumer.recSource.\(source)"), isOn: Binding(
            get: { values.wrappedValue.contains(source) },
            set: { selected in
                if selected { values.wrappedValue.append(source) }
                else { values.wrappedValue.removeAll { $0 == source } }
            }
        ))
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            async let connectionList = try? client.assistantConnections()
            value = try await client.recommendationPreferences()
            tags = value?.lastfmTags.joined(separator: ", ") ?? ""
            connections = (await connectionList)?.items ?? []
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func save() async {
        guard var value else { return }
        busy = true
        defer { busy = false }
        value.lastfmTags = tags.split(whereSeparator: { $0 == "," || $0 == "，" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        do {
            self.value = try await client.saveRecommendationPreferences(value)
            error = nil
            saved = true
        } catch {
            self.error = ErrorText.message(for: error)
            saved = false
        }
    }
}

struct ExternalMusicView: View {
    let client: WildstringClient
    let playback: PlaybackService
    @State private var result: ExternalRecommendations?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            }
            if let result {
                if result.status == "disabled" {
                    NavigationLink(L10n("consumer.enableExternal")) {
                        RecommendationPreferencesView(client: client)
                    }
                } else if result.items.isEmpty {
                    ContentUnavailableView(L10n("consumer.noExternal"), systemImage: "sparkles")
                }
                if result.stale || result.degraded {
                    Text(L10n("consumer.externalCached")).foregroundStyle(.secondary)
                }
                ForEach(result.items) { item in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.name).font(.headline)
                            Text(item.artists.joined(separator: " / ")).foregroundStyle(.secondary)
                            if !item.reason.isEmpty {
                                Text(item.reason).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Menu {
                            if let track = item.localTrack, track.isAvailable {
                                Button(L10n("consumer.playLocal"), systemImage: "play") {
                                    playback.play(items: [track.playbackItem], startingAt: 0)
                                }
                            }
                            if let url = item.sourceUrl, ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                                Link(L10n("consumer.viewSource"), destination: url)
                            }
                            Button(item.wanted ? L10n("consumer.unwant") : L10n("consumer.want"), systemImage: "bookmark") {
                                Task { await feedback(item, action: item.wanted ? "clear" : "want") }
                            }
                            Button(L10n("consumer.dismissRecommendation")) {
                                Task { await feedback(item, action: "dismiss") }
                            }
                        } label: {
                            Image(systemName: "ellipsis").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel(L10n("bulk.actions"))
                        .disabled(busy)
                    }
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .navigationTitle(L10n("consumer.externalMusic"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if busy { ProgressView() }
                else {
                    Button(L10n("dailyRec.refresh"), systemImage: "arrow.clockwise") {
                        Task { await load(refresh: true) }
                    }
                    .disabled(result?.status == "disabled")
                }
            }
        }
        .miniPlayer(playback, client: client)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load(refresh: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            result = try await client.externalRecommendations(refresh: refresh)
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func feedback(_ item: ExternalRecommendation, action: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.externalRecommendationFeedback(id: item.externalId, action: action)
            result = try await client.externalRecommendations()
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}
