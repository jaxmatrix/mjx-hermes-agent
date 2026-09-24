/**
 * Installs the bridge as an import side effect, where Electron's preload runs:
 * before any renderer module evaluates.
 *
 * `main.tsx` imports this second, straight after the persisted-tab migration. A
 * call in the entry's body would come too late — ES imports evaluate first, and
 * desktop's side-effect stores (`store/power`, `store/translucency`,
 * `store/active-work`, …) reach `window.hermesDesktop?.…` at module scope, where
 * a missing bridge is a silent no-op rather than an error.
 *
 * So this module's STATIC graph has to stay a leaf: nothing that reaches
 * `@/hermes` or the session stores. `./connections` imports those dynamically
 * for that reason.
 */

import { installHermesDesktopBridge } from '.'

installHermesDesktopBridge()
