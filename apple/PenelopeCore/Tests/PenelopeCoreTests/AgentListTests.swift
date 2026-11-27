import Foundation
import Testing

@testable import PenelopeCore

/// The rows of 「みんな」: what each one says about its agent (18 章「一覧」).
struct AgentListTests {
    let origin = URL(string: "https://one.example.com")!
    let now = Date(timeIntervalSince1970: 1_795_000_000)  // a moment of an ordinary day
    var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    func row(_ link: AgentLink, _ summary: AgentSummary?) -> AgentRowProps {
        var state = AppState(agents: [SavedAgent(origin: origin, name: "ワン")])
        state.links[origin] = AgentConnection(link: link, summary: summary)
        guard case .rows(let rows) = AppProps.root(state, now: now, calendar: calendar).everyone.body else {
            fatalError("no rows")
        }
        return rows[0]
    }

    func summary(_ state: SummaryState, at: Date? = nil, unread: Int = 0, failures: Int = 0) -> AgentSummary {
        AgentSummary(
            state: state, lastMessage: LastMessage(kind: .agent, at: at ?? now, text: "ノードは 5 台とも Ready"),
            unread: unread, unseenFailures: failures)
    }

    /// The tool is the point of 「ツールを使っている」, so it goes on the state line beside the words.
    @Test func aToolInUseIsNamedOnTheStateLine() {
        let status = row(.live, summary(.tool("bash: kubectl get nodes"))).status

        #expect(status.text == "ツールを使っている")
        #expect(status.detail == "bash: kubectl get nodes")
        #expect(status.tone == .info)
    }

    /// Waiting for an approval is told by a mark and words with the count, not by colour alone.
    @Test func waitingForApprovalSaysHowMany() {
        let status = row(.live, summary(.approval(pending: 2))).status

        #expect(status.mark == .pause)
        #expect(status.text == "止まって待っている ・ 承認 2")
    }

    /// An agent that cannot be reached still shows the last thing it said (18 章「一覧」7).
    @Test func anUnreachableAgentKeepsItsLastMessage() {
        let row = row(.unreachable, summary(.thinking))

        #expect(row.status.text == "つながらない")
        #expect(row.status.mark == .warning)
        #expect(row.lastMessage == "ノードは 5 台とも Ready")
    }

    /// When the token no longer works, the row says so and pressing it signs in again instead of opening her.
    @Test func aSignedOutRowSignsInAgain() {
        let row = row(.signedOut, nil)

        #expect(row.status.text == "ログインし直す")
        #expect(row.action == .signInAgainRequested(origin))
    }

    /// The badges count what is waiting for the owner, and a zero is not shown at all.
    @Test func onlyCountsAboveZeroGetABadge() {
        let row = row(.live, summary(.waiting, unread: 3, failures: 0))

        #expect(row.unread?.text == "3")
        #expect(row.failures == nil)
    }

    /// Today's messages show the time, as in a chat list.
    @Test func aMessageOfTodayShowsItsTime() {
        let morning = calendar.date(bySettingHour: 9, minute: 5, second: 0, of: now)!

        #expect(row(.live, summary(.waiting, at: morning)).time == "9:05")
    }

    /// A message of the day before says 「昨日」 rather than a time that could be read as today's.
    @Test func aMessageOfYesterdaySaysYesterday() {
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now)!

        #expect(row(.live, summary(.waiting, at: yesterday)).time == "昨日")
    }

    /// Anything older shows the date.
    @Test func anOlderMessageShowsItsDate() {
        let older = calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 12))!

        #expect(row(.live, summary(.waiting, at: older)).time == "11/3")
    }

    /// Until the backend has told her name, the host stands in for it, so a row is never blank.
    @Test func theHostStandsInForAnUnknownName() {
        let state = AppState(agents: [SavedAgent(origin: origin)])
        guard case .rows(let rows) = AppProps.root(state, now: now, calendar: calendar).everyone.body else {
            Issue.record("no rows")
            return
        }

        #expect(rows[0].name == "one.example.com")
    }
}
