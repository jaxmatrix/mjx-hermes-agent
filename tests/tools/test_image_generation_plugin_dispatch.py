from __future__ import annotations

import pytest

from agent import image_gen_registry


@pytest.fixture(autouse=True)
def _reset_registry():
    image_gen_registry._reset_for_tests()
    yield
    image_gen_registry._reset_for_tests()


class TestPluginDispatch:


class TestAutoSelection:
    """With image_gen.provider unset, the tool resolves the image backend
    belonging to the user's active LLM provider.

    The consent rule stands: a bare credential for some *other* vendor must
    never opt a user into paid image generation.
    """

    def test_matching_runtime_provider_is_selected(self, hermetic):
        from tools import image_generation_tool

        hermetic("openrouter")
        provider = _FakeProvider("openrouter")
        image_gen_registry.register_provider(provider)

        payload = json.loads(image_generation_tool._dispatch_to_plugin_provider("a cat", "square"))

        assert payload["provider"] == "openrouter"

    def test_check_and_dispatch_agree_when_unset(self, hermetic):
        """Both directions in one test so the two call sites cannot drift.

        If the check advertises the tool while dispatch falls through to the
        keyless in-tree FAL path, the model is handed a tool that cannot run.
        """
        from tools import image_generation_tool

        hermetic("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openrouter"))

        assert image_generation_tool.check_image_generation_requirements() is True
        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is not None

    def test_check_and_dispatch_agree_when_nothing_resolves(self, hermetic):
        from tools import image_generation_tool

        hermetic("anthropic")
        image_gen_registry.register_provider(_FakeProvider("openrouter"))
        image_gen_registry.register_provider(_FakeProvider("openai"))

        assert image_generation_tool.check_image_generation_requirements() is False
        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None

    def test_unrelated_key_alone_does_not_select_image_backend(self, hermetic):
        """DeepInfra chat credentials do not imply consent to image billing.

        Two providers are available and neither matches the runtime provider,
        so no rule may resolve one.
        """
        from tools import image_generation_tool

        hermetic("anthropic")
        image_gen_registry.register_provider(_FakeProvider("deepinfra"))
        image_gen_registry.register_provider(_FakeProvider("xai"))

        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None

    def test_auto_runtime_matches_nothing(self, hermetic):
        """"auto" is the unconfigured default and names no image backend."""
        from tools import image_generation_tool

        hermetic("auto")
        image_gen_registry.register_provider(_FakeProvider("openrouter"))
        image_gen_registry.register_provider(_FakeProvider("openai"))

        assert image_generation_tool._auto_selected_provider() is None

    def test_unavailable_match_is_skipped(self, hermetic):
        from tools import image_generation_tool

        hermetic("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openrouter", available=False))
        image_gen_registry.register_provider(_FakeProvider("openai"))

        # Falls through to the single-available rule, which openai satisfies.
        selected = image_generation_tool._auto_selected_provider()
        assert selected is not None and selected.name == "openai"

    def test_auto_selection_never_returns_fal(self, hermetic):
        """FAL belongs on the in-tree pipeline, not plugin dispatch — the
        registry's legacy-FAL rule would otherwise hand it back here."""
        from tools import image_generation_tool

        hermetic("fal")
        image_gen_registry.register_provider(_FakeProvider("fal"))

        assert image_generation_tool._auto_selected_provider() is None
        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None

    def test_stale_top_level_model_is_not_passed(self, hermetic, tmp_path):
        """image_gen.model is written alongside image_gen.provider, so with no
        provider set it belongs to a different backend. Passing it would also
        disable the plugin's own fallback chain, since an explicit model kwarg
        means "use exactly this"."""
        from tools import image_generation_tool

        hermetic("openrouter")
        (tmp_path / "config.yaml").write_text("image_gen:\n  model: fal-ai/flux/dev\n")
        provider = _FakeProvider("openrouter")
        image_gen_registry.register_provider(provider)

        image_generation_tool._dispatch_to_plugin_provider("a cat", "square")

        assert provider.calls, "provider was never dispatched to"
        assert "model" not in provider.calls[0]

    def test_explicit_provider_still_receives_the_configured_model(self, hermetic, tmp_path):
        from tools import image_generation_tool

        (tmp_path / "config.yaml").write_text(
            "image_gen:\n  provider: openrouter\n  model: vendor/pinned\n"
        )
        provider = _FakeProvider("openrouter")
        image_gen_registry.register_provider(provider)

        image_generation_tool._dispatch_to_plugin_provider("a cat", "square")

        assert provider.calls[0]["model"] == "vendor/pinned"

    def test_capabilities_reflect_the_auto_selected_backend(self, hermetic):
        """The third call site. Falling through to the FAL catalog here would
        advertise text-to-image only, so the model would never be told it can
        pass a reference image to a backend that accepts one."""
        from tools import image_generation_tool

        hermetic("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openrouter", max_refs=14))

        info = image_generation_tool._active_image_capabilities()

        assert "image" in info["modalities"]
        assert info["max_reference_images"] == 14
        assert info["model"] == "openrouter/model-v1"


class TestExplicitFalUnchanged:
    def test_explicit_fal_keeps_the_in_tree_path(self, hermetic, tmp_path):
        """`provider: fal` must short-circuit to the in-tree pipeline even
        though a fal plugin is registered and available."""
        from tools import image_generation_tool

        (tmp_path / "config.yaml").write_text("image_gen:\n  provider: fal\n")
        provider = _FakeProvider("fal")
        image_gen_registry.register_provider(provider)

        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None
        assert provider.calls == []

    def test_requirements_false_for_explicit_fal_without_key(self, monkeypatch, tmp_path):
        from tools import image_generation_tool

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setattr(image_generation_tool, "check_fal_api_key", lambda: False)
        monkeypatch.setattr(
            image_generation_tool, "_read_configured_image_provider", lambda: "fal"
        )
        assert image_generation_tool.check_image_generation_requirements() is False
