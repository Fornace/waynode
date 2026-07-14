import SwiftUI
import SwiftTerm
import UIKit

// MARK: - SwiftTerm bridge
//
// SwiftTerm owns VT/xterm parsing, scrollback, selection, keyboard input,
// resizing, colours, hyperlinks and the platform-native renderer. This bridge
// deliberately owns no terminal state: Waynode remains the transport owner and
// simply feeds bytes from its server-side PTY into the emulator.

struct NativeTerminalSurface: UIViewRepresentable {
    let output: String
    let streamID: UUID
    var onInput: ([UInt8]) -> Void
    var onResize: (Int, Int) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onInput: onInput, onResize: onResize)
    }

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let terminal = SwiftTerm.TerminalView(frame: .zero)
        terminal.terminalDelegate = context.coordinator
        terminal.backgroundColor = .black
        context.coordinator.streamID = streamID
        return terminal
    }

    func updateUIView(_ terminal: SwiftTerm.TerminalView, context: Context) {
        context.coordinator.onInput = onInput
        context.coordinator.onResize = onResize

        // A reconnect intentionally begins with ED2 + CUP so the server's new
        // PTY starts from a clean screen. If a stream is replaced, replay its
        // captured output into this view; otherwise feed only the new suffix.
        if context.coordinator.streamID != streamID || output.utf8.count < context.coordinator.fedByteCount {
            context.coordinator.streamID = streamID
            context.coordinator.fedByteCount = 0
        }

        let bytes = Array(output.utf8)
        guard context.coordinator.fedByteCount < bytes.count else { return }
        terminal.feed(byteArray: bytes[context.coordinator.fedByteCount...])
        context.coordinator.fedByteCount = bytes.count
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
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

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            onInput(Array(data))
        }

        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func bell(source: SwiftTerm.TerminalView) {
            Task { @MainActor in Haptics.light() }
        }
        func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}

        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String : String]) {
            guard let url = URL(string: link) else { return }
            Task { @MainActor in
                guard UIApplication.shared.canOpenURL(url) else { return }
                UIApplication.shared.open(url)
            }
        }

        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            UIPasteboard.general.setData(content, forPasteboardType: "public.utf8-plain-text")
        }

        func clipboardRead(source: SwiftTerm.TerminalView) -> Data? {
            UIPasteboard.general.data(forPasteboardType: "public.utf8-plain-text")
        }
    }
}
