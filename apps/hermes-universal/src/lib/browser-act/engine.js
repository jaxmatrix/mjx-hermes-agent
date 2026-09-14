/**
 * The in-page act engine for `drive_preview` / `annotate_preview`.
 *
 * Imported `?raw` and injected into the GUEST with `browser_eval`. It is
 * therefore self-contained by construction: no imports, no `import()`, no
 * bundler runtime, no TypeScript. It installs exactly one global,
 * `window.__hermesAct`, carrying a version so the host can probe for it in one
 * cheap eval instead of re-injecting on every call.
 *
 * It is re-injected after every navigation because the document is new — which
 * is also why a navigation retires every ref, and why `stale: true` exists
 * rather than a ref table in the host.
 *
 * Why DOM-level synthetic events rather than platform input injection: there is
 * no portable input-injection API. WebKitGTK exposes none for an embedded
 * WebView, WebView2's `SendMouseInput` needs visual hosting Tauri does not use,
 * and WKWebView has none at all. Android CAN do real `MotionEvent`s from our
 * plugin, and `browser_capabilities().act` is what would say so.
 *
 * ponytail: DOM injection. The ceiling is `isTrusted`-gated widgets (some
 * payment and captcha flows), which is DETECTED and reported rather than
 * silently reported as success. Upgrade path = ActInjection::NativeInput.
 */
