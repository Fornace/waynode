import Foundation
#if canImport(Observation)
import Observation
#endif

// MARK: - AppModel
//
// Top-level observable state container. Owns the AuthStore, the REST API
// client, and the caches of orgs/spaces/sessions. Individual SessionStore
// instances are created on-demand and held in a dictionary keyed by
// sessionId.
//
// The SwiftUI environment reads from AppModel to render the sidebar, the
// session list, and to coordinate navigation.

@MainActor
@Observable
public final class AppModel {
    public let auth: AuthStore

    // REST caches.
    public private(set) var orgs: [Org] = []
    public private(set) var spaces: [Space] = []
    public private(set) var sessionsBySpace: [String: [Session]] = [:]
    public private(set) var models: [ModelOption] = []
    public private(set) var isLoadingSpaces: Bool = false
    public private(set) var isLoadingSessions: Bool = false
    public private(set) var spacesError: String?
    public private(set) var sessionsError: String?
    #if DEBUG
    public private(set) var isUITestFixture = false
    #endif

    // Active session stores (lifecycle-managed by views via acquire/release).
    public private(set) var sessionStores: [String: SessionStore] = [:]

    // Selection state.
    public var selectedSpaceId: String?
    public var selectedSessionId: String?

    // Deep-link navigation. Set by .onOpenURL handler; consumed by
    // MainView's NavigationStack to push the right destination.
    public var pendingDeepLink: DeepLink?

    private var api: APIClient?
    private var unauthorizedTask: Task<Void, Never>?

    public init(auth: AuthStore) {
        self.auth = auth
        reconfigureAPI()
    }

    #if DEBUG
    /// Seeds realistic workbench state without requiring a network or token.
    public func installUITestFixture() {
        isUITestFixture = true
        let now = "2026-07-14T12:00:00Z"
        let space = Space(id: "ui-space", ownerId: "ui-user", repoUrl: "https://github.com/example/waynode", repoName: "waynode", repoFullName: "example/waynode", branch: "main", localPath: "/tmp/waynode", createdAt: now, sessionCount: 2, myRole: "owner", latestSessionTitle: "Polish the workbench", latestSessionAt: now)
        orgs = [Org(id: "ui-org", name: "Waynode Studio", slug: "waynode-studio", createdAt: now, myRole: "owner", spaceCount: 1)]
        let sessions = [
            Session(id: "ui-session", spaceId: space.id, ownerId: "ui-user", title: "Polish the workbench", piSessionDir: "/tmp/waynode/.pi", model: "claude-sonnet", provider: "anthropic", createdAt: now, updatedAt: now),
            Session(id: "ui-archived", spaceId: space.id, ownerId: "ui-user", title: "Archived exploration", piSessionDir: "/tmp/waynode/.pi-old", archived: true, createdAt: now, updatedAt: now)
        ]
        spaces = [space]
        sessionsBySpace = [space.id: sessions]
        models = [ModelOption(id: "claude-sonnet", name: "Claude Sonnet", desc: "Balanced speed and quality")]
        selectedSpaceId = space.id
        selectedSessionId = sessions[0].id
    }
    #endif

    /// Reconfigure the API client after auth/server changes.
    /// Wires the 401 handler so token expiry automatically returns to login.
    public func reconfigureAPI() {
        // Cancel the previous 401 listener task so we don't accumulate
        // zombie tasks + APIClient instances across reconfigure calls.
        unauthorizedTask?.cancel()
        let client = APIClient(baseURL: auth.serverConfig.baseURL, token: auth.token)
        api = client
        // Listen for 401s on a background task; bounce to MainActor.
        unauthorizedTask = Task { [weak self] in
            for await _ in client.unauthorizedStream {
                guard let self else { return }
                self.handleUnauthorized()
            }
        }
    }

    public func currentAPI() -> APIClient? { api }

    // MARK: - Bootstrap (called after auth)

