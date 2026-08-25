import SwiftRs
import Tauri
import UIKit
import WebKit

/**
 * The iOS half of the in-app browser (MJXHRM-447).
 *
 * A `WKWebView` added as a subview of the Tauri view controller's view at the
 * rect the pane reports. It is NOT a Tauri webview: no message handler is
 * registered, there is no `window.__TAURI_INTERNALS__`, and the only
 * host↔guest channels are `evaluateJavaScript` (pull) and the `Channel` below
 * (push).
 *
 * iOS is the ONE platform with a real edge-swipe back gesture:
 * `allowsBackForwardNavigationGestures` is a property here, while wry's
 * equivalent flag exists but is never plumbed by tauri, so no desktop target
 * gets it. The capability report says so instead of implying parity.
 */
class BoundsArg: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

class OpenArgs: Decodable {
  let guestId: String
  let url: String
  let bounds: BoundsArg
  let onEvent: Channel
}

class GuestArgs: Decodable {
  let guestId: String
}

class NavigateArgs: Decodable {
  let guestId: String
  let url: String
}

class BoundsArgs: Decodable {
  let guestId: String
  let bounds: BoundsArg
}

class VisibleArgs: Decodable {
  let guestId: String
  let visible: Bool
}

class EvalArgs: Decodable {
  let guestId: String
  let script: String
}

class BrowserPlugin: Plugin, WKNavigationDelegate, WKUIDelegate {
  private var guests: [String: WKWebView] = [:]
  private var channels: [String: Channel] = [:]
  private var idsByView: [ObjectIdentifier: String] = [:]

  private func send(_ guestId: String, _ kind: String, _ fields: [String: Any]) {
    guard let channel = channels[guestId] else { return }

    var payload: [String: Any] = fields
    payload["kind"] = kind
    payload["guestId"] = guestId

    try? channel.send(JSObject(payload))
  }

  private func guestId(for webView: WKWebView) -> String? {
    idsByView[ObjectIdentifier(webView)]
  }

  /// The same gate the desktop guard applies: an in-app browser shows web
  /// pages, and hands everything else to the OS.
  private func allowed(_ url: URL?) -> Bool {
    guard let scheme = url?.scheme?.lowercased() else { return false }
    if scheme == "http" || scheme == "https" { return true }
    return url?.absoluteString.lowercased() == "about:blank"
  }

