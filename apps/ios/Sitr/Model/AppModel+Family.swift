import Foundation
import SitrCore
import StoreKit

/// Sitr Family in the app (docs/sync-protocol.md §What each client must
/// do, iOS): subscribe with StoreKit 2, claim, create the household, show
/// the pairing code; renew on Transaction.updates, on foreground and in the
/// background refresh (SyncScheduler.syncNow); restore with AppStore.sync().
/// The app never sets appAccountToken.
extension AppModel {
    /// One purchase/claim/create at a time: the purchase result and
    /// Transaction.updates can deliver the same transaction.
    private func serial(_ op: @escaping @MainActor () async -> Void) async {
        let previous = familyChain
        let task = Task { @MainActor in
            await previous?.value
            await op()
        }
        familyChain = task
        await task.value
    }

    func listenForTransactions() {
        Task.detached { [weak self] in
            for await update in Transaction.updates {
                await self?.handle(update)
            }
        }
    }

    private func handle(_ update: VerificationResult<Transaction>) async {
        let transaction = update.unsafePayloadValue
        guard Entitlement.Products.all.contains(transaction.productID) else { return }
        await serial { [self] in
            await refreshFamily()
            guard settings.household != nil else {
                // Nothing to renew yet: an active purchase waits, unfinished,
                // for "Create household"; anything else is done with.
                if !subscribed { await transaction.finish() }
                return
            }
            await runSync()
            await refreshFamily()
            // Finished once the claim got a token or a final answer; a
            // claim that could not reach the service leaves it for later.
            if Family.loadState().backoff == nil { await transaction.finish() }
        }
    }

    func refreshFamily() async {
        if products.isEmpty {
            products = ((try? await Product.products(for: Entitlement.Products.all)) ?? [])
                .sorted { $0.price < $1.price }
        }
        subscribed = await Family.isSubscribed()
        let state = Family.loadState()
        let now = Family.nowMs
        let inHousehold = settings.household != nil
        familyNotice = inHousehold ? ClaimPlan.notice(state, now: now) : .none
        familyEnd = inHousehold ? state.entExp : nil
        familyStopped = state.stopped
        offersReplace = inHousehold && ClaimPlan.offersReplace(state, now: now)
        iCloudKeyFound = !inHousehold && Storage.loadRootSecret() != nil
        keychainInICloud = Storage.keychainInICloud
    }

    func subscribe(_ product: Product) async {
        familyMessage = nil
        let result: Product.PurchaseResult
        do {
            result = try await product.purchase()
        } catch {
            familyMessage = "The purchase did not go through: \(error.localizedDescription)"
            return
        }
        switch result {
        case .success(let verification):
            subscribed = true
            purchasedCredential = verification.jwsRepresentation
            if settings.household == nil {
                await createHousehold(credential: verification.jwsRepresentation)
            } else {
                // Subscribed again with a household: renew it (a lapsed one
                // claims with current: true and reopens).
                await retryFamilyClaim()
                if Family.loadState().backoff == nil { await finishUnfinished() }
            }
        case .pending:
            familyMessage = "The purchase is waiting for approval. The household is created once it goes through."
        case .userCancelled:
            break
        @unknown default:
            break
        }
    }