    public func bootstrap() async {
        reconfigureAPI()
        await refreshAll()
    }

    public func refreshAll() async {
        async let o: () = refreshOrgs()
        async let s: () = refreshSpaces()
        _ = await (o, s)
    }

    // MARK: - Orgs

    public func refreshOrgs() async {
        guard let api else { return }
        orgs = (try? await api.listOrgs()) ?? []
    }

    // MARK: - Models

    @discardableResult
    public func refreshModels() async throws -> [ModelOption] {
        #if DEBUG
        if isUITestFixture { return models }
        #endif
        guard let api else { throw AuthStoreError.notAuthenticated }
        let response = try await api.listModels()
        models = response.models
        return models
    }

    // MARK: - Spaces

    public func refreshSpaces() async {
        #if DEBUG
        if isUITestFixture { return }
        #endif
        guard let api else { return }
        isLoadingSpaces = true
        spacesError = nil
        do {
            spaces = try await api.listSpaces()
            if selectedSpaceId == nil { selectedSpaceId = spaces.first?.id }
        } catch {
            spacesError = error.localizedDescription
        }
        isLoadingSpaces = false
    }

    public func createSpace(repoUrl: String, branch: String? = nil, orgId: String? = nil) async throws -> Space {
        #if DEBUG
        if isUITestFixture {
            let now = "2026-07-14T12:00:00Z"
            let id = "ui-clone-\(spaces.count)"
            let name = repoUrl.split(separator: "/").last.map(String.init) ?? "repository"
            let space = Space(id: id, ownerId: "ui-user", repoUrl: repoUrl, repoName: name, repoFullName: nil, branch: branch ?? "main", localPath: "/tmp/\(name)", createdAt: now, sessionCount: 0, myRole: "owner", latestSessionTitle: nil, latestSessionAt: nil)
            spaces.insert(space, at: 0)
            sessionsBySpace[id] = []
            return space
        }
        #endif
        guard let api else { throw AuthStoreError.notAuthenticated }
        let space = try await api.createSpace(.init(repoUrl: repoUrl, branch: branch, orgId: orgId))
        spaces.insert(space, at: 0)
        return space
    }

    public func deleteSpace(_ id: String) async {
        #if DEBUG
        if isUITestFixture {
            let sessionIds = Set((sessionsBySpace[id] ?? []).map(\.id))
            sessionIds.forEach { sessionStores[$0]?.close(); sessionStores.removeValue(forKey: $0) }
            spaces.removeAll { $0.id == id }
            sessionsBySpace.removeValue(forKey: id)
            if selectedSpaceId == id { selectedSpaceId = spaces.first?.id }
            if let selectedSessionId, sessionIds.contains(selectedSessionId) { self.selectedSessionId = nil }
            return
        }
        #endif
        guard let api else { return }
        do {
            try await api.deleteSpace(id)
            // Close and tear down any live session stores belonging to this
            // space's sessions. We close (not just release) because the space
            // is gone — there's no point keeping a 30s close timer alive.
            let orphanedSessionIds = Set((sessionsBySpace[id] ?? []).map(\.id))
            for sid in orphanedSessionIds {
                if let store = sessionStores[sid] {
                    store.close()
                    sessionStores.removeValue(forKey: sid)
                }
            }
            if let sel = selectedSessionId, orphanedSessionIds.contains(sel) {
                selectedSessionId = nil
            }
            spaces.removeAll { $0.id == id }
            sessionsBySpace.removeValue(forKey: id)
            if selectedSpaceId == id { selectedSpaceId = spaces.first?.id }
        } catch {
            spacesError = error.localizedDescription
        }
    }

    // MARK: - Sessions

    public func refreshSessions(spaceId: String) async {
        #if DEBUG
        if isUITestFixture { return }
        #endif
        guard let api else { return }
        isLoadingSessions = true
        sessionsError = nil
        do {
            sessionsBySpace[spaceId] = try await api.listSessions(spaceId: spaceId)
        } catch {
            sessionsError = error.localizedDescription
        }
        isLoadingSessions = false
    }

