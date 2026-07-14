import Foundation

// MARK: - Git types (from getSnapshot)

public struct GitSnapshot: Decodable, Hashable, Sendable {
    public var currentBranch: String
    public var detached: Bool
    public var upstream: String?
    public var ahead: Int
    public var behind: Int
    public var hasUncommittedChanges: Bool
    public var files: [GitFile]
    public var commits: [GitCommit]
    public var branches: [GitBranch]
    public var defaultBranch: String

    enum CodingKeys: String, CodingKey {
        case currentBranch, detached, upstream, ahead, behind
        case hasUncommittedChanges, files, commits, branches, defaultBranch
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currentBranch = try c.decodeIfPresent(String.self, forKey: .currentBranch) ?? ""
        detached = try c.decodeIfPresent(Bool.self, forKey: .detached) ?? false
        upstream = try c.decodeIfPresent(String.self, forKey: .upstream)
        ahead = try c.decodeIfPresent(Int.self, forKey: .ahead) ?? 0
        behind = try c.decodeIfPresent(Int.self, forKey: .behind) ?? 0
        hasUncommittedChanges = try c.decodeIfPresent(Bool.self, forKey: .hasUncommittedChanges) ?? false
        files = try c.decodeIfPresent([GitFile].self, forKey: .files) ?? []
        commits = try c.decodeIfPresent([GitCommit].self, forKey: .commits) ?? []
        branches = try c.decodeIfPresent([GitBranch].self, forKey: .branches) ?? []
        defaultBranch = try c.decodeIfPresent(String.self, forKey: .defaultBranch) ?? "main"
    }
}

public struct GitFile: Decodable, Hashable, Identifiable, Sendable {
    public var id: String { path }
    public var path: String
    public var status: String // M, A, D, untracked, modified, ...
    public var staged: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        // Server sends `staged` as a String (e.g. "M", " ", "untracked",
        // "conflict") — the X field of `git status --porcelain`. Convert to
        // Bool: non-empty and non-space means staged.
        if let s = try? c.decodeIfPresent(String.self, forKey: .staged) {
            staged = !s.isEmpty && s != " "
        } else {
            staged = (try? c.decodeIfPresent(Bool.self, forKey: .staged)) ?? false
        }
    }

    enum CodingKeys: String, CodingKey { case path, status, staged }
}

public struct GitCommit: Decodable, Hashable, Identifiable, Sendable {
    public var id: String { hash }
    public var hash: String
    public var message: String
    public var author: String
    public var date: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = try c.decodeIfPresent(String.self, forKey: .hash) ?? ""
        // Server sends `subject` (the git log %s field), not `message`.
        message = try c.decodeIfPresent(String.self, forKey: .message)
            ?? c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        author = try c.decodeIfPresent(String.self, forKey: .author) ?? ""
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? ""
    }

    enum CodingKeys: String, CodingKey { case hash, message, subject, author, date }
}

public struct GitBranch: Decodable, Hashable, Identifiable, Sendable {
    public var id: String { name }
    public var name: String
    public var current: Bool
    public var isDefault: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        // Server doesn't send `current`; it's derived by the caller by
        // comparing branch.name to snapshot.currentBranch. Default false.
        current = (try? c.decodeIfPresent(Bool.self, forKey: .current)) ?? false
        isDefault = (try? c.decodeIfPresent(Bool.self, forKey: .isDefault)) ?? false
    }

    enum CodingKeys: String, CodingKey { case name, current, isDefault }
}

public struct GitDiffResponse: Decodable, Sendable {
    public var diff: String
    public var error: String?
}
