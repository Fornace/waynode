import SwiftUI

struct AccountDeletionSheet: View {
    let accountName: String
    let providers: [String]
    let isDeleting: Bool
    let error: String?
    let onCancel: () -> Void
    let onDelete: (String) -> Void

    @State private var confirmation = ""
    @State private var selectedProvider: String

    init(
        accountName: String,
        providers: [String],
        isDeleting: Bool,
        error: String?,
        onCancel: @escaping () -> Void,
        onDelete: @escaping (String) -> Void
    ) {
        self.accountName = accountName
        self.providers = providers
        self.isDeleting = isDeleting
        self.error = error
        self.onCancel = onCancel
        self.onDelete = onDelete
        _selectedProvider = State(initialValue: providers.first ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Permanently delete \(accountName)", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Personal spaces, sessions, API tokens, and saved credentials are permanently removed. Shared organization work stays with its other administrators.")
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section("Billing and organizations") {
                    Text("Deleting your account does not cancel an organization subscription. Transfer administration and cancel or manage billing first. Waynode will block deletion if an organization would be left without an administrator.")
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section("Verify your identity") {
                    if providers.isEmpty {
                        Text("No linked GitHub or GitLab account is available for secure reauthentication.")
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("account.delete.provider.unavailable")
                    } else {
                        Picker("Continue with", selection: $selectedProvider) {
                            ForEach(providers, id: \.self) { provider in
                                Text(provider.capitalized).tag(provider)
                            }
                        }
                        .accessibilityIdentifier("account.delete.provider")
                    }
                }

                Section {
                    TextField("Type DELETE", text: $confirmation)
                        .platformConfirmationTextInput()
                        .submitLabel(.done)
                        .accessibilityIdentifier("account.delete.confirmation")
                    Text("Type DELETE exactly, then sign in again with the linked provider above.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("account.delete.error")
                    }
                }
            }
            .accessibilityIdentifier("account.delete.surface")
            .navigationTitle("Delete Account")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isDeleting)
                        .accessibilityIdentifier("account.delete.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(role: .destructive) {
                        onDelete(selectedProvider.isEmpty ? providers.first ?? "" : selectedProvider)
                    } label: {
                        if isDeleting {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Delete Account")
                        }
                    }
                    .disabled(confirmation != "DELETE" || providers.isEmpty || isDeleting)
                    .accessibilityIdentifier("account.delete.confirm")
                }
            }
        }
        .onAppear {
            if selectedProvider.isEmpty { selectedProvider = providers.first ?? "" }
        }
    }
}
