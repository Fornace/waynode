import SwiftUI
import WaynodeCore

// MARK: - TerminalView
//
// A native terminal view using the WSClient to connect to the server's
// terminal WebSocket. We use a custom text-based rendering (not xterm.js)
// since this is native — no need for a web-based terminal emulator.
//
// Features:
//   • Monospace output rendering
//   • Input field at the bottom
//   • Auto-scroll
//   • Connection status
//   • Copy output

struct TerminalView: View {
    let sessionId: String
    let spaceId: String

    @Environment(AppModel.self) private var appModel
    @State private var output: String = ""
    @State private var input: String = ""
    @State private var connectionState: TerminalConnection = .disconnected
    @State private var scrollTarget: Int = 0
    @State private var outputLines: [String] = []
    @State private var wsClient: WSClient?
    @State private var listenTask: Task<Void, Never>?
    @FocusState private var inputFocused: Bool
    @State private var hasExited: Bool = false

    enum TerminalConnection: Equatable {
        case disconnected, connecting, connected, failed(String), exited(Int)

        var isFailed: Bool {
            if case .failed = self { return true }
            return false
        }
    }

    private let bottomID = "term-bottom"

    var body: some View {
        VStack(spacing: 0) {
            // Status bar
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                Text(statusText)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()

                if connectionState == .connected {
                    Button {
                        Task { await sendResize() }
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.caption2)
                    }
                    .buttonStyle(.plain)
                    .help("Fit terminal to 80×24")
                    .accessibilityLabel("Resize terminal")
                }

                Button {
                    copyToClipboard(outputLines.joined(separator: "\n"))
                    Haptics.success()
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
                .disabled(outputLines.isEmpty)

                Button {
                    Task { await reconnect() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            // Terminal output
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(outputLines.enumerated()), id: \.offset) { _, line in
                            Text(line.isEmpty ? " " : line)
                                .font(.system(.caption, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                        Color.clear.frame(height: 1).id(bottomID)
                    }
                    .padding(8)
                }
                .background(Color.black.opacity(0.9))
                .defaultScrollAnchor(.bottom)
                .onChange(of: outputLines.count) {
                    withAnimation(.smooth) {
                        proxy.scrollTo(bottomID, anchor: .bottom)
                    }
                }
            }

            // Input bar
            if !hasExited {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.green)

                    TextField("Type a command…", text: $input, axis: .vertical)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1...4)
                        .focused($inputFocused)
                        .onSubmit {
                            sendInput()
                        }
                        .background(.thinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .padding(.vertical, 4)

                    Button {
                        sendInput()
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.caption.bold())
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.small)
                    .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || connectionState != .connected)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            } else if case .failed(let msg) = connectionState {
                HStack {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Text(msg)
                        .font(.caption)
                        .lineLimit(2)
                    Spacer()
                    Button("Retry") {
                        Task { await reconnect() }
                    }
                    .buttonStyle(.glass)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.thinMaterial)
            } else {
                HStack {
                    Image(systemName: "checkmark.circle")
                    Text("Terminal exited with code \(exitCode)")
                    Spacer()
                    Button("Restart") {
                        Task { await reconnect() }
                    }
                    .buttonStyle(.glass)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.thinMaterial)
            }
        }
        .task {
            await connect()
        }
        .onDisappear {
            listenTask?.cancel()
            Task { await wsClient?.disconnect() }
        }
    }

    private var statusColor: Color {
        switch connectionState {
        case .connected: return .green
        case .connecting: return .orange
        case .disconnected: return .secondary
        case .failed: return .red
        case .exited: return .secondary
        }
    }

    private var statusText: String {
        switch connectionState {
        case .connected: return "Connected"
        case .connecting: return "Connecting…"
        case .disconnected: return "Disconnected"
        case .failed(let msg): return "Error: \(msg)"
        case .exited(let code): return "Exited (\(code))"
        }
    }

    private var exitCode: Int {
        if case .exited(let code) = connectionState { return code }
        return 0
    }

    // MARK: - Connection

    private func connect() async {
        guard let api = appModel.currentAPI() else { return }
        connectionState = .connecting
        outputLines = []
        hasExited = false

        // The server's terminal WebSocket lives at /ws/terminal and takes
        // the session ID as a query param (see routes/terminal.js). It is
        // NOT a REST path under /api/sessions/:id/.
        var components = URLComponents(
            url: api.makeURL("/ws/terminal"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
        let url = components.url ?? api.makeURL("/ws/terminal")

        let token = await api.currentToken()
        let client = WSClient(url: url, token: token)
        wsClient = client
        await client.connect()

        listenTask = Task {
            let stream = client.output()
            for await msg in stream {
                await handleMessage(msg)
            }
            // Stream ended. If the terminal didn't exit cleanly, the
            // socket dropped unexpectedly — surface as a failure so the
            // user knows they need to reconnect.
            if !hasExited {
                await MainActor.run {
                    if case .exited = connectionState {
                        // already handled
                    } else {
                        connectionState = .failed("Connection closed")
                    }
                }
            }
        }
        connectionState = .connected
        inputFocused = true
    }

    private func reconnect() async {
        listenTask?.cancel()
        Task { await wsClient?.disconnect() }
        await connect()
    }

    // MARK: - Message handling

    private func handleMessage(_ msg: WSClient.TerminalMessage) async {
        switch msg {
        case .output(let data):
            // Strip ANSI escape sequences (colors, cursor movement, etc.)
            // for clean text rendering. The native view doesn't emulate a
            // full terminal — we show readable text output.
            let cleaned = TerminalView.stripANSI(data)
            // Split on newlines and append
            let newLines = cleaned.components(separatedBy: "\n")
            for (i, line) in newLines.enumerated() {
                if i == 0 && !outputLines.isEmpty {
                    // Append to last line
                    outputLines[outputLines.count - 1] += line
                } else {
                    outputLines.append(line)
                }
            }
            // Cap output to last 1000 lines to avoid memory bloat
            if outputLines.count > 1000 {
                outputLines.removeFirst(outputLines.count - 1000)
            }
        case .exited(let code):
            connectionState = .exited(code)
            hasExited = true
        case .error(let message):
            // Server-side error (agent busy, terminal disabled, etc.)
            connectionState = .failed(message)
            hasExited = true
        }
    }

    // MARK: - Input

    private func sendInput() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            await wsClient?.sendInput(trimmed + "\n")
            input = ""
        }
    }

    private func sendResize() async {
        await wsClient?.sendResize(cols: 80, rows: 24)
    }

    // MARK: - ANSI stripping

    /// Strips ANSI escape sequences from terminal output.
    /// Handles CSI sequences (colors, cursor movement), OSC sequences
    /// (window titles), and simple escape sequences.
    private static func stripANSI(_ input: String) -> String {
        // CSI: ESC [ ... letter  (colors, cursor movement, etc.)
        // OSC: ESC ] ... BEL or ST  (window title, etc.)
        // Other: ESC followed by one char
        var result = ""
        result.reserveCapacity(input.count)
        var iter = input.makeIterator()
        while let ch = iter.next() {
            if ch == "\u{1B}" {  // ESC
                guard let next = iter.next() else { break }
                if next == "[" {
                    // CSI — skip until we hit a letter (0x40–0x7E)
                    while let c = iter.next() {
                        if c.isLetter || c.asciiValue.map({ $0 >= 0x40 && $0 <= 0x7E }) == true {
                            break
                        }
                    }
                } else if next == "]" {
                    // OSC — skip until BEL (\u{07}) or ST (ESC \\\)
                    while let c = iter.next() {
                        if c == "\u{07}" { break }
                        if c == "\u{1B}" {
                            _ = iter.next()  // consume backslash
                            break
                        }
                    }
                } else {
                    // Other escape — skip the one char we already consumed
                    continue
                }
            } else {
                result.append(ch)
            }
        }
        return result
    }
}
