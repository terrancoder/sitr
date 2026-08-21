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
                    Text("always on").foregroundStyle(.green)
                }
                Text("Blocking adult content is what Sitr is for — it has no off switch.")
                    .font(.caption).foregroundStyle(.secondary)
            }
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
                }
            }
        }
        .navigationTitle("Filter categories")
    }
}