;(function () {
  var VERSION = 1

  if (window.__hermesAct && window.__hermesAct.v === VERSION) {
    return
  }

  var MAX_DEFAULT = 200
  var refs = Object.create(null)
  var previous = null
  var marks = Object.create(null)
  var overlayRoot = null
  var frame = 0

  var ROLE_PREFIX = {
    button: 'btn',
    checkbox: 'chk',
    heading: 'hdr',
    image: 'img',
    link: 'lnk',
    listitem: 'li',
    option: 'opt',
    radio: 'rad',
    select: 'sel',
    tab: 'tab',
    textbox: 'inp'
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role')
    if (explicit && ROLE_PREFIX[explicit]) return explicit

    var tag = (el.tagName || '').toLowerCase()
    if (tag === 'a' && el.getAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'select'
    if (tag === 'option') return 'option'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'img') return 'image'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      var type = (el.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      return 'textbox'
    }
    if (el.getAttribute && el.getAttribute('tabindex') !== null) return 'button'
    return 'element'
  }

  function textOf(el) {
    var text = ''
    try {
      text = el.innerText || el.textContent || ''
    } catch (e) {
      text = ''
    }
    return text.replace(/\s+/g, ' ').trim()
  }

  function labelOf(el) {
    var candidates = [
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('alt'),
      el.getAttribute && el.getAttribute('placeholder'),
      textOf(el),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('name'),
      el.value && typeof el.value === 'string' ? el.value : ''
    ]

    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) return String(candidates[i]).slice(0, 120)
    }

    return ''
  }

  function slug(label) {
    var s = String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return s.slice(0, 24) || 'x'
  }

  function visible(el) {
    if (!el.getClientRects || !el.getClientRects().length) return false
    var style = window.getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }

  var SELECTOR =
    'a[href],button,input,select,textarea,summary,[role],[tabindex],[onclick],h1,h2,h3,h4,h5,h6,img[alt]'

  function collect(max) {
    var limit = typeof max === 'number' && max > 0 ? Math.min(max, 1000) : MAX_DEFAULT
    var nodes = document.querySelectorAll(SELECTOR)
    var used = Object.create(null)
    var entries = []
    var skipped = 0

    refs = Object.create(null)

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (!visible(el)) continue

      if (entries.length >= limit) {
        skipped++
        continue
      }

      var role = roleOf(el)
      var label = labelOf(el)
      var base = (ROLE_PREFIX[role] || 'el') + '-' + slug(label)
      var ref = base
      var n = 2

      while (used[ref]) {
        ref = base + '-' + n
        n++
      }

      used[ref] = true
      refs[ref] = el

      // Stamped on the element so a ref is ALSO a CSS selector. The tour
      // surface needs one that survives a re-render, and this is the only
      // identity we control.
      try {
        el.setAttribute('data-hermes-ref', ref)
      } catch (e) {
        /* a read-only node (SVG use, some custom elements) */
      }

      var entry = { label: label, ref: ref, role: role }
      if (typeof el.value === 'string') entry.value = el.value.slice(0, 200)
      if (el.disabled) entry.disabled = true

      entries.push(entry)
    }

    return { entries: entries, skipped: skipped }
  }

  function diff(next) {
    if (!previous) return null

    var before = Object.create(null)
    var i
    for (i = 0; i < previous.length; i++) before[previous[i].ref] = previous[i]

    var delta = { added: [], changed: [], rebound: [], removed: [], same: 0 }
    var seen = Object.create(null)

    for (i = 0; i < next.length; i++) {
      var entry = next[i]
      seen[entry.ref] = true
      var old = before[entry.ref]

      if (!old) {
        delta.added.push(entry)
        continue
      }

      var moved = {}
      var changed = false
      if (old.label !== entry.label) {
        moved.label = entry.label
        changed = true
      }
      if (old.value !== entry.value) {
        moved.value = entry.value
        changed = true
      }
      if (!!old.disabled !== !!entry.disabled) {
        moved.disabled = !!entry.disabled
        changed = true
      }

      if (changed) {
        moved.ref = entry.ref
        delta.changed.push(moved)
      } else {
        delta.same++
      }
    }

    for (i = 0; i < previous.length; i++) {
      if (!seen[previous[i].ref]) delta.removed.push(previous[i].ref)
    }

    return delta
  }

  function inventory(request) {
    var collected = collect(request.max)
    var delta = request.full ? null : diff(collected.entries)
    previous = collected.entries

    var result = ok('elements')
    if (delta) {
      result.delta = delta
    } else {
      result.elements = collected.entries
    }
    if (collected.skipped) {
      result.error = 'Stopped after ' + collected.entries.length + ' elements; ' + collected.skipped + ' more were skipped.'
    }
    return result
  }

  function ok(action) {
    return { action: action, success: true, title: document.title, url: location.href }
  }

  function fail(action, error) {
    return { action: action, error: error, success: false, title: document.title, url: location.href }
  }

  function resolve(request) {
    if (request.ref) return refs[request.ref] || null
    if (request.selector) {
      try {
        return document.querySelector(request.selector)
      } catch (e) {
        return null
      }
    }
    return null
  }

  function fire(el, type, init) {
    var options = { bubbles: true, cancelable: true, composed: true }
    for (var key in init) options[key] = init[key]

    var event
    if (/^pointer/.test(type) && window.PointerEvent) event = new PointerEvent(type, options)
    else if (/^(mouse|click|dbl)/.test(type)) event = new MouseEvent(type, options)
    else if (/^key/.test(type)) event = new KeyboardEvent(type, options)
    else event = new Event(type, options)

    el.dispatchEvent(event)
    return event
  }

  function centre(el) {
    var rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  function pointerInto(el, point) {
    var init = { clientX: point.x, clientY: point.y }
    fire(el, 'pointerover', init)
    fire(el, 'pointerenter', init)
    fire(el, 'pointermove', init)
  }

  function click(el, action) {
    var point = centre(el)
    var top = document.elementFromPoint(point.x, point.y)

    // An overlay that swallows the click is REPORTED, not silently missed.
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      return fail(action, 'The overlay above it took the click.')
    }

    var witnessed = false
    var witness = function () {
      witnessed = true
    }
    el.addEventListener('click', witness, true)

    var init = { clientX: point.x, clientY: point.y }
    pointerInto(el, point)
    fire(el, 'pointerdown', init)
    fire(el, 'mousedown', init)
    try {
      el.focus({ preventScroll: true })
    } catch (e) {
      /* not focusable */
    }
    fire(el, 'pointerup', init)
    fire(el, 'mouseup', init)
    fire(el, 'click', init)

    el.removeEventListener('click', witness, true)

    if (!witnessed) {
      return fail(action, 'The page did not accept the click; it may require real user input.')
    }

    return ok(action)
  }

  /** React installs its own `value` setter on the element; assigning through
   *  the prototype's is the only way a controlled input keeps the text. */
  function setValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value')

    if (descriptor && descriptor.set) descriptor.set.call(el, value)
    else el.value = value
  }

  function type(el, request) {
    try {
      el.focus({ preventScroll: true })
    } catch (e) {
      /* not focusable */
    }

    if (typeof el.select === 'function') el.select()

    var text = String(request.text == null ? '' : request.text)

    if (el.isContentEditable) {
      el.textContent = text
    } else if ('value' in el) {
      fire(el, 'beforeinput', {})
      setValue(el, text)
    } else {
      return fail('type', 'That element does not take text.')
    }

    fire(el, 'input', {})
    fire(el, 'change', {})

    if (request.submit) {
      press(el, { key: 'Enter' })
      var form = el.form || (el.closest && el.closest('form'))
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
    }

    return ok('type')
  }

  var KEYS = {
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    Backspace: 'Backspace',
    Delete: 'Delete',
    End: 'End',
    Enter: 'Enter',
    Escape: 'Escape',
    Home: 'Home',
    PageDown: 'PageDown',
    PageUp: 'PageUp',
    Space: ' ',
    Tab: 'Tab'
  }

  function press(el, request) {
    var name = request.key || 'Enter'
    var key = KEYS[name] || name
    var code = key === ' ' ? 'Space' : /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : name
    var init = { code: code, key: key }

    fire(el, 'keydown', init)
    fire(el, 'keypress', init)
    fire(el, 'keyup', init)

    return ok('press')
  }

  function scrollable(el) {
    var node = el
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node)
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node
      node = node.parentElement
    }
    return document.scrollingElement || document.documentElement
  }

  function scroll(el, request) {
    var target = el ? scrollable(el) : document.scrollingElement || document.documentElement

    if (target.scrollHeight <= target.clientHeight + 4) {
      return fail('scroll', 'There is nothing to scroll here.')
    }

    if (request.to === 'top') target.scrollTop = 0
    else if (request.to === 'bottom') target.scrollTop = target.scrollHeight
    else target.scrollTop += typeof request.amount === 'number' ? request.amount : target.clientHeight * 0.9

    return ok('scroll')
  }

  // --- annotations ---------------------------------------------------------

  function root() {
    if (overlayRoot && overlayRoot.isConnected) return overlayRoot

    overlayRoot = document.createElement('div')
    overlayRoot.setAttribute('data-hermes-annotations', '')
    overlayRoot.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:strict'
    document.documentElement.appendChild(overlayRoot)

    return overlayRoot
  }

  /** Marks are bound to ELEMENTS, not coordinates, so they ride scrolls and
   *  reflows and die with the element they point at. */
  function sync() {
    frame = 0
    var any = false

    for (var ref in marks) {
      var mark = marks[ref]
      var el = mark.el

      if (!el || !el.isConnected || !visible(el)) {
        mark.box.remove()
        delete marks[ref]
        continue
      }

      any = true
      var rect = el.getBoundingClientRect()
      mark.box.style.left = rect.left + 'px'
      mark.box.style.top = rect.top + 'px'
      mark.box.style.width = rect.width + 'px'
      mark.box.style.height = rect.height + 'px'
    }

    if (any) frame = requestAnimationFrame(sync)
    else if (overlayRoot) overlayRoot.remove()
  }

  function annotate(request) {
    var verb = request.action

    if (verb === 'unpin' && !request.ref) {
      for (var key in marks) marks[key].box.remove()
      marks = Object.create(null)
      if (overlayRoot) overlayRoot.remove()
      return ok('unpin')
    }

    if (verb === 'hold') {
      // The whole visible field rather than one element — a different overlay,
      // and the reason `hold` is not just `pin` with a bigger box.
      var box = document.createElement('div')
      box.style.cssText =
        'position:fixed;inset:0;border:3px solid #ffb020;box-shadow:inset 0 0 0 9999px rgba(255,176,32,.08);pointer-events:none'
      root().appendChild(box)
      marks['__hold'] = { box: box, el: document.documentElement }
      if (!frame) frame = requestAnimationFrame(sync)
      return ok('hold')
    }

    var el = resolve(request)
    if (!el) return fail(verb, 'No element for that ref; run `elements` again.')

    if (verb === 'unpin') {
      if (marks[request.ref]) {
        marks[request.ref].box.remove()
        delete marks[request.ref]
      }
      return ok('unpin')
    }

    var pin = document.createElement('div')
    pin.style.cssText =
      'position:fixed;border:2px solid #4f9cf9;border-radius:4px;box-shadow:0 0 0 3px rgba(79,156,249,.25);pointer-events:none'
    if (request.text) {
      var tag = document.createElement('span')
      tag.textContent = String(request.text).slice(0, 80)
      tag.style.cssText =
        'position:absolute;top:-1.4em;left:0;font:12px/1.2 system-ui,sans-serif;background:#4f9cf9;color:#fff;padding:2px 4px;border-radius:3px;white-space:nowrap'
      pin.appendChild(tag)
    }
    root().appendChild(pin)

    if (marks[request.ref]) marks[request.ref].box.remove()
    marks[request.ref] = { box: pin, el: el }
    if (!frame) frame = requestAnimationFrame(sync)

    return ok('pin')
  }

  /**
   * The `tour` surface's target list. A separate verb rather than more fields
   * on `elements`: a rect per row would inflate every drive inventory, and the
   * two callers want different things.
   */
  function tourTargets(request) {
    var collected = collect(request.max || 150)
    var out = []

    for (var i = 0; i < collected.entries.length; i++) {
      var entry = collected.entries[i]
      var el = refs[entry.ref]
      if (!el) continue

      var rect = el.getBoundingClientRect()
      out.push({
        label: entry.label,
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        role: entry.role,
        selector: '[data-hermes-ref="' + entry.ref + '"]',
        // The ref keys off role + accessible name, not DOM position, so it
        // survives a re-render that rebuilds the element.
        stable: true
      })
    }

    var result = ok('targets')
    result.targets = out
    return result
  }

  function strobe() {
    var collected = collect(60)
    var els = []
    for (var ref in refs) els.push(refs[ref])

    els.forEach(function (el, index) {
      setTimeout(function () {
        var saved = el.style.outline
        el.style.outline = '3px solid #4f9cf9'
        setTimeout(function () {
          el.style.outline = saved
        }, 220)
      }, index * 30)
    })

    var result = ok('strobe')
    result.elements = collected.entries
    return result
  }

  // --- dispatch ------------------------------------------------------------

  function run(request) {
    try {
      var action = request && request.action ? String(request.action) : ''

      if (action === 'elements') return inventory(request)
      if (action === 'targets') return tourTargets(request)
      if (action === 'strobe') return strobe()
      if (action === 'pin' || action === 'hold' || action === 'unpin') return annotate(request)

      if (action === 'scroll') return scroll(resolve(request), request)

      var el = resolve(request)

      if (!el) {
        return fail(action, 'No element for that ref; run `elements` again to refresh them.')
      }

      if (action === 'click') return click(el, action)
      if (action === 'hover') {
        // Leave the pointer there — hover menus stay open.
        pointerInto(el, centre(el))
        return ok('hover')
      }
      if (action === 'type') return type(el, request)
      if (action === 'press') return press(el, request)

      return fail(action || 'unknown', 'The in-app browser does not know the action "' + action + '".')
    } catch (e) {
      return fail(request && request.action ? request.action : 'unknown', String((e && e.message) || e))
    }
  }

  window.__hermesAct = { run: run, v: VERSION }
})()
