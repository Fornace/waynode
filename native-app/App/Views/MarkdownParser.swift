import Foundation

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
