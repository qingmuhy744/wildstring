import SwiftUI

@MainActor
struct ConnectionView: View {
    @Bindable var model: ConnectionModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("music.example.com", text: $model.serverText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                } header: {
                    Text(L10n("connView.serverAddressHeader"))
                } footer: {
                    Text(L10n("connView.serverAddressFooter"))
                }

                Section(L10n("connView.accountSection")) {
                    TextField(L10n("connView.usernamePlaceholder"), text: $model.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                    SecureField(L10n("connView.passwordPlaceholder"), text: $model.password)
                        .textContentType(.password)
                }

                if let message = model.errorMessage {
                    Section {
                        Text(message)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await model.login() }
                    } label: {
                        HStack {
                            Spacer()
                            if model.isBusy {
                                ProgressView()
                            } else {
                                Text(L10n("connView.connectAndLogin")).bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(model.isBusy || !model.canSubmit)
                }
            }
            .navigationTitle(L10n("connView.brandTitle"))
            .toolbar {
                if !model.servers.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            model.showServers()
                        } label: {
                            Label(L10n("connView.servers"), systemImage: "chevron.backward")
                        }
                    }
                }
            }
            .alert(L10n("connView.insecureHTTPTitle"), isPresented: $model.showInsecureHTTPWarning) {
                Button(L10n("connView.insecureHTTPConfirm")) { model.confirmInsecureHTTP() }
                Button(L10n("connView.cancel"), role: .cancel) {}
            } message: {
                Text(L10n("connView.insecureHTTPMessage"))
            }
        }
    }
}
