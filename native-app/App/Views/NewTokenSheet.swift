import SwiftUI

/// Shows a freshly-created token with copy button. The token is shown only
/// once, with a clear copy action and a non-blocking way to close the sheet.
struct NewTokenSheet: View {
    let token: String
    var onDone: () -> Void
    @State private var hasCopied = false
    @State private var showingDiscardConfirmation = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.green)
                    .symbolEffect(.bounce, value: token)
                    .accessibilityHidden(true)
                Text("Token Created").font(.title2.bold())
                Text("Copy this token now. For security, it will not be shown again.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                ScrollView(.horizontal) {
                    Text(token)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(12)
                        .accessibilityLabel("New API token")
                        .accessibilityValue(token)
                        .accessibilityIdentifier("token.value")
                }
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)
                Button {
                    copyToClipboard(token)
                    Haptics.success()
                    hasCopied = true
                } label: {
                    Label(hasCopied ? "Copied!" : "Copy Token", systemImage: hasCopied ? "checkmark" : "doc.on.doc")
                        .symbolEffect(.bounce, value: hasCopied)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.horizontal)
                .accessibilityIdentifier("token.copy")
                .accessibilityHint("Copies the one-time token to the clipboard")
                Spacer()
            }
            .padding(.top, 40)
            .navigationTitle("New Token")
            .platformInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if hasCopied { onDone() } else { showingDiscardConfirmation = true }
                    }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("token.done")
                        .accessibilityHint(hasCopied ? "Closes this window" : "Asks before discarding the uncopied token")
                }
            }
            .interactiveDismissDisabled(!hasCopied)
            .alert(
                "Discard Uncopied Token?",
                isPresented: $showingDiscardConfirmation
            ) {
                Button("Discard Token", role: .destructive, action: onDone)
                    .accessibilityIdentifier("token.discard.confirm")
                Button("Keep Open", role: .cancel) {}
                    .accessibilityIdentifier("token.discard.cancel")
            } message: {
                Text("This token is shown only once. If you close now, you will need to create another token.")
            }
        }
        .macSheetFrame(minWidth: 500, idealWidth: 580, maxWidth: 680, minHeight: 420, idealHeight: 500, maxHeight: 620)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("token.surface")
    }
}
