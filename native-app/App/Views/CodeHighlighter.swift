import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

#if canImport(UIKit)
private typealias PlatformColor = UIColor
private typealias PlatformFont = UIFont
private let platformLabelColor = UIColor.label
#elseif canImport(AppKit)
private typealias PlatformColor = NSColor
private typealias PlatformFont = NSFont
private let platformLabelColor = NSColor.labelColor
#endif

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
            attributes: [.foregroundColor: platformLabelColor]
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

    private static func applyRegex(_ s: NSMutableAttributedString, pattern: String, color: PlatformColor) {
        guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return }
        let range = NSRange(location: 0, length: s.length)
        re.enumerateMatches(in: s.string, options: [], range: range) { match, _, _ in
            guard let match else { return }
            // Don't overwrite a range that already has a foregroundColor (comment/string priority).
            if hasColor(s, range: match.range) { return }
            colorRange(s, range: match.range, color: color, italic: false)
        }
    }

    private static func applyWordSet(_ s: NSMutableAttributedString, words: Set<String>, color: PlatformColor) {
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
        return any && (s.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? PlatformColor) != platformLabelColor
    }

    private static func colorRange(_ s: NSMutableAttributedString, range: NSRange, color: PlatformColor, italic: Bool) {
        guard range.location != NSNotFound, range.length > 0 else { return }
        // Only set color on substrings that are still the base label color.
        s.enumerateAttribute(.foregroundColor, in: range, options: []) { existing, subRange, _ in
            if existing == nil || (existing as? PlatformColor) == platformLabelColor {
                s.addAttribute(.foregroundColor, value: color, range: subRange)
                if italic {
                    s.addAttribute(.font, value: italicMonoFont(), range: subRange)
                }
            }
        }
    }

    private static func italicMonoFont() -> PlatformFont {
        let base = PlatformFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        return base.withItalicTraits()
    }

    // MARK: Palette

    private struct Palette {
        let comment: PlatformColor
        let string: PlatformColor
        let number: PlatformColor
        let keyword: PlatformColor
        let type: PlatformColor
        let attribute: PlatformColor
    }

    private static var palette: Palette {
        // Tuned for dark UI; falls back gracefully on light mode via dynamic colors.
        Palette(
            comment: PlatformColor(white: 0.50, alpha: 1.0),
            string: PlatformColor(red: 0.49, green: 0.78, blue: 0.56, alpha: 1.0),
            number: PlatformColor(red: 0.82, green: 0.64, blue: 0.37, alpha: 1.0),
            keyword: PlatformColor(red: 0.78, green: 0.47, blue: 0.87, alpha: 1.0),
            type: PlatformColor(red: 0.90, green: 0.75, blue: 0.48, alpha: 1.0),
            attribute: PlatformColor(red: 0.43, green: 0.74, blue: 0.82, alpha: 1.0)
        )
    }
}

#if canImport(UIKit)
private extension UIFont {
    func withItalicTraits() -> UIFont {
        if let descriptor = fontDescriptor.withSymbolicTraits(.traitItalic) {
            return UIFont(descriptor: descriptor, size: 0)
        }
        return self
    }
}
#elseif canImport(AppKit)
private extension NSFont {
    func withItalicTraits() -> NSFont {
        NSFontManager.shared.convert(self, toHaveTrait: .italicFontMask)
    }
}
#endif
