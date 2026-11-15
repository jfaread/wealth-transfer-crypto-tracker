import SwiftUI
import UserNotifications

@MainActor
final class SoundCompanionModel: ObservableObject {
    @Published var status = "iPhone notifications have not been checked."
    @Published var authorised = false

    private let centre = UNUserNotificationCenter.current()

    func checkPermission() async {
        let settings = await centre.notificationSettings()
        let permission = settings.authorizationStatus
        authorised = permission == .authorized || permission == .provisional || permission == .ephemeral
        status = authorised
            ? "iPhone notification permission is available."
            : "Enable notification permission to test the built-in sound."
    }

    func requestPermission() async {
        do {
            let allowed = try await centre.requestAuthorization(options: [.alert, .badge, .sound])
            await checkPermission()
            if allowed {
                status = "Native notifications enabled. Remote APNs delivery is not connected."
            }
        } catch {
            status = "Notification permission could not be enabled on this device."
        }
    }

    func scheduleSoundTest() async {
        do {
            if !authorised {
                let allowed = try await centre.requestAuthorization(options: [.alert, .badge, .sound])
                if !allowed {
                    status = "Allow notifications first to test the sound."
                    return
                }
            }
            guard Bundle.main.url(forResource: "xrp-alert", withExtension: "wav") != nil else {
                status = "The bundled XRP sound is missing. The build must be corrected."
                return
            }
            let content = UNMutableNotificationContent()
            content.title = "XRP Alert"
            content.body = "Sound test only. No XRP threshold or market event has occurred."
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: "xrp-alert.wav"))
            content.threadIdentifier = "xrp-sound-test"
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
            let request = UNNotificationRequest(
                identifier: "cw-native-audio-test-" + UUID().uuidString,
                content: content,
                trigger: trigger
            )
            try await centre.add(request)
            authorised = true
            status = "A local sound test is scheduled in five seconds. Lock the iPhone now."
        } catch {
            status = "iOS could not schedule the local sound test."
        }
    }
}

struct ContentView: View {
    @StateObject private var model = SoundCompanionModel()
    @StateObject private var native = NativePairingModel()
    private let website = URL(string: "https://jfaread.github.io/wealth-transfer-crypto-tracker/")!

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label("XRP Alert", systemImage: "bell.badge.fill")
                        .font(.largeTitle.bold())
                    Text("Background sound companion").font(.headline)
                    Text("This native iPhone app bundles the original two-tone sound. iOS can play it on a native notification when the app is closed or the screen is locked.")
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Planned XRP thresholds", systemImage: "arrow.down.circle")
                            .font(.headline)
                        Text("$0.90  ·  $0.80  ·  $0.70")
                            .font(.title3.monospacedDigit().bold())
                        Text("These are not active native alerts until APNs is connected. Your existing web alerts are unchanged.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    Button("Enable iPhone notifications") {
                        Task {
                            await model.requestPermission()
                            if model.authorised { native.registerWithApple() }
                        }
                    }.buttonStyle(.borderedProminent)
                    Button("Test locked-screen sound") {
                        Task { await model.scheduleSoundTest() }
                    }.buttonStyle(.bordered)
                    Text(model.status).font(.callout)
                    Divider()
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Secure native pairing", systemImage: "iphone.gen3.radiowaves.left.and.right")
                            .font(.headline)
                        Text("Pair this iPhone with an existing connected Crypto-Watch web alert device. The website will issue a one-use code valid for five minutes. Pairing is disabled until the native backend is deployed.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        SecureField("Paste the one-time pairing code", text: $native.pairingCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.oneTimeCode)
                            .textFieldStyle(.roundedBorder)
                            .privacySensitive()
                        Button("Pair this iPhone") {
                            Task { await native.pair() }
                        }
                        .disabled(!native.hasAPNsToken || native.isBusy || native.pairingCode.isEmpty || native.isConnected)
                        .buttonStyle(.borderedProminent)
                        if native.isConnected {
                            Button("Disconnect native alerts") {
                                Task { await native.disconnect() }
                            }
                            .disabled(native.isBusy)
                            .buttonStyle(.bordered)
                        }
                        Text(native.status).font(.footnote)
                        Text("Your existing website alerts, thresholds and Web Push registration remain separate.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    Link("Open Crypto-Watch", destination: website).font(.headline)
                    Divider()
                    Text("Remote XRP notifications are not yet operational. The signed app, APNs credentials and secure registration backend must all be enabled before this companion can sound while closed. The local sound test does not mean a price notification was delivered.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding()
            }
            .navigationTitle("Crypto-Watch")
        }
        .task { await model.checkPermission() }
        .onReceive(NotificationCenter.default.publisher(for: .cryptoWatchAPNSTokenReceived)) { notification in
            if let token = notification.userInfo?["deviceToken"] as? Data {
                native.receivedToken(token)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .cryptoWatchAPNSTokenUnavailable)) { _ in
            native.tokenUnavailable()
        }
    }
}
