import SwiftUI
import SwiftTerm
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - SwiftTerm bridge
//
// Transport state stays in TerminalView. These two tiny representable adapters
// host SwiftTerm's platform-native renderer while sharing feed and delegate
// behavior across iPhone, iPad, Catalyst, and native macOS.

#if canImport(UIKit)
struct NativeTerminalSurface: UIViewRepresentable {
    let output: String
    let streamID: UUID
    var onInput: ([UInt8]) -> Void
    var onResize: (Int, Int) -> Void

    func makeCoordinator() -> NativeTerminalCoordinator {
        NativeTerminalCoordinator(onInput: onInput, onResize: onResize)
    }

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let terminal = SwiftTerm.TerminalView(frame: .zero)
        configureNativeTerminal(terminal, coordinator: context.coordinator, streamID: streamID)
        terminal.backgroundColor = .black
        return terminal
    }

    func updateUIView(_ terminal: SwiftTerm.TerminalView, context: Context) {
        updateNativeTerminal(
            terminal,
            coordinator: context.coordinator,
            output: output,
            streamID: streamID,
            onInput: onInput,
            onResize: onResize
        )
    }
}
#elseif canImport(AppKit)
struct NativeTerminalSurface: NSViewRepresentable {
    let output: String
    let streamID: UUID
    var onInput: ([UInt8]) -> Void
    var onResize: (Int, Int) -> Void

    func makeCoordinator() -> NativeTerminalCoordinator {
        NativeTerminalCoordinator(onInput: onInput, onResize: onResize)
    }

    func makeNSView(context: Context) -> SwiftTerm.TerminalView {
        let terminal = SwiftTerm.TerminalView(frame: .zero)
        configureNativeTerminal(terminal, coordinator: context.coordinator, streamID: streamID)
        terminal.nativeBackgroundColor = .black
        return terminal
    }

    func updateNSView(_ terminal: SwiftTerm.TerminalView, context: Context) {
        updateNativeTerminal(
            terminal,
            coordinator: context.coordinator,
            output: output,
            streamID: streamID,
            onInput: onInput,
            onResize: onResize
        )
    }
}
#endif

@MainActor
private func configureNativeTerminal(
    _ terminal: SwiftTerm.TerminalView,
    coordinator: NativeTerminalCoordinator,
    streamID: UUID
) {
    terminal.terminalDelegate = coordinator
    coordinator.streamID = streamID
}

@MainActor
private func updateNativeTerminal(
    _ terminal: SwiftTerm.TerminalView,
    coordinator: NativeTerminalCoordinator,
    output: String,
    streamID: UUID,
    onInput: @escaping ([UInt8]) -> Void,
    onResize: @escaping (Int, Int) -> Void
) {
    coordinator.onInput = onInput
    coordinator.onResize = onResize

    let byteCount = output.utf8.count
    if coordinator.streamID != streamID || byteCount < coordinator.fedByteCount {
        coordinator.streamID = streamID
        coordinator.fedByteCount = 0
    }

    let bytes = Array(output.utf8)
    guard coordinator.fedByteCount < bytes.count else { return }
    terminal.feed(byteArray: bytes[coordinator.fedByteCount...])
    coordinator.fedByteCount = bytes.count
}

final class NativeTerminalCoordinator: NSObject, TerminalViewDelegate {
    var streamID = UUID()
    var fedByteCount = 0
    var onInput: ([UInt8]) -> Void
    var onResize: (Int, Int) -> Void

    init(onInput: @escaping ([UInt8]) -> Void, onResize: @escaping (Int, Int) -> Void) {
        self.onInput = onInput
        self.onResize = onResize
    }

    func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
        guard newCols > 0, newRows > 0 else { return }
        onResize(newCols, newRows)
    }

    func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) { onInput(Array(data)) }
    func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
    func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
    func bell(source: SwiftTerm.TerminalView) { Task { @MainActor in Haptics.light() } }
    func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}

    func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        Task { @MainActor in
            #if canImport(UIKit)
            guard UIApplication.shared.canOpenURL(url) else { return }
            UIApplication.shared.open(url)
            #elseif canImport(AppKit)
            NSWorkspace.shared.open(url)
            #endif
        }
    }

    func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
        #if canImport(UIKit)
        UIPasteboard.general.setData(content, forPasteboardType: "public.utf8-plain-text")
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setData(content, forType: .string)
        #endif
    }

    func clipboardRead(source: SwiftTerm.TerminalView) -> Data? {
        #if canImport(UIKit)
        UIPasteboard.general.data(forPasteboardType: "public.utf8-plain-text")
        #elseif canImport(AppKit)
        NSPasteboard.general.data(forType: .string)
        #else
        nil
        #endif
    }
}
