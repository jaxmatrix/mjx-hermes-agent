import asyncio
import concurrent.futures
import datetime
import json
import threading

from tui_gateway import server
from tui_gateway import ws as ws_mod




def _run_disconnect(monkeypatch, seed):
    """Drive handle_ws to its disconnect `finally`, seeding sessions against the
    live WSTransport the moment it exists. Returns nothing; inspect _sessions."""
    # Disable the grace-reap Timer: detached sessions normally schedule a
    # threading.Timer via _schedule_ws_orphan_reap, which would outlive the test
    # and fire _reap during interpreter teardown — touching _sessions/DB and
    # producing spurious post-run errors under the per-file CI runner. Grace=0
    # short-circuits the Timer (see _schedule_ws_orphan_reap) so the test leaves
    # no lingering thread.
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)

    # Mirror the real _finalize_session chokepoint: it is the single place that
    # closes the slash-worker (#38095). Stub it but keep that behavior so the
    # disconnect-reap path still exercises worker teardown.
    def _fake_finalize(s, end_reason="tui_close"):
        w = s.get("slash_worker")
        if w:
            w.close()

    monkeypatch.setattr(server, "_finalize_session", _fake_finalize)

    created = []
    real_transport = ws_mod.WSTransport
    monkeypatch.setattr(
        ws_mod, "WSTransport",
        lambda ws, loop, **kw: created.append(real_transport(ws, loop, **kw)) or created[-1],
    )

    class FakeWS:
        async def accept(self):
            pass

        async def send_text(self, line):
            pass

        async def receive_text(self):
            seed(created[0])  # transport now exists; attach it to sessions
            raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    asyncio.run(ws_mod.handle_ws(FakeWS()))


def test_ws_disconnect_reaps_flagged_session_and_closes_worker(monkeypatch):
    closed = []

    class FakeWorker:
        def close(self):
            closed.append(True)

    server._sessions.clear()
    try:
        _run_disconnect(
            monkeypatch,
            lambda t: server._sessions.update(
                flagged={
                    "transport": t,
                    "close_on_disconnect": True,
                    "slash_worker": FakeWorker(),
                    "session_key": "k",
                }
            ),
        )
        assert "flagged" not in server._sessions
        assert closed == [True]
    finally:
        server._sessions.clear()




def test_ws_connection_registers_then_disconnect_unregisters_live_transport(monkeypatch):
    """A connected client must be tracked in the live-transport registry so a
    session-less global broadcast (skin.changed from the background watcher)
    reaches it, and dropped on disconnect so no stale write targets a dead peer.
    This is the WS half of the cross-surface live-theme fix."""
    server._sessions.clear()
    server._live_transports.clear()
    seen = {}
    try:
        _run_disconnect(
            monkeypatch,
            lambda t: seen.__setitem__("registered", t in server._live_transports),
        )
        # Seeded at receive_text time — i.e. after gateway.ready registered it.
        assert seen["registered"] is True
        # handle_ws's finally must have unregistered it.
        assert not server._live_transports
    finally:
        server._sessions.clear()
        server._live_transports.clear()


def test_ws_disconnect_releases_wake_word_owner(monkeypatch):
    released = []
    created = []
    monkeypatch.setattr(
        server,
        "_release_wake_for_transport",
        lambda transport: released.append(transport) or True,
    )

    _run_disconnect(monkeypatch, lambda transport: created.append(transport))

    assert released == created






def test_ws_ready_advertises_heartbeat_and_ping_is_inline(monkeypatch):
    sent = []
    inbound = iter(
        [
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "heartbeat-1",
                    "method": "gateway.ping",
                    "params": {},
                }
            )
        ]
    )
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)

    class FakeWS:
        async def accept(self):
            pass

        async def send_text(self, line):
            sent.append(json.loads(line))

        async def receive_text(self):
            try:
                return next(inbound)
            except StopIteration:
                raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    asyncio.run(ws_mod.handle_ws(FakeWS()))

    ready = sent[0]["params"]
    assert ready["type"] == "gateway.ready"
    assert ready["payload"]["heartbeat"] is True
    assert sent[1] == {
        "jsonrpc": "2.0",
        "result": {"ok": True},
        "id": "heartbeat-1",
    }


def test_ws_transport_serializes_concurrent_sends():
    active_sends = 0
    max_active_sends = 0
    sent = []

    class FakeWS:
        async def send_text(self, line):
            nonlocal active_sends, max_active_sends
            active_sends += 1
            max_active_sends = max(max_active_sends, active_sends)
            try:
                await asyncio.sleep(0.05)
                sent.append(line)
            finally:
                active_sends -= 1

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        transport = ws_mod.WSTransport(FakeWS(), loop, peer="serialize-test")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(transport.write, {"idx": 1}),
                pool.submit(transport.write, {"idx": 2}),
            ]
            assert [f.result(timeout=2) for f in futures] == [True, True]

        assert len(sent) == 2
        assert max_active_sends == 1
        assert transport._closed is False
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()


