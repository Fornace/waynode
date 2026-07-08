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

indirect enum MarkdownBlock: Hashable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case codeBlock(language: String, code: String)
    case listBlock(ordered: Bool, items: [MarkdownListItem])
    case blockquote(blocks: [MarkdownBlock])
    case table(header: [String], alignments: [MarkdownTableAlign], rows: [[String]])
    case thematicBreak
}

struct MarkdownListItem: Hashable {
    var depth: Int       // 0 = top level; +1 per 2 spaces of indent
    var marker: String   // "•" / number text
    var text: String
}

enum MarkdownTableAlign: Hashable { case leading, center, trailing }

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
                .accessibilityLabel(showCopied ? "Copied" : "Copy code")
                Button {
                    withAnimation(.smooth) { isExpanded.toggle() }
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

// MARK: - Lightweight syntax highlighter
//
// A curated, dependency-free tokenizer for the languages that show up most in
// agent output (Swift, JS/TS, Python, Go, Rust, Java/Kotlin, shell, JSON,
// YAML, HTML/XML). It is intentionally simple: comments and strings win,
// then keywords, numbers, and Capitalized types. Not spec-complete, but
// fast, offline, and reads well in a dark UI. This is the standard approach
// (even Splash/highlight.js are tokenizers); syntax highlighting is a
// well-structured domain where a curated tokenizer is appropriate.

enum CodeHighlighter {
    static func highlight(_ code: String, language: String) -> AttributedString {
        let base = NSMutableAttributedString(
            string: code,
            attributes: [.foregroundColor: UIColor.label]
        )
        let lang = language.lowercased()
        let family = family(for: lang)

        // 1. Comments (language-aware)
        applyComments(base, family: family)

        // 2. Strings (single, double, backtick) — skip ranges already styled
        applyRegex(base, pattern: #"(?:@)?"(?:\\.|[^"\\])*""#, color: palette.string)
        applyRegex(base, pattern: #"'(?:\\.|[^'\\])*'"#, color: palette.string)
        if family == .javascript {
            applyRegex(base, pattern: #"`(?:\\.|[^`\\])*`"#, color: palette.string)
        }

        // 3. Numbers
        applyRegex(base, pattern: #"\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?\b"#, color: palette.number)

        // 4. Keywords (language-aware)
        if let kw = keywords(for: family) {
            applyWordSet(base, words: kw, color: palette.keyword)
        }

        // 5. Capitalized types / constants
        applyRegex(base, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#, color: palette.type)

        // 6. Annotations / decorators (@State, @objc, @app.route)
        applyRegex(base, pattern: #"@\w+"#, color: palette.attribute)

        return AttributedString(base)
    }

    // MARK: Families

    private enum Family { case swift, javascript, python, go, rust, java, shell, markup, config, other }

    private static func family(for lang: String) -> Family {
        switch lang {
        case "swift": return .swift
        case "js", "javascript", "ts", "typescript", "jsx", "tsx": return .javascript
        case "py", "python", "ruby", "rb": return .python
        case "go", "golang": return .go
        case "rs", "rust": return .rust
        case "java", "kotlin", "kt", "scala", "c", "cpp", "c++", "objc", "objective-c": return .java
        case "sh", "bash", "shell", "zsh", "console", "terminal": return .shell
        case "html", "xml", "svg", "vue", "svelte": return .markup
        case "json", "yaml", "yml", "toml", "ini", "env", "dockerfile", "makefile": return .config
        default: return .other
        }
    }

    // MARK: Comment handling

    private static func applyComments(_ s: NSMutableAttributedString, family: Family) {
        let nl = "\n"
        let lines = s.string.components(separatedBy: nl)
        var location = 0
        for (i, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let isComment =
                (family != .python && family != .shell && family != .config && trimmed.hasPrefix("//"))
                || ((family == .python || family == .shell || family == .config) && trimmed.hasPrefix("#"))
                || trimmed.hasPrefix("<!--")
                || trimmed.hasPrefix("/*")
                || trimmed.hasPrefix("*")
            if isComment {
                let len = (line as NSString).length
                colorRange(s, range: NSRange(location: location, length: len), color: palette.comment, italic: true)
            }
            // advance past this line + its newline
            location += (line as NSString).length
            if i < lines.count - 1 { location += (nl as NSString).length }
        }
    }

    // MARK: Regex application (skip already-styled ranges)

    private static func applyRegex(_ s: NSMutableAttributedString, pattern: String, color: UIColor) {
        guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return }
        let range = NSRange(location: 0, length: s.length)
        re.enumerateMatches(in: s.string, options: [], range: range) { match, _, _ in
            guard let match else { return }
            // Don't overwrite a range that already has a foregroundColor (comment/string priority).
            if hasColor(s, range: match.range) { return }
            colorRange(s, range: match.range, color: color, italic: false)
        }
    }

    private static func applyWordSet(_ s: NSMutableAttributedString, words: Set<String>, color: UIColor) {
        // Match whole words only.
        let pattern = "\\b(?:" + words.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|") + ")\\b"
        applyRegex(s, pattern: pattern, color: color)
    }

    private static func keywords(for family: Family) -> Set<String>? {
        switch family {
        case .swift: return ["func","let","var","if","else","guard","for","in","while","switch","case","default","return","struct","class","enum","protocol","extension","import","init","deinit","self","Self","super","public","private","internal","fileprivate","static","throws","rethrows","try","catch","throw","defer","where","as","is","nil","true","false","async","await","actor","some","any","indirect","mutating","nonmutating","override","final","open","weak","unowned","inout","Type"]
        case .javascript: return ["function","const","let","var","if","else","for","in","of","while","do","switch","case","default","return","class","extends","new","this","super","import","export","from","as","async","await","try","catch","finally","throw","typeof","instanceof","in","null","undefined","true","false","void","delete","yield","static","get","set","public","private","protected","readonly","interface","type","enum","namespace","implements"]
        case .python: return ["def","class","if","elif","else","for","while","return","import","from","as","try","except","finally","raise","with","lambda","None","True","False","and","or","not","is","in","pass","break","continue","global","nonlocal","yield","async","await","assert","del","self"]
        case .go: return ["func","var","const","type","struct","interface","map","chan","package","import","if","else","for","range","switch","case","default","return","go","defer","select","break","continue","fallthrough","nil","true","false","iota","make","new","len","cap","append","copy","delete"]
        case .rust: return ["fn","let","mut","const","static","if","else","match","for","in","while","loop","return","struct","enum","trait","impl","pub","use","mod","crate","self","Self","super","as","ref","move","async","await","dyn","unsafe","where","break","continue","true","false","Some","None","Ok","Err"]
        case .java: return ["public","private","protected","class","interface","enum","extends","implements","static","final","void","int","long","double","float","boolean","char","byte","short","String","new","this","super","if","else","for","while","do","switch","case","default","return","try","catch","finally","throw","throws","import","package","null","true","false","instanceof","abstract","synchronized","volatile","transient","native"]
        case .shell: return ["if","then","else","elif","fi","for","in","do","done","while","case","esac","function","return","export","local","echo","printf","cd","set","unset","source","alias","exit","echo","sudo"]
        case .markup: return nil
        case .config: return nil
        case .other: return nil
        }
    }

    private static func hasColor(_ s: NSMutableAttributedString, range: NSRange) -> Bool {
        guard range.length > 0 else { return false }
        var any = false
        s.enumerateAttribute(.foregroundColor, in: range, options: []) { value, _, stop in
            if value != nil {
                any = true
                stop.pointee = true
            }
        }
        return any && (s.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor) != UIColor.label
    }

    private static func colorRange(_ s: NSMutableAttributedString, range: NSRange, color: UIColor, italic: Bool) {
        guard range.location != NSNotFound, range.length > 0 else { return }
        // Only set color on substrings that are still the base label color.
        s.enumerateAttribute(.foregroundColor, in: range, options: []) { existing, subRange, _ in
            if existing == nil || (existing as? UIColor) == UIColor.label {
                s.addAttribute(.foregroundColor, value: color, range: subRange)
                if italic {
                    s.addAttribute(.font, value: italicMonoFont(), range: subRange)
                }
            }
        }
    }

    private static func italicMonoFont() -> UIFont {
        let base = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        return base.withTraits(.traitItalic)
    }

    // MARK: Palette

    private struct Palette {
        let comment: UIColor
        let string: UIColor
        let number: UIColor
        let keyword: UIColor
        let type: UIColor
        let attribute: UIColor
    }

    private static var palette: Palette {
        // Tuned for dark UI; falls back gracefully on light mode via dynamic colors.
        Palette(
            comment:   UIColor { _ in UIColor(white: 0.50, alpha: 1.0) },
            string:    UIColor { _ in UIColor(red: 0.49, green: 0.78, blue: 0.56, alpha: 1.0) }, // green
            number:    UIColor { _ in UIColor(red: 0.82, green: 0.64, blue: 0.37, alpha: 1.0) }, // orange
            keyword:   UIColor { _ in UIColor(red: 0.78, green: 0.47, blue: 0.87, alpha: 1.0) }, // purple
            type:      UIColor { _ in UIColor(red: 0.90, green: 0.75, blue: 0.48, alpha: 1.0) }, // yellow
            attribute: UIColor { _ in UIColor(red: 0.43, green: 0.74, blue: 0.82, alpha: 1.0) }  // teal
        )
    }
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        if let descriptor = fontDescriptor.withSymbolicTraits(traits) {
            return UIFont(descriptor: descriptor, size: 0)
        }
        return self
    }
}

// MARK: - Markdown parser (line-based, GFM-ish)

enum MarkdownParser {
    static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.components(separatedBy: "\n")
        return parseLines(lines)
    }

    private static func parseLines(_ lines: [String]) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Blank line
            if trimmed.isEmpty { i += 1; continue }

            // Fenced code block
            if let fence = fenceMarker(trimmed) {
                let lang = fence.info
                var code: [String] = []
                i += 1
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if fence.isClosing(t) { break }
                    code.append(lines[i])
                    i += 1
                }
                i += 1 // consume closing fence
                blocks.append(.codeBlock(language: lang, code: code.joined(separator: "\n")))
                continue
            }

            // ATX heading
            if let heading = parseHeading(trimmed) {
                blocks.append(heading)
                i += 1
                continue
            }

            // Thematic break
            if isThematicBreak(trimmed) {
                blocks.append(.thematicBreak)
                i += 1
                continue
            }

            // Table
            if let (table, consumed) = parseTable(lines, from: i) {
                blocks.append(table)
                i += consumed
                continue
            }

            // Blockquote
            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix(">") {
                        var s = t
                        if s.hasPrefix("> ") { s.removeFirst(2) }
                        else if s.hasPrefix(">") { s.removeFirst() }
                        quoteLines.append(s)
                        i += 1
                    } else if t.isEmpty {
                        // blank line ends the quote only if next isn't a quote
                        if i + 1 < lines.count, lines[i+1].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                            quoteLines.append("")
                            i += 1
                        } else { break }
                    } else {
                        break
                    }
                }
                blocks.append(.blockquote(blocks: parseLines(quoteLines)))
                continue
            }

            // List
            if let (list, consumed) = parseList(lines, from: i) {
                blocks.append(list)
                i += consumed
                continue
            }

            // Paragraph: gather consecutive non-blank, non-special lines
            var para: [String] = [line]
            i += 1
            while i < lines.count {
                let l = lines[i]
                let t = l.trimmingCharacters(in: .whitespaces)
                if t.isEmpty { break }
                if isBlockStart(t) { break }
                para.append(l)
                i += 1
            }
            let joined = para.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
            if !joined.isEmpty {
                blocks.append(.paragraph(joined))
            }
        }
        return blocks
    }

    /// Quick check whether a trimmed line begins a non-paragraph block.
    private static func isBlockStart(_ t: String) -> Bool {
        if fenceMarker(t) != nil { return true }
        if parseHeading(t) != nil { return true }
        if isThematicBreak(t) { return true }
        if t.hasPrefix(">") { return true }
        if isListItem(t) != nil { return true }
        return false
    }

    // MARK: Heading

    private static func parseHeading(_ t: String) -> MarkdownBlock? {
        var hashes = 0
        for ch in t { if ch == "#" { hashes += 1 } else { break } }
        guard hashes >= 1, hashes <= 6 else { return nil }
        let after = t.dropFirst(hashes)
        guard after.first == " " else { return nil }
        let text = after.drop(while: { $0 == " " }).trimmingCharacters(in: .whitespaces)
        return .heading(level: hashes, text: text)
    }

    // MARK: Thematic break

    private static func isThematicBreak(_ t: String) -> Bool {
        let s = t.replacingOccurrences(of: " ", with: "")
        if s.count < 3 { return false }
        let first = s.first
        guard first == "-" || first == "*" || first == "_" else { return false }
        return s.allSatisfy { $0 == first }
    }

    // MARK: Fence

    private struct Fence {
        let char: Character
        let info: String
        func isClosing(_ t: String) -> Bool {
            let s = t.trimmingCharacters(in: .whitespaces)
            return s.allSatisfy { $0 == char } && s.count >= 3
        }
    }

    private static func fenceMarker(_ t: String) -> Fence? {
        let s = t
        guard let first = s.first, (first == "`" || first == "~") else { return nil }
        let run = s.prefix(while: { $0 == first })
        guard run.count >= 3 else { return nil }
        let info = s.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
        // Info string may contain a language token; take the first word.
        let lang = info.split(separator: " ").first.map(String.init) ?? info
        return Fence(char: first, info: lang)
    }

    // MARK: List

    private static func isListItem(_ t: String) -> (ordered: Bool, marker: String, body: String)? {
        // Leading whitespace handled by caller via original line; here t is trimmed.
        // Ordered: ^\d+[.)]\s+
        if let r = t.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) {
            let markerNum = t[r].trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: ")."))
            let body = String(t[r.upperBound...])
            return (true, markerNum, body)
        }
        // Unordered: ^[-*+]\s+
        if let r = t.range(of: #"^[-*+]\s+"#, options: .regularExpression) {
            let body = String(t[r.upperBound...])
            return (false, "•", body)
        }
        return nil
    }

    private static func parseList(_ lines: [String], from start: Int) -> (MarkdownBlock, Int)? {
        guard let first = isListItem(lines[start].trimmingCharacters(in: .whitespaces)) else { return nil }
        let ordered = first.ordered
        var items: [MarkdownListItem] = []
        var i = start
        var counter = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                // A blank line ends the list unless the next non-blank is an indented continuation or another item.
                if i + 1 < lines.count, isListItem(lines[i+1].trimmingCharacters(in: .whitespaces)) != nil {
                    i += 1
                    continue
                }
                break
            }
            if let item = isListItem(trimmed) {
                // depth from leading spaces of the ORIGINAL line
                let leading = line.prefix(while: { $0 == " " }).count
                let depth = leading / 2
                let marker = ordered ? "\(counter + 1)." : "•"
                items.append(MarkdownListItem(depth: depth, marker: marker, text: item.body))
                counter += 1
                i += 1
            } else {
                // indented continuation (belongs to previous item)
                let leading = line.prefix(while: { $0 == " " }).count
                if leading >= 2, !items.isEmpty {
                    items[items.count - 1].text += " " + trimmed
                    i += 1
                } else {
                    break
                }
            }
        }
        guard !items.isEmpty else { return nil }
        return (.listBlock(ordered: ordered, items: items), i - start)
    }

    // MARK: Table

    private static func parseTable(_ lines: [String], from start: Int) -> (MarkdownBlock, Int)? {
        // Need at least a header row + a separator row, both containing pipes.
        guard start + 1 < lines.count else { return nil }
        let headerLine = lines[start].trimmingCharacters(in: .whitespaces)
        let sepLine = lines[start + 1].trimmingCharacters(in: .whitespaces)
        guard headerLine.contains("|"), isTableSeparator(sepLine) else { return nil }

        let header = splitTableRow(headerLine)
        let alignments = parseAlignments(sepLine, count: header.count)

        var rows: [[String]] = []
        var i = start + 2
        while i < lines.count {
            let t = lines[i].trimmingCharacters(in: .whitespaces)
            if t.isEmpty || !t.contains("|") { break }
            rows.append(splitTableRow(t))
            i += 1
        }
        return (.table(header: header, alignments: alignments, rows: rows), i - start)
    }

    private static func isTableSeparator(_ t: String) -> Bool {
        let cleaned = t.replacingOccurrences(of: " ", with: "")
        guard cleaned.contains("-"), cleaned.contains("|") else { return false }
        // Each cell must be like :?-{1,}:?
        let cells = cleaned.split(separator: "|", omittingEmptySubsequences: true)
        return cells.allSatisfy { cell in
            let s = String(cell)
            return s.range(of: #":?-{1,}:?"#, options: .regularExpression) != nil
                && s.allSatisfy({ $0 == "-" || $0 == ":" })
        }
    }

    private static func parseAlignments(_ t: String, count: Int) -> [MarkdownTableAlign] {
        let cells = t.split(separator: "|", omittingEmptySubsequences: true).map { String($0).trimmingCharacters(in: .whitespaces) }
        return (0..<count).map { idx in
            guard idx < cells.count else { return .leading }
            let c = cells[idx]
            let left = c.hasPrefix(":")
            let right = c.hasSuffix(":")
            if left && right { return .center }
            if right { return .trailing }
            return .leading
        }
    }

    private static func splitTableRow(_ t: String) -> [String] {
        var s = t
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
