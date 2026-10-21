//
//  MirrorApp.swift
//  The container app: settings, the room code, the start button. The mirroring itself happens in
//  the broadcast extension (MirrorBroadcast), which keeps running when this app is in the background.
//
import SwiftUI

@main
struct MirrorApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
