import SwiftUI

@main
struct SitrApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Background refresh: best-effort sync; state converges on app
        // open (honest copy lives in HouseholdView).
        SyncScheduler.register {
            await SyncScheduler.syncAndApply()
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onChange(of: scenePhase) { phase in
                    guard phase == .active else { return }
                    Task {
                        await model.refreshStatus()
                        await model.runSync()
                    }
                }
        }
    }
}