    public func sessions(forSpace spaceId: String) -> [Session] {
        sessionsBySpace[spaceId] ?? []
    }

    public func createSession(spaceId: String, title: String? = nil) async throws -> Session {
        #if DEBUG
        if isUITestFixture {
            let now = "2026-07-14T12:00:00Z"
            let id = "ui-session-\(sessions(forSpace: spaceId).count + 1)"
            let session = Session(id: id, spaceId: spaceId, ownerId: "ui-user", title: title ?? "New session", piSessionDir: "/tmp/waynode/.pi-\(id)", model: "claude-sonnet", provider: "anthropic", createdAt: now, updatedAt: now)
            sessionsBySpace[spaceId, default: []].insert(session, at: 0)
            return session
        }
        #endif
        guard let api else { throw AuthStoreError.notAuthenticated }
        let session = try await api.createSession(spaceId: spaceId, title: title)
        var list = sessionsBySpace[spaceId] ?? []
        list.insert(session, at: 0)
        sessionsBySpace[spaceId] = list
        return session
    }

    public func deleteSession(_ id: String) async {
        #if DEBUG
        if isUITestFixture {
            for (spaceId, var list) in sessionsBySpace {
                list.removeAll { $0.id == id }
                sessionsBySpace[spaceId] = list
            }
            if selectedSessionId == id { selectedSessionId = nil }
            return
        }
        #endif
        guard let api else { return }
        do {
            try await api.deleteSession(id)
            // Close and remove the session store to avoid SSE stream leaks.
            if let store = sessionStores[id] {
                store.close()
                sessionStores.removeValue(forKey: id)
            }
            for (spaceId, var list) in sessionsBySpace {
                list.removeAll { $0.id == id }
                sessionsBySpace[spaceId] = list
            }
            if selectedSessionId == id { selectedSessionId = nil }
        } catch {
            sessionsError = error.localizedDescription
        }
    }

    // MARK: - Session store access

    /// Get-or-create a SessionStore for the given session. Views call
    /// acquire() when they appear and release() when they disappear.
    public func store(for sessionId: String, spaceId: String) -> SessionStore {
        if let existing = sessionStores[sessionId] {
            return existing
        }
        // OAuth changes AuthStore synchronously, while SwiftUI may render a
        // restored/deep-linked SessionDetail before AuthView's following
        // bootstrap task reaches reconfigureAPI().  This used to fatalError
        // in that narrow window, turning a successful native GitHub callback
        // into an app crash. Reconfigure on demand instead; the client is
        // cheap and this also makes restoration resilient to view timing.
        if api == nil { reconfigureAPI() }
        let client = api ?? APIClient(baseURL: auth.serverConfig.baseURL, token: auth.token)
        if api == nil { api = client }
        #if DEBUG
        let store = SessionStore(sessionId: sessionId, spaceId: spaceId, api: client, offlineFixture: isUITestFixture)
        #else
        let store = SessionStore(sessionId: sessionId, spaceId: spaceId, api: client)
        #endif
        sessionStores[sessionId] = store
        return store
    }

    // MARK: - 401 handling

    /// Called when the API returns 401 — clears auth state.
    public func handleUnauthorized() {
        auth.logout()
        // Close every active SessionStore to release SSE connections and
        // listener tasks. Just removing from the dict would leak URLSessions.
        for store in sessionStores.values {
            store.close()
        }
        sessionStores.removeAll()
        orgs = []
        spaces = []
        sessionsBySpace.removeAll()
        selectedSpaceId = nil
        selectedSessionId = nil
    }
}

// MARK: - Errors

public enum AuthStoreError: Error, LocalizedError {
    case notAuthenticated

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Not authenticated"
        }
    }
}
