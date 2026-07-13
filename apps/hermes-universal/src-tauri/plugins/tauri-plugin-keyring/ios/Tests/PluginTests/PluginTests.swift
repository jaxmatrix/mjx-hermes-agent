import XCTest
@testable import tauri_plugin_keyring

/**
 * Simple unit tests for the iOS keyring plugin stub.
 * 
 * Since all actual keyring functionality is implemented in Rust,
 * these tests only verify that the plugin class can be instantiated.
 * The real functionality is tested in the Rust implementation tests.
 */
final class KeyringPluginTests: XCTestCase {
    
    func testPluginCanBeInstantiated() throws {
        let plugin = KeyringPlugin()
        XCTAssertNotNil(plugin, "KeyringPlugin should be instantiable")
    }
    
    func testInitPluginFunction() throws {
        let plugin = initPlugin()
        XCTAssertTrue(plugin is KeyringPlugin, "initPlugin should return KeyringPlugin instance")
    }
    
    func testPluginIsOfCorrectType() throws {
        let plugin = KeyringPlugin()
        XCTAssertTrue(plugin is Plugin, "KeyringPlugin should inherit from Plugin")
    }
}
