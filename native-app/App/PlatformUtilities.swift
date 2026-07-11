import SwiftUI

// MARK: - PlatformUtilities
//
// Cross-platform helpers for iOS + macOS. SwiftUI's `UIPasteboard` is iOS-only,
// so we abstract clipboard access here. Haptic feedback is iOS-only; on macOS
// these calls are no-ops.

#if canImport(UIKit)
import UIKit

/// Copy text to the system clipboard.
func copyToClipboard(_ text: String) {
    UIPasteboard.general.string = text
}

/// Trigger a haptic feedback pattern. No-op on macOS.
@MainActor
enum Haptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    static func rigid() {
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
    }

    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}

#elseif canImport(AppKit)
import AppKit

func copyToClipboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

enum Haptics {
    static func success() {}
    static func error() {}
    static func warning() {}
    static func light() {}
    static func medium() {}
    static func rigid() {}
    static func selection() {}
}
#endif

// MARK: - Error Alert Modifier

/// A reusable error alert that observes an optional error string.
struct ErrorAlert: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content.alert("Error", isPresented: Binding(
            get: { message != nil },
            set: { if !$0 { message = nil } }
        )) {
            Button("OK", role: .cancel) { message = nil }
        } message: {
            Text(message ?? "")
        }
    }
}

extension View {
    /// Present an alert when `message` is non-nil. Clears on dismiss.
    func errorAlert(_ message: Binding<String?>) -> some View {
        modifier(ErrorAlert(message: message))
    }
}

// MARK: - Confirma­ble Destructive Action

/// A reusable confirmation dialog for destructive actions.
struct ConfirmDestructive: ViewModifier {
    let title: String
    let message: String
    let action: () -> Void
    @State private var isPresented = false

    func body(content: Content) -> some View {
        content
            .onTapGesture { isPresented = true }
            .confirmationDialog(title, isPresented: $isPresented, titleVisibility: .visible) {
                Button(title, role: .destructive, action: action)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(message)
            }
    }
}