    /// Claim, then create the household on the sync server, then show the
    /// pairing code. The key is saved before the creating write and kept
    /// (Family.createPending) until a definite answer, so a retry after a
    /// lost answer finds the same household.
    func createHousehold(replace: Bool = false, credential: String? = nil) async {
        await serial { [self] in
            guard settings.household == nil else { return }
            familyBusy = true
            defer { familyBusy = false }
            familyMessage = nil
            let credential = credential ?? purchasedCredential
            Family.update { $0 = ClaimPlan.userRetry($0) }
            guard var outcome = await Family.claim(current: false, replace: replace, credential: credential) else {
                familyMessage = "No Sitr Family purchase was found on this Apple Account. Subscribe, or use Restore Purchases."
                return
            }
            for attempt in 0..<2 {
                switch outcome {
                case .refused(.boundToOtherDevice, _) where !replace:
                    askReplace = true
                    return
                case .refused(let reason, let retryAfter):
                    familyMessage = Family.text(reason, retryAfter: retryAfter)
                    await finishUnfinished()  // finally refused
                    return
                case .unavailable(let why):
                    familyMessage = "The subscription service could not be reached (\(why)). Try again in a moment."
                    return
                case .token(let token):
                    // One key per creation attempt, kept across retries: if a
                    // write created the household but its answer was lost,
                    // the retry finds that household (the token is single-use).
                    let secret: Data
                    if Family.createPending, let pending = Storage.loadRootSecret() {
                        secret = pending
                    } else if Storage.loadRootSecret() != nil {
                        // A key from iCloud Keychain: replacing it would take that
                        // household away from the user's other devices.
                        familyMessage =
                            "This device already holds a household key from iCloud Keychain. Join that household above, or turn off iCloud Keychain for the key first."
                        return
                    } else {
                        secret = SyncCrypto.generateRootSecret()
                        guard Storage.saveRootSecret(secret) else {
                            familyMessage = "The household key could not be stored on this device."
                            return
                        }
                        Family.createPending = true
                    }
                    guard let id = Family.householdId(secret) else { return }
                    let client = SyncClient(
                        transport: URLSessionTransport(), now: { Family.nowMs }, baseURL: Endpoints.sync)
                    let created = await client.syncOnce(
                        SyncInput(
                            rootSecret: secret,
                            local: Household.emptyState(deviceId: settings.deviceId, now: Family.nowMs),
                            maxSeenRev: 0, deviceId: settings.deviceId, entitlement: token.raw))
                    if created.status.state == .ok {
                        Family.createPending = false
                        Family.update { s in
                            s.tokens.removeAll { $0 == token }
                            s.appliedHousehold = id
                            s.testHousehold = token.test
                            s.entExp = created.entExp ?? s.entExp
                            s.lapsed = false
                            s.lapseClaimed = false
                        }
                        await mutate { next in
                            next.household = created.state
                            next.role = "guardian"
                            next.maxSeenRev = created.maxSeenRev
                            next.syncStatus = created.status
                        }
                        newPairingCode = PairingCode.encode(rootSecret: secret)
                        SyncScheduler.scheduleNext()
                        await finishUnfinished()
                        await refreshFamily()
                        return
                    }
                    guard created.refusal != nil else {
                        // Offline, a timeout, another error: the household may
                        // exist. Keep the key for the next attempt.
                        familyMessage =
                            "The household could not be created yet (\(created.status.error ?? "no answer")). Tap Create household to try again."
                        return
                    }
                    // A definite 402: no household was made with this key.
                    Storage.forgetRootSecret()
                    Family.createPending = false
                    // token-used / -expired / -invalid / -required: claim
                    // once more, then retry the creation once.
                    if attempt == 0, created.refusal?.retryCreateWithNewClaim == true,
                        let again = await Family.claim(current: false, credential: credential)
                    {
                        outcome = again
                        continue
                    }
                    familyMessage =
                        "The household could not be created: \(created.refusal?.message ?? created.status.error ?? "unknown error")."
                    return
                }
            }
        }
    }

    private func finishUnfinished() async {
        for await result in Transaction.unfinished {
            let transaction = result.unsafePayloadValue
            if Entitlement.Products.all.contains(transaction.productID) { await transaction.finish() }
        }
    }

    func restorePurchases() async {
        familyMessage = nil
        do {
            try await AppStore.sync()
        } catch {
            familyMessage = "Restore did not complete: \(error.localizedDescription)"
        }
        Family.update { $0 = ClaimPlan.userRetry($0) }
        await refreshFamily()
        if settings.household != nil {
            await runSync()
            await refreshFamily()
        } else if !subscribed {
            familyMessage = familyMessage ?? "No active Sitr Family subscription was found on this Apple Account."
        }
    }

    /// "Try again" after a refusal that waits for the user.
    func retryFamilyClaim() async {
        Family.update { $0 = ClaimPlan.userRetry($0) }
        await runSync()
        await refreshFamily()
    }

    /// Move the renewal to this device (replace: true). Asked first by the
    /// view: a rebind can be made only once in 180 days.
    func renewOnThisDevice() async {
        let lapsed = ClaimPlan.isLapsed(Family.loadState(), now: Family.nowMs)
        if case .refused(let reason, let retryAfter)? = await Family.claim(current: lapsed, replace: true) {
            familyMessage = Family.text(reason, retryAfter: retryAfter)
        }
        await runSync()
        await refreshFamily()
    }

    func setKeychainInICloud(_ on: Bool) async {
        Storage.setKeychainInICloud(on)
        await refreshFamily()
    }

    func joinFromICloudKey(asChild: Bool) async {
        guard let secret = Storage.loadRootSecret() else { return }
        await joinHousehold(secret: secret, asChild: asChild)
    }
}
