"""``subagent.complete`` must carry spend, truncation, worktree and budget state.

``_on_tool_progress``'s subagent branch is an ALLOW-LIST: a key the delegate
tool puts on the callback kwargs reaches no client unless this builder copies
it. Four facts were being dropped there (MJXHRM-459):

* ``cost_usd`` — ``delegate_tool`` has emitted it on the completion callback
  since the cost rollup landed, and both GUI clients read ``payload.cost_usd``
  and sum it into the Agents-overlay header. Dropped here, so every spawn tree
  reported ``$0.00`` however much the children spent.
* ``truncated`` — a child that exhausts its iteration budget still returns a
  summary and still reports ``status: "completed"``. Without this flag an
  overlay calls a half-finished run finished.
* ``worktree`` — under ``delegation.worktree_isolation`` the child's work lands
  on its own branch in its own checkout; the finalize report is the only thing
  that says whether there is anything there to review.
* ``budget_wrapup`` — past 80% of ``agent.run_budget_seconds`` the child is told
  to wrap up, so it ran out of TIME, not of work. A hurried child otherwise
  looks exactly like one that finished on its own.

Same argument as ``missed_steer`` (MJXHRM-410): the event stream is all a UI
gets.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def server():
    # Mocks are scoped to the initial import only (see
    # tests/tui_gateway/test_protocol.py for the rationale).
    with patch.dict(
        "sys.modules",
        {
            "hermes_constants": MagicMock(
                get_hermes_home=MagicMock(
                    return_value="/tmp/hermes_test_subagent_fields"
                )
            ),
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
            "hermes_state": MagicMock(),
        },
    ):
        import importlib

        mod = importlib.import_module("tui_gateway.server")

    yield mod
    mod._sessions.clear()


@pytest.fixture()
def emits(server, monkeypatch):
    captured: list = []
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: captured.append((event, sid, payload)),
    )
    monkeypatch.setattr(server, "_tool_progress_enabled", lambda sid: True)
    return captured


def _complete(server, **kwargs):
    server._on_tool_progress(
        "sid-1",
        "subagent.complete",
        None,
        "done",
        None,
        subagent_id="sub-1",
        goal="ship it",
        status="completed",
        **kwargs,
    )


def test_cost_truncation_and_worktree_reach_the_client(server, emits):
    _complete(
        server,
        cost_usd=0.4213,
        truncated=True,
        worktree={
            "path": "/tmp/wt/sub-1",
            "branch": "hermes/sub-1",
            "commits": 3,
            "dirty": True,
            "pruned": False,
        },
    )

    assert len(emits) == 1
    _event, _sid, payload = emits[0]
    assert payload["cost_usd"] == pytest.approx(0.4213)
    assert payload["truncated"] is True
    assert payload["worktree"]["branch"] == "hermes/sub-1"
    assert payload["worktree"]["commits"] == 3
    assert payload["worktree"]["pruned"] is False


def test_a_clean_run_states_truncated_false_rather_than_omitting_it(server, emits):
    """``False`` is a measurement, not a default.

    The client cannot tell "not truncated" from "gateway too old to say" unless
    the key is present, so the builder must copy an explicit ``False`` through
    instead of treating it as absent.
    """
    _complete(server, cost_usd=0.0, truncated=False)

    _event, _sid, payload = emits[0]
    assert payload["truncated"] is False
    assert payload["cost_usd"] == pytest.approx(0.0)


def test_omitted_fields_stay_omitted(server, emits):
    """An emitter that never mentions them must not grow invented defaults."""
    _complete(server)

    _event, _sid, payload = emits[0]
    assert "cost_usd" not in payload
    assert "truncated" not in payload
    assert "worktree" not in payload


def test_the_run_budget_wrapup_latch_reaches_the_client(server, emits):
    """A hurried child looks exactly like one that finished on its own.

    ``agent.run_budget_seconds`` applies to a delegated child like any other
    agent, and past 80% of it the child is told to wrap up. Only the latch
    knows the difference.
    """
    _complete(server, budget_wrapup=True)

    _event, _sid, payload = emits[0]
    assert payload["budget_wrapup"] is True


def test_no_budget_no_wrapup_key(server, emits):
    """Dormant when no budget is configured, which is the default."""
    _complete(server, budget_wrapup=False)

    _event, _sid, payload = emits[0]
    assert "budget_wrapup" not in payload


def test_a_non_dict_worktree_is_dropped_not_forwarded(server, emits):
    """The client indexes ``worktree.branch``; a string here would throw."""
    _complete(server, worktree="/tmp/wt/sub-1")

    _event, _sid, payload = emits[0]
    assert "worktree" not in payload
