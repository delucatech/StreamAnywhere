//
//  ContentView.swift
//  One screen: the server sign-in, the room code the Tesla types, the start button, what is going on.
//
import SwiftUI
import ReplayKit

struct ContentView: View {
    @State private var settings = MirrorSettings.load()
    @State private var password = ""
    @State private var signInMessage = ""
    @State private var busy = false
    @State private var status: MirrorStatus? = MirrorStatus.read()
    @State private var addresses: [String] = LocalServer.localIPv4Addresses()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationView {
            Form {
                roomSection
                startSection
                statusSection
                serverSection
                qualitySection
            }
            .navigationTitle("Mirror")
        }
        .navigationViewStyle(.stack)
        .onReceive(timer) { _ in
            status = MirrorStatus.read()
            addresses = LocalServer.localIPv4Addresses()
        }
        .onChange(of: settings) { s in s.save() }
        .task { await ensureRoom() }
    }

    // MARK: - sections

    private var roomSection: some View {
        Section(header: Text("On the Tesla")) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Open StreamAnywhere → Mirror and type this code:")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Text(settings.room.isEmpty ? "······" : settings.room)
                    .font(.system(size: 44, weight: .bold, design: .monospaced))
                    .kerning(6)
                if let url = viewerURL {
                    HStack(alignment: .top, spacing: 12) {
                        QRCodeView(text: url.absoluteString)
                            .frame(width: 96, height: 96)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Or scan / open:").font(.caption).foregroundColor(.secondary)
                            Text(url.absoluteString).font(.caption).textSelection(.enabled)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
            Button("New code") { Task { await newRoom() } }
                .disabled(busy)
            if !addresses.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Tesla on this phone's hotspot (or the same Wi-Fi)? Open instead:")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    ForEach(addresses, id: \.self) { a in
                        Text("http://\(a):\(MirrorProtocol.localPagePort)/")
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                    }
                    Text("No internet needed; the picture never leaves the hotspot.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.vertical, 4)
            }
        }
    }

    private var startSection: some View {
        Section {
            BroadcastPickerButton(title: live ? "Mirroring – tap to stop" : "Start mirroring")
                .frame(height: 52)
            Text(live ? "The red indicator at the top of the screen means the screen is being mirrored. Tap it (or come back here) to stop." : "iOS asks which app receives the broadcast: choose Mirror and tap Start Broadcast. Then open the app you want on the Tesla.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var statusSection: some View {
        Section(header: Text("Status")) {
            if let s = status, s.state != "idle", Date().timeIntervalSince(s.updatedAt) < 5 || s.state == "stopped" || s.state == "error" {
                LabeledContent("State", value: s.state)
                if s.width > 0 { LabeledContent("Picture", value: "\(s.width)×\(s.height)\(s.rotation != 0 ? ", turned \(s.rotation)°" : "")") }
                LabeledContent("Sending", value: s.kbps >= 1000 ? String(format: "%.1f Mb/s", Double(s.kbps) / 1000) : "\(s.kbps) kb/s")
                LabeledContent("Server relay", value: s.relay)
                LabeledContent("Watching", value: "\(s.watchers) via server · \(s.directLinks) direct · \(s.localClients) local")
                if !s.message.isEmpty { Text(s.message).font(.caption).foregroundColor(.secondary) }
            } else {
                Text("Not mirroring.").foregroundColor(.secondary)
            }
        }
    }

    private var serverSection: some View {
        Section(header: Text("Server"), footer: Text("The StreamAnywhere server relays the picture when the car and the phone cannot reach each other directly, and introduces them for the direct link. Sign in with the site password once.")) {
            Toggle("Use the server", isOn: $settings.useServer)
            if settings.useServer {
                TextField("https://teslavplayer.duckdns.org", text: $settings.serverURL)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                SecureField("Site password", text: $password)
                Button(busy ? "Signing in…" : (settings.signedIn ? "Signed in – sign in again" : "Sign in")) { Task { await signIn() } }
                    .disabled(busy || settings.server == nil)
                if !signInMessage.isEmpty { Text(signInMessage).font(.caption).foregroundColor(.secondary) }
                Toggle("Try the direct link (WebRTC)", isOn: $settings.useDirectLink)
            }
            TextField("This phone's name", text: $settings.deviceName)
        }
    }

    private var qualitySection: some View {
        Section(header: Text("Quality"), footer: Text("Saver suits the car's own LTE through the relay; Sharp suits the hotspot. Sound is the app's sound; the microphone adds yours.")) {
            Picker("Picture", selection: $settings.quality) {
                ForEach(MirrorQuality.allCases) { q in Text(q.label).tag(q) }
            }
            Picker("Frame rate", selection: $settings.fps) {
                Text("15").tag(15)
                Text("24").tag(24)
                Text("30").tag(30)
                Text("60").tag(60)
            }
            Toggle("Sound", isOn: $settings.audio)
            Toggle("Microphone", isOn: $settings.microphone)
        }
    }

    // MARK: - state

    private var live: Bool {
        guard let s = status else { return false }
        return s.state == "live" && Date().timeIntervalSince(s.updatedAt) < 5
    }

    private var viewerURL: URL? {
        guard settings.useServer, let server = settings.server, !settings.room.isEmpty else { return nil }
        var comps = URLComponents(url: server.appendingPathComponent("mirror.html"), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "room", value: settings.room)]
        return comps?.url
    }

    private func ensureRoom() async {
        if settings.room.isEmpty || !RoomCode.isValid(settings.room) { await newRoom() }
    }

    /// A code from the server when signed in (unique there), a local one otherwise (the relay makes the room when the phone connects).
    private func newRoom() async {
        busy = true
        defer { busy = false }
        if settings.useServer, let server = settings.server, let code = try? await ServerAPI(server: server).createRoom() {
            settings.room = code
        } else {
            settings.room = RoomCode.random()
        }
        settings.roomCreatedAt = Date()
        settings.save()
    }

    private func signIn() async {
        guard let server = settings.server else { return }
        busy = true
        signInMessage = ""
        defer { busy = false }
        let api = ServerAPI(server: server)
        do {
            try await api.signIn(password: password)
            settings.signedIn = await api.signedIn()
            signInMessage = settings.signedIn ? "Signed in." : "The server took the password but the cookie did not work; check the address."
            password = ""
            settings.save()
            await newRoom()
        } catch {
            settings.signedIn = false
            signInMessage = error.localizedDescription
        }
    }
}

