import Foundation
import Testing
@testable import WaynodeCore

/// Deterministic regressions for the SSE transport pieces that feed
/// `connectOnce()`: request construction, line-level parsing, cursor
/// commitment, and reconnect-cycle state reset. Everything here runs against
/// in-memory line streams, so the reconnect semantics are covered without a
/// live URLSession.
@Suite("SSE transport contract")
struct SSETransportTests {
    private static let url = URL(string: "https://waynode.example.test/api/sessions/s1/stream")!

    private func lines(_ values: [String]) -> AsyncStream<String> {
        AsyncStream { continuation in
            for value in values { continuation.yield(value) }
            continuation.finish()
        }
    }

    private func collect(_ client: SSEClient, count: Int) async -> [SSEFrame] {
        var frames: [SSEFrame] = []
        for await frame in client.events() {
            frames.append(frame)
            if frames.count == count { break }
        }
        return frames
    }

    @Test("request carries bearer and replay cursor")
    func requestHeaders() {
        let authed = SSEWire.request(url: Self.url, token: "tok", lastEventId: "cur-9")
        #expect(authed.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(authed.value(forHTTPHeaderField: "Last-Event-ID") == "cur-9")
        #expect(authed.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        #expect(authed.value(forHTTPHeaderField: "Cache-Control") == "no-cache")

        let bare = SSEWire.request(url: Self.url, token: nil, lastEventId: nil)
        #expect(bare.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(bare.value(forHTTPHeaderField: "Last-Event-ID") == nil)

        let empty = SSEWire.request(url: Self.url, token: nil, lastEventId: "")
        #expect(empty.value(forHTTPHeaderField: "Last-Event-ID") == nil)
    }

    @Test("consume yields frames at event boundaries and counts every keep-alive")
    func consumeBoundaries() async {
        let client = SSEClient(url: Self.url, token: nil)
        let wire = [
            ": keep-alive",
            "id: cursor-1",
            "data: {\"type\":\"ping\"}",
            "data: {\"type\":\"ping\"}",
            "id",
            "data: {\"type\":\"ping\"}",
            ": keep-alive",
        ]
        try? await client.consume(lines(wire))
        let frames = await collect(client, count: 3)
        #expect(frames.count == 3)
        #expect(frames[0].eventIdField == .value("cursor-1"))
        #expect(frames[1].eventIdField == .absent, "id-less frame keeps prior cursor")
        #expect(frames[2].eventIdField == .value(nil), "bare id line means explicit empty")
        #expect(frames.allSatisfy { !$0.malformed })
        #expect(await client.heartbeatResets == wire.count, "every line proves liveness")
    }

    @Test("malformed data keeps its frame id and flags the payload")
    func malformedFrameCarriesId() async {
        let client = SSEClient(url: Self.url, token: nil)
        try? await client.consume(lines([
            "id: bad-1",
            "data: {broken",
        ]))
        let frames = await collect(client, count: 1)
        #expect(frames.count == 1)
        #expect(frames[0].malformed)
        #expect(frames[0].event == nil)
        #expect(frames[0].eventIdField == .value("bad-1"))
    }

    @Test("reconnect reset clears the block but keeps the committed cursor")
    func reconnectResetKeepsCursor() async {
        let client = SSEClient(url: Self.url, token: nil)
        try? await client.consume(lines(["id: rejected", "data: {broken"]))
        let rejected = await collect(client, count: 1)
        await client.acknowledge(rejected[0], applied: false)

        // The rejected frame must freeze the cursor for the rest of this
        // connection even when later frames decode cleanly.
        try? await client.consume(lines(["id: late", "data: {\"type\":\"ping\"}"]))
        let late = await collect(client, count: 1)
        await client.acknowledge(late[0], applied: true)
        #expect(await client.reconnectCursor == nil)

        // A fresh connection lifts the barrier; the replay starts from the
        // last committed cursor, not from the rejected frame.
        await client.resetForConnection()
        try? await client.consume(lines(["id: after-reset", "data: {\"type\":\"ping\"}"]))
        let fresh = await collect(client, count: 1)
        await client.acknowledge(fresh[0], applied: true)
        #expect(await client.reconnectCursor == "after-reset")
    }

    @Test("stop preserves the committed cursor")
    func stopPreservesCursor() async {
        let client = SSEClient(url: Self.url, token: nil, lastEventId: "seed")
        try? await client.consume(lines(["id: c-2", "data: {\"type\":\"ping\"}"]))
        let frames = await collect(client, count: 1)
        await client.acknowledge(frames[0], applied: true)
        await client.stop()
        #expect(await client.reconnectCursor == "c-2")
        let states = await client.stateChanges()
        let first = await states.first(where: { $0 == .disconnected })
        #expect(first == .disconnected)
    }
}
