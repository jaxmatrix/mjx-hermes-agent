"""Tests for the update check mechanism in hermes_cli.banner."""

import json
import os
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest




def test_check_for_updates_uses_cache(tmp_path, monkeypatch):
    """When cache is fresh, check_for_updates should return cached value without calling git."""
    from hermes_cli.banner import check_for_updates
    from hermes_cli import __version__

    # Create a fake git repo and fresh cache
    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    cache_file = tmp_path / ".update_check"
    cache_file.write_text(json.dumps({"ts": time.time(), "behind": 3, "ver": __version__}))

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    with patch("hermes_cli.banner.subprocess.run") as mock_run:
        result = check_for_updates()

    assert result == 3
    mock_run.assert_not_called()






def _seed_fresh_cache(tmp_path, monkeypatch, behind=3):
    """A cache that says "3 commits behind" — deliberately NOT the answer the
    skip guard must give, so a guard that silently stopped running would show
    up as 3 rather than None."""
    from hermes_cli import __version__

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()
    (tmp_path / ".update_check").write_text(
        json.dumps({"ts": time.time(), "behind": behind, "ver": __version__})
    )
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))


def test_skip_env_short_circuits_before_cache_or_git(tmp_path, monkeypatch):
    """HERMES_SKIP_UPDATE_CHECK=1 returns None without touching git or the cache.

    This is the contract universal's install-detection probe depends on
    (apps/hermes-universal/src-tauri/src/local_install/detect.rs): since
    ``hermes version`` was folded into ``--version``, every probe of a
    candidate binary otherwise pays a ``git ls-remote``/``git fetch``, ~10s
    with no reachable network — over the probe's own timeout, so a working
    install got reported as missing.
    """
    from hermes_cli.banner import SKIP_UPDATE_CHECK_ENV, check_for_updates

    _seed_fresh_cache(tmp_path, monkeypatch)
    monkeypatch.setenv(SKIP_UPDATE_CHECK_ENV, "1")

    with patch("hermes_cli.banner.subprocess.run") as mock_run:
        result = check_for_updates()

    # Not 3: the seeded cache would have answered 3, so None can only come
    # from the guard itself.
    assert result is None
    mock_run.assert_not_called()


def test_update_check_still_runs_when_the_skip_env_is_absent_or_falsy(
    tmp_path, monkeypatch
):
    """The guard must not fire on its own — otherwise every human-facing
    surface (banner, TUI, dashboard) silently loses its update status."""
    from hermes_cli.banner import SKIP_UPDATE_CHECK_ENV, check_for_updates

    _seed_fresh_cache(tmp_path, monkeypatch)
    monkeypatch.delenv(SKIP_UPDATE_CHECK_ENV, raising=False)
    assert check_for_updates() == 3

    # Set-but-falsy is "no", not "set at all" — shared truthy-string coercion.
    monkeypatch.setenv(SKIP_UPDATE_CHECK_ENV, "0")
    assert check_for_updates() == 3


def test_version_report_drops_only_the_update_line_when_skipping(
    tmp_path, monkeypatch, capsys
):
    """The lines the Rust probe parses are unchanged; only the trailing
    update-status line disappears. ``first_line()`` keeps working either way."""
    from hermes_cli._startup_fast import print_fast_version_info
    from hermes_cli.banner import SKIP_UPDATE_CHECK_ENV

    _seed_fresh_cache(tmp_path, monkeypatch)

    monkeypatch.delenv(SKIP_UPDATE_CHECK_ENV, raising=False)
    print_fast_version_info()
    with_check = capsys.readouterr().out.splitlines()

    monkeypatch.setenv(SKIP_UPDATE_CHECK_ENV, "1")
    print_fast_version_info()
    without_check = capsys.readouterr().out.splitlines()

    assert any("commits behind" in line for line in with_check), with_check
    assert not any("commits behind" in line for line in without_check), without_check
    # Everything the probe reads is identical, first line included.
    assert without_check == [
        line for line in with_check if "commits behind" not in line
    ]
    assert without_check[0].startswith("Hermes Agent v")


def test_prefetch_non_blocking():
    """prefetch_update_check() should return immediately without blocking."""
    import hermes_cli.banner as banner

    # Reset module state
    banner._update_result = None
    banner._update_check_done = threading.Event()

    with patch.object(banner, "check_for_updates", return_value=5):
        start = time.monotonic()
        banner.prefetch_update_check()
        elapsed = time.monotonic() - start

        # Should return almost immediately (well under 1 second)
        assert elapsed < 1.0

        # Wait for the background thread to finish
        banner._update_check_done.wait(timeout=5)
        assert banner._update_result == 5




