"""Image generation provider registry.

Populated by plugins at import-time via ``PluginContext.register_image_gen_provider()``;
the ``image_generate`` tool dispatches to :func:`get_active_provider`. Selection is
``image_gen.provider`` in config.yaml; when unset: the provider whose name matches the
active LLM runtime provider (when available), else the single *available* provider,
else ``fal`` if registered and available (legacy default), else ``None`` (the tool
points the user at ``hermes tools``).

The runtime-provider rule exists because holding a key is not consent: a bare credential
for some unrelated vendor must never opt a user into paid image generation, but refusing
to resolve *anything* left the tool unavailable to everyone who had not run ``hermes
tools`` — which is how image generation ended up silently switched off for users with a
perfectly good OpenRouter or Nous credential. The user already pays the matching vendor
for inference, so it cannot be a surprise bill.
"""

from __future__ import annotations

import logging
from typing import Optional

from agent.image_gen_provider import ImageGenProvider
from agent.provider_registry import ProviderRegistry, configured_provider_name, is_available_safe

logger = logging.getLogger(__name__)


_registry: ProviderRegistry[ImageGenProvider] = ProviderRegistry(
    label="Image gen", provider_cls=ImageGenProvider, logger=logger,
)
_registry.export(globals())


def get_active_provider() -> Optional[ImageGenProvider]:
    """Resolve the currently-active provider. Availability semantics (mirrors
    :mod:`agent.web_search_registry`): an explicitly configured provider is returned
    even if ``is_available()`` is False, so the dispatcher surfaces a precise
    "X_API_KEY is not set" error instead of silently switching backends; only the
    unconfigured fallback path is filtered by availability."""
    configured = configured_provider_name("image_gen", logger)
    snapshot = _registry.merged()
    if configured:
        if snapshot.get(configured) is not None:
            return snapshot[configured]
        logger.debug("image_gen.provider='%s' configured but not registered; falling back", configured)

    def _available(p: ImageGenProvider) -> bool:
        return is_available_safe(p, logger, "image_gen provider %s.is_available() raised %s")

    # The image backend belonging to the user's active LLM provider. Every *other*
    # credential stays strictly opt-in (the rules below never match on a bare key).
    # resolve_requested_provider() — not resolve_runtime_provider(), whose tail
    # resolves *any* unmatched request (including the literal "auto") to openrouter
    # and would opt an unconfigured user into its billing. "auto" matches no
    # registered image provider, so it falls through.
    try:
        from hermes_cli.runtime_provider import resolve_requested_provider

        runtime_name = (resolve_requested_provider() or "").strip().lower()
    except Exception as exc:  # noqa: BLE001 - resolution is best-effort
        logger.debug("could not resolve the active runtime provider: %s", exc)
        runtime_name = ""
    runtime_match = snapshot.get(runtime_name) if runtime_name else None
    if runtime_match is not None and _available(runtime_match):
        return runtime_match

    available = [p for p in snapshot.values() if _available(p)]
    if len(available) == 1:
        return available[0]
    fal = snapshot.get("fal")
    return fal if fal is not None and _available(fal) else None


# ---- BEGIN PLUGIN-COMPAT (revert-scheduled; see COMPAT_MANIFEST.md) ----
# Names external plugins imported from this module before the Sep 2026 decomposition.
# Internal code MUST NOT use these (scripts/check_compat_pointers.py fails CI if it does).
# The whole block is removed by reverting the commit that added it.
from typing import Dict  # noqa: F401,E402
from typing import List  # noqa: F401,E402
import threading  # noqa: F401,E402


_PLUGIN_COMPAT_LAZY = {
    'hermes_home_key': ('hermes_constants', 'hermes_home_key'),
}


def __getattr__(name):  # PEP 562 — lazy so no import cycles
    target = _PLUGIN_COMPAT_LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    from hermes_cli.plugin_compat import warn_once
    warn_once(__name__, name, *target)
    return getattr(importlib.import_module(target[0]), target[1])
# ---- END PLUGIN-COMPAT ----
