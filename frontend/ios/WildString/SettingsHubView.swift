import CoreNetwork
import CorePlayback
import SwiftUI

enum SettingsCategory: String, CaseIterable {
    case profile, playback, podcast, appearance, storage, assistant, server

    var label: String { L10n("consumer.settings.\(rawValue)") }

    var icon: String {
        switch self {
        case .profile: "person.crop.circle"
        case .playback: "play.circle"
        case .podcast: "antenna.radiowaves.left.and.right"
        case .appearance: "circle.lefthalf.filled"
        case .storage: "internaldrive"
        case .assistant: "bubble.left"
        case .server: "server.rack"
        }
    }
}

struct SettingsHubView: View {
    let playback: PlaybackService
    let client: WildstringClient
    let server: String
    let username: String
    let onLogout: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selected: SettingsCategory?
    @State private var showingMusicPreferences = false

    var body: some View {
        NavigationSplitView {
            List(selection: $selected) {
                ForEach(SettingsCategory.allCases, id: \.self) { category in
                    NavigationLink(value: category) { Label(category.label, systemImage: category.icon) }
                }
            }
            .navigationTitle(L10n("settings.title"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L10n("queueView.close")) { dismiss() } }
            }
            .navigationSplitViewColumnWidth(ideal: 260)
        } detail: {
            NavigationStack {
                if let selected {
                    categoryContent(selected)
                        .id(selected)
                        .navigationDestination(for: AdminDestination.self) { destination in
                            switch destination {
                            case .scans: ScansView(client: client)
                            case .imports: ImportsView(client: client)
                            }
                        }
                } else {
                    ContentUnavailableView(L10n("consumer.selectSetting"), systemImage: "gearshape")
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingMusicPreferences) { AssistantMusicPreferencesView(client: client) }
    }

    @ViewBuilder private func categoryContent(_ category: SettingsCategory) -> some View {
        switch category {
        case .profile:
            List {
                NavigationLink(L10n("consumer.profile")) { AccountProfileView(client: client) }
                NavigationLink(L10n("consumer.changePassword")) {
                    ChangePasswordView(client: client, onLogout: onLogout)
                }
                NavigationLink("Last.fm") { LastfmSettingsView(client: client) }
                NavigationLink(L10n("consumer.notificationPreferences")) { NotificationPreferencesView(client: client) }
            }.navigationTitle(category.label)
        case .assistant:
            List {
                Button(L10n("assistantMusic.title")) { showingMusicPreferences = true }
                NavigationLink(L10n("consumer.recommendationPreferences")) {
                    RecommendationPreferencesView(client: client)
                }
            }.navigationTitle(category.label)
        default:
            SettingsView(playback: playback, client: client, server: server, username: username, category: category)
        }
    }
}
