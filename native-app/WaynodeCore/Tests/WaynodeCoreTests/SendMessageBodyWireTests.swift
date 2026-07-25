import Foundation
import Testing
@testable import WaynodeCore

@Suite("Send message wire body")
struct SendMessageBodyWireTests {
    private func encoded(_ mode: SubmissionMode) throws -> [String: Any] {
        let body = APIClient.SendMessageBody(prompt: "ship it", mode: mode, submissionId: "s1")
        let data = try JSONEncoder().encode(body)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("A goal turn is carried by mode alone")
    func goalTravelsAsMode() throws {
        let json = try encoded(.goal)
        #expect(json["mode"] as? String == "goal")
        #expect(json["prompt"] as? String == "ship it")
        #expect(json["submissionId"] as? String == "s1")
    }

    @Test("A plain turn sends mode=message")
    func messageTravelsAsMode() throws {
        #expect(try encoded(.message)["mode"] as? String == "message")
    }

    @Test("The legacy isGoal boolean is gone from the wire")
    func noLegacyBoolean() throws {
        for mode in SubmissionMode.allCases {
            let json = try encoded(mode)
            #expect(json["isGoal"] == nil, "mode is the only submission vocabulary")
            #expect(json.keys.sorted() == ["mode", "prompt", "submissionId"])
        }
    }
}
