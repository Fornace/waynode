import Foundation

// MARK: - Submission vocabulary
//
// One canonical word describes what the user asked for: `mode`. The server
// speaks it on every submission surface — the POST bodies for
// /api/sessions/:id/{message,queue,hammersmith}, the submission payload those
// endpoints return, and the SSE `submission` / `hammersmith_run` events. The
// client speaks exactly the same word, end to end: wire body → Submission →
// SubmissionDraft → ChatItem.UserItem → the composer.

/// What a submission *is*. Mirrors the server's `SUBMISSION_MODES` and the web
/// client's `ComposerMode`.
public enum SubmissionMode: String, Codable, Sendable, Hashable, CaseIterable {
    /// A plain chat turn.
    case message
    /// A goal turn: the agent keeps working autonomously until it reports done.
    case goal
    /// Delegation to a verified Hammersmith swarm (its own endpoint).
    case hammersmith
}

extension SubmissionMode {
    /// Lenient decoding, matching the rest of the SSE surface (see SSEEvent and
    /// HammersmithRunLifecycle): an unrecognised mode reads as `.message`
    /// instead of failing the whole event, so a server-side addition can never
    /// blank out a live transcript.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SubmissionMode(rawValue: raw) ?? .message
    }
}

public enum SubmissionStatus: String, Codable, Sendable, Hashable {
    case sending, queued, starting, running, completed, failed, cancelled
}

/// A submission as the server reports it (POST acknowledgement, SSE
/// `submission` event, and the `/state` snapshot).
public struct Submission: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var prompt: String
    public var mode: SubmissionMode
    public var status: SubmissionStatus
    public var error: String?

    public init(id: String, prompt: String, mode: SubmissionMode, status: SubmissionStatus, error: String? = nil) {
        self.id = id
        self.prompt = prompt
        self.mode = mode
        self.status = status
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        prompt = try container.decode(String.self, forKey: .prompt)
        mode = try container.decodeIfPresent(SubmissionMode.self, forKey: .mode) ?? .message
        status = try container.decode(SubmissionStatus.self, forKey: .status)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}

/// A submission the client still owns: not yet acknowledged, or failed and
/// waiting for a retry.
public struct SubmissionDraft: Sendable, Hashable {
    /// Which endpoint carries the draft. This is the transport axis — `mode`
    /// says what the submission is, `kind` says where it goes — and it is
    /// *derived*, so the two can never disagree. Hammersmith owns its endpoint;
    /// nothing but `.hammersmith` can reach it, and a hammersmith draft can
    /// never be re-routed to the chat endpoints by a stale queue flag.
    public enum Kind: String, Sendable, Hashable { case message, queue, hammersmith }

    public var id: String
    public var prompt: String
    public var mode: SubmissionMode
    /// Set when a run is already active or work is already queued: chat
    /// submissions then go to /queue instead of /message. Ignored for
    /// hammersmith, which the server queues itself.
    public var queued: Bool

    public var kind: Kind {
        switch mode {
        case .hammersmith: .hammersmith
        case .message, .goal: queued ? .queue : .message
        }
    }

    public init(id: String, prompt: String, mode: SubmissionMode, queued: Bool = false) {
        self.id = id
        self.prompt = prompt
        self.mode = mode
        self.queued = queued
    }
}
