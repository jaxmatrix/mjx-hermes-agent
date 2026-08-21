import asyncio

from hermes_cli import web_server


class _FakeSessionDB:
    """Fake backing the /api/sessions/search endpoint.

    The endpoint surfaces direct session-id matches first, then FTS message
    matches, deduping both by compression lineage root. This fake has no
    compression chains (get_session returns no parent), so each session is its
    own lineage root.
    """

    closed = False
    opened_read_only = None
    requested_fields = None

    def __init__(self, *args, **kwargs):
        type(self).opened_read_only = kwargs.get("read_only")

    @staticmethod
    def _source_allowed(row, source=None, sources=None, exclude_sources=None):
        row_source = row.get("source")
        if source and row_source != source:
            return False
        if sources and row_source not in sources:
            return False
        if exclude_sources and row_source in exclude_sources:
            return False
        return True

    def search_sessions_by_id(
        self,
        query,
        limit=20,
        include_archived=True,
        source=None,
        sources=None,
        exclude_sources=None,
    ):
        assert query == "20260603"
        assert include_archived is True
        rows = [
            {
                "id": "20260603_090200_exact",
                "preview": "ID match preview",
                "source": "cli",
                "model": "claude",
                "started_at": 100,
            }
        ]
        return [
            row
            for row in rows
            if self._source_allowed(
                row, source=source, sources=sources, exclude_sources=exclude_sources
            )
        ][:limit]

    def search_messages(
        self,
        query,
        source_filter=None,
        exclude_sources=None,
        limit=20,
        fields=None,
    ):
        assert query == "20260603*"
        type(self).requested_fields = fields
        rows = [
            {
                "session_id": "20260603_090200_exact",
                "snippet": "duplicate content hit should not replace ID hit",
                "role": "user",
                "source": "cli",
                "model": "claude",
                "session_started": 100,
            },
            {
                "session_id": "content_session",
                "snippet": "content hit",
                "role": "assistant",
                "source": "desktop",
                "model": "gpt",
                "session_started": 200,
            },
        ]
        return [
            row
            for row in rows
            if self._source_allowed(
                row, sources=source_filter, exclude_sources=exclude_sources
            )
        ][:limit]

    def get_session(self, session_id):
        # No compression chains in this fixture — every session is its own root.
        return {"id": session_id, "parent_session_id": None}

    def get_compression_tip(self, session_id):
        return session_id

    def close(self):
        self.closed = True


def test_desktop_session_search_merges_id_matches_before_content_matches(monkeypatch):
    _FakeSessionDB.opened_read_only = None
    _FakeSessionDB.requested_fields = None
    monkeypatch.setattr("hermes_state.SessionDB", _FakeSessionDB)

    response = asyncio.run(web_server.search_sessions(q="20260603", limit=2))

    assert _FakeSessionDB.requested_fields is not None
    assert "context" not in _FakeSessionDB.requested_fields
    # ID match surfaces first; the content hit on the SAME session is deduped
    # by lineage root (not double-listed); the unrelated content hit follows.
    assert response == {
        "results": [
            {
                "id": "20260603_090200_exact",
                "session_id": "20260603_090200_exact",
                "lineage_root": "20260603_090200_exact",
                "snippet": "ID match preview",
                "role": None,
                "source": "cli",
                "model": "claude",
                "session_started": 100,
            },
            {
                "id": "content_session",
                "session_id": "content_session",
                "lineage_root": "content_session",
                "snippet": "content hit",
                "role": "assistant",
                "source": "desktop",
                "model": "gpt",
                "session_started": 200,
            },
        ]
    }
    assert _FakeSessionDB.opened_read_only is True


class _HiddenAwareSessionDB(_FakeSessionDB):
    """Same fixture, but with the rich-row lookup the endpoint enriches from.

    `session.set_hidden` keeps a session fully resumable while dropping it from
    the shared sessions list. Every listing route honours that through
    `list_sessions_rich(include_hidden=False)`; search enriches from
    `get_session_rich_row` instead, so without an explicit guard a query that
    matched the hidden chat's text put the row straight back on screen.
    """

    def get_session_rich_row(self, session_id):
        return {
            "id": session_id,
            "hidden": 1 if session_id == "content_session" else 0,
            "source": "desktop",
            "model": "gpt",
            "title": None,
            "started_at": 200,
            "ended_at": None,
            "last_active": 200,
            "message_count": 3,
            "tool_call_count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "preview": None,
            "parent_session_id": None,
            "archived": 0,
        }


def test_session_search_drops_hidden_sessions(monkeypatch):
    monkeypatch.setattr("hermes_state.SessionDB", _HiddenAwareSessionDB)

    response = asyncio.run(web_server.search_sessions(q="20260603", limit=5))

    ids = [result["session_id"] for result in response["results"]]
    # The fixture makes BOTH sessions match the query and marks only
    # `content_session` hidden — so a passing assertion needs the filter, not a
    # fixture that had nothing to drop.
    assert ids == ["20260603_090200_exact"]
