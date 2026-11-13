import CoreNetwork
import SwiftUI

@MainActor
struct ServerRoutesEditor: View {
    @Bindable var routes: ServerRoutes

    enum FormMode: Equatable {
        case add
        case reauth(ServerRoute)

        var title: String {
            switch self {
            case .add: return L10n("routes.addAndSignIn")
            case .reauth(let route): return L10n("routes.reauthRoute", route.name)
            }
        }

        var submitTitle: String {
            switch self {
            case .add: return L10n("routes.verifyAndAdd")
            case .reauth: return L10n("routes.reverifyAndUpdate")
            }
        }
    }

    @State private var formMode: FormMode?
    @State private var name = ""
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var allowHTTP = false
    @State private var error: String?
    @State private var adding = false
    @State private var probes: [String: ServerRoutes.RouteProbe] = [:]
    @State private var testing: Set<String> = []

    var body: some View {
        Form {
            Section(L10n("routes.modeSection")) {
                Picker(L10n("routes.select"), selection: Binding(get: { routes.profile.manualAddress ?? "" }, set: { value in Task { await routes.select(value.isEmpty ? nil : value) } })) {
                    Text(L10n("routes.fallbackOption")).tag("")
                    ForEach(routes.profile.routes) { route in Text(L10n("routes.manualOption", route.name)).tag(route.address) }
                }
                Text(L10n("routes.modeDescription"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section(L10n("routes.prioritySection")) {
                ForEach(Array(routes.profile.routes.enumerated()), id: \.element.id) { index, route in
                    ServerRouteRow(
                        route: route,
                        index: index,
                        totalCount: routes.profile.routes.count,
                        isActive: route.address == routes.profile.activeAddress,
                        probe: probes[route.address],
                        isTesting: testing.contains(route.address),
                        onRename: { newName in routes.rename(route, name: newName) },
                        onMove: { distance in routes.move(route, by: distance) },
                        onReauth: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                name = route.name
                                address = route.address
                                allowHTTP = route.allowHTTP
                                password = ""
                                error = nil
                                formMode = .reauth(route)
                            }
                        },
                        onRemove: {
                            Task { await routes.remove(route) }
                        },
                        onTest: {
                            let key = route.address
                            testing.insert(key)
                            Task {
                                let result = await routes.test(route: route)
                                testing.remove(key)
                                probes[key] = result
                            }
                        }
                    )
                }

                if formMode == nil {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            name = ""
                            address = ""
                            allowHTTP = false
                            password = ""
                            error = nil
                            formMode = .add
                        }
                    } label: {
                        Label(L10n("routes.addNew"), systemImage: "plus")
                    }
                    .buttonStyle(.borderless)
                }
            }

            if let mode = formMode {
                Section(mode.title) {
                    TextField(L10n("routes.namePlaceholder"), text: $name)
                    TextField(L10n("routes.addressPlaceholder"), text: $address).onChange(of: address) { _, _ in allowHTTP = false }
                    Toggle(L10n("routes.allowHttp"), isOn: $allowHTTP)
                    TextField(L10n("routes.username"), text: $username)
                    SecureField(L10n("routes.password"), text: $password)
                    HStack(spacing: 12) {
                        Button(L10n("common.cancel")) {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                formMode = nil
                                error = nil
                                password = ""
                            }
                        }
                        .buttonStyle(.bordered)

                        Button(adding ? L10n("routes.verifying") : mode.submitTitle) {
                            adding = true; error = nil
                            Task {
                                defer { adding = false; password = "" }
                                do {
                                    try await routes.add(name: name, address: address, allowHTTP: allowHTTP, username: username, password: password)
                                    name = ""
                                    address = ""
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        formMode = nil
                                    }
                                } catch {
                                    self.error = (error as? APIError)?.code ?? L10n("routes.connectionFailed")
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(adding || password.isEmpty || address.isEmpty || name.isEmpty || username.isEmpty)
                    }
                    Text(L10n("routes.sessionNote"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message = error ?? routes.message {
                Text(message)
                    .foregroundStyle(error != nil ? .red : .secondary)
                    .font(.caption)
            }
        }
        .disabled(routes.busy && !adding)
        .formStyle(.grouped)
    }
}

private struct ServerRouteRow: View {
    let route: ServerRoute
    let index: Int
    let totalCount: Int
    let isActive: Bool
    let probe: ServerRoutes.RouteProbe?
    let isTesting: Bool
    let onRename: (String) -> Void
    let onMove: (Int) -> Void
    let onReauth: () -> Void
    let onRemove: () -> Void
    let onTest: () -> Void

    @State private var isEditing = false
    @State private var draftName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if isEditing {
                    TextField(L10n("routes.routeName"), text: $draftName)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { commitRename() }
                    Button(L10n("common.save")) { commitRename() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button(L10n("common.cancel")) { cancelRename() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                } else {
                    Text(route.name)
                        .font(.body)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Button {
                        draftName = route.name
                        isEditing = true
                    } label: {
                        Image(systemName: "pencil")
                    }
                    .buttonStyle(.borderless)
                    .help(L10n("routes.renameHelp"))

                    if isActive {
                        Text(L10n("routes.active"))
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.15))
                            .foregroundStyle(Color.accentColor)
                            .clipShape(Capsule())
                    }

                    Spacer()

                    Button { onMove(-1) } label: { Image(systemName: "arrow.up") }
                        .buttonStyle(.borderless)
                        .disabled(index == 0)
                        .help(L10n("routes.moveUpHelp"))
                    Button { onMove(1) } label: { Image(systemName: "arrow.down") }
                        .buttonStyle(.borderless)
                        .disabled(index == totalCount - 1)
                        .help(L10n("routes.moveDownHelp"))
                    Button { onTest() } label: { Image(systemName: "stethoscope") }
                        .buttonStyle(.borderless)
                        .disabled(isTesting)
                        .help(L10n("routes.testHelp"))
                        .accessibilityLabel(L10n("routes.testHelp"))
                    Button(L10n("routes.reauth")) { onReauth() }
                        .buttonStyle(.borderless)
                    Button(role: .destructive) { onRemove() } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                        .disabled(isActive || totalCount <= 1)
                        .help(L10n("routes.removeHelp"))
                }
            }
            HStack(spacing: 10) {
                Text(route.address)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if isTesting {
                    Text(L10n("routes.testing")).font(.caption2).foregroundStyle(.secondary)
                } else if let probe {
                    switch probe {
                    case .ok(let ms):
                        Label(L10n("routes.testOk", ms), systemImage: "checkmark.circle.fill")
                            .font(.caption2).foregroundStyle(.green)
                    case .sessionExpired:
                        Label(L10n("routes.testSessionExpired"), systemImage: "exclamationmark.circle.fill")
                            .font(.caption2).foregroundStyle(.orange)
                    case .unreachable:
                        Label(L10n("routes.testFailed"), systemImage: "xmark.circle.fill")
                            .font(.caption2).foregroundStyle(.red)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func commitRename() {
        let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            onRename(trimmed)
        }
        isEditing = false
    }

    private func cancelRename() {
        draftName = route.name
        isEditing = false
    }
}
