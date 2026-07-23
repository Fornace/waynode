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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var terminal = TerminalSessionState()
    @State private var streamID = UUID()
    @State private var wsClient: WSClient?
    @State private var listenTask: Task<Void, Never>?
    @State private var hasAttemptedConnection = false
    @State private var showCopied = false

    private let bottomID = "term-bottom"

    var body: some View {
        VStack(spacing: 0) {
            // Status bar
            HStack(spacing: 6) {
                Image(systemName: statusSystemImage)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(statusColor)
                    .symbolEffect(.rotate, isActive: isConnecting && !reduceMotion)
                    .symbolEffect(.wiggle, value: retryMessage != nil)
                    .contentTransition(.symbolEffect(.replace))
                Text(statusText)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(statusText)
                Spacer()

                if terminal.connection == .connected {
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
                    copyToClipboard(terminal.output)
                    Haptics.success()
                    withAnimation(reduceMotion ? nil : .default) { showCopied = true }
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        await MainActor.run { showCopied = false }
                    }
                } label: {
                    Image(systemName: showCopied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                        .foregroundStyle(showCopied ? .green : .secondary)
                        .symbolEffect(.bounce, value: showCopied)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .disabled(terminal.output.isEmpty)
                .accessibilityLabel("Copy terminal output")
                .accessibilityIdentifier("terminal.copy")
                .frame(minWidth: 44, minHeight: 44)

                Button {
                    terminal.clearScrollback()
                    streamID = UUID()
                } label: {
                    Image(systemName: "trash")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
                .disabled(terminal.output.isEmpty)
                .accessibilityLabel("Clear terminal scrollback")
                .accessibilityIdentifier("terminal.clear")
                .frame(minWidth: 44, minHeight: 44)

                if !isExited {
                    Button {
                        Task { await retryConnection() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.caption2)
                            .symbolEffect(.rotate, value: isConnecting)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Reconnect terminal transport")
                    .accessibilityIdentifier("terminal.reconnect")
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(isConnecting)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("terminal.status")
            .accessibilityLabel("Terminal status: \(statusText)")
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            NativeTerminalSurface(
                output: terminal.output,
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

            if let msg = retryMessage {
                HStack {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .symbolEffect(.wiggle, value: msg)
                    Text(msg)
                        .font(.caption)
                        .lineLimit(2)
                    Spacer()
                    Button("Retry") {
                        Task { await retryConnection() }
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
            } else if case .exited(let code) = terminal.connection {
                HStack {
                    Image(systemName: "checkmark.circle")
                    Text("Terminal exited with code \(code)")
                    Spacer()
                    Button("Restart") {
                        Task { await restartTerminal() }
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
                terminal.beginConnection()
                terminal.apply(.error("Terminal service unavailable"))
                return
            }
            if CommandLine.arguments.contains("-ui-test-terminal-exited") {
                terminal.apply(.exited(0))
                return
            }
            if CommandLine.arguments.contains("-ui-test-terminal-connecting") {
                terminal.beginConnection()
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
        switch terminal.connection {
        case .connected: return .green
        case .connecting, .reconnecting: return .orange
        case .disconnected: return .secondary
        case .failed: return .red
        case .exited: return .secondary
        }
    }

    private var statusSystemImage: String {
        switch terminal.connection {
        case .connected: "checkmark.circle.fill"
        case .connecting, .reconnecting: "arrow.triangle.2.circlepath"
        case .disconnected: "wifi.slash"
        case .failed: "exclamationmark.triangle.fill"
        case .exited: "checkmark.circle"
        }
    }

    private var statusText: String {
        switch terminal.connection {
        case .connected: return "Connected"
        case .connecting: return "Connecting…"
        case .reconnecting: return "Reconnecting…"
        case .disconnected: return "Disconnected"
        case .failed(let msg): return "Error: \(msg)"
        case .exited(let code): return "Exited (\(code))"
        }
    }

    private var isConnecting: Bool {
        terminal.connection == .connecting || terminal.connection == .reconnecting
    }

    private var isExited: Bool {
        if case .exited = terminal.connection { return true }
        return false
    }

    private var retryMessage: String? {
        switch terminal.connection {
        case .failed(let message): return message
        case .disconnected where hasAttemptedConnection: return "Connection closed"
        default: return nil
        }
    }

    // MARK: - Connection

    private func connect(reconnecting: Bool = false, restarting: Bool = false) async {
        hasAttemptedConnection = true
        guard let api = appModel.currentAPI() else {
            terminal.apply(.error("Server configuration is unavailable"))
            return
        }
        if restarting { terminal.beginRestart() }
        else { terminal.beginConnection(reconnecting: reconnecting) }

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
        }
    }

    private func retryConnection() async {
        listenTask?.cancel()
        await wsClient?.disconnect()
        wsClient = nil
        await connect(reconnecting: true)
    }

    private func restartTerminal() async {
        listenTask?.cancel()
        await wsClient?.disconnect()
        wsClient = nil
        await connect(restarting: true)
    }

    // MARK: - Message handling

    private func handleMessage(_ msg: WSClient.TerminalMessage) async {
        if terminal.apply(msg) { streamID = UUID() }
    }

    // MARK: - Input

    private func sendTerminalBytes(_ bytes: [UInt8]) {
        guard terminal.connection == .connected, !bytes.isEmpty else { return }
        Task {
            await wsClient?.sendInput(String(decoding: bytes, as: UTF8.self))
        }
    }

    private func sendResize() async {
        await wsClient?.sendResize(cols: 80, rows: 24)
    }

}
