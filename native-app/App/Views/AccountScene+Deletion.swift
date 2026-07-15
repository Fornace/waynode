import AuthenticationServices
import SwiftUI
import WaynodeCore

extension AccountScene {
    var linkedDeletionProviders: [String] {
        var result: [String] = []
        if appModel.auth.providers?.github == true { result.append("github") }
        if appModel.auth.providers?.gitlab == true { result.append("gitlab") }
        return result
    }

    var deleteAccountSection: some View {
        Section {
            Button(role: .destructive) {
                accountDeletionError = nil
                showingDeleteAccount = true
            } label: {
                Label("Delete Account", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("account.delete.request")
            .accessibilityHint("Opens permanent account deletion with identity verification")
        } header: {
            Text("Danger Zone")
        } footer: {
            Text("Permanent deletion requires a fresh GitHub or GitLab sign-in and explicit confirmation.")
        }
    }

    func beginAccountDeletion(provider: String) async {
        guard deletionSession == nil else { return }
        accountDeletionError = nil
        isDeletingAccount = true

        #if DEBUG
        if appModel.isUITestFixture {
            if CommandLine.arguments.contains("-ui-test-account-deletion-failure") {
                accountDeletionError = "Verification failed. Your account was not deleted."
                isDeletingAccount = false
            } else {
                showingDeleteAccount = false
                appModel.clearAfterAccountDeletion()
            }
            return
        }
        #endif

        guard let api = appModel.currentAPI() else {
            accountDeletionError = "The server connection is unavailable. Your account was not deleted."
            isDeletingAccount = false
            return
        }

        do {
            let nonce = try NativeAccountDeletion.makeNonce()
            let authURL = try await api.beginAccountDeletionReauth(provider: provider, nonce: nonce)
            guard let presentationProvider = AuthPresentationProvider.active() else {
                throw APIClient.APIError(statusCode: -1, message: "Waynode needs an active window to verify your identity.")
            }
            let completion: @Sendable (URL?, Error?) -> Void = { callbackURL, error in
                DispatchQueue.main.async {
                    Task { @MainActor in
                        await finishAccountDeletion(callbackURL: callbackURL, error: error, nonce: nonce, api: api)
                    }
                }
            }
            let session = ASWebAuthenticationSession(
                url: authURL,
                callback: .customScheme(AuthStore.callbackScheme),
                completionHandler: completion
            )
            session.prefersEphemeralWebBrowserSession = true
            session.presentationContextProvider = presentationProvider
            deletionPresentationProvider = presentationProvider
            deletionSession = session
            guard session.start() else {
                deletionSession = nil
                deletionPresentationProvider = nil
                throw APIClient.APIError(statusCode: -1, message: "Waynode couldn't open identity verification.")
            }
        } catch {
            accountDeletionError = error.localizedDescription
            isDeletingAccount = false
        }
    }

    func finishAccountDeletion(callbackURL: URL?, error: Error?, nonce: String, api: APIClient) async {
        deletionSession = nil
        deletionPresentationProvider = nil
        if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
            isDeletingAccount = false
            return
        }
        do {
            if let error { throw error }
            guard let callbackURL else { throw NativeAccountDeletion.CallbackError.invalidOrExpired }
            let grant = try NativeAccountDeletion.grant(from: callbackURL, expectedNonce: nonce)
            try await api.deleteAccount(grant: grant, nonce: nonce)
            showingDeleteAccount = false
            appModel.clearAfterAccountDeletion()
        } catch {
            accountDeletionError = error.localizedDescription
            isDeletingAccount = false
        }
    }

    func cancelAccountDeletion() {
        deletionSession?.cancel()
        deletionSession = nil
        deletionPresentationProvider = nil
        isDeletingAccount = false
    }
}
