"""plugins.manage rows carry the manifest's env declarations (API keys) with is_set."""

import hermes_cli.config as config_module
import hermes_cli.plugins_cmd as plugins_cmd
from tui_gateway import server


def _handler(name):
    # Handlers are rebound onto server's globals at install time; the raw
    # pending function has no _ok/_err.
    return server._methods[name]


def test_plugins_manage_list_rows_carry_manifest_env(tmp_path, monkeypatch):
    plugin_dir = tmp_path / "video_gen" / "fal"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.yaml").write_text(
        "name: fal\n"
        "requires_env:\n"
        "  - name: FAL_KEY\n"
        "    description: FAL API key\n"
        "    url: https://fal.ai/\n"
        "optional_env:\n"
        "  - FAL_REGION\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        plugins_cmd,
        "_discover_all_plugins",
        lambda: [("fal", "1.0", "Video", "user", plugin_dir, "video_gen/fal")],
    )
    monkeypatch.setattr(plugins_cmd, "_get_enabled_set", lambda: {"video_gen/fal"})
    monkeypatch.setattr(plugins_cmd, "_get_disabled_set", lambda: set())
    monkeypatch.setattr(config_module, "get_env_value", lambda name: "x" if name == "FAL_KEY" else None)

    result = _handler("plugins.manage")(7, {"action": "list"})

    row = result["result"]["plugins"][0]
    assert row["key"] == "video_gen/fal"
    assert row["env"] == [
        {
            "name": "FAL_KEY",
            "description": "FAL API key",
            "url": "https://fal.ai/",
            "password": True,
            "required": True,
            "is_set": True,
        },
        {
            "name": "FAL_REGION",
            "description": "",
            "url": None,
            "password": False,
            "required": False,
            "is_set": False,
        },
    ]


def test_missing_requires_env_names_uses_the_shared_normalizer(monkeypatch):
    monkeypatch.setattr(config_module, "get_env_value", lambda name: "set" if name == "B" else None)
    manifest = {"requires_env": ["A", {"name": "B"}, {"bogus": True}], "optional_env": ["C"]}
    assert plugins_cmd._missing_requires_env_names(manifest) == ["A"]


def test_bundled_non_platform_manifest_env_reaches_optional_env_vars():
    """video_gen/fal declares FAL_KEY in plugin.yaml; the walk must cover more than platforms/."""
    from hermes_cli.config_defaults import OPTIONAL_ENV_VARS

    assert "FAL_KEY" in OPTIONAL_ENV_VARS  # hardcoded — wins
    # A var only a non-platform manifest declares: pick any present in the repo.
    import glob
    import yaml

    declared = set()
    for path in glob.glob("plugins/*/*/plugin.yaml"):
        if "/platforms/" in path:
            continue
        manifest = yaml.safe_load(open(path, encoding="utf-8")) or {}
        for entry in list(manifest.get("requires_env") or []) + list(manifest.get("optional_env") or []):
            declared.add(entry if isinstance(entry, str) else entry.get("name"))
    declared.discard(None)
    assert declared, "no non-platform manifest declares env — test premise broken"
    assert declared <= set(OPTIONAL_ENV_VARS)
