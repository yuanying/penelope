import Foundation
import Testing

@testable import PenelopeCore

/// Keeping one summary stream open for each agent while the list is up (ADR-0066).
struct SummaryStreamTests {
    let one = URL(string: "https://one.example.com")!
    let two = URL(string: "https://two.example.com")!

    func listing(_ origins: [URL]) -> (AppState, [AppEffect]) {
        let launched = AppMediator.reduce(AppState(), .launched).0
        return AppMediator.reduce(launched, .agentsLoaded(origins.map { SavedAgent(origin: $0) }))
    }

    func generation(_ effects: [AppEffect], _ origin: URL) -> Int? {
        for case .openSummaryStream(origin, let generation, _) in effects { return generation }
        return nil
    }

    /// The list is drawn from the streams, so reading the saved agents opens one for each.
    @Test func showingTheListOpensAStreamForEachAgent() {
        let (_, effects) = listing([one, two])

        #expect(generation(effects, one) != nil)
        #expect(generation(effects, two) != nil)
    }

    /// A lost stream marks only its own row and is tried again after a pause.
    @Test func aLostStreamIsRetriedLater() {
        let (state, effects) = listing([one, two])
        let (next, retry) = AppMediator.reduce(
            state, .summaryStreamEnded(one, generation: generation(effects, one)!, .failed))

        #expect(next.links[one]?.link == .unreachable)
        #expect(next.links[two]?.link == .connecting)
        guard case .openSummaryStream(one, _, let delay) = retry.first else {
            Issue.record("not retried: \(retry)")
            return
        }
        #expect(delay > 0)
    }

    /// A refused token will not start working by itself, so the row asks for a new sign-in and nothing is retried.
    @Test func aRefusedTokenIsNotRetried() {
        let (state, effects) = listing([one])
        let (next, retry) = AppMediator.reduce(
            state, .summaryStreamEnded(one, generation: generation(effects, one)!, .unauthorized))

        #expect(next.links[one]?.link == .signedOut)
        #expect(retry.isEmpty)
    }

    /// What a stream that was already replaced says must not overwrite what the new one said.
    @Test func anOldStreamIsNotListenedTo() {
        let (state, effects) = listing([one])
        let old = generation(effects, one)!
        let lost = AppMediator.reduce(state, .summaryStreamEnded(one, generation: old, .failed)).0

        let (next, _) = AppMediator.reduce(lost, .summaryStreamEnded(one, generation: old, .unauthorized))

        #expect(next.links[one]?.link == .unreachable)
    }

    /// The streams are for the list: they close when the app goes to the background.
    @Test func goingToTheBackgroundClosesTheStreams() {
        let (state, _) = listing([one, two])
        let (_, effects) = AppMediator.reduce(state, .movedToBackground)

        #expect(Set(effects) == [.closeSummaryStream(one), .closeSummaryStream(two)])
    }
}
