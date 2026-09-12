"""Tests: finding a LIVE session that has no database row yet.

Why: ``session.create`` persists no row until the first prompt, so a fresh Bot
Chat is live in ``_sessions`` while ``state.db`` has never heard of it.
``session.resume`` refused such a session with 4007 before ever consulting the
live sessions — upstream's words: "a 404 here killed messaging for never-spoken
bots". ``find_live_unpersisted`` is the matching rule the resume now consults
before refusing.

Contract under test:
- Matches the durable ``session_key``, or a title still in ``pending_title``.
- NEVER crosses profiles: ``profile_home`` must match, Path or str.
- Skips a finalized record.
- An empty needle matches nothing.
"""

from __future__ import annotations

from pathlib import Path

from tui_gateway.live_unpersisted import find_live_unpersisted


def _record(key, *, home=None, pending_title=None, finalized=False):
    record = {"session_key": key, "profile_home": home, "pending_title": pending_title}
    if finalized:
        record["_finalized"] = True
    return record


def test_matches_a_live_session_by_its_durable_key():
    sessions = {"run-1": _record("20260913_015759_bc539a")}

    assert find_live_unpersisted(sessions, "20260913_015759_bc539a", None) == (
        "run-1",
        sessions["run-1"],
    )


def test_matches_by_a_title_still_pending():
    # A resume by exact title must reach a session whose title has not been
    # written yet.
    sessions = {"run-1": _record("k1", pending_title="Bot Chat")}

    assert find_live_unpersisted(sessions, "Bot Chat", None)[0] == "run-1"


def test_never_crosses_profile_homes():
    # Reattaching another profile's session forks a conversation into the wrong
    # database, however well the key or title matches.
    sessions = {"run-1": _record("k1", home="/data/profiles/work", pending_title="Bot Chat")}

    assert find_live_unpersisted(sessions, "k1", None) is None
    assert find_live_unpersisted(sessions, "Bot Chat", "/data/profiles/radar") is None


def test_a_path_home_matches_the_stored_string_home():
    # session.create stores ``str(profile_home)``; session.resume holds a Path.
    sessions = {"run-1": _record("k1", home="/data/profiles/radar")}

    assert find_live_unpersisted(sessions, "k1", Path("/data/profiles/radar"))[0] == "run-1"


def test_skips_a_finalized_session():
    sessions = {"run-1": _record("k1", finalized=True)}

    assert find_live_unpersisted(sessions, "k1", None) is None


def test_returns_none_when_nothing_matches():
    sessions = {"run-1": _record("k1", pending_title="Refactor the parser")}

    assert find_live_unpersisted(sessions, "k2", None) is None
    assert find_live_unpersisted(sessions, "Bot Chat", None) is None


def test_an_empty_needle_matches_nothing():
    # Without the guard, every record with no pending title compares equal to "".
    sessions = {"run-1": _record("k1")}

    assert find_live_unpersisted(sessions, "", None) is None
