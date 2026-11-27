import Foundation
import Testing

@testable import PenelopeCore

/// Adding an agent: the URL, the check that it is a penelope, the sign-in (18 章「エージェントを足す」, ADR-0064).
struct AddAgentTests {
    let origin = URL(string: "https://one.example.com")!

    func submitted(_ text: String, to state: AppState? = nil) -> (AppState, [AppEffect]) {
        var state = state ?? AppMediator.reduce(AppState(), .agentsLoaded([])).0
        state = AppMediator.reduce(state, .addAgentRequested).0
        state = AppMediator.reduce(state, .addURLChanged(text)).0
        return AppMediator.reduce(state, .addSubmitted)
    }

    func addProps(_ state: AppState) -> AddAgentProps {
        AppProps.root(state, now: Date(), calendar: Calendar(identifier: .gregorian)).add
    }

    /// What the owner types is taken as the Web UI's address: the scheme may be left out and a page's path is not
    /// part of it, so the backend is asked at its origin.
    @Test func theAgentIsAskedAtTheOriginOfWhatWasTyped() {
        let (_, effects) = submitted("one.example.com/record?x=1")

        #expect(effects == [.fetchProfile(origin)])
    }

    /// When no penelope answers there, the field says so in 18 章's words and no sign-in starts.
    @Test func anAddressWithoutAPenelopeIsTurnedDown() {
        let (checking, _) = submitted("https://one.example.com")
        let (state, effects) = AppMediator.reduce(checking, .profileFetched(origin, nil))

        #expect(effects.isEmpty)
        #expect(addProps(state).problem == "この URL には penelope が見つかりません。Web の画面を開くときの URL を入れてください。")
    }

    /// Once a penelope answers, the owner signs in to her backend.
    @Test func aPenelopeThatAnswersLeadsToTheSignIn() {
        let (checking, _) = submitted("https://one.example.com")
        let (_, effects) = AppMediator.reduce(
            checking, .profileFetched(origin, AgentProfile(name: "ワン", iconPath: nil)))

        #expect(effects == [.signIn(origin)])
    }

    /// After the sign-in the agent joins the bottom of the list, is kept, and the list is shown again.
    @Test func aSignedInAgentIsAddedAtTheBottom() {
        let first = SavedAgent(origin: URL(string: "https://zero.example.com")!, name: "ゼロ")
        let loaded = AppMediator.reduce(AppState(), .agentsLoaded([first])).0
        let (checking, _) = submitted("https://one.example.com", to: loaded)
        let profiled = AppMediator.reduce(checking, .profileFetched(origin, AgentProfile(name: "ワン", iconPath: nil))).0

        let (state, effects) = AppMediator.reduce(profiled, .signInFinished(origin, .signedIn))

        let added = [first, SavedAgent(origin: origin, name: "ワン")]
        #expect(state.agents == added)
        #expect(effects.contains(.saveAgents(added)))
        #expect(state.screens.isEmpty)
    }

    /// Closing the sign-in sheet is the owner changing their mind, not a failure to be reported.
    @Test func cancellingTheSignInIsNotAnError() {
        let (checking, _) = submitted("https://one.example.com")
        let profiled = AppMediator.reduce(checking, .profileFetched(origin, AgentProfile(name: "ワン", iconPath: nil))).0

        let (state, _) = AppMediator.reduce(profiled, .signInFinished(origin, .cancelled))

        #expect(addProps(state).problem == nil)
        #expect(addProps(state).submit.enabled)
    }

    /// An agent already on the list is not added twice.
    @Test func anAgentAlreadyListedIsNotAddedAgain() {
        let loaded = AppMediator.reduce(AppState(), .agentsLoaded([SavedAgent(origin: origin)])).0
        let (state, effects) = submitted("https://one.example.com/", to: loaded)

        #expect(effects.isEmpty)
        #expect(addProps(state).problem != nil)
    }
}

/// Taking an agent off this iPhone (18 章「アプリの設定」, docs/ui-api.md).
struct RemoveAgentTests {
    let origin = URL(string: "https://one.example.com")!

    /// Removing is confirmed first, and then her token is revoked and forgotten and the list kept without her.
    @Test func aConfirmedRemovalRevokesAndForgets() {
        var state = AppMediator.reduce(AppState(), .agentsLoaded([SavedAgent(origin: origin, name: "ワン")])).0
        state = AppMediator.reduce(state, .appSettingsRequested).0
        let (asking, asked) = AppMediator.reduce(state, .removeRequested(origin))
        #expect(asked.isEmpty)

        let (removed, effects) = AppMediator.reduce(asking, .removeConfirmed)

        #expect(removed.agents == [])
        #expect(effects.contains(.forgetAgent(origin, name: "ワン")))
        #expect(effects.contains(.saveAgents([])))
    }

    /// If the backend could not be told, the token may still work there, so the owner is told where to revoke it.
    @Test func anUnconfirmedRevocationIsReported() {
        let state = AppMediator.reduce(AppState(), .agentsLoaded([])).0
        let (next, _) = AppMediator.reduce(state, .agentForgotten(name: "ワン", revoked: false))

        let alert = AppProps.root(next, now: Date(), calendar: Calendar(identifier: .gregorian)).alert
        #expect(alert?.message.contains("Web の設定") == true)
    }
}