  private func frame(_ bounds: BoundsArg) -> CGRect {
    CGRect(
      x: bounds.x,
      y: bounds.y,
      width: max(bounds.width, 1),
      height: max(bounds.height, 1))
  }

  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)

    DispatchQueue.main.async {
      if let existing = self.guests[args.guestId] {
        existing.frame = self.frame(args.bounds)
        if let url = URL(string: args.url) {
          existing.load(URLRequest(url: url))
        }
        invoke.resolve()
        return
      }

      guard let host = self.manager.viewController?.view else {
        invoke.reject("The in-app browser could not start: no view controller.")
        return
      }

      let configuration = WKWebViewConfiguration()

      // A real second cookie jar on iOS 17+, and a NON-PERSISTENT one below
      // that, which forgets logins on every launch. The capability report says
      // `ephemeral` in that case rather than implying a persistence we do not
      // have.
      if #available(iOS 17.0, *),
        let identifier = UUID(uuidString: "6d1a5f2c-0b7e-4c1a-9d3f-7e2b1c4a8f90")
      {
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: identifier)
      } else {
        configuration.websiteDataStore = .nonPersistent()
      }

      let webView = WKWebView(frame: self.frame(args.bounds), configuration: configuration)
      webView.allowsBackForwardNavigationGestures = true
      webView.navigationDelegate = self
      webView.uiDelegate = self

      host.addSubview(webView)

      self.guests[args.guestId] = webView
      self.channels[args.guestId] = args.onEvent
      self.idsByView[ObjectIdentifier(webView)] = args.guestId

      if let url = URL(string: args.url) {
        webView.load(URLRequest(url: url))
      }

      invoke.resolve()
    }
  }

  private func withGuest(_ invoke: Invoke, _ guestId: String, _ body: @escaping (WKWebView) -> Void)
  {
    DispatchQueue.main.async {
      guard let webView = self.guests[guestId] else {
        invoke.reject("No in-app browser guest named \"\(guestId)\" is open.")
        return
      }

      body(webView)
    }
  }

  @objc public func navigate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(NavigateArgs.self)
    withGuest(invoke, args.guestId) { webView in
      guard let url = URL(string: args.url) else {
        invoke.reject("\(args.url) is not an address.")
        return
      }
      webView.load(URLRequest(url: url))
      invoke.resolve()
    }
  }

  @objc public func back(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GuestArgs.self)
    withGuest(invoke, args.guestId) { webView in
      webView.goBack()
      invoke.resolve()
    }
  }

  @objc public func forward(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GuestArgs.self)
    withGuest(invoke, args.guestId) { webView in
      webView.goForward()
      invoke.resolve()
    }
  }

  @objc public func reload(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GuestArgs.self)
    withGuest(invoke, args.guestId) { webView in
      webView.reload()
      invoke.resolve()
    }
  }

  @objc public func stop(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GuestArgs.self)
    withGuest(invoke, args.guestId) { webView in
      webView.stopLoading()
      invoke.resolve()
    }
  }

  @objc public func setBounds(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BoundsArgs.self)
    withGuest(invoke, args.guestId) { webView in
      webView.frame = self.frame(args.bounds)
      invoke.resolve()
    }
  }

  @objc public func setVisible(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(VisibleArgs.self)
    withGuest(invoke, args.guestId) { webView in
      webView.isHidden = !args.visible
      // The RESULTING visibility, read back off the view.
      invoke.resolve(["visible": !webView.isHidden])
    }
  }

  @objc public func eval(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EvalArgs.self)
    withGuest(invoke, args.guestId) { webView in
      webView.evaluateJavaScript(args.script) { value, error in
        if error != nil {
          // Never throw at the caller: a page that refused the script still
          // owes an answer, and `null` is the honest one.
          invoke.resolve(["value": "null"])
          return
        }

        // JSON, the same shape `eval_with_callback` produces on desktop, so
        // both halves feed one parser.
        guard let value = value,
          !(value is NSNull),
          let data = try? JSONSerialization.data(
            withJSONObject: value, options: [.fragmentsAllowed]),
          let json = String(data: data, encoding: .utf8)
        else {
          invoke.resolve(["value": "null"])
          return
        }

        invoke.resolve(["value": json])
      }
    }
  }

  @objc public func clearData(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GuestArgs.self)
    withGuest(invoke, args.guestId) { webView in
      let store = webView.configuration.websiteDataStore
      let types = WKWebsiteDataStore.allWebsiteDataTypes()

      store.fetchDataRecords(ofTypes: types) { records in
        store.removeData(ofTypes: types, for: records) {
          invoke.resolve()
        }
      }
    }
  }

  @objc public func close(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GuestArgs.self)

    DispatchQueue.main.async {
      if let webView = self.guests.removeValue(forKey: args.guestId) {
        self.idsByView.removeValue(forKey: ObjectIdentifier(webView))
        webView.stopLoading()
        webView.removeFromSuperview()
      }

      self.channels.removeValue(forKey: args.guestId)
      invoke.resolve()
    }
  }

  @objc public func capabilities(_ invoke: Invoke) throws {
    var notes: [String] = []
    var store = "ephemeral"

    if #available(iOS 17.0, *) {
      store = "own"
    } else {
      notes.append(
        "This iOS version has no persistent data store for the in-app browser, so it forgets logins when Hermes restarts."
      )
    }

    invoke.resolve([
      "isolatedStore": store,
      // `canGoBack` is engine truth, not a counted estimate.
      "historyEngine": true,
      "gestures": true,
      // WKWebView has no console hook; the injected ring is polled instead.
      "consolePush": false,
      "notes": notes,
    ])
  }

  // MARK: - WKNavigationDelegate

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url

    if allowed(url) {
      decisionHandler(.allow)
      return
    }

    // A `mailto:` is a handoff, not a failure. Rust decides what to do with it
    // so both platforms behave the same way.
    if let id = guestId(for: webView), let url = url {
      send(id, "external", ["url": url.absoluteString])
    }

    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    guard let id = guestId(for: webView) else { return }
    send(id, "load", ["started": true, "url": webView.url?.absoluteString ?? ""])
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let id = guestId(for: webView) else { return }

    send(id, "load", ["started": false, "url": webView.url?.absoluteString ?? ""])
    send(
      id, "nav",
      [
        "url": webView.url?.absoluteString ?? "",
        "title": webView.title ?? "",
        "canBack": webView.canGoBack,
        "canForward": webView.canGoForward,
      ])
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    reportFailure(webView, error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    reportFailure(webView, error)
  }

  private func reportFailure(_ webView: WKWebView, _ error: Error) {
    guard let id = guestId(for: webView) else { return }

    let nsError = error as NSError

    // `NSURLErrorCancelled` is a superseded navigation, not a failure — the
    // same rule desktop applies to Chromium's -3.
    if nsError.code == NSURLErrorCancelled {
      return
    }

    send(
      id, "error",
      [
        // A real code, which desktop cannot report at all.
        "code": nsError.code,
        "description": nsError.localizedDescription,
        "url": webView.url?.absoluteString ?? "",
      ])
  }

  // MARK: - WKUIDelegate

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    // An uncontrolled second webview is an uncontrolled second surface. Refuse,
    // and hand the URL back to the host instead.
    if let id = guestId(for: webView), let url = navigationAction.request.url {
      send(id, "external", ["url": url.absoluteString])
    }

    return nil
  }
}

@_cdecl("init_plugin_browser")
func initPlugin() -> Plugin {
  return BrowserPlugin()
}
