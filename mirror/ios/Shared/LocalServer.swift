//
//  LocalServer.swift
//  The "local direct" way: the phone serves the viewer page itself (plain HTTP on 8420, one
//  bundled file) and streams the frames over a WebSocket on 8421, for a Tesla on the phone's
//  hotspot (http://172.20.10.1:8420/) or any device on the same Wi-Fi. Network.framework does the
//  WebSocket handshake and framing; the HTTP side is one static answer.
//
import Foundation
import Network

final class LocalServer {
    private var pageListener: NWListener?
    private var socketListener: NWListener?
    private let queue: DispatchQueue
    private var clients: [ObjectIdentifier: Client] = [:]
    private let page: Data
    private(set) var running = false

    var onClientJoined: (() -> Void)?
    var onClientsChanged: ((Int) -> Void)?
    var onNeedKey: (() -> Void)?
    var onLog: ((String) -> Void)?
    var clientCount: Int { clients.count }

    private final class Client {
        let connection: NWConnection
        var pendingBytes = 0
        var skipping = true
        init(_ c: NWConnection) { connection = c }
    }

    private let highWater = 3 * 1024 * 1024
    private let lowWater = 256 * 1024

    init(queue: DispatchQueue) {
        self.queue = queue
        if let url = Bundle.main.url(forResource: "viewer", withExtension: "html"), let d = try? Data(contentsOf: url) {
            page = d
        } else {
            page = Data("<!doctype html><title>Mirror</title><p>viewer.html is missing from the app bundle (run npm run build:mirror-local -w client).".utf8)
        }
    }

    func start() {
        guard !running else { return }
        running = true
        startPage()
        startSocket()
    }

    private func startPage() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: MirrorProtocol.localPagePort)!)
            l.newConnectionHandler = { [weak self] c in self?.servePage(c) }
            l.stateUpdateHandler = { [weak self] st in
                if case .failed(let e) = st { self?.onLog?("page listener failed: \(e)") }
            }
            l.start(queue: queue)
            pageListener = l
        } catch {
            onLog?("page listener: \(error)")
        }
    }

    /// Any GET gets the viewer page (a browser also asks for /favicon.ico and the like: same answer is harmless).
    private func servePage(_ c: NWConnection) {
        c.start(queue: queue)
        c.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self else { return }
            let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let notFound = request.hasPrefix("GET /favicon")
            let head = notFound
                ? "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                : "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: \(self.page.count)\r\nConnection: close\r\n\r\n"
            var body = Data(head.utf8)
            if !notFound && !request.hasPrefix("HEAD ") { body.append(self.page) }
            c.send(content: body, completion: .contentProcessed { _ in c.cancel() })
        }
    }

    private func startSocket() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let ws = NWProtocolWebSocket.Options()
            ws.autoReplyPing = true
            ws.maximumMessageSize = 1024 * 1024
            params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
            let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: MirrorProtocol.localSocketPort)!)
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.stateUpdateHandler = { [weak self] st in
                if case .failed(let e) = st { self?.onLog?("socket listener failed: \(e)") }
            }
            l.start(queue: queue)
            socketListener = l
        } catch {
            onLog?("socket listener: \(error)")
        }
    }

    private func accept(_ c: NWConnection) {
        let client = Client(c)
        let id = ObjectIdentifier(client)
        c.stateUpdateHandler = { [weak self, weak client] st in
            guard let self else { return }
            switch st {
            case .ready:
                guard let client else { return }
                self.clients[id] = client
                self.send(text: MirrorControl.hello(name: self.name), to: client)
                self.onClientsChanged?(self.clients.count)
                self.onClientJoined?()
                self.readLoop(client)
            case .failed, .cancelled:
                if self.clients.removeValue(forKey: id) != nil { self.onClientsChanged?(self.clients.count) }
            default:
                break
            }
        }
        c.start(queue: queue)
    }

    var name = "iPhone"

    private func readLoop(_ client: Client) {
        client.connection.receiveMessage { [weak self, weak client] data, context, _, error in
            guard let self, let client else { return }
            if error != nil { client.connection.cancel(); return }
            if let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                switch meta.opcode {
                case .close:
                    client.connection.cancel()
                    return
                case .text:
                    if let d = data, let s = String(data: d, encoding: .utf8), let msg = MirrorControl.decode(s) {
                        if msg["t"] as? String == "ping" { self.send(text: MirrorControl.encode(["t": "pong"]), to: client) }
                        if msg["t"] as? String == "need-key" { client.skipping = true; self.onNeedKey?() }
                    }
                default:
                    break
                }
            }
            self.readLoop(client)
        }
    }

    private func send(text: String, to client: Client) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
        client.connection.send(content: Data(text.utf8), contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
    }

    private func send(binary: Data, to client: Client) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
        let ctx = NWConnection.ContentContext(identifier: "bin", metadata: [meta])
        client.pendingBytes += binary.count
        client.connection.send(content: binary, contentContext: ctx, isComplete: true, completion: .contentProcessed { [weak self, weak client] _ in
            self?.queue.async { client?.pendingBytes -= binary.count }
        })
    }

    func broadcast(config: Data) {
        for c in clients.values { send(binary: config, to: c) }
    }

    func broadcast(frame: Data, isVideo: Bool, key: Bool) {
        var wantKey = false
        for c in clients.values {
            if c.skipping {
                if isVideo && key && c.pendingBytes < lowWater { c.skipping = false } else { wantKey = true; continue }
            } else if c.pendingBytes > highWater {
                c.skipping = true
                wantKey = true
                continue
            }
            send(binary: frame, to: c)
        }
        if wantKey { onNeedKey?() }
    }

    func stop() {
        running = false
        for c in clients.values { c.connection.cancel() }
        clients.removeAll()
        pageListener?.cancel()
        socketListener?.cancel()
        pageListener = nil
        socketListener = nil
    }

    /// The phone's IPv4 addresses (the hotspot's 172.20.10.1 among them), for the app to show.
    static func localIPv4Addresses() -> [String] {
        var out: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return out }
        defer { freeifaddrs(ifaddr) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = p {
            let flags = Int32(cur.pointee.ifa_flags)
            if let addr = cur.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET), (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    let s = String(cString: host)
                    if !s.hasPrefix("169.254") { out.append(s) }
                }
            }
            p = cur.pointee.ifa_next
        }
        // the hotspot address first
        return out.sorted { a, _ in a.hasPrefix("172.20.10.") }
    }
}
