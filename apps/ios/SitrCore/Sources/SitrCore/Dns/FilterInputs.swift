/// Exactly what the DNS filter's snapshot is built from: the lists that
/// exist and apply, and the four domain lists. Settings that give equal
/// inputs give the same snapshot, so the recovery machine (TunnelRecovery)
/// compares these to skip a reload: a household revision that changes only
/// its rev, devices or PIN, a category id with no list, or a media switch
/// for a site without a media list rebuilds nothing and keeps the cache.
public struct FilterInputs: Equatable, Sendable {
    /// List stems in the builder's order (adult, gambling, dating, media,
    /// opt-in), only those this bundle has.
    public internal(set) var lists: [String]
    public internal(set) var householdAllow: Set<String>
    public internal(set) var householdBlock: Set<String>
    public internal(set) var userAllow: Set<String>
    public internal(set) var userBlock: Set<String>
}

extension BlocklistBundle {
    /// Port of rebuildEngine's inputs, the same as the Safari blocker
    /// (BlockerController.enabledFragments): adult always; gambling and
    /// dating unless disabled (the household's list wins when joined);
    /// each site in `mediaOff` adds `<site>-media.domains`; each opt-in
    /// list switched on adds `<id>.domains`; a list this bundle does not
    /// have is left out.
    public func filterInputs(_ settings: TunnelSettings) -> FilterInputs {
        let disabled = Set(settings.household?.disabledCategories ?? settings.disabledCategories)
        var stems = ["adult"]
        if !disabled.contains("sitr_gambling") { stems.append("gambling") }
        if !disabled.contains("sitr_dating") { stems.append("dating") }
        stems += settings.mediaOff.sorted().map { "\($0)-media" }
        stems += Self.optionalLists.filter(settings.optionalOn.contains)
        return FilterInputs(
            lists: stems.filter { sets[$0] != nil },
            householdAllow: Set(settings.household?.allowDomains ?? []),
            householdBlock: Set(settings.household?.blockDomains ?? []),
            userAllow: Set(settings.userAllow),
            userBlock: Set(settings.userBlock))
    }

    public func snapshot(_ f: FilterInputs) -> DecisionSnapshot {
        DecisionSnapshot(
            householdAllow: f.householdAllow,
            householdBlock: f.householdBlock,
            userAllow: f.userAllow,
            userBlock: f.userBlock,
            staticBlock: f.lists.compactMap { sets[$0] }
        )
    }
}
