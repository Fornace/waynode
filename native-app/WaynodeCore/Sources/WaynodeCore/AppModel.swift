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
                await self.handleUnauthorized()
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

    public func refreshModels() async {
        guard let api else { return }
        if let resp = try? await api.listModels() {
            models = resp.models
        }
    }

    // MARK: - Spaces

    public func refreshSpaces() async {
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
        guard let api else { throw AuthStoreError.notAuthenticated }
        let space = try await api.createSpace(.init(repoUrl: repoUrl, branch: branch, orgId: orgId))
        spaces.insert(space, at: 0)
        return space
    }

    public func deleteSpace(_ id: String) async {
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
        guard let api else { throw AuthStoreError.notAuthenticated }
        let session = try await api.createSession(spaceId: spaceId, title: title)
        var list = sessionsBySpace[spaceId] ?? []
        list.insert(session, at: 0)
        sessionsBySpace[spaceId] = list
        return session
    }

    public func deleteSession(_ id: String) async {
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
        guard let api else { fatalError("No API client — not authenticated") }
        let store = SessionStore(sessionId: sessionId, spaceId: spaceId, api: api)
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
