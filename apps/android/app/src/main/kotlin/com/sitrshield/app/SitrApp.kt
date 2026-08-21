package com.sitrshield.app

import android.app.Application
import com.sitrshield.app.data.Repository
import com.sitrshield.app.data.SecretStore
import com.sitrshield.app.data.Settings
import com.sitrshield.app.managed.ManagedConfig
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.domainset.DomainSet
import com.sitrshield.core.rules.DecisionSnapshot
import com.sitrshield.engine.EngineController
import org.json.JSONObject

/**
 * Application: loads the committed blocklist artifacts (checksum-verified
 * — a failure is surfaced red and the engine refuses to start), builds
 * the decision snapshot, and is the single mutation path enforcing
 * "engine first, persist after".
 */
class SitrApp : Application() {
    lateinit var repository: Repository
        private set
    lateinit var secretStore: SecretStore
        private set

    private var categorySets: Map<String, DomainSet> = emptyMap()
    private var safeSearchMap: SafeSearchMap = SafeSearchMap(emptyList())

    override fun onCreate() {
        super.onCreate()
        repository = Repository(this)
        secretStore = SecretStore(this)
        loadArtifacts()
        rebuildEngine(repository.current())
        if (secretStore.load() != null) SyncWorker.schedulePeriodic(this)
    }

    /**
     * Load + checksum-verify the compiler artifacts bundled as assets.
     * Any failure leaves blocklistVerified=false: the service refuses to
     * start and the UI shows red — never "start anyway".
     */
    private fun loadArtifacts() {
        try {
            val checksums = JSONObject(
                assets.open("checksums.json").readBytes().decodeToString()
            )
            val sets = mutableMapOf<String, DomainSet>()
            for (category in listOf("adult", "dating", "gambling")) {
                val name = "$category.domains"
                val artifact = assets.open(name).readBytes()
                val set = DomainSet.load(artifact, checksums.getString(name)).getOrNull()
                    ?: throw IllegalStateException("$name failed verification")
                sets[category] = set
            }
            val map = SafeSearchMap.parse(
                assets.open("safesearch-hosts.json").readBytes().decodeToString()
            ).getOrNull() ?: throw IllegalStateException("safesearch map failed to parse")

            categorySets = sets
            safeSearchMap = map
            EngineController.updateFacts { it.copy(blocklistVerified = true) }
        } catch (_: Exception) {
            EngineController.updateFacts { it.copy(blocklistVerified = false) }
        }
    }

    /**
     * THE mutation path. Installs the snapshot for `next` into the engine
     * (atomic swap), THEN persists — settings never claim a state the
     * engine doesn't have. `kickSync` is set by UI mutations that change
     * household state; the sync worker itself passes false.
     */
    fun applySettings(next: Settings, kickSync: Boolean = false) {
        rebuildEngine(next)
        repository.persist(next)
        if (kickSync && secretStore.load() != null) {
            SyncWorker.schedulePeriodic(this)
            SyncWorker.kick(this)
        }
    }

    fun managedPolicy() = ManagedConfig.read(this)

    private fun rebuildEngine(settings: Settings) {
        val managed = ManagedConfig.read(this)
        // Household config wins over device-level toggles when joined;
        // managed forcedCategories override both. Adult + SafeSearch are
        // always on and not representable as "disabled".
        val disabled = (settings.household?.disabledCategories
            ?: settings.disabledCategories)
            .filter { it !in managed.forcedCategories }
        val enabledCategoryFiles = buildList {
            add("adult")
            if ("sitr_gambling" !in disabled) add("gambling")
            if ("sitr_dating" !in disabled) add("dating")
        }
        val staticBlock = buildSet {
            for (file in enabledCategoryFiles) {
                categorySets[file]?.let { addAll(it.domains) }
            }
        }
        EngineController.apply(
            DecisionSnapshot(
                managedAllow = managed.allowDomains.toSet(),
                managedBlock = managed.blockDomains.toSet(),
                householdAllow = settings.household?.allowDomains?.toSet() ?: emptySet(),
                householdBlock = settings.household?.blockDomains?.toSet() ?: emptySet(),
                userAllow = settings.userAllow.toSet(),
                userBlock = settings.userBlock.toSet(),
                staticBlock = staticBlock,
            ),
            safeSearchMap,
        )
    }
}