/// RPSystemBroadcastPickerView: the system's own "start broadcast" button, pointed at our extension.
struct BroadcastPickerButton: UIViewRepresentable {
    let title: String

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: .zero)
        picker.preferredExtension = MirrorSettings.broadcastExtensionBundleId
        picker.showsMicrophoneButton = false
        picker.backgroundColor = UIColor.systemBlue
        picker.layer.cornerRadius = 12
        style(picker)
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {
        style(uiView)
    }

    private func style(_ picker: RPSystemBroadcastPickerView) {
        for case let button as UIButton in picker.subviews {
            button.setImage(nil, for: .normal)
            button.setTitle(title, for: .normal)
            button.setTitleColor(.white, for: .normal)
            button.titleLabel?.font = .boldSystemFont(ofSize: 18)
            button.frame = picker.bounds
            button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        }
    }
}

/// The viewer link as a QR code (a laptop's camera, a phone: anything but the car's keyboard).
struct QRCodeView: View {
    let text: String
    var body: some View {
        if let img = Self.image(for: text) {
            Image(uiImage: img)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        } else {
            Color.gray
        }
    }
    static func image(for text: String) -> UIImage? {
        let filter = CIFilter(name: "CIQRCodeGenerator")
        filter?.setValue(Data(text.utf8), forKey: "inputMessage")
        filter?.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = filter?.outputImage else { return nil }
        let scaled = out.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
