import Foundation

// MARK: - DeepLink
//
// Represents a navigation destination that can be triggered via URL
// (waynode://space/<id> or waynode://space/<id>/session/<id>) or
// programmatically. Used for deep linking and E2E test navigation.

public enum DeepLink: Hashable {
    case sessionsList(spaceId: String)
    case sessionDetail(spaceId: String, sessionId: String)
}

// MARK: - Core Domain Models
// Exact mirror of frontend/src/types.ts — every field, every optionality,
// every union case. Decoding is lenient: unknown keys are ignored and
// missing keys fall back to defaults, so a server version drift never
// crashes the client.

// MARK: User

public struct User: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var githubId: Int?
    public var gitlabId: Int?
    public var name: String
    public var email: String?
    public var avatarUrl: String?
    public var role: String?

    enum CodingKeys: String, CodingKey {
        case id, name, email, role
        case githubId = "github_id"
        case gitlabId = "gitlab_id"
        case avatarUrl = "avatar_url"
    }

    public init(id: String, githubId: Int? = nil, gitlabId: Int? = nil, name: String, email: String? = nil, avatarUrl: String? = nil, role: String? = nil) {
        self.id = id; self.githubId = githubId; self.gitlabId = gitlabId
        self.name = name; self.email = email; self.avatarUrl = avatarUrl; self.role = role
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        githubId = try c.decodeIfPresent(Int.self, forKey: .githubId)
        gitlabId = try c.decodeIfPresent(Int.self, forKey: .gitlabId)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Unknown"
        email = try c.decodeIfPresent(String.self, forKey: .email)
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        role = try c.decodeIfPresent(String.self, forKey: .role)
    }
}

public struct AuthMeResponse: Codable, Sendable {
    public var user: User?
    public var providers: Providers?
    public var capabilities: Capabilities?
    public struct Providers: Codable, Sendable {
        public var github: Bool?
        public var gitlab: Bool?
        public var dev: Bool?
    }
    public struct Capabilities: Codable, Sendable {
        public var terminal: Bool?
        public init(terminal: Bool? = nil) { self.terminal = terminal }
    }
    public init(user: User? = nil, providers: Providers? = nil, capabilities: Capabilities? = nil) {
        self.user = user; self.providers = providers; self.capabilities = capabilities
    }
}

public enum TerminalCapabilityState: Sendable, Equatable {
    case checking
    case supported
    case unsupported
    case unavailable

    public init(serverValue: Bool?) {
        if serverValue == true { self = .supported }
        else if serverValue == false { self = .unsupported }
        else { self = .unavailable }
    }
}

public enum BillingCapabilityState: Sendable, Equatable {
    case checking
    case hosted
    case selfHosted
    case unavailable

    public init(deployment: String?) {
        if deployment == "hosted" { self = .hosted }
        else if deployment == "self-hosted" { self = .selfHosted }
        else { self = .unavailable }
    }
}

// MARK: Org

public struct Org: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var slug: String
    public var createdAt: String
    public var myRole: String?
    public var spaceCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, slug
        case createdAt = "created_at"
        case myRole = "my_role"
        case spaceCount = "space_count"
    }
    public init(id: String, name: String, slug: String, createdAt: String, myRole: String? = nil, spaceCount: Int? = nil) {
        self.id = id; self.name = name; self.slug = slug; self.createdAt = createdAt; self.myRole = myRole; self.spaceCount = spaceCount
    }
}

// MARK: Space

public struct Space: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var ownerId: String
    public var repoUrl: String
    public var repoName: String
    public var repoFullName: String?
    public var branch: String
    public var localPath: String
    public var createdAt: String
    public var orgId: String?
    public var sessionCount: Int?
    public var myRole: String?
    public var latestSessionTitle: String?
    public var latestSessionAt: String?

    enum CodingKeys: String, CodingKey {
        case id, branch
        case ownerId = "owner_id"
        case repoUrl = "repo_url"
        case repoName = "repo_name"
        case repoFullName = "repo_full_name"
        case localPath = "local_path"
        case createdAt = "created_at"
        case orgId = "org_id"
        case sessionCount = "session_count"
        case myRole = "my_role"
        case latestSessionTitle = "latest_session_title"
        case latestSessionAt = "latest_session_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId) ?? ""
        repoUrl = try c.decodeIfPresent(String.self, forKey: .repoUrl) ?? ""
        repoName = try c.decodeIfPresent(String.self, forKey: .repoName) ?? ""
        repoFullName = try c.decodeIfPresent(String.self, forKey: .repoFullName)
        branch = try c.decodeIfPresent(String.self, forKey: .branch) ?? "main"
        localPath = try c.decodeIfPresent(String.self, forKey: .localPath) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        orgId = try c.decodeIfPresent(String.self, forKey: .orgId)
        sessionCount = try c.decodeIfPresent(Int.self, forKey: .sessionCount)
        myRole = try c.decodeIfPresent(String.self, forKey: .myRole)
        latestSessionTitle = try c.decodeIfPresent(String.self, forKey: .latestSessionTitle)
        latestSessionAt = try c.decodeIfPresent(String.self, forKey: .latestSessionAt)
    }

    public init(id: String, ownerId: String, repoUrl: String, repoName: String, repoFullName: String? = nil, branch: String, localPath: String, createdAt: String, orgId: String? = nil, sessionCount: Int? = nil, myRole: String? = nil, latestSessionTitle: String? = nil, latestSessionAt: String? = nil) {
        self.id = id; self.ownerId = ownerId; self.repoUrl = repoUrl; self.repoName = repoName
        self.repoFullName = repoFullName; self.branch = branch; self.localPath = localPath
        self.createdAt = createdAt; self.orgId = orgId; self.sessionCount = sessionCount; self.myRole = myRole
        self.latestSessionTitle = latestSessionTitle; self.latestSessionAt = latestSessionAt
    }
}

