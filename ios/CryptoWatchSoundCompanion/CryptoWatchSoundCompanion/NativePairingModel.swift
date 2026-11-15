import Foundation
import Security
import SwiftUI
import UIKit

/// A separate, optional native APNs identity. The web push registration is not
/// migrated or changed. The APNs token is held in memory and can rotate.
@MainActor
final class NativePairingModel: ObservableObject {
    @Published var pairingCode = ""
    @Published private(set) var status = "Native pairing is not connected."
    @Published private(set) var hasAPNsToken = false
    @Published private(set) var isConnected = CredentialVault.load() != nil
    @Published private(set) var isBusy = false

    private let service = URL(string: "https://crypto-watch-alerts.jfaread-crypto-watch.workers.dev/")!
    private var deviceToken: Data?

    private var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    func registerWithApple() {
        UIApplication.shared.registerForRemoteNotifications()
        status = "Requesting a device token securely from Apple."
    }

    func receivedToken(_ token: Data) {
        guard !token.isEmpty else { return }
        deviceToken = token
        hasAPNsToken = true
        status = "Apple Push token received. Pair with a code from your connected Crypto-Watch website."
        if isConnected {
            Task { await refreshRegistration() }
        }
    }

    func tokenUnavailable() {
        hasAPNsToken = false
        deviceToken = nil
        status = "Apple Push registration is unavailable. A signed build with the Push Notifications entitlement is required."
    }

    private func request(path: String, method: String, body: [String: String] = [:],
                         bearer: String? = nil) async throws -> Data {
        // All native calls use this one fixed HTTPS origin. Do not make a token
        // an authentication credential, append secrets to URLs or follow redirects.
        guard path.hasPrefix("v1/native/"),
              let url = URL(string: path, relativeTo: service)?.absoluteURL,
              url.scheme == "https", url.host == service.host else {
            throw PairingError.request
        }
        var call = URLRequest(url: url)
        call.httpMethod = method
        call.timeoutInterval = 12
        call.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            call.setValue("application/json", forHTTPHeaderField: "Content-Type")
            call.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        if let bearer {
            call.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        }
        // Use ephemeral networking so an APNs token or pairing code cannot
        // accidentally persist in a shared URL cache.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        let delegate = RedirectDenyingDelegate()
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: call)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode),
              data.count <= 16_384 else {
            throw PairingError.service
        }
        return data
    }

    func pair() async {
        guard !isBusy else { return }
        guard let apns = deviceToken, !apns.isEmpty else {
            status = "First enable notifications and register with Apple for a device token."
            return
        }
        let code = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard code.count == 64, code.utf8.allSatisfy({
            ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
        }) else {
            status = "Paste the one-time pairing code from Crypto-Watch. It expires after five minutes."
            return
        }
        isBusy = true
        defer { pairingCode = ""; isBusy = false }
        do {
            let body = ["pairingCode": code,
                        "apnsToken": apns.map { String(format: "%02x", $0) }.joined(),
                        "environment": environment]
            let result = try await request(path: "v1/native/complete", method: "POST", body: body)
            let reply = try JSONDecoder().decode(PairResponse.self, from: result)
            guard reply.connected, reply.environment == environment else { throw PairingError.service }
            try CredentialVault.save(reply.bearer)
            isConnected = true
            status = "Native device paired. The server still needs APNs signing to deliver remote sounds."
        } catch {
            status = "Native pairing is not available yet. Your existing website alerts are unchanged."
        }
    }

    func refreshRegistration() async {
        guard !isBusy, let bearer = CredentialVault.load(), let apns = deviceToken else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let data = try await request(path: "v1/native/device", method: "PUT",
                 body: ["apnsToken": apns.map { String(format: "%02x", $0) }.joined()],
                 bearer: bearer)
            let reply = try JSONDecoder().decode(StatusResponse.self, from: data)
            guard reply.connected else { throw PairingError.service }
            isConnected = true
            status = "Native device identity verified. XRP alerts follow your paired website rules."
        } catch {
            status = "Native registration could not be refreshed. Existing website alerts are unchanged."
        }
    }

    func disconnect() async {
        guard !isBusy, let bearer = CredentialVault.load() else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await request(path: "v1/native/device", method: "DELETE", bearer: bearer)
            CredentialVault.clear()
            isConnected = false
            status = "This native device was disconnected. Website alerts are unchanged."
        } catch {
            status = "Could not verify disconnection. The saved native key was kept to prevent an orphaned registration."
        }
    }

    private struct PairResponse: Decodable {
        let deviceId: String
        let bearer: String
        let environment: String
        let connected: Bool
    }
    private struct StatusResponse: Decodable { let connected: Bool }
    private enum PairingError: Error { case request, service }
}

/// APNs credentials are separate from the original web push credentials.
private enum CredentialVault {
    private static let service = "com.jfaread.cryptowatch.sound.native"
    private static let account = "device-bearer"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
    static func load() -> String? {
        var q = query
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        q[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ bearer: String) throws {
        let pieces = bearer.split(separator: ".")
        guard pieces.count == 2, pieces[0].count == 36, pieces[1].count == 64 else {
            throw VaultError.invalid
        }
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = Data(bearer.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw VaultError.unavailable
        }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
    private enum VaultError: Error { case invalid, unavailable }
}

private final class RedirectDenyingDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
