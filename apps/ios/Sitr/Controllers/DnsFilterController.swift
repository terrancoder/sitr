import Foundation
import os
import SitrCore

#if SITR_DNS_FILTER
    import NetworkExtension
#endif

/// The opt-in DNS filter as Home and its screen show it. Derived from
/// facts iOS reports (the saved VPN configuration and its connection),
/// never from a log file, and never optimistic: anything Sitr turned on
/// that is not running is red, like the Safari blocker being off.
enum DnsFilterStatus: Equatable {
    /// Built without the DNS filter (SITR_DNS_FILTER = NO): nothing shown.
    case unavailable
    /// Not turned on in Sitr. Optional, so grey, never red.
    case off
    case starting
    case on
    /// On in Sitr, switched off in iOS Settings.
    case switchedOff
    /// On in Sitr, its VPN configuration deleted in iOS Settings.
    case removed
    /// On in Sitr, another VPN configuration selected (iOS allows one).
    case otherVPN
    /// Running, but it could not read this network's DNS server, so
    /// lookups that need one fail (closed) until the network changes.
    case noResolver
    /// Should be running and is not; the reason iOS or the filter gave.
    case stopped(String)

    /// Turned on in Sitr and not filtering.
    var isFailing: Bool {
        switch self {
        case .switchedOff, .removed, .otherVPN, .stopped: return true
        case .unavailable, .off, .starting, .on, .noResolver: return false
        }
    }

    /// Turned on in Sitr (running or not).
    var isWanted: Bool { self != .unavailable && self != .off }
}

/// Turns the DNS filter (SitrTunnel) on and off and reports its status.
/// Turning it on is free; turning it off is a loosening change, so every
/// caller goes through RootView.attempt(.disableCategory, …) first.
@MainActor
enum DnsFilterController {
    /// Whether the user turned the filter on in Sitr. Device-local, its
    /// own key (SettingsStore.persist rewrites the AppSettings keys).
    static var userEnabled: Bool {
        get { Storage.defaults.bool(forKey: "dnsFilterEnabled") }
        set { Storage.defaults.set(newValue, forKey: "dnsFilterEnabled") }
    }

    #if SITR_DNS_FILTER
        static let statusDidChange = Notification.Name.NEVPNStatusDidChange
        /// What iOS Settings → VPN shows for the configuration.
        static let configurationName = "Sitr DNS filter"
        static let serverLabel = "On this device"

        /// The ONE manager object Sitr keeps and observes. loadAllFromPreferences
        /// returns new objects every call, and each new connection object posts
        /// NEVPNStatusDidChange; refreshing on those notifications and loading
        /// again looped forever once the filter was connected (device run,
        /// 2026-11-18: main thread never idle, app killed). So the kept object
        /// is only re-read, and only its own status changes trigger a refresh
        /// (`isOurStatusChange`).
        private static var manager: NETunnelProviderManager?
        private static var lastStatus: NEVPNStatus?

        private static func load() async throws -> NETunnelProviderManager? {
            // Existence check (a configuration removed in iOS Settings is gone
            // from this list); the fresh objects are dropped, not observed.
            guard let first = try await NETunnelProviderManager.loadAllFromPreferences().first else {
                manager = nil
                return nil
            }
            if let kept = manager {
                try await kept.loadFromPreferences()
                return kept
            }
            manager = first
            return first
        }

        /// True only for a real status change of the kept connection.
        static func isOurStatusChange(_ note: Notification) -> Bool {
            guard let connection = note.object as? NEVPNConnection, connection === manager?.connection,
                connection.status != lastStatus
            else { return false }
            lastStatus = connection.status
            if connection.status == .connecting { resetStartingClock() }
            return true
        }
    #else
        static let statusDidChange = Notification.Name("SitrDnsFilterUnavailable")
        static func isOurStatusChange(_ note: Notification) -> Bool { false }
    #endif

    /// Starting is not proven on: longer than this, it counts as stopped.
    static let startingLimit: TimeInterval = 15
    private static var startingSince: Date?

    /// A fresh start (a real change into connecting) or a return to the
    /// foreground restarts the 15 s clock: an old start seen before going
    /// to the background must not make a new one look stuck.
    static func resetStartingClock() { startingSince = nil }

    static func status() async -> DnsFilterStatus {
        let s = await currentStatus()
        guard s == .starting else {
            startingSince = nil
            return s
        }
        let since = startingSince ?? Date()
        startingSince = since
        return Date().timeIntervalSince(since) > startingLimit
            ? .stopped("it has been starting for more than \(Int(startingLimit)) seconds") : .starting
    }