// MARK: Session

public struct Session: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var spaceId: String
    public var ownerId: String
    public var title: String
    public var piSessionDir: String
    public var model: String?
    public var provider: String?
    public var archived: Bool
    public var createdAt: String
    public var updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, model, provider, archived
        case spaceId = "space_id"
        case ownerId = "owner_id"
        case piSessionDir = "pi_session_dir"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId) ?? ""
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "New Session"
        piSessionDir = try c.decodeIfPresent(String.self, forKey: .piSessionDir) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        // Server sends archived as 0/1 (SQLite int) for list responses but
        // true/false (JSON bool) in others. Accept both.
        if let i = try? c.decodeIfPresent(Int.self, forKey: .archived) {
            archived = i != 0
        } else if let b = try? c.decodeIfPresent(Bool.self, forKey: .archived) {
            archived = b
        } else {
            archived = false
        }
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    }

    public init(id: String, spaceId: String, ownerId: String, title: String, piSessionDir: String, model: String? = nil, provider: String? = nil, archived: Bool = false, createdAt: String, updatedAt: String) {
        self.id = id; self.spaceId = spaceId; self.ownerId = ownerId; self.title = title
        self.piSessionDir = piSessionDir; self.model = model; self.provider = provider
        self.archived = archived; self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

// MARK: Goal Status

public struct GoalStatus: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Sendable {
        case active, paused, complete, budgetLimited
    }
    public var status: Status?
    public var objective: String?
    public var tokenBudget: Int?
    public var tokenUsage: Int?
    public var elapsedMs: Int?

    enum CodingKeys: String, CodingKey {
        case status, objective
        case tokenBudget = "tokenBudget"
        case tokenUsage = "tokenUsage"
        case elapsedMs = "elapsedMs"
    }

    public init(status: Status? = nil, objective: String? = nil, tokenBudget: Int? = nil, tokenUsage: Int? = nil, elapsedMs: Int? = nil) {
        self.status = status; self.objective = objective; self.tokenBudget = tokenBudget
        self.tokenUsage = tokenUsage; self.elapsedMs = elapsedMs
    }
}

// MARK: Models

public struct ModelOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var desc: String?
    public init(id: String, name: String, desc: String? = nil) { self.id = id; self.name = name; self.desc = desc }
}

public struct ModelsResponse: Codable, Sendable {
    public var models: [ModelOption]
    public var configured: Bool
}

// MARK: Repo picker (GitHub/GitLab browse)

public struct RepoItem: Codable, Hashable, Identifiable, Sendable {
    public var id: Int
    public var name: String
    public var fullName: String
    public var url: String
    public var sshUrl: String
    public var isPrivate: Bool
    public var fork: Bool
    public var defaultBranch: String
    public var description: String?
    public var stars: Int
    public var updatedAt: String
    public var language: String?
    public var htmlUrl: String

    enum CodingKeys: String, CodingKey {
        case id, name, fork, stars, language
        case isPrivate = "private"
        case fullName = "full_name"
        case url
        case sshUrl = "ssh_url"
        case defaultBranch = "default_branch"
        case description
        case updatedAt = "updated_at"
        case htmlUrl = "html_url"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        fullName = try c.decode(String.self, forKey: .fullName)
        url = try c.decode(String.self, forKey: .url)
        sshUrl = try c.decodeIfPresent(String.self, forKey: .sshUrl) ?? ""
        isPrivate = try c.decodeIfPresent(Bool.self, forKey: .isPrivate) ?? false
        fork = try c.decodeIfPresent(Bool.self, forKey: .fork) ?? false
        defaultBranch = try c.decodeIfPresent(String.self, forKey: .defaultBranch) ?? "main"
        description = try c.decodeIfPresent(String.self, forKey: .description)
        stars = try c.decodeIfPresent(Int.self, forKey: .stars) ?? 0
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        language = try c.decodeIfPresent(String.self, forKey: .language)
        htmlUrl = try c.decodeIfPresent(String.self, forKey: .htmlUrl) ?? url
    }

    public init(id: Int, name: String, fullName: String, url: String, sshUrl: String = "", isPrivate: Bool = false, fork: Bool = false, defaultBranch: String = "main", description: String? = nil, stars: Int = 0, updatedAt: String = "", language: String? = nil, htmlUrl: String = "") {
        self.id = id; self.name = name; self.fullName = fullName; self.url = url
        self.sshUrl = sshUrl; self.isPrivate = isPrivate; self.fork = fork
        self.defaultBranch = defaultBranch; self.description = description
        self.stars = stars; self.updatedAt = updatedAt; self.language = language; self.htmlUrl = htmlUrl
    }
}

public struct RepoGroup: Codable, Sendable {
    public var owner: String
    public var avatar: String?
    public var url: String
    public var repos: [RepoItem]
}
