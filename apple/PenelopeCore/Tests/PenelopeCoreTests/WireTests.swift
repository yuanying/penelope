import Foundation
import Testing

@testable import PenelopeCore

/// The shapes exchanged with a backend (docs/ui-api.md).
struct WireTests {
    /// A summary event's data is read as the backend sends it, the tool's state included.
    @Test func aSummaryIsReadAsTheBackendSendsIt() throws {
        let data = Data(
            #"{"state":{"kind":"tool","tool":"bash: ls"},"last_message":{"kind":"owner","at":"2026-11-27T01:02:03.456Z","text":"見て"},"unread":2,"unseen_failures":1}"#
                .utf8)

        let summary = try AgentSummary.decode(data)

        #expect(summary.state == .tool("bash: ls"))
        #expect(summary.lastMessage?.kind == .owner)
        #expect(summary.lastMessage?.at == Date(timeIntervalSince1970: 1_795_741_323.456))
        #expect(summary.unread == 2)
        #expect(summary.unseenFailures == 1)
    }

    /// An event is complete only at its blank line; its data lines join, and the keepalive comments are not events.
    @Test func anEventIsDeliveredAtItsBlankLine() {
        var reader = ServerSentEventReader()
        let lines = [": keepalive", "event: summary", "data: {\"a\":", "data: 1}", ""]

        let events = lines.compactMap { reader.feed(line: $0) }

        #expect(events == [ServerSentEvent(event: "summary", data: "{\"a\":\n1}")])
    }

    /// The sign-in is opened at the backend with the app's challenge, and the code comes back on penelope://auth.
    @Test func theSignInIsOpenedWithTheChallengeAndAnswersWithACode() {
        let start = AppLogin.startURL(origin: URL(string: "https://one.example.com")!, challenge: "abc-_")

        #expect(start.absoluteString == "https://one.example.com/auth/app/start?code_challenge=abc-_&code_challenge_method=S256")
        #expect(AppLogin.code(from: URL(string: "penelope://auth?code=xyz")!) == "xyz")
        #expect(AppLogin.code(from: URL(string: "https://evil.example.com/auth?code=xyz")!) == nil)
    }
}
