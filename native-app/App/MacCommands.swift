#if os(macOS)
import SwiftUI
import WaynodeCore

extension Notification.Name {
    static let waynodeNewWorktree = Notification.Name("waynode.command.new-worktree")
    static let waynodeNewSession = Notification.Name("waynode.command.new-session")
    static let waynodeFindTranscript = Notification.Name("waynode.command.find-transcript")
    static let waynodeToggleReview = Notification.Name("waynode.command.toggle-review")
    static let waynodeToggleTerminal = Notification.Name("waynode.command.toggle-terminal")
    static let waynodeCommandPalette = Notification.Name("waynode.command.palette")
}

struct WaynodeMacCommands: Commands {
    let terminalSupported: Bool
    var body: some Commands {
        CommandGroup(after: .newItem) {
            command("New Worktree", icon: "folder.badge.plus", notification: .waynodeNewWorktree)
                .keyboardShortcut("n", modifiers: [.command, .option])
            command("New Session", icon: "plus.bubble", notification: .waynodeNewSession)
                .keyboardShortcut("n", modifiers: [.command, .shift])
        }

        CommandMenu("Session") {
            command("Search Transcript", icon: "magnifyingglass", notification: .waynodeFindTranscript)
                .keyboardShortcut("f", modifiers: .command)
            Divider()
            command("Toggle Review", icon: "sidebar.right", notification: .waynodeToggleReview)
                .keyboardShortcut("r", modifiers: [.command, .option])
            command("Toggle Terminal", icon: "terminal", notification: .waynodeToggleTerminal)
                .keyboardShortcut("t", modifiers: [.command, .option])
                .disabled(!terminalSupported)
            Divider()
            command("Command Palette", icon: "command", notification: .waynodeCommandPalette)
                .keyboardShortcut("p", modifiers: [.command, .shift])
        }
    }

    private func command(
        _ title: String,
        icon: String,
        notification: Notification.Name
    ) -> some View {
        Button {
            NotificationCenter.default.post(name: notification, object: nil)
        } label: {
            Label(title, systemImage: icon)
        }
    }
}

struct MacCommandPalette: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var appModel

    var body: some View {
        NavigationStack {
            List {
                paletteButton("New Worktree", icon: "folder.badge.plus", notification: .waynodeNewWorktree)
                paletteButton("New Session", icon: "plus.bubble", notification: .waynodeNewSession)
                paletteButton("Search Transcript", icon: "magnifyingglass", notification: .waynodeFindTranscript)
                paletteButton("Toggle Review", icon: "sidebar.right", notification: .waynodeToggleReview)
                if appModel.auth.terminalCapability != .unsupported {
                    paletteButton("Toggle Terminal", icon: "terminal", notification: .waynodeToggleTerminal)
                        .disabled(appModel.auth.terminalCapability != .supported)
                }
            }
            .navigationTitle("Command Palette")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 320)
    }

    private func paletteButton(
        _ title: String,
        icon: String,
        notification: Notification.Name
    ) -> some View {
        Button {
            dismiss()
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: notification, object: nil)
            }
        } label: {
            Label(title, systemImage: icon)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}

struct MacSettingsView: View {
    var body: some View {
        NavigationStack {
            AccountScene()
        }
        .frame(minWidth: 620, idealWidth: 700, minHeight: 660, idealHeight: 760)
    }
}
#endif