    private static func currentStatus() async -> DnsFilterStatus {
        #if SITR_DNS_FILTER
            #if DEBUG
                if let forced = debugOverride { return userEnabled ? forced : .off }
            #endif
            let m: NETunnelProviderManager?
            do {
                m = try await load()
            } catch {
                return userEnabled ? .stopped("iOS did not report the filter's state (\(error.localizedDescription))") : .off
            }
            let connection = m?.connection.status ?? .invalid
            lastStatus = m?.connection.status
            #if DEBUG
                refreshTimes = (refreshTimes + [Date()]).filter { $0.timeIntervalSinceNow > -10 }
            #endif
            // Running is on, whatever Sitr's switch last said (for example,
            // switched back on in iOS Settings).
            guard userEnabled || connection == .connected else { return .off }
            guard let m else { return .removed }
            guard m.isEnabled else { return .otherVPN }
            switch connection {
            case .connected: return await providerReportsNoResolver(m) ? .noResolver : .on
            case .connecting, .reasserting: return .starting
            default:
                guard m.isOnDemandEnabled else { return .switchedOff }
                // Fail-visible: on-demand should bring it straight back, so
                // a disconnected filter is red until iOS reports it again.
                return .stopped(await lastDisconnectError(m) ?? "iOS has not restarted it")
            }
        #else
            return .unavailable
        #endif
    }

    /// Saves the configuration (the first time, iOS asks permission) with
    /// on-demand Connect, so it comes back after a reboot and after iOS
    /// stops it, and starts it. Returns an error message, or nil.
    /// Callers show the disclosure first when no configuration exists.
    static func turnOn() async -> String? {
        #if SITR_DNS_FILTER
            #if DEBUG
                if debugOverride != nil {
                    userEnabled = true
                    return nil
                }
            #endif
            do {
                let m = try await load() ?? NETunnelProviderManager()
                let proto = NETunnelProviderProtocol()
                proto.providerBundleIdentifier = "com.sitrshield.sitr.tunnel"
                proto.serverAddress = serverLabel
                m.protocolConfiguration = proto
                m.localizedDescription = configurationName
                m.isEnabled = true
                m.onDemandRules = [NEOnDemandRuleConnect()]  // any network
                m.isOnDemandEnabled = true
                try await m.saveToPreferences()
                // Only once iOS accepted it: a refused permission leaves it off.
                userEnabled = true
                try await m.loadFromPreferences()  // required before starting a fresh configuration
                manager = m
                try m.connection.startVPNTunnel()
                return nil
            } catch {
                return "The DNS filter could not be turned on: \(error.localizedDescription)"
            }
        #else
            return nil
        #endif
    }

    /// On-demand off FIRST (saved), then stop: otherwise iOS restarts it.
    /// The configuration stays, so turning it on again asks nothing.
    static func turnOff() async -> String? {
        #if SITR_DNS_FILTER
            #if DEBUG
                if debugOverride != nil {
                    userEnabled = false
                    return nil
                }
            #endif
            do {
                guard let m = try await load() else {
                    userEnabled = false
                    return nil
                }
                m.isOnDemandEnabled = false
                try await m.saveToPreferences()
                userEnabled = false
                m.connection.stopVPNTunnel()
                return nil
            } catch {
                return "The DNS filter could not be turned off: \(error.localizedDescription)"
            }
        #else
            return nil
        #endif
    }

    /// True when turning on will make iOS ask permission (no saved
    /// configuration): the disclosure must come first.
    static func needsPermission() async -> Bool {
        #if SITR_DNS_FILTER
            #if DEBUG
                if debugOverride != nil { return true }
            #endif
            return ((try? await load()) ?? nil) == nil
        #else
            return false
        #endif
    }

    #if SITR_DNS_FILTER
        /// Asks the running filter (one-byte provider message, no file):
        /// true when it could not read this network's DNS server. No reply
        /// within 2 s counts as false; the connection status still applies.
        private static func providerReportsNoResolver(_ m: NETunnelProviderManager) async -> Bool {
            guard let session = m.connection as? NETunnelProviderSession else { return false }
            let pending = OSAllocatedUnfairLock<CheckedContinuation<Bool, Never>?>(initialState: nil)
            func finish(_ value: Bool) {
                pending.withLock { c in
                    c?.resume(returning: value)
                    c = nil
                }
            }
            return await withCheckedContinuation { continuation in
                pending.withLock { $0 = continuation }
                do {
                    try session.sendProviderMessage(Data([1])) { reply in finish(reply?.first == 1) }
                } catch {
                    finish(false)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish(false) }
            }
        }

        private static func lastDisconnectError(_ m: NETunnelProviderManager) async -> String? {
            await withCheckedContinuation { continuation in
                m.connection.fetchLastDisconnectError { error in
                    continuation.resume(returning: error?.localizedDescription)
                }
            }
        }
    #endif

    #if SITR_DNS_FILTER && DEBUG
        /// Status reads in the last 10 s (Diagnostics screen): a refresh loop
        /// shows here as a large number.
        static var refreshTimes: [Date] = []

        /// Simulator testing of every state (the tunnel cannot run there):
        /// launch with `-SitrDebugDnsFilterState on|starting|switchedOff|
        /// removed|otherVPN|noResolver|stopped`. Turning on/off then only flips the
        /// switch. Debug builds only.
        static var debugOverride: DnsFilterStatus? {
            switch UserDefaults.standard.string(forKey: "SitrDebugDnsFilterState") {
            case "on": return .on
            case "starting": return .starting
            case "switchedOff": return .switchedOff
            case "removed": return .removed
            case "otherVPN": return .otherVPN
            case "noResolver": return .noResolver
            case "stopped": return .stopped("iOS did not restore the filter's DNS settings after a network change.")
            default: return nil
            }
        }
    #endif
}
