import CoreNetwork
import PhotosUI
import SwiftUI

struct AccountProfileView: View {
    let client: WildstringClient
    @State private var user: User?
    @State private var avatar: UIImage?
    @State private var selection: PhotosPickerItem?
    @State private var name = ""
    @State private var email = ""
    @State private var busy = false
    @State private var error: String?
    @State private var avatarError: String?
    @State private var saved = false

    var body: some View {
        Form {
            if let user {
                Section {
                    HStack(spacing: 12) {
                        Group {
                            if let avatar {
                                Image(uiImage: avatar).resizable().scaledToFill()
                            } else {
                                Image(systemName: "person.crop.circle.fill").resizable().scaledToFit()
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(width: 54, height: 54)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                        Text(user.username)
                    }
                    PhotosPicker(selection: $selection, matching: .images) {
                        Label(L10n("consumer.changeAvatar"), systemImage: "photo")
                    }
                    if avatar != nil {
                        Button(L10n("consumer.removeAvatar"), role: .destructive) {
                            Task { await saveAvatar(nil) }
                        }
                    }
                    if let avatarError { Text(avatarError).foregroundStyle(.secondary) }
                }
                Section {
                    TextField(L10n("consumer.displayName"), text: $name)
                    TextField(L10n("consumer.email"), text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button(L10n("adminEdit.save")) { Task { await saveProfile() } }
                        .disabled(name == (user.displayName ?? "") && email == (user.email ?? ""))
                    if saved { Text(L10n("adminEdit.savedMessage")).foregroundStyle(.secondary) }
                }
            } else if error == nil { ProgressView() }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            }
        }
        .disabled(busy)
        .navigationTitle(L10n("consumer.profile"))
        .task { await load() }
        .onChange(of: selection) { _, item in
            guard let item else { return }
            Task { await upload(item) }
        }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            guard let current = try await client.authStatus().user else {
                throw APIError(statusCode: 401, code: "authentication_required")
            }
            if user == nil {
                name = current.displayName ?? ""
                email = current.email ?? ""
            }
            user = current
            error = nil
            do {
                let data = try await client.avatarImage(accountID: current.id)
                avatar = data.flatMap { UIImage(data: $0) }
                avatarError = nil
            } catch {
                avatarError = ErrorText.message(for: error)
            }
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func saveProfile() async {
        guard let user else { return }
        busy = true
        defer { busy = false }
        do {
            self.user = try await client.updateProfile(user, displayName: name, email: email)
            saved = true
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        defer { selection = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                avatarError = L10n("consumer.invalidAvatar")
                return
            }
            let factor = min(1, 768 / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * factor, height: image.size.height * factor)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let resized = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.86) { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            await saveAvatar(resized)
        } catch {
            avatarError = ErrorText.message(for: error)
        }
    }

    private func saveAvatar(_ data: Data?) async {
        guard let user else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.saveAvatar(data, accountID: user.id)
            let stored = try await client.avatarImage(accountID: user.id)
            avatar = stored.flatMap { UIImage(data: $0) }
            avatarError = nil
        } catch {
            avatarError = ErrorText.message(for: error)
        }
    }
}

struct ChangePasswordView: View {
    let client: WildstringClient
    let onLogout: () -> Void
    @State private var password = ""
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            SecureField(L10n("consumer.currentPassword"), text: $password).textContentType(.password)
            SecureField(L10n("consumer.newPassword"), text: $newPassword).textContentType(.newPassword)
            SecureField(L10n("consumer.confirmPassword"), text: $confirmation).textContentType(.newPassword)
            if let error { Text(error).foregroundStyle(.secondary) }
            Section {
                Button(L10n("adminEdit.save")) { Task { await save() } }
                    .disabled(password.isEmpty || !(12...128).contains(newPassword.unicodeScalars.count) || newPassword != confirmation)
            } footer: {
                Text(L10n("consumer.passwordSignIn"))
            }
        }
        .disabled(busy)
        .navigationTitle(L10n("consumer.changePassword"))
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            try await client.changePassword(current: password, new: newPassword)
            password = ""
            newPassword = ""
            confirmation = ""
            onLogout()
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct LastfmSettingsView: View {
    let client: WildstringClient
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var account: LastfmAccount?
    @State private var scrobble = false
    @State private var nowPlaying = false
    @State private var busy = false
    @State private var error: String?
    @State private var confirmingDisconnect = false

    var body: some View {
        Form {
            if let account {
                if !account.configured {
                    ContentUnavailableView(L10n("consumer.lastfmNotConfigured"), systemImage: "antenna.radiowaves.left.and.right")
                } else if !account.connected || account.needsAuth == true {
                    Button(L10n("consumer.connectLastfm")) {
                        Task {
                            await run {
                                let url = try await client.authorizeLastfm()
                                guard url.scheme == "https", url.host == "www.last.fm" else {
                                    throw APIError(statusCode: 422, code: "invalid_lastfm_authorization_url")
                                }
                                openURL(url)
                            }
                        }
                    }
                } else {
                    if let username = account.username {
                        LabeledContent(L10n("account.username"), value: username)
                    }
                    Toggle(L10n("consumer.scrobble"), isOn: $scrobble)
                    Toggle(L10n("consumer.lastfmNowPlaying"), isOn: $nowPlaying)
                    Button(L10n("adminEdit.save")) {
                        Task {
                            await run {
                                apply(try await client.saveLastfmAccount(account, scrobble: scrobble, nowPlaying: nowPlaying))
                            }
                        }
                    }
                    .disabled(scrobble == account.scrobble && nowPlaying == account.nowPlaying)
                }
                if account.connected {
                    Button(L10n("consumer.disconnectLastfm"), role: .destructive) { confirmingDisconnect = true }
                }
            } else if error == nil { ProgressView() }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            }
        }
        .disabled(busy)
        .navigationTitle("Last.fm")
        .task { await load() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await load() } } }
        .confirmationDialog(L10n("consumer.disconnectLastfm"), isPresented: $confirmingDisconnect, titleVisibility: .visible) {
            Button(L10n("consumer.disconnectLastfm"), role: .destructive) {
                Task { await run { try await client.disconnectLastfm(); apply(try await client.lastfmAccount()) } }
            }
        }
    }

    private func apply(_ current: LastfmAccount) {
        account = current
        scrobble = current.scrobble
        nowPlaying = current.nowPlaying
    }

    private func load() async {
        await run { apply(try await client.lastfmAccount()) }
    }

    private func run(_ action: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await action()
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct NotificationPreferencesView: View {
    let client: WildstringClient
    @State private var value: PersonalNotificationPreferences?
    @State private var start = ""
    @State private var end = ""
    @State private var busy = false
    @State private var error: String?
    @State private var saved = false

    private let events = ["draft.pending", "draft.applied", "task.completed", "task.partial", "task.failed", "task.paused"]

    var body: some View {
        Form {
            if saved { Text(L10n("adminEdit.savedMessage")).foregroundStyle(.secondary) }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            }
            if let binding = Binding($value) {
                Toggle(L10n("consumer.telegramNotifications"), isOn: binding.telegramEnabled)
                Section(L10n("consumer.notificationEvents")) {
                    ForEach(events, id: \.self) { event in
                        Toggle(L10n("consumer.event.\(event)"), isOn: Binding(
                            get: { binding.eventTypes.wrappedValue.contains(event) },
                            set: { selected in
                                if selected { binding.eventTypes.wrappedValue.append(event) }
                                else { binding.eventTypes.wrappedValue.removeAll { $0 == event } }
                            }
                        ))
                    }
                }
                Picker(L10n("consumer.notificationSeverity"), selection: binding.minSeverity) {
                    Text(L10n("consumer.allNotifications")).tag("info")
                    Text(L10n("notifications.severityWarning")).tag("warning")
                    Text(L10n("notifications.severityError")).tag("error")
                }
                TextField(L10n("consumer.quietStart"), text: $start).keyboardType(.numbersAndPunctuation)
                TextField(L10n("consumer.quietEnd"), text: $end).keyboardType(.numbersAndPunctuation)
                TextField(L10n("consumer.timezone"), text: binding.timezone).autocorrectionDisabled()
            } else if error == nil { ProgressView() }
        }
        .disabled(busy)
        .navigationTitle(L10n("consumer.notificationPreferences"))
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(L10n("adminEdit.save")) { Task { await save() } }
                    .disabled(value == nil || busy)
            }
        }
        .task { await load() }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await client.notificationPreferences()
            value = result
            start = result.quietStart ?? ""
            end = result.quietEnd ?? ""
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func save() async {
        guard var value else { return }
        busy = true
        defer { busy = false }
        value.quietStart = start.isEmpty ? nil : start
        value.quietEnd = end.isEmpty ? nil : end
        do {
            self.value = try await client.saveNotificationPreferences(value)
            error = nil
            saved = true
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}

struct PodcastCacheSettingsView: View {
    let client: WildstringClient
    @State private var value: PodcastCachePreferences?
    @State private var error: String?
    @State private var busy = false
    @State private var saved = false

    var body: some View {
        Form {
            if let binding = Binding($value) {
                Toggle(L10n("consumer.cacheCurrentEpisode"), isOn: binding.autoCacheCurrent)
                Toggle(L10n("consumer.prefetchNextEpisode"), isOn: binding.prefetchNext)
                Picker(L10n("consumer.cacheNetwork"), selection: binding.networkPolicy) {
                    Text(L10n("consumer.none")).tag("off")
                    Text("Wi-Fi").tag("wifi")
                    Text(L10n("consumer.anyNetwork")).tag("any")
                }
                Button(L10n("adminEdit.save")) { Task { await save() } }
                if saved { Text(L10n("adminEdit.savedMessage")).foregroundStyle(.secondary) }
            } else if error == nil { ProgressView() }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button(L10n("notifications.retry")) { Task { await load() } }
            }
        }
        .disabled(busy)
        .navigationTitle(L10n("consumer.podcastCache"))
        .task { await load() }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            value = try await client.podcastCachePreferences()
            error = nil
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }

    private func save() async {
        guard let value else { return }
        busy = true
        defer { busy = false }
        do {
            self.value = try await client.savePodcastCachePreferences(value)
            error = nil
            saved = true
        } catch {
            self.error = ErrorText.message(for: error)
        }
    }
}
