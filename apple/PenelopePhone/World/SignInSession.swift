import AuthenticationServices
import CryptoKit
import Foundation
import PenelopeCore
import UIKit

/// The sign-in to one deployment (docs/ui-api.md「iPhone のログインと端末の失効」): a PKCE verifier made here, her
/// backend's GitHub sign-in in `ASWebAuthenticationSession`, the one-time code it sends back on `penelope://auth`, and
/// the token it is exchanged for, kept in the Keychain.
@MainActor
final class SignInSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let tokens: TokenKeychain
    private let session: URLSession
    /// The session on screen. ASWebAuthenticationSession has to be held while it is up.
    private var current: ASWebAuthenticationSession?

    init(tokens: TokenKeychain, session: URLSession) {
        self.tokens = tokens
        self.session = session
    }

    func run(origin: URL, deviceName: String) async -> SignInResult {
        let verifier = Self.verifier()
        let start = AppLogin.startURL(origin: origin, challenge: Self.challenge(verifier))
        let callback: URL
        do {
            callback = try await present(start)
        } catch ASWebAuthenticationSessionError.canceledLogin {
            return .cancelled
        } catch {
            return .failed
        }
        guard let code = AppLogin.code(from: callback) else { return .failed }

        var request = URLRequest(url: origin.appending(path: "auth/app/token"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = AppLogin.tokenRequest(code: code, verifier: verifier, deviceName: deviceName)
        guard let (data, response) = try? await session.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200,
            let token = AppLogin.token(from: data),
            tokens.write(token, for: origin)
        else { return .failed }
        return .signedIn
    }

    private func present(_ url: URL) async throws -> URL {
        defer { current = nil }
        return try await withCheckedThrowingContinuation { continuation in
            let auth = ASWebAuthenticationSession(url: url, callback: .customScheme(AppLogin.callbackScheme)) {
                callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else {
                    continuation.resume(throwing: error ?? ASWebAuthenticationSessionError(.canceledLogin))
                }
            }
            auth.presentationContextProvider = self
            // The GitHub sign-in is kept between the agents, so the second one does not ask again.
            auth.prefersEphemeralWebBrowserSession = false
            current = auth
            if !auth.start() {
                current = nil
                continuation.resume(throwing: ASWebAuthenticationSessionError(.presentationContextInvalid))
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        // A sign-in starts from a button on screen, so there is a window; a new one only stands in.
        return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor(windowScene: scenes[0])
    }

    /// 32 random bytes as base64url without padding: 43 characters of the allowed ones.
    private static func verifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64url(Data(bytes))
    }

    private static func challenge(_ verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
