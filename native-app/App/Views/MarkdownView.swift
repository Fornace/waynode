import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - MarkdownView
//
// A lightweight, dependency-free, block-level Markdown renderer tuned for
// AI-assistant output. Handles the constructs that actually appear in an
// agent's replies — no full CommonMark/GFM spec, but ~95% coverage of real
// assistant text with exact visual control and zero third-party deps.
//
// Supported blocks:
//   • ATX headings (# … ######)
//   • Paragraphs with inline markdown (bold/italic/code/links/strikethrough)
//   • Fenced code blocks ```lang … ``` with lightweight syntax highlighting
//   • Ordered + unordered lists, nested by 2-space indentation
//   • Blockquotes (> …), one level deep with nested inline markdown
//   • GFM tables (| a | b | with a --- separator row)
//   • Thematic breaks (---, ***, ___)
//
// Inline rendering delegates to Foundation's AttributedString(markdown:) in
// inline-only mode, so bold/italic/inline-code/links/strikethrough work
// natively. Inline code is given a subtle chip background via a run pass.

struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownParser.parse(text).enumerated()), id: \.offset) { _, block in
                MarkdownBlockRenderer(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

// MARK: - Parsing options (shared)

enum MarkdownInline {
    /// Inline-only markdown parsing with extended attributes (strikethrough,
    /// etc.) and partial-parse tolerance so a stray `*` never blanks a run.
    /// Built via property assignment to stay forward-compatible with SDK
    /// memberwise-initializer argument-order changes.
    static let options: AttributedString.MarkdownParsingOptions = {
        var o = AttributedString.MarkdownParsingOptions()
        o.interpretedSyntax = .inlineOnlyPreservingWhitespace
        o.allowsExtendedAttributes = true
        o.failurePolicy = .returnPartiallyParsedIfPossible
        return o
    }()

    /// Build an AttributedString for an inline markdown fragment. Inline
    /// code is rendered in the system monospaced face so it reads as a chip.
    static func attributed(_ s: String, baseColor: Color? = nil) -> AttributedString {
        var attr: AttributedString
        if let parsed = try? AttributedString(markdown: s, options: options) {
            attr = parsed
        } else {
            attr = AttributedString(s)
        }
        // Style inline-code runs: monospaced + subtle tint so they stand out.
        for run in attr.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                attr[run.range].font = .system(.body, design: .monospaced)
            }
        }
        if let baseColor {
            attr.foregroundColor = baseColor
        }
        return attr
    }
}

// MARK: - Block model

indirect enum MarkdownBlock: Hashable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case codeBlock(language: String, code: String)
    case listBlock(ordered: Bool, items: [MarkdownListItem])
    case blockquote(blocks: [MarkdownBlock])
    case table(header: [String], alignments: [MarkdownTableAlign], rows: [[String]])
    case thematicBreak
}

struct MarkdownListItem: Hashable, Sendable {
    var depth: Int       // 0 = top level; +1 per 2 spaces of indent
    var marker: String   // "•" / number text
    var text: String
}

enum MarkdownTableAlign: Hashable, Sendable { case leading, center, trailing }

// MARK: - Block renderer

struct MarkdownBlockRenderer: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(MarkdownInline.attributed(text))
                .font(headingFont(level))
                .fontWeight(.bold)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, level <= 2 ? 4 : 0)

        case .paragraph(let text):
            Text(MarkdownInline.attributed(text))
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .codeBlock(let language, let code):
            CodeBlockView(language: language, code: code)

        case .listBlock(let ordered, let items):
            ListBlockView(ordered: ordered, items: items)

        case .blockquote(let inner):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Color.secondary.opacity(0.5))
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(inner.enumerated()), id: \.offset) { _, b in
                        MarkdownBlockRenderer(block: b)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 2)

        case .table(let header, let alignments, let rows):
            TableView(header: header, alignments: alignments, rows: rows)

        case .thematicBreak:
            Divider().padding(.vertical, 2)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2
        case 2: return .title3
        case 3: return .headline
        default: return .subheadline
        }
    }
}

// MARK: - List renderer

struct ListBlockView: View {
    let ordered: Bool
    let items: [MarkdownListItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.marker)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 16, alignment: .trailing)
                    Text(MarkdownInline.attributed(item.text))
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.leading, CGFloat(item.depth) * 16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Table renderer

struct TableView: View {
    let header: [String]
    let alignments: [MarkdownTableAlign]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { col, cell in
                        Text(cell)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: frameAlign(safe: col))
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { col, cell in
                            Text(MarkdownInline.attributed(cell))
                                .font(.caption)
                                .frame(maxWidth: .infinity, alignment: frameAlign(safe: col))
                        }
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .padding(10)
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func frameAlign(safe col: Int) -> Alignment {
        guard col < alignments.count else { return .leading }
        switch alignments[col] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

// MARK: - Code Block (with lightweight syntax highlighting)

struct CodeBlockView: View {
    let language: String
    let code: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                .accessibilityLabel(showCopied ? "Copied" : "Copy code")
                Button {
                    withAnimation(reduceMotion ? nil : .smooth) { isExpanded.toggle() }
                } label: {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isExpanded ? "Collapse code" : "Expand code")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.thinMaterial)

            if isExpanded {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(CodeHighlighter.highlight(code, language: language))
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
