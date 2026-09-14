"""Tests: profiles.list ``canonical_session`` — the bot's chat, resolved by title.

Why: a bot's canonical chat and a user's ordinary sessions are SEPARATE
entities — two modes of conversation that must never overlap.  Identity is the
pair ``(profile, session titled exactly "Bot Chat")``; there is no
client-supplied session-id pin, and recency is never consulted.  Resolving it
server-side is what makes a roster row's preview and the session that row's
click opens the same session by construction.

Contract under test:
- ``canonical_session`` is a summary dict for an eligible exact-title hit,
  mirroring ``preferred_session``'s keys so clients need no new parsing.
- Hidden rows DO resolve (a canonical chat is born hidden).
- Archived rows and deny-listed internal sources (``kanban``/``tool``) count
  as ABSENT — a worker carrying the title is not a conversation.
- Compression lineages resolve to the live tip while ``id`` stays the root.
- ``null`` means "looked, there is none". An ABSENT key means "could not
  look" — a distinction the client depends on, because reading a failure as
  "no chat exists" makes it mint a duplicate and fork the bot's memory.
- ``canonical_session_title`` on the envelope discloses the capability.
- Matching is EXACT: no case-folding, no trimming, and never the numbered
  ``"<title> #N"`` lineage variants ``resolve_session_by_title`` would find.
- ``last_session`` behaviour is unchanged, and never substituted.
"""

from __future__ import annotations

import pytest

import tui_gateway.server as srv
from tools.bot_mode_probe import BOT_CHAT_TITLE


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Temp HERMES_HOME with the default profile plus one named profile."""
    h = tmp_path / ".hermes"
    (h / "profiles" / "ops").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    return h


def _db(profile_dir):
    from hermes_state import SessionDB

    return SessionDB(db_path=profile_dir / "state.db")


def _add_session(db, sid, *, source="cli", title="", ts, text, hidden=False,
                 parent=None, end_reason=None, archived=False):
    """One session with a single user message at an exact timestamp.

    NOTE: ``idx_sessions_title_unique`` is a UNIQUE partial index on
    ``sessions(title)``, so every session in one db needs a DISTINCT title —
    two rows both defaulting to "" raise IntegrityError.
    """
    db.create_session(sid, source, parent_session_id=parent)
    db.append_message(sid, "user", text, timestamp=ts)
    with db._lock:
        db._conn.execute("UPDATE sessions SET title = ? WHERE id = ?", (title, sid))
        if archived:
            db._conn.execute("UPDATE sessions SET archived = 1 WHERE id = ?", (sid,))
        if end_reason:
            db._conn.execute(
                "UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?",
                (ts + 1, end_reason, sid),
            )
    if hidden:
        db.set_session_hidden(sid, True)


def _envelope(params):
    return srv._methods["profiles.list"](1, params)["result"]


def _profiles(params):
    return _envelope(params)["profiles"]


def _row(profiles, name):
    return next(p for p in profiles if p["name"] == name)


# ---------------------------------------------------------------------------
# The anti-recency contract
# ---------------------------------------------------------------------------


def test_canonical_wins_over_a_newer_ordinary_session(home):
    """The bot's chat is the bot's chat, however recently the user chatted."""
    db = _db(home)
    _add_session(db, "botchat", title=BOT_CHAT_TITLE, ts=1000, text="bot words", hidden=True)
    _add_session(db, "ordinary", title="Refactor the parser", ts=9000, text="user words")

    row = _row(_profiles({}), "default")

    assert row["canonical_session"]["id"] == "botchat"
    assert row["canonical_session"]["preview"] == "bot words"
    # last_session still reports recency — the two answer different questions.
    assert row["last_session"]["id"] == "ordinary"


def test_no_bot_chat_is_an_explicit_null(home):
    """Looked, and there is none — distinct from having failed to look."""
    db = _db(home)
    _add_session(db, "ordinary", title="Refactor the parser", ts=1000, text="user words")

    row = _row(_profiles({}), "default")

    assert "canonical_session" in row
    assert row["canonical_session"] is None
    assert row["last_session"]["id"] == "ordinary"


def test_a_hidden_bot_chat_still_resolves(home):
    """Hidden means "not in shared lists", never "does not exist"."""
    db = _db(home)
    _add_session(db, "botchat", title=BOT_CHAT_TITLE, ts=1000, text="hi", hidden=True)

    row = _row(_profiles({}), "default")

    assert row["canonical_session"]["id"] == "botchat"
    # It is hidden, so the recency listing cannot see it at all.
    assert row["last_session"] is None


def test_an_archived_bot_chat_counts_as_absent(home):
    """And the ordinary session must not be substituted for it."""
    db = _db(home)
    _add_session(db, "botchat", title=BOT_CHAT_TITLE, ts=1000, text="hi", archived=True)
    _add_session(db, "ordinary", title="Refactor the parser", ts=2000, text="user words")

    row = _row(_profiles({}), "default")

    assert row["canonical_session"] is None


@pytest.mark.parametrize("source", ["kanban", "tool"])
def test_a_denied_worker_carrying_the_title_is_not_a_conversation(home, source):
    db = _db(home)
    _add_session(db, "worker", source=source, title=BOT_CHAT_TITLE, ts=1000, text="working")

    row = _row(_profiles({}), "default")

    assert row["canonical_session"] is None


def test_a_compression_lineage_resolves_to_the_tip_and_keeps_the_root(home):
    db = _db(home)
    _add_session(db, "root", title=BOT_CHAT_TITLE, ts=1000, text="early",
                 end_reason="compression")
    _add_session(db, "tip", title=f"{BOT_CHAT_TITLE} (continued)", ts=3000, text="later",
                 parent="root")

    canonical = _row(_profiles({}), "default")["canonical_session"]

    assert canonical["id"] == "root"
    assert canonical["resolved_id"] == "tip"
    assert canonical["root_title"] == BOT_CHAT_TITLE
    assert canonical["title"] == f"{BOT_CHAT_TITLE} (continued)"
    assert canonical["preview"] == "later"


# ---------------------------------------------------------------------------
# Could-not-look degrades to SILENCE, never to a false negative
# ---------------------------------------------------------------------------


def test_a_missing_database_omits_the_key_rather_than_reporting_none(home):
    """`ops` has no state.db. Absent ≠ null: null would make a client mint."""
    db = _db(home)
    _add_session(db, "botchat", title=BOT_CHAT_TITLE, ts=1000, text="hi")

    profiles = _profiles({})

    assert "canonical_session" not in _row(profiles, "ops")
    # …and one unreadable profile never costs another profile its answer.
    assert _row(profiles, "default")["canonical_session"]["id"] == "botchat"


def test_a_corrupt_database_omits_the_key(home):
    (home / "profiles" / "ops" / "state.db").write_bytes(b"not a database at all")
    db = _db(home)
    _add_session(db, "botchat", title=BOT_CHAT_TITLE, ts=1000, text="hi")

    profiles = _profiles({})

    assert "canonical_session" not in _row(profiles, "ops")
    assert _row(profiles, "default")["canonical_session"]["id"] == "botchat"


# ---------------------------------------------------------------------------
# Exactness, scoping, and the envelope
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "title", ["bot chat", "Bot Chat ", "Bot Chat #2", "My Bot Chat", "BOT CHAT"]
)
def test_only_an_exact_title_counts(home, title):
    """Pins the ban on resolve_session_by_title's numbered-variant fallback."""
    db = _db(home)
    _add_session(db, "nearly", title=title, ts=1000, text="close but no")

    assert _row(_profiles({}), "default")["canonical_session"] is None


