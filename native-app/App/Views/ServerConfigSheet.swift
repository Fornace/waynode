import SwiftUI
import WaynodeCore

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
                        .platformURLTextInput()
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
                    Text("Use HTTPS for hosted or self-hosted servers. Unencrypted HTTP is accepted only for localhost development.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("server.url.surface")
            .navigationTitle("Server")
            .platformInlineNavigationTitle()
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
                        .accessibilityHint(validatedURL == nil ? "Enter a secure Waynode server address" : "Saves this server and reconnects")
                }
            }
            .onAppear { urlFocused = true }
        }
    }

    private var trimmedURL: String {
        url.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var validatedURL: URL? {
        ServerConfig.validatedBaseURL(from: trimmedURL)
    }

    private var validationMessage: String {
        if trimmedURL.isEmpty { return "Enter the full address of your Waynode server." }
        if validatedURL == nil { return "Use https://, or http://localhost for local development." }
        return "Saving signs out of the current server before connecting to this one."
    }

    private func save() {
        guard let validatedURL else { return }
        onSave(validatedURL.absoluteString)
        dismiss()
    }
}
