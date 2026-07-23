import SwiftUI
import WaynodeCore

// MARK: - ChatItemView
//
// Renders a single chat item (user, assistant, or system message).
// Each item may contain multiple blocks (text, thinking, tool).

struct ChatItemView: View {
    let item: ChatItem
    var onStopHammersmith: ((String) -> Void)? = nil
    @Environment(\.onStopHammersmith) private var envOnStopHammersmith

    var body: some View {
        switch item {
        case .user(let msg):
            UserMessageView(message: msg)
        case .assistant(let msg):
            AssistantMessageView(message: msg)
        case .system(let msg):
            SystemMessageView(message: msg)
        case .hammersmithRun(let item):
            HammersmithRunView(run: item.run, onStop: onStopHammersmith ?? envOnStopHammersmith?.call)
        }
    }
}

// MARK: - User Message
//
// iMessage-style: blue bubble, right-aligned, text left-aligned inside.
// The bubble takes its natural width up to a cap so short messages form a
// compact pill and long ones wrap, always hugging the trailing edge.

struct UserMessageView: View {
    let message: ChatItem.UserItem
    @Environment(\.onEditMessage) private var onEdit

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Spacer(minLength: 48)
            VStack(alignment: .leading, spacing: 6) {
                if message.isGoal {
                    HStack(spacing: 4) {
                        Image(systemName: "target")
                            .font(.caption2)
                        Text("Goal")
                            .font(.caption2.bold())
                            .textCase(.uppercase)
                    }
                    .foregroundStyle(.white.opacity(0.9))
                }
                Text(message.content)
                    .foregroundStyle(.white)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.blue)
            .clipShape(UserBubbleShape())
            .frame(maxWidth: 300, alignment: .trailing)
            .fixedSize(horizontal: false, vertical: true)
            .contextMenu {
                Button {
                    copyToClipboard(message.content)
                    Haptics.success()
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                // Edit-and-resend: pre-fills the composer with this message's
                // text so the user can tweak and send as a new message. True
                // conversation forking needs server-side support (#9).
                Button {
                    onEdit?.call(message.content)
                    Haptics.light()
                } label: {
                    Label("Edit and Resend", systemImage: "pencil")
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("You: \(message.content)")
        .accessibilityHint(message.isGoal ? "Goal request" : "Your message")
    }
}

// UserBubbleShape lives in HammersmithRunView.swift (line-cap manoeuvre).

// MARK: - Assistant Message

struct AssistantMessageView: View {
    let message: ChatItem.AssistantItem

    var body: some View {
        let blocks = displayBlocks

        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                BlockView(block: block, isReasoningStreaming: isLiveReasoningBlock(block, at: index, in: blocks))
            }
            if !message.done {
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { _ in
                        Circle()
                            .fill(.secondary)
                            .frame(width: 6, height: 6)
                            .opacity(0.6)
                    }
                }
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Waynode: \(message.blocks.accessibilitySummary)")
        .accessibilityValue(message.done ? "Complete" : "Still responding")
    }

    private var displayBlocks: [Block] {
        message.blocks.reduce(into: []) { result, block in
            guard case .thinking(let next) = block,
                  let last = result.last,
                  case .thinking(let previous) = last else {
                result.append(block)
                return
            }
            result[result.count - 1] = .thinking(.init(text: previous.text + "\n\n" + next.text))
        }
    }

    private func isLiveReasoningBlock(_ block: Block, at index: Int, in blocks: [Block]) -> Bool {
        guard !message.done,
              index == blocks.indices.last,
              case .thinking = block else {
            return false
        }
        return true
    }
}

private extension Array where Element == Block {
    var accessibilitySummary: String {
        map { block in
            switch block {
            case .text(let data): return data.text
            case .thinking(let data): return "Thinking: \(data.text)"
            case .tool(let data): return "Tool result: \(data.name)"
            }
        }.joined(separator: " ")
    }
}

// MARK: - System Message

struct SystemMessageView: View {
    let message: ChatItem.SystemItem

    var body: some View {
        HStack {
            Spacer()
            VStack(alignment: .center, spacing: 2) {
                if let key = message.key {
                    Image(systemName: iconFor(key))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(message.content)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.secondary.opacity(0.08))
            .clipShape(Capsule())
            Spacer()
        }
    }

    private func iconFor(_ key: String) -> String {
        switch key.lowercased() {
        case let s where s.contains("error"): return "exclamationmark.triangle"
        case let s where s.contains("abort"): return "stop"
        case let s where s.contains("rename"): return "pencil"
        case let s where s.contains("archive"): return "archivebox"
        default: return "info.circle"
        }
    }
}

// MARK: - Block View

struct BlockView: View {
    let block: Block
    var isReasoningStreaming: Bool = false

    var body: some View {
        switch block {
        case .text(let data):
            TextBlock(text: data.text)
        case .thinking(let data):
            ThinkingBlock(text: data.text, isStreaming: isReasoningStreaming)
        case .tool(let data):
            ToolBlockView(data: data)
        }
    }
}

// MARK: - Text Block
//
// All assistant text renders through MarkdownView — a dependency-free,
// block-level Markdown engine with lightweight syntax-highlighted code
// blocks. This gives full coverage of headers, lists, tables, blockquotes,
// fenced code, and inline formatting (#6, #2).

struct TextBlock: View {
    let text: String

    var body: some View {
        MarkdownView(text: text)
    }
}

// MARK: - Tool Block

struct ToolBlockView: View {
    let data: Block.ToolBlock
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.light()
                withAnimation(reduceMotion ? nil : .smooth) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(data.name)
                        .font(.caption.bold().monospaced())
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .contentShape(Rectangle())
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !prettyArgs.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Arguments")
                                .font(.caption2.bold())
                                .foregroundStyle(.secondary)
                            Text(prettyArgs)
                                .font(.system(.caption2, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if !data.output.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Output")
                                .font(.caption2.bold())
                                .foregroundStyle(.secondary)
                            ScrollView {
                                Text(data.output)
                                    .font(.system(.caption2, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 300)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
                .transition(.opacity)
            }
        }
        .background(backgroundColor.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(borderColor.opacity(0.3))
        )
        .contextMenu {
            Button {
                copyToClipboard(data.output.isEmpty ? data.args : data.output)
                Haptics.success()
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch data.status {
        case .running:
            ActivitySymbol(
                systemImage: "gearshape.arrow.triangle.2.circlepath",
                reduceMotion: reduceMotion,
                size: 12
            )
            .foregroundStyle(.orange)
            .contentTransition(.symbolEffect(.replace))
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption)
                .symbolEffect(.bounce, value: data.status)
                .contentTransition(.symbolEffect(.replace))
        case .error:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.caption)
                .symbolEffect(.wiggle, value: data.status)
                .contentTransition(.symbolEffect(.replace))
        }
    }

    private var backgroundColor: Color {
        switch data.status {
        case .running: return .orange
        case .done: return .green
        case .error: return .red
        }
    }

    private var borderColor: Color {
        backgroundColor
    }

    /// Pretty-print JSON args if valid; otherwise return raw args.
    private var prettyArgs: String {
        let raw = data.args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty,
              let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let str = String(data: pretty, encoding: .utf8) else {
            return data.args
        }
        return str
    }
}
