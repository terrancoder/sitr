package com.sitrshield.app

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import com.sitrshield.app.data.Repository
import com.sitrshield.app.data.SecretStore
import com.sitrshield.app.data.Settings
import com.sitrshield.app.managed.ManagedConfig
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.dns.StrictSearchHosts
import com.sitrshield.core.domainset.DomainSet
import com.sitrshield.core.rules.DecisionSnapshot
import com.sitrshield.engine.EngineController
import org.json.JSONObject

/**
 * Application: loads the committed blocklist artifacts (checksum-verified
 * — a failure is surfaced red and the engine refuses to start), builds
 * the decision snapshot, and is the single mutation path (update)
 * enforcing "engine first, persist after".
 */
class SitrApp : Application() {
    lateinit var repository: Repository
        private set
    lateinit var secretStore: SecretStore
        private set

    private var categorySets: Map<String, DomainSet> = emptyMap()
    private var safeSearchMap: SafeSearchMap = SafeSearchMap(emptyList())
    var strictSearchHosts: StrictSearchHosts = StrictSearchHosts.EMPTY
        private set

    override fun onCreate() {
        super.onCreate()
        repository = Repository(this)
        secretStore = SecretStore(this)
        loadArtifacts()
        rebuildEngine(repository.current())
        if (secretStore.load() != null) SyncWorker.schedulePeriodic(this)

        // Managed configuration can change while the filter runs; without
        // this the engine kept the old policy until some unrelated setting
        // changed or the process restarted. (The broadcast only reaches
        // receivers registered at run time.)
        ContextCompat.registerReceiver(
            this,
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    update { it }
                }
            },
            IntentFilter(Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
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

            // Strict Search is optional; a missing or bad artifact must
            // not stop the filter from starting — the toggle just stays
            // unavailable, which the UI reflects.
            strictSearchHosts = StrictSearchHosts.parse(
                assets.open("strict-search-hosts.json").readBytes().decodeToString()
            ).getOrNull() ?: StrictSearchHosts.EMPTY

            categorySets = sets
            safeSearchMap = map
            EngineController.updateFacts { it.copy(blocklistVerified = true) }
        } catch (_: Exception) {
            EngineController.updateFacts { it.copy(blocklistVerified = false) }
        }
    }

    private val settingsLock = Any()

    /**
     * THE mutation path. `transform` runs against the CURRENT settings
     * under a lock; the result is installed into the engine (atomic swap)
     * and THEN persisted — settings never claim a state the engine doesn't
     * have. Every writer goes through here (UI thread, sync worker,
     * restrictions receiver), so one read-modify-write can no longer
     * interleave with another and silently undo it. `kickSync` is set by
     * UI mutations that change household state; the sync worker itself
     * passes false.
     */
    fun update(kickSync: Boolean = false, transform: (Settings) -> Settings): Settings {
        val next = synchronized(settingsLock) {
            transform(repository.current()).also {
                rebuildEngine(it)
                repository.persist(it)
            }
        }
        if (kickSync && secretStore.load() != null) {
            SyncWorker.schedulePeriodic(this)
            SyncWorker.kick(this)
        }
        return next
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
            // Strict Search folds into the same static layer, so a user
            // allow rule can still override it like any other block.
            if (settings.strictSearch) addAll(strictSearchHosts.hosts)
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
