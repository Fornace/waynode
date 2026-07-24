import Foundation
import Testing
@testable import WaynodeCore

@Suite("Send message wire body")
struct SendMessageBodyWireTests {
    private func encoded(isGoal: Bool) throws -> [String: Any] {
        let body = APIClient.SendMessageBody(prompt: "ship it", isGoal: isGoal, submissionId: "s1")
        let data = try JSONEncoder().encode(body)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("Goal turn sends canonical mode=goal and keeps the legacy isGoal flag")
    func goalCarriesCanonicalMode() throws {
        let json = try encoded(isGoal: true)
        #expect(json["mode"] as? String == "goal")
        #expect(json["isGoal"] as? Bool == true)
        #expect(json["prompt"] as? String == "ship it")
        #expect(json["submissionId"] as? String == "s1")
    }

    @Test("Plain turn sends canonical mode=message and isGoal=false")
    func messageCarriesCanonicalMode() throws {
        let json = try encoded(isGoal: false)
        #expect(json["mode"] as? String == "message")
        #expect(json["isGoal"] as? Bool == false)
    }
}
