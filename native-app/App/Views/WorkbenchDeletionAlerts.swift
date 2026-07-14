import SwiftUI
import WaynodeCore

private struct WorkbenchDeletionAlerts: ViewModifier {
    @Environment(AppModel.self) private var appModel
    @Binding var space: Space?
    @Binding var session: Session?

    func body(content: Content) -> some View {
        content
            .alert(
                "Delete Worktree?",
                isPresented: Binding(
                    get: { space != nil },
                    set: { if !$0 { space = nil } }
                ),
                presenting: space
            ) { worktree in
                Button("Delete Worktree", role: .destructive) {
                    Task { await appModel.deleteSpace(worktree.id) }
                }
                .accessibilityIdentifier("worktree.delete.confirm")
                Button("Cancel", role: .cancel) {}
                    .accessibilityIdentifier("worktree.delete.cancel")
            } message: { worktree in
                Text("This removes \"\(worktree.repoName)\" and all its sessions from Waynode. This cannot be undone.")
            }
            .alert(
                "Delete Session?",
                isPresented: Binding(
                    get: { session != nil },
                    set: { if !$0 { session = nil } }
                ),
                presenting: session
            ) { selectedSession in
                Button("Delete", role: .destructive) {
                    Task { await appModel.deleteSession(selectedSession.id) }
                }
                .accessibilityIdentifier("session.delete.confirm")
                Button("Cancel", role: .cancel) {}
                    .accessibilityIdentifier("session.delete.cancel")
            } message: { selectedSession in
                Text("Delete \"\(selectedSession.title)\" and its conversation history? This cannot be undone.")
            }
    }
}

extension View {
    func workbenchDeletionAlerts(space: Binding<Space?>, session: Binding<Session?>) -> some View {
        modifier(WorkbenchDeletionAlerts(space: space, session: session))
    }
}
