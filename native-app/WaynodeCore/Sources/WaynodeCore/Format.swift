import Foundation

// MARK: - Format
//
// Centralized formatting helpers for dates, numbers, and durations.
// All server timestamps are ISO 8601 strings (e.g. "2026-07-06T14:32:01.234Z").
// These helpers parse them once and present them in a human-friendly way.
//
// Uses Date.ISO8601FormatStyle (value type, Sendable) instead of the
// legacy ISO8601DateFormatter (non-Sendable, triggers Swift 6 warnings).

/// Parser for the ISO 8601 timestamps returned by the Waynode server.
enum ISODate {
    /// Parse an ISO 8601 string to `Date`, returning `nil` on failure.
    /// Handles both fractional-second and whole-second variants.
    static func parse(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        // Try with fractional seconds first (server uses .234Z suffix).
        if let d = try? Date.ISO8601FormatStyle(
            dateSeparator: .dash,
            timeSeparator: .colon,
            includingFractionalSeconds: true
        ).parse(string) {
            return d
        }
        // Fall back to standard ISO 8601 without fractional seconds.
        return try? Date.ISO8601FormatStyle(
            dateSeparator: .dash,
            timeSeparator: .colon
        ).parse(string)
    }
}

/// Presentation helpers for dates and durations.
public enum Format {
    // MARK: - Relative (used in list rows)

    /// "5m ago", "3h ago", "Yesterday", "Jul 6", "Jul 6, 2025"
    public static func relative(fromISO isoString: String?) -> String {
        guard let date = ISODate.parse(isoString) else { return "" }
        return date.formatted(.relative(presentation: .named))
    }

    /// Compact relative: "5m", "3h", "2d", or falls back to "M/d" for older.
    public static func compactRelative(fromISO isoString: String?) -> String {
        guard let date = ISODate.parse(isoString) else { return "" }
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "now" }
        if interval < 3600 { return "\(Int(interval / 60))m" }
        if interval < 86_400 { return "\(Int(interval / 3600))h" }
        if interval < 604_800 { return "\(Int(interval / 86_400))d" }
        // Same year → "Jul 6"; different year → "Jul 6, 2025"
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    // MARK: - Absolute (used in detail views)

    /// "July 6, 2026 at 2:32 PM"
    public static func dateTime(fromISO isoString: String?) -> String {
        guard let date = ISODate.parse(isoString) else { return "" }
        return date.formatted(date: .complete, time: .shortened)
    }

    /// "2:32 PM"
    public static func time(fromISO isoString: String?) -> String {
        guard let date = ISODate.parse(isoString) else { return "" }
        return date.formatted(.dateTime.hour().minute())
    }

    // MARK: - Token counts

    /// "1.2k", "950", "12.3M"
    public static func tokenCount(_ n: Int) -> String {
        if n >= 1_000_000 {
            return String(format: "%.1fM", Double(n) / 1_000_000)
        }
        if n >= 1_000 {
            return String(format: "%.1fk", Double(n) / 1_000)
        }
        return "\(n)"
    }

    // MARK: - Durations

    /// "3m 42s", "1h 5m", "42s"
    public static func duration(ms: Int) -> String {
        let s = ms / 1000
        if s >= 3600 {
            return String(format: "%dh %dm", s / 3600, (s % 3600) / 60)
        }
        if s >= 60 {
            return String(format: "%dm %ds", s / 60, s % 60)
        }
        return "\(s)s"
    }
}