def test_ws_transport_replies_with_error_for_unserializable_response(caplog):
    """#92506: an unserializable payload (datetime from profile.yaml ui_meta) must surface as a
    JSON-RPC error frame with the original id plus a log line — on both the worker-thread
    ``write`` and the loop-side ``write_async`` twin — and leave the transport open, instead of
    killing the pool worker silently so the client waits forever."""
    sent = []

    class FakeWS:
        async def send_text(self, line):
            sent.append(json.loads(line))

    bad = {"jsonrpc": "2.0", "id": "profiles", "result": {"created": datetime.datetime(2026, 8, 22)}}

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        transport = ws_mod.WSTransport(FakeWS(), loop, peer="serialization-test")
        assert transport.write(bad) is True
        assert transport.write({"jsonrpc": "2.0", "id": "next", "result": {}}) is True
        assert asyncio.run_coroutine_threadsafe(transport.write_async(bad), loop).result(5) is True
        assert transport.closed is False
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()

    assert [m.get("id") for m in sent] == ["profiles", "next", "profiles"]
    for frame in (sent[0], sent[2]):
        assert frame["error"]["code"] == -32603
        assert frame["error"]["message"].startswith("response serialization error")
        assert "datetime" in frame["error"]["message"]
    assert sent[1] == {"jsonrpc": "2.0", "id": "next", "result": {}}
    assert caplog.text.count("frame serialization failed") == 2


def test_ws_transport_preserves_cross_batch_order():
    async def scenario():
        entered = []
        first_entered = asyncio.Event()
        release_first = asyncio.Event()
        second_started = asyncio.Event()

        class FakeWS:
            async def send_text(self, line):
                entered.append(line)
                if line == "A1":
                    first_entered.set()
                    await release_first.wait()

        transport = ws_mod.WSTransport(
            FakeWS(), asyncio.get_running_loop(), peer="batch-order-test"
        )
        first = asyncio.create_task(transport._safe_send_many(["A1", "A2"]))
        await first_entered.wait()

        async def send_second():
            second_started.set()
            await transport._safe_send_many(["B1", "B2"])

        second = asyncio.create_task(send_second())
        await second_started.wait()

        # The second task has reached the transport. Without whole-batch
        # serialization it runs B1/B2 before this task can resume.
        assert entered == ["A1"]

        release_first.set()
        await asyncio.gather(first, second)
        assert entered == ["A1", "A2", "B1", "B2"]

    asyncio.run(scenario())




# ---------------------------------------------------------------------------
# Concurrent sessions on ONE websocket.
#
# The client demuxes purely on params.session_id, so these guard the two
# property that makes possible: every frame is attributed (MJX-132). A second
# viewer no longer displaces the first at all — sessions fan out to every
# attached transport (tests/tui_gateway/test_multi_client_fanout.py).
# ---------------------------------------------------------------------------


def test_event_frames_always_carry_their_session_id():
    """`_event_frame` is the single builder for every event the gateway emits."""
    # Only events whose contract takes a bare ``text`` payload: ``_event_frame`` validates the payload.
    for event in ("message.delta", "reasoning.delta"):
        for sid in ("session-a", "session-b"):
            frame = server._event_frame(event, sid, {"text": "x"})

            assert frame["method"] == "event"
            assert frame["params"]["session_id"] == sid
            assert frame["params"]["type"] == event

    # A payload-less frame still carries its id (payload is the optional half).
    assert server._event_frame("message.start", "session-a")["params"] == {
        "type": "message.start",
        "session_id": "session-a",
    }


def test_two_sessions_on_one_transport_keep_their_own_ids():
    """Interleaved emits from two sessions never borrow each other's id."""
    written = []

    class RecordingTransport:
        def write(self, obj):
            written.append(obj)
            return True

    transport = RecordingTransport()

    for sid, text in (("a", "A1"), ("b", "B1"), ("a", "A2"), ("b", "B2")):
        transport.write(server._event_frame("message.delta", sid, {"text": text}))

    by_session = {}
    for frame in written:
        params = frame["params"]
        by_session.setdefault(params["session_id"], []).append(params["payload"]["text"])

    assert by_session == {"a": ["A1", "A2"], "b": ["B1", "B2"]}


def test_secret_capture_callback_is_thread_local():
    """Concurrent turns must not share one session's secret-capture callback.

    The gateway wires this per turn with a callback closed over that turn's
    session id; as a module global the last writer won, so a secret prompt
    raised by session A could be emitted carrying session B's id.
    """
    from tools import skills_tool

    previous_default = skills_tool._secret_capture_callback
    seen = {}
    barrier = threading.Barrier(2)

    def worker(sid):
        skills_tool.set_secret_capture_callback(lambda: sid, thread_only=True)
        barrier.wait(timeout=5)  # let the other thread install its callback too
        seen[sid] = skills_tool.get_secret_capture_callback()()

    try:
        threads = [threading.Thread(target=worker, args=(sid,)) for sid in ("a", "b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        assert seen == {"a": "a", "b": "b"}
        # thread_only must leave the process-wide default untouched.
        assert skills_tool._secret_capture_callback is previous_default
    finally:
        skills_tool._secret_capture_callback = previous_default
        skills_tool._secret_capture_tls.callback = None