def test_each_profile_reads_its_own_database(home):
    _add_session(_db(home), "mine", title=BOT_CHAT_TITLE, ts=1000, text="default words")
    _add_session(_db(home / "profiles" / "ops"), "theirs", title=BOT_CHAT_TITLE, ts=1000,
                 text="ops words")

    profiles = _profiles({})

    assert _row(profiles, "default")["canonical_session"]["preview"] == "default words"
    assert _row(profiles, "ops")["canonical_session"]["preview"] == "ops words"


def test_include_sessions_false_skips_it_entirely(home):
    db = _db(home)
    _add_session(db, "botchat", title=BOT_CHAT_TITLE, ts=1000, text="hi")

    row = _row(_profiles({"include_sessions": False}), "default")

    assert "canonical_session" not in row
    assert "last_session" not in row


def test_the_envelope_discloses_the_capability_and_the_title(home):
    envelope = _envelope({})

    assert envelope["canonical_session_title"] == BOT_CHAT_TITLE
    assert envelope["bot_mode_protocol"] is True


def test_the_pin_path_still_works_alongside_it(home):
    """Backward compatibility: both resolve, and agree when the pin is right."""
    db = _db(home)
    _add_session(db, "botchat", title=BOT_CHAT_TITLE, ts=1000, text="hi", hidden=True)

    row = _row(_profiles({"preferred_session_ids": {"default": "botchat"}}), "default")

    assert row["preferred_session"]["id"] == "botchat"
    assert row["canonical_session"]["id"] == "botchat"
