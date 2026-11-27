import Foundation
import PenelopeCore
import UIKit

/// The real world: UserDefaults for the list, the Keychain for the tokens, and HTTPS to each backend
/// (docs/ui-api.md).
@MainActor
final class LiveWorld: AppWorld {
    private let defaults = UserDefaults.standard
    private let tokens = TokenKeychain()
    private let session: URLSession
    private lazy var signInSession = SignInSession(tokens: tokens, session: session)

    private static let agentsKey = "agents"

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
    }

    func loadAgents() -> [SavedAgent] {
        guard let data = defaults.data(forKey: Self.agentsKey) else { return [] }
        return (try? JSONDecoder().decode([SavedAgent].self, from: data)) ?? []
    }

    func saveAgents(_ agents: [SavedAgent]) {
        guard let data = try? JSONEncoder().encode(agents) else { return }
        defaults.set(data, forKey: Self.agentsKey)
    }

    func profile(at origin: URL) async -> AgentProfile? {
        var request = URLRequest(url: origin.appending(path: "api/agent"))
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await session.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return AgentProfile.decode(data)
    }

    func signIn(to origin: URL) async -> SignInResult {
        await signInSession.run(origin: origin, deviceName: UIDevice.current.name)
    }

    func streamSummaries(at origin: URL, received: @escaping @MainActor (AgentSummary) -> Void) async -> StreamEnd {
        guard let token = tokens.read(origin) else { return .unauthorized }
        return await SummaryStreamReader(session: session).read(origin: origin, token: token, received: received)
    }

    func forget(_ origin: URL) async -> Bool {
        defer { tokens.delete(origin) }
        guard let token = tokens.read(origin) else { return true }
        var request = URLRequest(url: origin.appending(path: "api/app/devices/current"))
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (_, response) = try? await session.data(for: request),
            let status = (response as? HTTPURLResponse)?.statusCode
        else { return false }
        // 401: the token was no longer valid there, so there is nothing left to revoke.
        return status == 204 || status == 401
    }

    func openInBrowser(_ url: URL) {
        UIApplication.shared.open(url)
    }
}

/// Reads `GET /api/summary/stream` (docs/ui-api.md「要約の流れ」).
struct SummaryStreamReader: Sendable {
    let session: URLSession

    func read(origin: URL, token: String, received: @escaping @MainActor (AgentSummary) -> Void) async -> StreamEnd {
        var request = URLRequest(url: origin.appending(path: "api/summary/stream"))
        // The backend sends a comment every 25 seconds, so a minute of silence is a lost connection.
        request.timeoutInterval = 60
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            switch (response as? HTTPURLResponse)?.statusCode {
            case 200: break
            case 401: return .unauthorized
            default: return .failed
            }
            var reader = ServerSentEventReader()
            var line: [UInt8] = []
            // `bytes.lines` drops the blank lines that end the events, so the lines are cut here.
            for try await byte in bytes {
                guard byte == UInt8(ascii: "\n") else {
                    line.append(byte)
                    continue
                }
                if line.last == UInt8(ascii: "\r") { line.removeLast() }
                let text = String(decoding: line, as: UTF8.self)
                line.removeAll(keepingCapacity: true)
                guard let event = reader.feed(line: text), event.event == "summary",
                    let summary = try? AgentSummary.decode(Data(event.data.utf8))
                else { continue }
                await received(summary)
            }
            return .failed
        } catch {
            return .failed
        }
    }
}
