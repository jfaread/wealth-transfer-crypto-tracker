import SwiftUI
import UserNotifications

@main
struct CryptoWatchSoundCompanionApp: App {
    @UIApplicationDelegateAdaptor(AlertAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

// The iOS notification system owns the sound, even when the app is closed.
final class AlertAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // No token is logged or uploaded. Secure registration is not deployed.
        NotificationCenter.default.post(name: .cryptoWatchAPNSTokenReceived, object: nil)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .cryptoWatchAPNSTokenUnavailable, object: nil)
    }
}

extension Notification.Name {
    static let cryptoWatchAPNSTokenReceived = Notification.Name("cw.apnsTokenReceived")
    static let cryptoWatchAPNSTokenUnavailable = Notification.Name("cw.apnsTokenUnavailable")
}
