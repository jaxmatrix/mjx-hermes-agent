"""Regression tests: pinned sessions survive bulk prune/archive (round-3 SES-01).

Pinning is a durable "keep" flag. Before this fix `_prune_filter_where` had no
pinned exclusion, so `hermes sessions prune`/`archive` with a filter silently
destroyed pinned conversations. These drive the real SessionDB (temp file DB).
"""

import time

import pytest

from hermes_state import SessionDB


@pytest.fixture()
def db(tmp_path):
    d = SessionDB(tmp_path / "state.db")
    yield d
    try:
        d.close()
    except Exception:
        pass


def _mk(db, sid, title, pinned=False):
    db.create_session(sid, source="cli")
    db.set_session_title(sid, title)
    # mark ended + old so it is prune-eligible
    with db._lock:
        db._conn.execute(
            "UPDATE sessions SET ended_at=?, started_at=?, message_count=1 WHERE id=?",
            (time.time() - 100 * 86400, time.time() - 100 * 86400, sid),
        )
        db._conn.commit()
    if pinned:
        db.set_session_pinned(sid, True)


def test_prune_spares_pinned_by_default(db):
    _mk(db, "20260101_000000_aaaaaa", "keep me", pinned=True)
    _mk(db, "20260101_000001_bbbbbb", "delete me", pinned=False)

    # Filter matches both by title substring "me"; default must spare pinned.
    cands = db.list_prune_candidates(title_like="me")
    ids = {c["id"] for c in cands}
    assert "20260101_000001_bbbbbb" in ids
    assert "20260101_000000_aaaaaa" not in ids  # pinned excluded

    deleted = db.prune_sessions(older_than_days=None, title_like="me")
    assert deleted == 1
    assert db.get_session("20260101_000000_aaaaaa") is not None  # pinned survived
    assert db.get_session("20260101_000001_bbbbbb") is None


def test_prune_include_pinned_opts_in(db):
    _mk(db, "20260101_000000_aaaaaa", "keep me", pinned=True)

    # With the opt-in, the pinned row IS eligible.
    cands = db.list_prune_candidates(title_like="me", include_pinned=True)
    assert {c["id"] for c in cands} == {"20260101_000000_aaaaaa"}

    deleted = db.prune_sessions(older_than_days=None, title_like="me", include_pinned=True)
    assert deleted == 1
    assert db.get_session("20260101_000000_aaaaaa") is None


def test_count_prune_matches_reflects_pinned_flag(db):
    _mk(db, "20260101_000000_aaaaaa", "keep me", pinned=True)
    _mk(db, "20260101_000001_bbbbbb", "delete me", pinned=False)

    assert db.count_prune_matches(title_like="me", include_pinned=False) == 1
    assert db.count_prune_matches(title_like="me", include_pinned=True) == 2


def test_archive_spares_pinned(db):
    _mk(db, "20260101_000000_aaaaaa", "keep me", pinned=True)
    _mk(db, "20260101_000001_bbbbbb", "arch me", pinned=False)

    archived = db.archive_sessions(older_than_days=None, title_like="me")
    assert archived == 1  # only the unpinned one


def test_empty_sweep_spares_pinned(db):
    """`Delete empty` is a bulk delete too — the keep flag must survive it.

    `delete_empty_sessions` does not go through `_prune_filter_where`, so it
    kept ignoring `pinned` after 76653a8eba fixed prune/archive.
    """
    db.create_session("20260101_000000_aaaaaa", source="cli")
    db.create_session("20260101_000001_bbbbbb", source="cli")
    db.end_session("20260101_000000_aaaaaa", "completed")
    db.end_session("20260101_000001_bbbbbb", "completed")
    db.set_session_pinned("20260101_000000_aaaaaa", True)

    assert db.count_empty_sessions() == 1  # the pinned one is not offered
    assert db.delete_empty_sessions() == 1
    assert db.get_session("20260101_000000_aaaaaa") is not None
    assert db.get_session("20260101_000001_bbbbbb") is None


# --- REST: POST /api/sessions/prune ----------------------------------------
#
# The dashboard is the only client of this route; before this change it could
# neither see that pinned rows had been spared nor opt in to deleting them.


@pytest.fixture()
def prune_client(_isolate_hermes_home):
    starlette = pytest.importorskip("starlette.testclient")
    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    hermes_state.DEFAULT_DB_PATH = get_hermes_home() / "state.db"
    client = starlette.TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return client


def _seed_rest(pinned_title, plain_title):
    """Two ended, prune-eligible rows under the isolated HERMES_HOME."""
    from hermes_state import SessionDB

    seed = SessionDB()
    try:
        for sid, title, pin in (
            ("rest-pinned", pinned_title, True),
            ("rest-plain", plain_title, False),
        ):
            seed.create_session(session_id=sid, source="prune-rest")
            seed.set_session_title(sid, title)
            seed.end_session(sid, "completed")
            if pin:
                seed.set_session_pinned(sid, True)
    finally:
        seed.close()


def test_rest_prune_dry_run_reports_pinned_spared(prune_client):
    _seed_rest("keep me", "drop me")

    body = prune_client.post(
        "/api/sessions/prune",
        json={"source": "prune-rest", "dry_run": True},
    ).json()

    assert [s["id"] for s in body["sessions"]] == ["rest-plain"]
    assert body["matched"] == 1
    assert body["skipped_pinned"] == 1


def test_rest_prune_spares_pinned_and_reports_the_count(prune_client):
    _seed_rest("keep me", "drop me")

    body = prune_client.post(
        "/api/sessions/prune", json={"source": "prune-rest"}
    ).json()

    assert body["removed"] == 1
    assert body["skipped_pinned"] == 1

    from hermes_state import SessionDB

    check = SessionDB()
    try:
        assert check.get_session("rest-pinned") is not None
        assert check.get_session("rest-plain") is None
    finally:
        check.close()


def test_rest_prune_include_pinned_opts_in(prune_client):
    _seed_rest("keep me", "drop me")

    body = prune_client.post(
        "/api/sessions/prune",
        json={"source": "prune-rest", "include_pinned": True},
    ).json()

    assert body["removed"] == 2
    # Nothing was spared, so the note must not claim otherwise.
    assert body["skipped_pinned"] == 0

    from hermes_state import SessionDB

    check = SessionDB()
    try:
        assert check.get_session("rest-pinned") is None
    finally:
        check.close()


def test_rest_prune_reports_zero_when_no_row_is_pinned(prune_client):
    """A fixture that DISAGREES with the assertion above: no pins at all."""
    from hermes_state import SessionDB

    seed = SessionDB()
    try:
        seed.create_session(session_id="rest-plain-1", source="prune-rest")
        seed.end_session("rest-plain-1", "completed")
    finally:
        seed.close()

    body = prune_client.post(
        "/api/sessions/prune", json={"source": "prune-rest"}
    ).json()

    assert body["removed"] == 1
    assert body["skipped_pinned"] == 0
