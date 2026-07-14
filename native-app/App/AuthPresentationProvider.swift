import AuthenticationServices
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Retains the real scene window used to present an authentication session.
/// Authentication starts only after a SwiftUI window is attached, so no
/// deprecated, scene-less fallback window is needed on iOS or Mac Catalyst.
@MainActor
final class AuthPresentationProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor

    private init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
        super.init()
    }

    static func active() -> AuthPresentationProvider? {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return nil }
        return AuthPresentationProvider(anchor: window)
        #elseif canImport(AppKit)
        guard let window = NSApplication.shared.keyWindow ?? NSApplication.shared.mainWindow else { return nil }
        return AuthPresentationProvider(anchor: window)
        #else
        return nil
        #endif
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor
    }
}
