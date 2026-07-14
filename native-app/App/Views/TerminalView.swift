import SwiftUI
import WaynodeCore

// MARK: - TerminalView
//
// A native terminal view using the WSClient to connect to the server's
// terminal WebSocket. SwiftTerm provides the real VT/xterm renderer; this
// view owns only Waynode's transport lifecycle and connection controls.
//
// Features:
//   • VT/xterm parsing, ANSI colours, cursor motion and scrollback
//   • Native keyboard input, selection, hyperlinks and terminal resize
//   • Connection status, reconnect, and copy fallback

struct TerminalView: View {
    let sessionId: String
    let spaceId: String

    @Environment(AppModel.self) private var appModel
    @State private var output: String = ""
    @State private var streamID = UUID()
    @State private var connectionState: TerminalConnection = .disconnected
    @State private var wsClient: WSClient?
    @State private var listenTask: Task<Void, Never>?
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
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(statusText)
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
                    .accessibilityIdentifier("terminal.resize")
                    .frame(minWidth: 44, minHeight: 44)
                }

                Button {
                    copyToClipboard(output)
                    Haptics.success()
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
                .disabled(output.isEmpty)
                .accessibilityLabel("Copy terminal output")
                .accessibilityIdentifier("terminal.copy")
                .frame(minWidth: 44, minHeight: 44)

                Button {
                    Task { await reconnect() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Reconnect terminal")
                .accessibilityIdentifier("terminal.reconnect")
                .frame(minWidth: 44, minHeight: 44)
                .disabled(connectionState == .connecting)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("terminal.status")
            .accessibilityLabel("Terminal status: \(statusText)")
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            NativeTerminalSurface(
                output: output,
                streamID: streamID,
                onInput: sendTerminalBytes,
                onResize: { cols, rows in
                    Task { await wsClient?.sendResize(cols: cols, rows: rows) }
                }
            )
            .background(Color.black)
            .accessibilityIdentifier("terminal.surface")
            .accessibilityLabel("Terminal output")
            .accessibilityHint("Use the keyboard to interact with the running agent")

            // SwiftTerm supplies its own keyboard input. This footer only
            // appears after the server-side PTY has reached a terminal state.
            if !hasExited {
                EmptyView()
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
                    .accessibilityIdentifier("terminal.failure.retry")
                    .accessibilityHint("Starts a new terminal connection")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.thinMaterial)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("terminal.failure")
            } else {
                HStack {
                    Image(systemName: "checkmark.circle")
                    Text("Terminal exited with code \(exitCode)")
                    Spacer()
                    Button("Restart") {
                        Task { await reconnect() }
                    }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("terminal.exited.restart")
                    .accessibilityHint("Starts a new terminal process")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.thinMaterial)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("terminal.exited")
            }
        }
        .task {
            #if DEBUG
            if CommandLine.arguments.contains("-ui-test-terminal-error") {
                connectionState = .failed("Terminal service unavailable")
                hasExited = true
                return
            }
            if CommandLine.arguments.contains("-ui-test-terminal-exited") {
                connectionState = .exited(0)
                hasExited = true
                return
            }
            #endif
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
        guard let api = appModel.currentAPI() else {
            connectionState = .failed("Server configuration is unavailable")
            hasExited = true
            return
        }
        connectionState = .connecting
        output = "\u{1B}[2J\u{1B}[H"
        streamID = UUID()
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

        let connectionID = streamID
        listenTask = Task {
            let stream = client.output()
            for await msg in stream {
                await handleMessage(msg)
            }
            // Stream ended. If the terminal didn't exit cleanly, the
            // socket dropped unexpectedly — surface as a failure so the
            // user knows they need to reconnect.
            if streamID == connectionID && !hasExited {
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
    }

    private func reconnect() async {
        listenTask?.cancel()
        await wsClient?.disconnect()
        wsClient = nil
        await connect()
    }

    // MARK: - Message handling

    private func handleMessage(_ msg: WSClient.TerminalMessage) async {
        switch msg {
        case .output(let data):
            output.append(data)
            // Transport retention guard. SwiftTerm owns visual scrollback;
            // this only limits the replay buffer used when SwiftUI recreates
            // its platform view.
            if output.utf8.count > 2_000_000 {
                output = "\u{1B}[2J\u{1B}[H" + String(output.suffix(1_500_000))
                streamID = UUID()
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

    private func sendTerminalBytes(_ bytes: [UInt8]) {
        guard connectionState == .connected, !bytes.isEmpty else { return }
        Task {
            await wsClient?.sendInput(String(decoding: bytes, as: UTF8.self))
        }
    }

    private func sendResize() async {
        await wsClient?.sendResize(cols: 80, rows: 24)
    }

}
