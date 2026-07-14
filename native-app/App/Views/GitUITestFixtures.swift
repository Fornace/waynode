import Foundation
import WaynodeCore

#if DEBUG
enum GitUITestFixtures {
    static var snapshot: GitSnapshot {
        let json = #"""
        {
          "currentBranch":"main","detached":false,"upstream":"origin/main",
          "ahead":1,"behind":0,"hasUncommittedChanges":true,
          "files":[
            {"path":"Sources/Waynode.swift","status":"M","staged":" "},
            {"path":"README.md","status":"A","staged":" "}
          ],
          "commits":[{"hash":"abc123456789","subject":"Improve workspace flow","author":"Waynode Tester","date":"2026-07-14T10:00:00Z"}],
          "branches":[{"name":"main","isDefault":true},{"name":"review/ui-polish","isDefault":false}],
          "defaultBranch":"main"
        }
        """#.data(using: .utf8)!
        return try! JSONDecoder().decode(GitSnapshot.self, from: json)
    }
}
#endif
