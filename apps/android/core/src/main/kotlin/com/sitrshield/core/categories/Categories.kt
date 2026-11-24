package com.sitrshield.core.categories

/**
 * Category model — which rulesets exist and which ids the household blob
 * may carry as disabled. Port of extension/src/lib/categories.ts.
 *
 * `sitr_adult` and `sitr_safesearch` are always on: they are the product's
 * single purpose. A disabled optional category is NOT a protection failure.
 */
object Categories {
    val ALWAYS_ON_RULESETS = listOf("sitr_adult", "sitr_safesearch")

    /**
     * Android only: the bundled lists no switch turns off and no allow entry
     * of any layer opens. The extension and iOS still let gambling and dating
     * be switched off, so TOGGLEABLE_CATEGORIES stays as the ids the blob may
     * carry; Android reads and keeps them but ignores them.
     */
    val ANDROID_ALWAYS_BLOCKED = listOf("adult", "gambling", "dating")

    data class ToggleableCategory(val rulesetId: String, val label: String)

    val TOGGLEABLE_CATEGORIES = listOf(
        ToggleableCategory("sitr_gambling", "Gambling"),
        ToggleableCategory("sitr_dating", "Dating"),
    )

    /** Sanitize a stored value: keep only known toggleable ruleset ids. */
    fun sanitizeDisabled(stored: List<Any?>?): List<String> {
        if (stored == null) return emptyList()
        val known = TOGGLEABLE_CATEGORIES.map { it.rulesetId }.toSet()
        val seen = LinkedHashSet<String>()
        for (item in stored) {
            if (item is String && item in known) seen.add(item)
        }
        return seen.toList()
    }

    /** The rulesets that MUST be enabled given the user's disabled set. */
    fun requiredRulesets(disabled: List<String>): List<String> {
        val off = disabled.toSet()
        return ALWAYS_ON_RULESETS +
            TOGGLEABLE_CATEGORIES.map { it.rulesetId }.filter { it !in off }
    }
}
