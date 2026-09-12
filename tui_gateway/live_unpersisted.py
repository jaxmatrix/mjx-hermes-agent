"""Find a LIVE session that has no database row yet.

``session.create`` deliberately persists nothing — the row is created lazily on
the first prompt — so a session can be fully live in ``_sessions`` while
``state.db`` has never heard of it. Every fresh Bot Chat is exactly that until
its first message lands, and so is any draft whose first prompt has not.

``session.resume`` looked the target up in the database and answered 4007
"session not found" before it ever consulted the live sessions, so a client
that opened such a session by its durable key was refused a session the
gateway was holding in memory. Upstream's ``_find_live_unpersisted`` closes
exactly this: "a 404 here killed messaging for never-spoken bots."

Pure, so the matching rule is testable without a running gateway.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Tuple


def find_live_unpersisted(
    sessions: Mapping[str, Any],
    needle: str,
    profile_home: Any,
) -> Optional[Tuple[str, dict]]:
    """``(runtime_sid, record)`` for a live session matching ``needle``, else None.

    Matches the durable ``session_key``, or a title still waiting in
    ``pending_title`` — so a resume by stored id and a resume by exact title both
    reach a session that has not been written yet.

    Never crosses profiles: the record's ``profile_home`` must equal the one this
    resume is scoped to. Two profiles can hold unrelated sessions with the same
    title, and reattaching another profile's session is a conversation forked
    into the wrong database. A finalized record is skipped, as the live fast path
    skips it. An empty needle matches nothing — every record without a pending
    title would otherwise compare equal to it.
    """
    if not needle:
        return None

    want_home = str(profile_home) if profile_home is not None else None

    for sid, record in list(sessions.items()):
        if not isinstance(record, dict) or record.get("_finalized"):
            continue
        if (record.get("profile_home") or None) != want_home:
            continue
        if str(record.get("session_key") or "") == needle or (record.get("pending_title") or "") == needle:
            return sid, record

    return None
