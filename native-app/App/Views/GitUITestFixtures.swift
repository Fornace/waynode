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
            {"path":"Sources/Waynode.swift","status":"modified","staged":" "},
            {"path":"README.md","status":"added","staged":" "},
            {"path":"scratch-notes.txt","status":"untracked","staged":"untracked"}
          ],
          "commits":[{"hash":"abc123456789","subject":"Improve workspace flow","author":"Waynode Tester","date":"2026-07-14T10:00:00Z"}],
          "branches":[{"name":"main","isDefault":true},{"name":"review/ui-polish","isDefault":false}],
          "defaultBranch":"main"
        }
        """#.data(using: .utf8)!
        var snapshot = try! JSONDecoder().decode(GitSnapshot.self, from: json)
        let arguments = CommandLine.arguments
        if arguments.contains("-ui-test-git-conflicted") {
            snapshot.files[0].status = "conflict"
            snapshot.files[0].staged = true
        } else if arguments.contains("-ui-test-git-diverged") {
            snapshot.ahead = 2
            snapshot.behind = 3
        } else if arguments.contains("-ui-test-git-detached") {
            snapshot.currentBranch = "abc1234"
            snapshot.detached = true
            snapshot.upstream = nil
        } else if arguments.contains("-ui-test-git-no-upstream") {
            snapshot.upstream = nil
        }
        return snapshot
    }
}
#endif
