#if DEBUG
import SwiftUI
import WaynodeCore

struct ChatUITestFixtureView: View {
    @State private var store: SessionStore

    init(historyFailure: Bool) {
        let api = APIClient(baseURL: URL(string: "https://example.test")!, token: "fixture")
        let fixture = SessionStore(
            sessionId: "ui-session", spaceId: "ui-space", api: api, offlineFixture: true
        )
        if historyFailure {
            fixture.historyError = "Conversation couldn’t be loaded. Your conversation is preserved on the server."
        } else {
            fixture.didLoadHistory = true
            _ = fixture.reducer.reduce(.submission(.init(
                id: "ui-running", prompt: "Audit every detail",
                isGoal: false, status: .running
            )))
        }
        _store = State(initialValue: fixture)
    }

    var body: some View {
        ChatView(store: store)
    }
}
#endif
