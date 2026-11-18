import SitrCore
import SwiftUI

/// Category toggles. Adult is always on — the product's single purpose,
/// rendered as fact. Disabling is loosening (PIN-gated via the ladder);
/// enabling never is. With a household, the household's list is the
/// effective one.
struct CategoriesView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void

    private var disabled: [String] {
        model.settings.household?.disabledCategories
            ?? model.settings.disabledCategories
    }

    var body: some View {
        List {
            Section {
                LabeledContent("Adult content blocking") {
                    Text("always on").foregroundStyle(Theme.green)
                }
                .foregroundStyle(Theme.ink)
                Text("Blocking adult content is what Sitr is for — it has no off switch.")
                    .font(.caption).foregroundStyle(Theme.inkSoft)
            }
            .sitrRows()
            Section("Optional categories") {
                ForEach(Categories.toggleableCategories, id: \.rulesetId) { category in
                    Toggle(
                        category.label,
                        isOn: .init(
                            get: { !disabled.contains(category.rulesetId) },
                            set: { on in
                                if on {
                                    attempt(.enableCategory, "") {
                                        Task {
                                            await model.setCategoryDisabled(
                                                category.rulesetId, disabled: false)
                                        }
                                    }
                                } else {
                                    attempt(
                                        .disableCategory,
                                        "Turn off \(category.label) blocking"
                                    ) {
                                        Task {
                                            await model.setCategoryDisabled(
                                                category.rulesetId, disabled: true)
                                        }
                                    }
                                }
                            })
                    )
                    .foregroundStyle(Theme.ink)
                }
            }
            .sitrRows()
            if !Self.availableOptionalLists.isEmpty {
                Section("Opt-in lists") {
                    ForEach(Self.availableOptionalLists, id: \.key) { list in
                        Toggle(
                            list.label,
                            isOn: .init(
                                get: { model.settings.optionalOn.contains(list.key) },
                                set: { on in
                                    let set: () -> Void = {
                                        Task {
                                            await model.mutate {
                                                if on { $0.optionalOn.insert(list.key) } else { $0.optionalOn.remove(list.key) }
                                            }
                                        }
                                    }
                                    if on {
                                        attempt(.enableCategory, "", set)
                                    } else {
                                        attempt(.disableCategory, "Turn off \(list.label) blocking", set)
                                    }
                                })
                        )
                        .foregroundStyle(Theme.ink)
                        Text(list.note).font(.caption).foregroundStyle(Theme.inkSoft)
                    }
                }
                .sitrRows()
            }
            Section {
                ForEach(Self.mediaSites.indices, id: \.self) { i in
                    let site = Self.mediaSites[i]
                    Toggle(
                        "Images and video off on \(site.label)",
                        isOn: .init(
                            get: { model.settings.mediaOff.contains(site.key) },
                            set: { on in
                                let set: () -> Void = {
                                    Task {
                                        await model.mutate {
                                            if on { $0.mediaOff.insert(site.key) } else { $0.mediaOff.remove(site.key) }
                                        }
                                    }
                                }
                                if on {
                                    attempt(.enableCategory, "", set)
                                } else {
                                    attempt(.disableCategory, "Turn on images and video on \(site.label)", set)
                                }
                            })
                    )
                    .foregroundStyle(Theme.ink)
                }
                // Say what it is: all of a site's media, in Safari only.
                Text(
                    "Each switch blocks every picture and video on that site in Safari — Sitr cannot tell which ones are explicit, and it cannot reach the sites' apps. Posts and text still load.\n\nTo hide only media X marks as sensitive, use X's own setting: Settings and privacy → Privacy and safety → Content you see."
                )
                .font(.caption).foregroundStyle(Theme.inkSoft)
                // Facebook, Instagram and TikTok get no switch (threat-model T12).
                Text(
                    "Facebook, Instagram and TikTok aren't filtered inside their apps: Sitr only sees site names. Use Instagram Teen Accounts, TikTok Family Pairing, or app limits in Screen Time. Their websites can be blocked in Allow & block lists."
                )
                .font(.caption).foregroundStyle(Theme.inkSoft)
            } header: {
                Text("Social media")
            }
            .sitrRows()
        }
        .navigationTitle("Filter categories")
        .sitrScreenBackground()
    }

    /// The "images and video off" sites — keys match the compiler's
    /// SITE_MEDIA_HOSTS and the bundled <key>-media.safari.json files.
    static let mediaSites: [(key: String, label: String)] = [
        ("x", "X"), ("reddit", "Reddit"), ("tumblr", "Tumblr"),
        ("pinterest", "Pinterest"), ("imgur", "Imgur"),
    ]

    /// Opt-in lists the compiler emits for Safari (blocklist/optional/
    /// lists.json) — keys match the bundled <key>.safari.json files. A new
    /// optional list needs only a row here; it is shown only when its
    /// fragment is bundled and verifies.
    static let optionalLists: [(key: String, label: String, note: String)] = [
        (
            "violence", "Gore and hate sites",
            "Blocks a list of gore and extremist hate sites. The list is old and incomplete, so many such sites are not on it. Off unless you turn it on; on iOS it works in Safari only."
        )
    ]

    static let availableOptionalLists = optionalLists.filter {
        BlockerController.fragmentAvailable($0.key)
    }
}
