import SwiftUI

@MainActor
struct ConnectionView: View {
    @Bindable var model: ConnectionModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://music.example.com", text: $model.serverText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("填写自托管实例的地址。HTTP 仅在你明确确认风险后使用。")
                }

                Section("账号") {
                    TextField("用户名", text: $model.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                    SecureField("密码", text: $model.password)
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
                                Text("连接并登录").bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(model.isBusy || !model.canSubmit)
                }
            }
            .navigationTitle("野弦")
            .toolbar {
                if !model.servers.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            model.showServers()
                        } label: {
                            Label("服务器", systemImage: "chevron.backward")
                        }
                    }
                }
            }
            .alert("使用未加密 HTTP？", isPresented: $model.showInsecureHTTPWarning) {
                Button("我了解风险，继续") { model.confirmInsecureHTTP() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("账号密码、播放记录和音频会以明文传输。请只在你信任的网络中使用；公网 HTTP 也不会被自动阻挡，但风险由你确认。")
            }
        }
    }
}
