import SwiftUI

/// Shows a freshly-created token with copy button. The token is shown only
/// once — the user must copy it before dismissing.
struct NewTokenSheet: View {
    let token: String
    var onDone: () -> Void
    @State private var hasCopied = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.green)
                Text("Token Created").font(.title2.bold())
                Text("Copy this token now. For security, it will not be shown again.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text(token)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)
                Button {
                    copyToClipboard(token)
                    Haptics.success()
                    hasCopied = true
                } label: {
                    Label(hasCopied ? "Copied!" : "Copy Token", systemImage: hasCopied ? "checkmark" : "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.horizontal)
                Spacer()
            }
            .padding(.top, 40)
            .navigationTitle("New Token")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone).disabled(!hasCopied)
                }
            }
            .interactiveDismissDisabled(!hasCopied)
        }
    }
}
