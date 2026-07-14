import SwiftUI

struct ServerConfigSheet: View {
    @Binding var url: String
    var onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var urlFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://your-server.com", text: $url)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .submitLabel(.done)
                        .focused($urlFocused)
                        .onSubmit(save)
                        .accessibilityIdentifier("server.url.field")
                } header: {
                    Text("Server URL")
                } footer: {
                    Text(validationMessage)
                        .foregroundStyle(trimmedURL.isEmpty || validatedURL != nil ? Color.secondary : Color.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("server.url.validation")
                }
                Section {
                    Text("Use your self-hosted Waynode address, including http:// or https://. The default is waynode.fornace.net.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("server.url.surface")
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("server.url.cancel")
                        .accessibilityHint("Closes without changing the server")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(validatedURL == nil)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("server.url.save")
                        .accessibilityHint(validatedURL == nil ? "Enter a complete HTTP or HTTPS server address" : "Saves this server and reconnects")
                }
            }
            .onAppear { urlFocused = true }
        }
    }

    private var trimmedURL: String {
        url.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var validatedURL: URL? {
        guard let components = URLComponents(string: trimmedURL),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty else { return nil }
        return components.url
    }

    private var validationMessage: String {
        if trimmedURL.isEmpty { return "Enter the full address of your Waynode server." }
        if validatedURL == nil { return "Enter a valid address beginning with http:// or https://." }
        return "Waynode will reconnect to this server after you save."
    }

    private func save() {
        guard let validatedURL else { return }
        onSave(validatedURL.absoluteString)
        dismiss()
    }
}
