/// The Lists screen's Add check: normalized input, and a duplicate says so.
import SitrCore
import XCTest

@testable import Sitr

final class ListsInputTests: XCTestCase {
    func testAddCheckNormalizesAndRefusesADuplicate() {
        XCTAssertEqual(try ListsView.addCheck("  https://WWW.Example.net/x ", in: []).get(), "example.net")
        XCTAssertEqual(
            ListsView.addCheck("example.net", in: ["example.net"]),
            .failure(SitrError("Already in the list.")))
        XCTAssertThrowsError(try ListsView.addCheck("not a domain", in: []).get())
    }
}
