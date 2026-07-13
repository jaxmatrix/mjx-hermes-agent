package com.charlesportwoodii.tauri.plugin.keyring

import org.junit.Test
import org.junit.Assert.*

/**
 * Simple unit tests for the Android keyring plugin stub.
 * 
 * Since all actual keyring functionality is implemented in Rust,
 * these tests only verify that the plugin class can be instantiated.
 * The real functionality is tested in the Rust implementation tests.
 */
class KeyringPluginTest {
    
    @Test
    fun testPluginClassExists() {
        // Verify that the KeyringPlugin class exists and can be referenced
        val pluginClass = KeyringPlugin::class.java
        assertNotNull("KeyringPlugin class should exist", pluginClass)
        assertEquals("Plugin should have correct package", "com.charlesportwoodii.tauri.plugin.keyring", pluginClass.packageName)
    }
    
    @Test
    fun testPluginHasCorrectAnnotations() {
        // Verify that the KeyringPlugin has the TauriPlugin annotation
        val pluginClass = KeyringPlugin::class.java
        val tauriPluginAnnotation = pluginClass.getAnnotation(app.tauri.annotation.TauriPlugin::class.java)
        assertNotNull("KeyringPlugin should have @TauriPlugin annotation", tauriPluginAnnotation)
    }
}
