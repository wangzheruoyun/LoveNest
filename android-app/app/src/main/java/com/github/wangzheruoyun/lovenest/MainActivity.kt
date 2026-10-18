package com.github.wangzheruoyun.lovenest

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File

/**
 * Minimal WebView host for the Love Nest demo.
 *
 * This task only stands the shell up: create the WebView, apply the file://
 * settings the design's §5.3 calls for, and point it at the game's default
 * index.html on the device. Task 7 adds the native `GameBridge`, the runtime
 * permission flow, immersive mode and the `gc-bridge.js` injection.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)
        loadGame()
    }

    private fun loadGame() {
        webView.webViewClient = WebViewClient()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowFileAccessFromFileURLs = true

            // Deliberate, informed trade-off. Android's security guidance says to
            // leave allowUniversalAccessFromFileURLs OFF because it opens a
            // file://-based XSS surface. Love Nest loads only local files the user
            // already has on their own device - no remote content and no external
            // input reach this WebView - so that surface does not exist here.
            // See design doc §5.3.
            allowUniversalAccessFromFileURLs = true

            mediaPlaybackRequiresUserGesture = false
        }

        // Encode the non-ASCII game folder name ("爱之巢DemoV1.52") so the file://
        // URL stays well-formed for WebView.
        val index = File(GAME_ROOT, "index.html")
        webView.loadUrl(Uri.fromFile(index).toString())
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private companion object {
        const val GAME_ROOT = "/storage/emulated/0/Download/爱之巢DemoV1.52"
    }
}
