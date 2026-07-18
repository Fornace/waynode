import Foundation

// MARK: - Hammersmith run folding
//
// Run items upsert by run id: repeat hammersmith_run events for the same job
// update the existing transcript row in place (preserving position) instead
// of appending duplicates.

extension ChatReducer {
    public mutating func upsertHammersmithRun(_ run: HammersmithRun) {
        if let index = items.firstIndex(where: {
            guard case .hammersmithRun(let item) = $0 else { return false }
            return item.run.id == run.id
        }) {
            items[index] = .hammersmithRun(.init(run: run, sentAt: items[index].sentAt))
        } else {
            items.append(.hammersmithRun(.init(run: run)))
        }
        revision += 1
    }

    /// The most recent run still executing, if any.
    public var activeHammersmithRun: HammersmithRun? {
        hammersmithRuns.last(where: { $0.lifecycle == .running })
    }

    public var hammersmithRuns: [HammersmithRun] {
        items.compactMap {
            guard case .hammersmithRun(let item) = $0 else { return nil }
            return item.run
        }
    }
}
