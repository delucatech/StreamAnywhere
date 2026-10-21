//
//  ServerAPI.swift
//  The few HTTP calls to the StreamAnywhere server: the site password (POST /login sets the sa_auth
//  cookie, kept in the App Group's cookie storage so the extension has it too), a room, the ICE servers.
//
import Foundation

struct IceServer: Codable {
    var urls: [String]
    var username: String?
    var credential: String?

    private enum CodingKeys: String, CodingKey { case urls, username, credential }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let one = try? c.decode(String.self, forKey: .urls) { urls = [one] } else { urls = try c.decode([String].self, forKey: .urls) }
        username = try c.decodeIfPresent(String.self, forKey: .username)
        credential = try c.decodeIfPresent(String.self, forKey: .credential)
    }
}

enum ServerAPIError: LocalizedError {
    case badURL
    case http(Int)
    case wrongPassword
    case noCookie

    var errorDescription: String? {
        switch self {
        case .badURL: return "The server address is not a valid URL."
        case .http(let code): return "The server answered \(code)."
        case .wrongPassword: return "Wrong password."
        case .noCookie: return "Signed in, but the server set no login cookie."
        }
    }
}

final class ServerAPI {
    let server: URL
    let session: URLSession

    init(server: URL) {
        self.server = server
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieStorage = MirrorSettings.cookieStorage
        cfg.httpCookieAcceptPolicy = .always
        cfg.timeoutIntervalForRequest = 15
        session = URLSession(configuration: cfg, delegate: NoRedirects(), delegateQueue: nil)
    }

    /// POST /login: a 303 with Set-Cookie means the password was right (a 401 page means it was not).
    func signIn(password: String) async throws {
        var req = URLRequest(url: server.appendingPathComponent("login"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var comps = URLComponents()
        comps.queryItems = [URLQueryItem(name: "password", value: password), URLQueryItem(name: "next", value: "/")]
        req.httpBody = (comps.percentEncodedQuery ?? "").data(using: .utf8)
        let (_, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ServerAPIError.http(0) }
        if http.statusCode == 401 { throw ServerAPIError.wrongPassword }
        guard (200..<400).contains(http.statusCode) else { throw ServerAPIError.http(http.statusCode) }
        // APP_PASSWORD_HASH=off: /login answers 303 without a cookie, and nothing needs one
        _ = MirrorSettings.cookieHeader(for: server)
    }

    /// Is the saved cookie still accepted? (/api/mirror/ice is cheap and needs the cookie)
    func signedIn() async -> Bool {
        var req = URLRequest(url: server.appendingPathComponent("api/mirror/ice"))
        req.httpMethod = "GET"
        guard let (_, resp) = try? await session.data(for: req), let http = resp as? HTTPURLResponse else { return false }
        return http.statusCode == 200
    }

    func createRoom() async throws -> String {
        var req = URLRequest(url: server.appendingPathComponent("api/mirror/rooms"))
        req.httpMethod = "POST"
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { throw ServerAPIError.http((resp as? HTTPURLResponse)?.statusCode ?? 0) }
        struct Room: Codable { var room: String }
        return try JSONDecoder().decode(Room.self, from: data).room
    }

    func iceServers() async -> [IceServer] {
        let req = URLRequest(url: server.appendingPathComponent("api/mirror/ice"))
        guard let (data, resp) = try? await session.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return [] }
        struct Answer: Codable { var iceServers: [IceServer] }
        return (try? JSONDecoder().decode(Answer.self, from: data).iceServers) ?? []
    }

    /// /login answers with a redirect; the status code (not the page it leads to) is the answer.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}
