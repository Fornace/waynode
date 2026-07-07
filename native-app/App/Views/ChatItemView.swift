import SwiftUI
import WaynodeCore

// MARK: - ChatItemView
//
// Renders a single chat item (user, assistant, or system message).
// Each item may contain multiple blocks (text, thinking, tool).

struct ChatItemView: View {
    let item: ChatItem

    var body: some View {
        switch item {
        case .user(let msg):
            UserMessageView(message: msg)
        case .assistant(let msg):
            AssistantMessageView(message: msg)
        case .system(let msg):
            SystemMessageView(message: msg)
        }
    }
}

// MARK: - User Message

struct UserMessageView: View {
    let message: ChatItem.UserItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.isGoal {
                Image(systemName: "target")
                    .font(.caption)
                    .foregroundStyle(.tint)
                    .padding(.top, 6)
            }
            VStack(alignment: .leading, spacing: 6) {
                if message.isGoal {
                    Text("Goal")
                        .font(.caption2.bold())
                        .foregroundStyle(.tint)
                        .textCase(.uppercase)
                }
                Text(message.content)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(Color.accentColor.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                Button {
                    copyToClipboard(message.content)
                    Haptics.success()
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
            Spacer(minLength: 40)
        }
    }
}

// MARK: - Assistant Message

struct AssistantMessageView: View {
    let message: ChatItem.AssistantItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Avatar / role indicator
            Image(systemName: "sparkles")
                .font(.caption)
                .foregroundStyle(.tint)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                    BlockView(block: block)
                }
                if !message.done {
                    // Typing indicator while streaming
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
            Spacer(minLength: 0)
        }
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
            .background(.thinMaterial)
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

    var body: some View {
        switch block {
        case .text(let data):
            TextBlock(text: data.text)
        case .thinking(let data):
            ThinkingBlock(text: data.text)
        case .tool(let data):
            ToolBlockView(data: data)
        }
    }
}

// MARK: - Text Block

struct TextBlock: View {
    let text: String

    var body: some View {
        // If the text contains fenced code blocks, render them with syntax
        // (the RichTextWithCode splitter handles fenced ``` blocks).
        if text.contains("```") {
            RichTextWithCode(text: text)
        } else {
            // Use AttributedString for inline markdown (bold, italic, inline
            // code, links). Falls back to plain text on parse failure.
            if let attributed = try? AttributedString(markdown: text) {
                Text(attributed)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: - Rich Text with Code

struct RichTextWithCode: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let str):
                    if !str.isEmpty {
                        // Render inline markdown (bold, italic, links, inline code)
                        if let attributed = try? AttributedString(markdown: str) {
                            Text(attributed)
                                .font(.body)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text(str)
                                .font(.body)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                case .codeBlock(let lang, let code):
                    CodeBlockView(language: lang, code: code)
                }
            }
        }
    }

    private enum Segment {
        case text(String)
        case codeBlock(String, String)
    }

    private var segments: [Segment] {
        // Split on ``` fences
        var parts: [Segment] = []
        let pattern = "```"
        var remaining = text[...]
        while let range = remaining.range(of: pattern) {
            // Text before fence (may contain inline markdown)
            let before = remaining[..<range.lowerBound]
            if !before.isEmpty {
                parts.append(.text(String(before)))
            }
            remaining = remaining[range.upperBound...]
            // Find closing fence
            if let endRange = remaining.range(of: pattern) {
                let block = remaining[..<endRange.lowerBound]
                parts.append(contentsOf: parseCodeBlock(String(block)))
                remaining = remaining[endRange.upperBound...]
            } else {
                // No closing fence — treat rest as code
                parts.append(contentsOf: parseCodeBlock(String(remaining)))
                break
            }
        }
        if !remaining.isEmpty {
            parts.append(.text(String(remaining)))
        }
        return parts
    }

    /// Parse a raw code-block body (the text between ``` fences) into a
    /// `.codeBlock` segment. Per GitHub-Flavored Markdown, the first line
    /// is treated as a language *info string* ONLY when it is a single
    /// token (letters, digits, +, -, #); otherwise the entire body is code
    /// with no language. This prevents the first line of a language-less
    /// code block from being eaten as a fake "language".
    private func parseCodeBlock(_ raw: String) -> [Segment] {
        // Strip a single leading newline (fences are usually ```\n...)
        var body = raw
        if body.hasPrefix("\n") { body.removeFirst() }
        // Single line with no newline: could be a language hint OR code.
        guard let firstNewline = body.firstIndex(of: "\n") else {
            let line = body.trimmingCharacters(in: .whitespaces)
            if isLanguageHint(line) {
                return [.codeBlock(line, "")]
            }
            return [.codeBlock("", body)]
        }
        let firstLine = String(body[..<firstNewline]).trimmingCharacters(in: .whitespaces)
        if isLanguageHint(firstLine) {
            let code = String(body[body.index(after: firstNewline)...])
            return [.codeBlock(firstLine, code)]
        } else {
            // No language hint — entire body is code.
            return [.codeBlock("", body)]
        }
    }

    /// A language info string is a single token: letters, digits, and the
    /// characters +, -, #. Anything with a space is NOT a language.
    private func isLanguageHint(_ s: String) -> Bool {
        guard !s.isEmpty else { return false }
        return s.allSatisfy { c in c.isLetter || c.isNumber || c == "+" || c == "-" || c == "#" }
    }
}

// MARK: - Code Block

struct CodeBlockView: View {
    let language: String
    let code: String
    @State private var isExpanded: Bool = true
    @State private var showCopied: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyToClipboard(code)
                    Haptics.success()
                    withAnimation { showCopied = true }
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        await MainActor.run { showCopied = false }
                    }
                } label: {
                    Image(systemName: showCopied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                        .foregroundStyle(showCopied ? .green : .secondary)
                }
                .buttonStyle(.plain)
                Button {
                    withAnimation(.smooth) { isExpanded.toggle() }
                } label: {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.thinMaterial)

            if isExpanded {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(12)
                }
                .frame(maxHeight: 400)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.gray.opacity(0.3))
        )
    }
}

// MARK: - Thinking Block

struct ThinkingBlock: View {
    let text: String
    @State private var isExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.smooth) { isExpanded.toggle() }
            } label: {
                HStack {
                    Image(systemName: "brain.head.profile")
                        .font(.caption)
                    Text("Thinking")
                        .font(.caption.bold())
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
                    .transition(.opacity)
            }
        }
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Tool Block

struct ToolBlockView: View {
    let data: Block.ToolBlock
    @State private var isExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.smooth) { isExpanded.toggle() }
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
            ProgressView()
                .controlSize(.mini)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.caption)
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
