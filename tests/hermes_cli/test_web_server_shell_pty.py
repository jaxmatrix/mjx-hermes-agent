"""The /api/shell-pty endpoint: spawns the operator's $SHELL and pumps bytes
(keystrokes in, output out) with the shared `\\x1b[RESIZE:cols;rows]` resize
escape consumed server-side. Mirrors tests/test_pty_keepalive_ws.py's approach:
monkeypatch PtyBridge.spawn with a fake, bypass the WS auth gates."""

import pytest

from hermes_cli import web_server


@pytest.mark.asyncio
async def test_shell_pty_spawns_shell_and_pumps(monkeypatch):
    captured = {}
    resizes = []

    class FakeBridge:
        def __init__(self):
            self._outbox = [b"welcome\r\n"]  # a fresh shell's first prompt

        def read(self, timeout):
            return self._outbox.pop(0) if self._outbox else b""

        def write(self, data):
            self._outbox.append(bytes(data))  # a shell echoes stdin back to the tty

        def resize(self, cols, rows):
            resizes.append((cols, rows))

        def close(self):
            pass

    def fake_spawn(argv, **kwargs):
        captured["argv"] = list(argv)
        captured["cwd"] = kwargs.get("cwd")
        captured["env"] = kwargs.get("env") or {}
        return FakeBridge()

    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))
    monkeypatch.setattr(web_server, "_PTY_BRIDGE_AVAILABLE", True)
    monkeypatch.setattr(web_server, "_ws_auth_reason", lambda ws: (None, "test"))
    monkeypatch.setattr(web_server, "_ws_host_origin_reason", lambda ws: None)
    monkeypatch.setattr(web_server, "_ws_client_reason", lambda ws: None)

    from starlette.testclient import TestClient

    client = TestClient(web_server.app)
    with client.websocket_connect("/api/shell-pty") as ws:
        assert ws.receive_bytes() == b"welcome\r\n"
        # The resize escape is consumed by the pump, never written to the PTY.
        ws.send_bytes(b"\x1b[RESIZE:120;40]")
        # A keystroke reaches bridge.write and is echoed straight back.
        ws.send_bytes(b"echo hi\r")
        assert ws.receive_bytes() == b"echo hi\r"

    # It spawned a shell (argv[0] a shell path) with a real cwd + a terminal env.
    assert captured["argv"] and captured["argv"][0]
    assert captured["cwd"]
    assert captured["env"].get("TERM") == "xterm-256color"
    assert resizes == [(120, 40)]


@pytest.mark.asyncio
async def test_shell_pty_rejects_unauthenticated(monkeypatch):
    monkeypatch.setattr(web_server, "_ws_auth_reason", lambda ws: ("missing", ""))

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(web_server.app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/api/shell-pty") as ws:
            ws.receive_bytes()

    assert excinfo.value.code == 4401
