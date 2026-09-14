"""Exact-title session resolution — the one copy of the eligibility policy.

Bot Mode's canonical chat and a user's ordinary sessions are SEPARATE
entities: two modes of conversation that must never overlap.  A bot's chat is
identified by name — the pair ``(profile, session titled exactly "Bot Chat")``
— and the core schema's UNIQUE title index makes that pair a registry holding
at most one row per database.

Two callers need that resolution and they must not drift apart:

* ``session.list {title}`` — the client's own registry lookup on the click
  path;
* ``profiles.list``'s ``canonical_session`` — the same answer, resolved
  server-side for a whole roster in one call, so a row's preview and the row's
  click target are the same session by construction.

They differ only in how they project the result, which is the one place two
handlers should differ.  The policy below is shared so a change to the
deny-list, to archiving, or to lineage resolution cannot land in one and miss
the other.
"""

from __future__ import annotations

from typing import Any, Optional, Tuple

# Internal machinery that is not a conversation.  A ``kanban`` dispatcher or a
# ``tool`` sub-agent run that happens to carry the canonical title is a worker,
# not the user's chat with their bot, and treating it as one is exactly the
# overlap this module exists to prevent.
DENY_SOURCES = frozenset({"kanban", "tool"})


def resolve_titled_session(db: Any, title: str) -> Optional[Tuple[dict, str, dict]]:
    """``(root_row, tip_id, tip_row)`` for an eligible exact-title hit, else None.

    EXACT lookup, never a search:

    * hidden rows DO resolve — a canonical chat is born hidden, and hidden
      means "not in shared lists", not "does not exist";
    * archived rows and deny-listed sources count as ABSENT;
    * a compression lineage resolves to its live tip, while the returned root
      stays the row that carries the title.

    Never consults recency, visibility, or "where the user left off".  In
    particular this must NOT use ``hermes_state.resolve_session_by_title``,
    which falls back to numbered ``"<title> #N"`` variants and prefers the
    newest of them — precisely the guess a registry lookup may not make.

    Returns ``None`` for "no eligible row".  It does not catch storage errors:
    a caller that cannot tell "looked and found nothing" from "could not look"
    would report a missing chat where none was proven missing, and a client
    reading that would mint a duplicate.  Callers handle that distinction.
    """
    row = db.get_session_by_title(title)

    if not row or row.get("archived") or (row.get("source") or "").strip().lower() in DENY_SOURCES:
        return None

    try:
        tip = db.resolve_resume_session_id(row["id"]) or row["id"]
    except Exception:
        # A broken lineage is not a missing session: the root is still the
        # registry's answer, and resuming it is better than reporting nothing.
        tip = row["id"]

    tip_row = (db.get_session(tip) or row) if tip != row["id"] else row

    return row, tip, tip_row
