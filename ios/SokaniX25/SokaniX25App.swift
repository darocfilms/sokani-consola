import SwiftUI

@main
struct SokaniX25App: App {
    var body: some Scene {
        WindowGroup {
            ConsoleView()
                .ignoresSafeArea(.keyboard)
                .preferredColorScheme(.dark)
                .statusBarHidden(false)
        }
    }
}
