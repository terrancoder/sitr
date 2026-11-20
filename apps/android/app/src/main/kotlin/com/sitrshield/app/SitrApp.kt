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
import android.os.SystemClock
import com.sitrshield.core.categories.OptionalLists
import com.sitrshield.core.gate.DelayClockReading
import com.sitrshield.core.gate.Pause
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
    /** For the UI; EMPTY when the artifact failed verification. */
    var strictSearchHosts: StrictSearchHosts = StrictSearchHosts.EMPTY
        private set
    private var strictSearchSet: DomainSet? = null
    /** Media hosts per site key (MEDIA_SITES); a site whose list failed is absent. */
    var mediaHosts: Map<String, DomainSet> = emptyMap()
        private set
    /** Opt-in lists by OptionalLists id; a list that failed is absent. */
    var optionalSets: Map<String, DomainSet> = emptyMap()
        private set

    companion object {
        /** The "images and video off" sites, in display order: key to label. */
        val MEDIA_SITES = listOf(
            "x" to "X", "reddit" to "Reddit", "tumblr" to "Tumblr",
            "pinterest" to "Pinterest", "imgur" to "Imgur",
        )
    }

    override fun onCreate() {
        super.onCreate()
        repository = Repository(this)
        secretStore = SecretStore(this)
        // ponytail: synchronous on the main thread, so a boot, always-on or
        // update start never sees an engine without its lists. Measured on
        // the API 35 emulator (debug build, busy host): ~60 ms median cold
        // start for 150,000 lines, worst seen ~215 ms. Past ~100 ms, load on a
        // background thread and have SitrVpnService wait on it before its
        // blocklistVerified check (always-on bypasses BootReceiver).
        loadArtifacts()
        rebuildEngine(repository.current())
        // Prune the pause allowance at every process start (boot included),
        // so after a reboot a remembered pause counts for an hour from boot,
        // not from whenever the pause sheet is next opened.
        repository.pauseRecords = Pause.live(
            repository.pauseRecords,
            DelayClockReading(SystemClock.elapsedRealtime(), System.currentTimeMillis()),
        )
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
            // Every list that feeds blocking is checked against
            // checksums.json; a missing entry is a failure, never a skip.
            fun verified(name: String): ByteArray {
                val bytes = assets.open(name).readBytes()
                check(DomainSet.sha256Hex(bytes) == checksums.getString(name).lowercase()) {
                    "$name failed checksum verification"
                }
                return bytes
            }
            fun domainSet(name: String): DomainSet =
                DomainSet.load(assets.open(name).readBytes(), checksums.getString(name)).getOrNull()
                    ?: throw IllegalStateException("$name failed verification")

            val sets = listOf("adult", "dating", "gambling")
                .associateWith { domainSet("$it.domains") }
            val map = SafeSearchMap.parse(verified("safesearch-hosts.json").decodeToString())
                .getOrNull() ?: throw IllegalStateException("safesearch map failed to parse")

            // Strict Search is optional; a missing or bad artifact must
            // not stop the filter from starting — the toggle just stays
            // unavailable and says so.
            val strict = runCatching {
                val hosts = StrictSearchHosts.parse(verified("strict-search-hosts.json").decodeToString())
                    .getOrNull()!!
                hosts to DomainSet.of(hosts.hosts).getOrNull()!!
            }.getOrNull()
            strictSearchHosts = strict?.first ?: StrictSearchHosts.EMPTY
            strictSearchSet = strict?.second
            // Optional too: a missing or bad list leaves only that site's
            // switch unavailable, never the filter.
            mediaHosts = MEDIA_SITES.mapNotNull { (key, _) ->
                runCatching { domainSet("$key-media.domains") }.getOrNull()
                    ?.takeIf { it.size > 0 }?.let { key to it }
            }.toMap()
            optionalSets = OptionalLists.load(checksums) { assets.open(it).readBytes() }

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
        // References only — no copy, however long the lists grow.
        val staticBlock = buildList {
            for (file in enabledCategoryFiles) categorySets[file]?.let { add(it) }
            // Strict Search folds into the same static layer, so a user
            // allow rule can still override it like any other block.
            if (settings.strictSearch) strictSearchSet?.let { add(it) }
            for (site in settings.mediaOff) mediaHosts[site]?.let { add(it) }
            addAll(OptionalLists.enabledSets(settings.optionalLists, optionalSets))
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
