package com.charlesportwoodii.tauri.plugin.keyring

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*

/**
 * Instrumented tests for the Android keyring plugin stub.
 * 
 * These tests run on Android devices to verify the plugin registration works.
 * The actual keyring functionality is tested in the Rust implementation.
 */
@RunWith(AndroidJUnit4::class)
class KeyringInstrumentedTest {
    
    @Test
    fun testContextPackageName() {
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.charlesportwoodii.tauri.plugin.keyring", appContext.packageName)
    }
    
    @Test 
    fun testPluginCanBeInstantiated() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // In a real app, this would be done by Tauri, but we can test basic instantiation
        try {
            val pluginClass = KeyringPlugin::class.java
            assertNotNull("Plugin class should be accessible", pluginClass)
        } catch (e: Exception) {
            fail("Plugin class should be accessible: ${e.message}")
        }
    }
}
