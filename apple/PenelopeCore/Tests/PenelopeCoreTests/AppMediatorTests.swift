import Foundation
import Testing

@testable import PenelopeCore

struct AppMediatorTests {
    /// The list of agents is kept by the app outside the mediator, so launching has to ask for it.
    @Test func launchingAsksForTheSavedAgents() {
        let (_, effects) = AppMediator.reduce(AppState(), .launched)

        #expect(effects == [.loadAgents])
    }

    /// 「まだ誰もいません」 is a claim about what is saved: it must not show before the saved agents were read,
    /// and once none turned up it offers to add one.
    @Test func theEmptyListIsOfferedOnlyOnceNoSavedAgentsWereFound() {
        let launched = AppMediator.reduce(AppState(), .launched).0
        #expect(AppProps.root(launched, now: Date(), calendar: .current).everyone.body == .blank)

        let (loaded, effects) = AppMediator.reduce(launched, .agentsLoaded([]))

        guard case .empty(let empty) = AppProps.root(loaded, now: Date(), calendar: .current).everyone.body else {
            Issue.record("the empty list is not shown")
            return
        }
        #expect(empty.action.event == .addAgentRequested)
        #expect(effects.isEmpty)
    }
}
