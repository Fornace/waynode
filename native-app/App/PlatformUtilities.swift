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
                .accessibilityIdentifier("error.dismiss")
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

    /// Give utility sheets a useful desktop footprint without imposing a
    /// desktop-sized minimum on iPhone and iPad.
    @ViewBuilder
    func macSheetFrame(
        minWidth: CGFloat = 480,
        idealWidth: CGFloat = 600,
        maxWidth: CGFloat = 760,
        minHeight: CGFloat = 480,
        idealHeight: CGFloat = 680,
        maxHeight: CGFloat = 900
    ) -> some View {
        #if targetEnvironment(macCatalyst) || os(macOS)
        frame(
            minWidth: minWidth,
            idealWidth: idealWidth,
            maxWidth: maxWidth,
            minHeight: minHeight,
            idealHeight: idealHeight,
            maxHeight: maxHeight
        )
        #else
        self
        #endif
    }

    /// Keep navigation-title styling native on macOS, where there is no
    /// UIKit navigation bar to force into an inline mode.
    @ViewBuilder
    func platformInlineNavigationTitle() -> some View {
        #if os(macOS)
        self
        #else
        navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// iPhone and iPad use detents; native macOS sheets size from their
    /// content and `macSheetFrame` instead of emulating a mobile drawer.
    @ViewBuilder
    func platformAdaptiveSheet() -> some View {
        #if os(macOS)
        self
        #else
        presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        #endif
    }

    @ViewBuilder
    func platformSensitiveCover<Item: Identifiable, Content: View>(
        item: Binding<Item?>,
        @ViewBuilder content: @escaping (Item) -> Content
    ) -> some View {
        #if os(macOS)
        sheet(item: item, content: content)
        #else
        fullScreenCover(item: item, content: content)
        #endif
    }

    @ViewBuilder
    func platformInteractiveKeyboardDismissal() -> some View {
        #if os(macOS)
        self
        #else
        scrollDismissesKeyboard(.interactively)
        #endif
    }

    /// UIKit offers keyboard/content hints that AppKit text fields do not.
    /// Keep the call sites shared without asking macOS to compile UIKit-only
    /// modifiers such as `keyboardType` and `textInputAutocapitalization`.
    @ViewBuilder
    func platformURLTextInput() -> some View {
        #if os(macOS)
        self
        #else
        keyboardType(.URL)
            .textContentType(.URL)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
        #endif
    }

    @ViewBuilder
    func platformCodeTextInput() -> some View {
        #if os(macOS)
        self
        #else
        autocorrectionDisabled()
            .textInputAutocapitalization(.never)
        #endif
    }

    @ViewBuilder
    func platformConfirmationTextInput() -> some View {
        #if os(macOS)
        self
        #else
        autocorrectionDisabled()
            .textInputAutocapitalization(.characters)
        #endif
    }

    @ViewBuilder
    func platformSessionSettingsShortcut() -> some View {
        #if os(macOS)
        keyboardShortcut(",", modifiers: [.command, .option])
        #else
        keyboardShortcut(",", modifiers: .command)
        #endif
    }

    @ViewBuilder
    func platformNavigationSearch(text: Binding<String>, prompt: String) -> some View {
        #if os(macOS)
        searchable(text: text, placement: .toolbar, prompt: prompt)
        #else
        searchable(
            text: text,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: prompt
        )
        #endif
    }

    @ViewBuilder
    func platformNewSessionShortcut() -> some View {
        #if os(macOS)
        keyboardShortcut("n", modifiers: [.command, .shift])
        #else
        keyboardShortcut("n", modifiers: .command)
        #endif
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
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Asks for confirmation")
            .alert(title, isPresented: $isPresented) {
                Button(title, role: .destructive, action: action)
                    .accessibilityIdentifier("destructive.confirm")
                Button("Cancel", role: .cancel) {}
                    .accessibilityIdentifier("destructive.cancel")
            } message: {
                Text(message)
            }
    }
}
