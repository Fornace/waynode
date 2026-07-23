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
            HammersmithRunView(run: item.run, onStop: onStopHammersmith ?? envOnStopHammersmith)
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
                    onEdit?(message.content)
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
            case .tool(let data): return "Tool result: \(String(describing: data))"
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

// MARK: - Thinking Block
//
// Collapsible reasoning. Now renders its content through MarkdownView so
// code snippets and structured markdown inside the model's reasoning are
// formatted readably instead of dumped as plain text (#5).

struct ThinkingBlock: View {
    let text: String
    let isStreaming: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded: Bool = false

    private var showsBody: Bool { isStreaming || isExpanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.light()
                withAnimation(reduceMotion ? nil : .smooth) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 9) {
                    ZStack {
                        Circle()
                            .fill(Color.indigo.opacity(0.16))
                        Image(systemName: isStreaming ? "sparkles" : "brain.head.profile")
                            .font(.caption)
                            .foregroundStyle(Color.indigo)
                            .symbolRenderingMode(.hierarchical)
                            .symbolEffect(.breathe, isActive: isStreaming && !reduceMotion)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Reasoning")
                            .font(.caption.bold())
                            .foregroundStyle(.primary)
                        Text(isStreaming ? "Streaming thoughts" : (isExpanded ? "Expanded" : "Collapsed"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: showsBody ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(isStreaming ? "Reasoning is shown while it streams" : "Expands or collapses reasoning")

            if showsBody {
                ScrollView(.vertical) {
                    ReasoningContentView(text: text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
                .frame(maxHeight: isStreaming ? 220 : 360)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.indigo.opacity(0.08))
        )
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(Color.indigo.opacity(isStreaming ? 0.85 : 0.55))
                .frame(width: 3)
                .padding(.vertical, 8)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.indigo.opacity(isStreaming ? 0.28 : 0.16))
        )
    }
}

private struct ReasoningContentView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownParser.parse(text).enumerated()), id: \.offset) { _, block in
                ReasoningMarkdownBlock(block: block)
            }
        }
        .textSelection(.enabled)
    }
}

private struct ReasoningMarkdownBlock: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: icon(for: level))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.indigo)
                    .frame(width: 14)
                Text(MarkdownInline.attributed(text))
                    .font(level <= 2 ? .subheadline.weight(.semibold) : .caption.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            .padding(.top, level <= 2 ? 2 : 0)

        case .paragraph(let text):
            Text(MarkdownInline.attributed(text, baseColor: .secondary))
                .font(.callout)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

        case .codeBlock(let language, let code):
            CodeBlockView(language: language, code: code)

        case .listBlock(let ordered, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? item.marker : "•")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.indigo)
                            .frame(width: ordered ? 24 : 12, alignment: .trailing)
                        Text(MarkdownInline.attributed(item.text, baseColor: .secondary))
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.depth) * 14)
                    .id(idx)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.indigo.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

        case .blockquote(let blocks):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Color.indigo.opacity(0.55))
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        ReasoningMarkdownBlock(block: block)
                    }
                }
            }
            .padding(10)
            .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

        case .table(let header, let alignments, let rows):
            TableView(header: header, alignments: alignments, rows: rows)

        case .thematicBreak:
            Divider()
                .padding(.vertical, 2)
        }
    }

    private func icon(for level: Int) -> String {
        level <= 2 ? "list.bullet.rectangle" : "smallcircle.filled.circle"
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
