//
//  RelayClient.swift
//  The sender's WebSocket to the StreamAnywhere server (/api/mirror/ws?role=sender): frames out,
//  control messages in (keyframe requests, watcher arrivals, the direct link's signalling).
//
import Foundation

final class RelayClient: NSObject, URLSessionWebSocketDelegate {
    enum State: String { case off, connecting, open, closed }

    private let url: URL
    private let cookie: String?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 1
    private var closed = false
    private var pingTimer: DispatchSourceTimer?
    private let queue: DispatchQueue
    /// Bytes handed to the socket and not yet written: the link's backlog (a slow server-side uplink)
    private(set) var pendingBytes = 0
    private var skipping = false
    private(set) var state: State = .off { didSet { if state != oldValue { onState?(state) } } }
    private(set) var bytesSent = 0

    var onState: ((State) -> Void)?
    var onControl: (([String: Any]) -> Void)?
    /// A keyframe is wanted (the backlog was dropped)
    var onNeedKey: (() -> Void)?

    /// The link skips frames (until the next keyframe) once its backlog passes this
    private let highWater = 2 * 1024 * 1024
    private let lowWater = 256 * 1024

    init(server: URL, room: String, name: String, cookie: String?, queue: DispatchQueue) {
        var comps = URLComponents(url: server.appendingPathComponent("api/mirror/ws"), resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.queryItems = [URLQueryItem(name: "room", value: room), URLQueryItem(name: "role", value: "sender"), URLQueryItem(name: "name", value: name)]
        url = comps.url!
        self.cookie = cookie
        self.queue = queue
        super.init()
    }

    func connect() {
        guard !closed else { return }
        state = .connecting
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForRequest = 20
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        session = s
        var req = URLRequest(url: url)
        if let cookie { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let t = s.webSocketTask(with: req)
        t.maximumMessageSize = 8 * 1024 * 1024
        task = t
        t.resume()
        receive(on: t)
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                switch result {
                case .success(let message):
                    if case .string(let text) = message, let dict = MirrorControl.decode(text) { self.onControl?(dict) }
                    self.receive(on: t)
                case .failure:
                    self.dropped(t)
                }
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        queue.async {
            guard webSocketTask === self.task else { return }
            self.state = .open
            self.reconnectDelay = 1
            self.pendingBytes = 0
            self.skipping = false
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 15, repeating: 15)
            timer.setEventHandler { [weak self] in self?.task?.sendPing { _ in } }
            timer.resume()
            self.pingTimer = timer
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        queue.async { self.dropped(webSocketTask) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let t = task as? URLSessionWebSocketTask { queue.async { self.dropped(t) } }
    }

    private func dropped(_ t: URLSessionWebSocketTask) {
        guard t === task else { return }
        pingTimer?.cancel()
        pingTimer = nil
        task = nil
        session?.invalidateAndCancel()
        session = nil
        state = .closed
        guard !closed else { return }
        let delay = reconnectDelay
        reconnectDelay = min(10, reconnectDelay * 2)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }

    func send(control dict: [String: Any]) {
        guard let t = task, state == .open else { return }
        t.send(.string(MirrorControl.encode(dict))) { _ in }
    }

    /// The decoder configuration goes through no matter the backlog.
    func send(config: Data) {
        guard let t = task, state == .open else { return }
        pendingBytes += config.count
        t.send(.data(config)) { [weak self] _ in self?.queue.async { self?.pendingBytes -= config.count } }
    }

    /// A frame; skipped while the backlog is too big (until a keyframe, which is requested).
    func send(frame: Data, isVideo: Bool, key: Bool) {
        guard let t = task, state == .open else { return }
        if skipping {
            if isVideo && key && pendingBytes < lowWater { skipping = false } else { return }
        } else if pendingBytes > highWater {
            skipping = true
            onNeedKey?()
            return
        }
        pendingBytes += frame.count
        bytesSent += frame.count
        t.send(.data(frame)) { [weak self] _ in self?.queue.async { self?.pendingBytes -= frame.count } }
    }

    func close() {
        closed = true
        pingTimer?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        state = .off
    }
}
