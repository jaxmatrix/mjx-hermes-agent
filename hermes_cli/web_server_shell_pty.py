"""Shell-pane PTY helpers for ``/api/shell-pty`` (route in ``web_routers/chat_ws.py``).

Unlike ``/api/pty`` (which spawns the Hermes TUI), ``/api/shell-pty`` spawns an
interactive login shell for the Hermes Universal app's right-pane terminal. These
helpers decide whether that shell is enabled, which backend hosts it, and — when
hosting it would be unsafe — refuse instead of silently handing out an unsandboxed
host shell. Re-exported from ``hermes_cli.web_server`` so ``web_server.<name>``
keeps resolving (the terminal-backend picker late-binds ``_effective_terminal_backend``).
"""

from __future__ import annotations

import logging
import os
import subprocess

from hermes_cli.web_deps import late

_log = logging.getLogger("hermes_cli.web_server")

# Late-bound so a test's monkeypatch on this module (or the owning module) wins.
load_config = late("load_config", "hermes_cli.config")
_probe_docker_backend = late("_probe_docker_backend", "hermes_cli.web_routers.tools")
_probe_ssh_backend = late("_probe_ssh_backend", "hermes_cli.web_routers.tools")
_terminal_cfg_value = late("_terminal_cfg_value", "hermes_cli.web_routers.tools")
_fs_default_cwd = late("_fs_default_cwd", "hermes_cli.web_routers.files")
_fs_path = late("_fs_path", "hermes_cli.web_server_files")


_SHELL_PTY_ENV_ALLOW = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "TZ", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK",  # SSH_AUTH_SOCK = agent-forwarding handle
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
    "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "HERMES_DOCKER_BINARY",
})


def _shell_pty_env() -> dict[str, str]:
    """Env for the shell-pty child: an allowlist of the gateway's env, plus the
    fixed TERM_* overrides. Deliberately drops API keys / tokens (a login shell
    re-sources the user's rc files, so an interactive user loses nothing real)."""
    env = {k: v for k, v in os.environ.items() if k in _SHELL_PTY_ENV_ALLOW}
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["TERM_PROGRAM"] = "Hermes"
    env["HERMES_UNIVERSAL_TERMINAL"] = "1"
    return env


def _normalize_shell_pty_mode(value) -> str:
    """Normalize ``terminal.shell_pty`` into ``"auto"`` or ``"off"``.

    YAML 1.1 (which ``load_config`` uses) parses a bare ``off`` as the boolean
    ``False``, so the documented form in ``cli-config.yaml.example`` —
    ``shell_pty: off`` — never arrives here as the string ``"off"``; collapsing
    that ``False`` to ``"auto"`` left the host shell ENABLED on a gateway whose
    operator had switched it off. The bridged path fails the same way:
    ``apply_terminal_config_to_env`` stringifies the boolean into
    ``TERMINAL_SHELL_PTY="False"``, and ``"false" != "off"``. So accept every shape
    a real config can produce (mirrors ``tools.approval._normalize_approval_mode``).
    """
    _VALID_MODES = ("auto", "off")
    if isinstance(value, bool):
        return "off" if value is False else "auto"
    if isinstance(value, str):
        normalized = value.strip().lower()
        if not normalized:
            return "auto"
        if normalized in {"off", "false", "no", "0"}:
            return "off"
        if normalized in _VALID_MODES:
            return normalized
        _log.warning(
            "Unknown terminal.shell_pty %r — defaulting to 'auto' (enabled). Valid values: %s",
            value, ", ".join(_VALID_MODES),
        )
        return "auto"
    if isinstance(value, (int, float)):
        return "off" if value == 0 else "auto"
    # None (YAML `null`/`~`) and anything exotic: unset means enabled.
    return "auto"


def _shell_pty_disabled_reason() -> str | None:
    """None if shell-pty is enabled; else a short reason string."""
    val = os.environ.get("TERMINAL_SHELL_PTY")
    if val is None:
        try:
            val = ((load_config().get("terminal") or {}).get("shell_pty"))
        except Exception:
            val = None
    if _normalize_shell_pty_mode(val) == "off":
        return "shell terminal is disabled by configuration (terminal.shell_pty: off)"
    return None


def _effective_terminal_backend(terminal_cfg: dict | None = None) -> tuple[str, str]:
    """``(effective, configured)`` for ``terminal.backend``.

    *configured* is what ``config.yaml`` says. *effective* is what the running
    process will actually use: ``TERMINAL_ENV`` wins, and it is pinned into
    ``os.environ`` at startup by ``apply_terminal_config_to_env``. The two disagree
    whenever config is edited at runtime until a restart, so callers that report
    state to a human must show both.
    """
    if terminal_cfg is None:
        try:
            terminal_cfg = load_config().get("terminal")
        except Exception:
            terminal_cfg = None
    if not isinstance(terminal_cfg, dict):
        terminal_cfg = {}

    configured = str(terminal_cfg.get("backend") or "local").strip().lower() or "local"
    effective = (os.environ.get("TERMINAL_ENV") or "").strip().lower() or configured
    return effective, configured


def _resolve_shell_pty_backend(terminal_cfg: dict | None = None) -> str:
    """Which backend hosts the shell pane (``/api/shell-pty``).

    ``terminal.shell_pty_backend`` routes the pane independently of the agent, so
    ``terminal.backend: docker`` can keep agent execution sandboxed while the pane
    shells into the host. ``auto`` (the default) inherits the effective
    ``terminal.backend``. Deliberately absent from ``TERMINAL_CONFIG_ENV_MAP``, so a
    config edit takes effect on the next connection. Shared with the
    terminal-backend picker and the startup bind warning so they cannot disagree.
    """
    if terminal_cfg is None:
        try:
            terminal_cfg = load_config().get("terminal")
        except Exception:
            terminal_cfg = None
    if not isinstance(terminal_cfg, dict):
        terminal_cfg = {}

    raw = os.environ.get("TERMINAL_SHELL_PTY_BACKEND")
    if raw is None:
        raw = terminal_cfg.get("shell_pty_backend")
    backend = "auto" if isinstance(raw, bool) or raw is None else str(raw).strip().lower()
    if backend in {"", "auto", "inherit"}:
        return _effective_terminal_backend(terminal_cfg)[0]
    return backend


def _shell_pty_allow_unsandboxed() -> bool:
    """True when the operator has opted into the unsandboxed host shell on a
    network-exposed bind. Off by default: with it on, any valid dashboard session is
    host code execution as the gateway user. Env wins over config."""
    from utils import is_truthy_value

    val = os.environ.get("TERMINAL_ALLOW_UNSANDBOXED_SHELL")
    if val is None:
        try:
            val = ((load_config().get("terminal") or {}).get("allow_unsandboxed_shell"))
        except Exception:
            val = None
    return is_truthy_value(val)


def _shell_pty_target(
    cwd_param: str | None, *, network_exposed: bool
) -> tuple[list[str], dict, str | None, str | None]:
    """Resolve the interactive-shell target for /api/shell-pty by backend.

    Returns ``(argv, env, cwd, refusal_reason)``. A non-None *refusal_reason*
    means REFUSE (the caller closes 4404) and NEVER fall back to an unsandboxed
    host shell. Shells out to ``docker info``/``docker ps`` (up to ~2s), so call
    it via ``asyncio.to_thread`` — never on the event loop.
    """
    try:
        terminal_cfg = load_config().get("terminal")
    except Exception:
        terminal_cfg = None
    if not isinstance(terminal_cfg, dict):
        terminal_cfg = {}

    backend = _resolve_shell_pty_backend(terminal_cfg)

    if backend == "local":
        # An unsandboxed host shell reachable off-box is host code execution for
        # anyone holding a session, so it stays refused unless the operator says so.
        if network_exposed and not _shell_pty_allow_unsandboxed():
            return (
                [], {}, None,
                "the gateway is network-exposed and the shell backend is "
                "unsandboxed (terminal.backend: local). Set terminal.backend to "
                "docker/ssh, bind the dashboard to loopback, or — only on a "
                "trusted, auth-gated network — set "
                "terminal.allow_unsandboxed_shell: true.",
            )
        if network_exposed:
            _log.warning(
                "shell-pty: spawning an UNSANDBOXED host shell on a network-exposed bind, "
                "permitted by terminal.allow_unsandboxed_shell. Anyone with a valid session "
                "has host code execution as this user."
            )
        # Host login shell. cwd: (path-hardened) ?cwd= -> default workspace -> ~.
        cwd = _fs_default_cwd()
        if cwd_param:
            try:
                candidate = _fs_path(cwd_param)
                if candidate.is_dir():
                    cwd = str(candidate)
            except Exception:
                pass
        if not os.path.isdir(cwd):
            cwd = os.path.expanduser("~")
        shell = os.environ.get("SHELL") or "/bin/bash"
        return ([shell, "-l"], _shell_pty_env(), cwd, None)

    if backend == "docker":
        status, message = _probe_docker_backend(terminal_cfg)
        if status != "ready":
            reason = message or "Docker backend unavailable."
            if "permission" in reason.lower() or "denied" in reason.lower():
                reason += " (check docker socket access for the gateway user)."
            return ([], {}, None, reason)
        try:
            from tools.environments.docker import (
                find_docker,
                _sanitize_label_value,
                _get_active_profile_name,
            )

            docker = find_docker() or "docker"
            profile = _sanitize_label_value(_get_active_profile_name())
            out = subprocess.run(
                [
                    docker, "ps",
                    "--filter", "label=hermes-agent=1",
                    "--filter", "label=hermes-task-id=default",
                    "--filter", f"label=hermes-profile={profile}",
                    "--filter", "status=running",
                    "--format", "{{.ID}}",
                ],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5,
            )
            lines = [ln.strip() for ln in (out.stdout or "").splitlines() if ln.strip()]
            cid = lines[0] if lines else ""
        except Exception as exc:
            return ([], {}, None, f"could not query the sandbox container: {exc}")
        if not cid:
            return (
                [], {}, None,
                "the sandbox container is not running yet — send the agent a "
                "command first, or set terminal.backend: local on a trusted "
                "(loopback) bind.",
            )
        if cwd_param:
            _log.info("shell-pty docker backend: discarding host ?cwd=%s", cwd_param)
        from tools.terminal_tool import _is_unusable_container_cwd

        container_cwd = _terminal_cfg_value(terminal_cfg, "cwd", "TERMINAL_CWD")
        if not container_cwd or _is_unusable_container_cwd(container_cwd):
            container_cwd = "/workspace"
        # Always `bash` inside the image — the host $SHELL may be fish/zsh, which
        # need not exist in the container. `-w` sets the in-container working dir.
        argv = [
            docker, "exec", "-it", "-w", container_cwd,
            "-e", "TERM=xterm-256color",
            "-e", "COLORTERM=truecolor",
            "-e", "TERM_PROGRAM=Hermes",
            "-e", "HERMES_UNIVERSAL_TERMINAL=1",
            cid, "bash", "-l",
        ]
        return (argv, _shell_pty_env(), None, None)

    if backend == "ssh":
        status, message = _probe_ssh_backend(terminal_cfg)
        if status != "ready":
            return ([], {}, None, message or "SSH backend unavailable.")
        host = _terminal_cfg_value(terminal_cfg, "ssh_host", "TERMINAL_SSH_HOST")
        user = _terminal_cfg_value(terminal_cfg, "ssh_user", "TERMINAL_SSH_USER")
        port = _terminal_cfg_value(terminal_cfg, "ssh_port", "TERMINAL_SSH_PORT")
        key = _terminal_cfg_value(terminal_cfg, "ssh_key", "TERMINAL_SSH_KEY")
        # Mirror SSHEnvironment._build_ssh_command's flags, made interactive with
        # -tt. BatchMode=yes stays: a password prompt in a browser pane would hang.
        argv = [
            "ssh", "-tt",
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=10",
        ]
        if port and port != "22":
            argv += ["-p", port]
        if key:
            argv += ["-i", key]
        argv.append(f"{user}@{host}")
        return (argv, _shell_pty_env(), None, None)

    # modal / daytona / singularity: no interactive-shell handle exists.
    return (
        [], {}, None,
        f"terminal.backend '{backend}' cannot host an interactive shell (its "
        "sandbox handle is process-local / SDK-only). Use docker or ssh, or a "
        "loopback bind with terminal.backend: local.",
    )


def _warn_shell_pty_bind(host: str) -> None:
    """Startup bind warning: tell the operator what /api/shell-pty will do on *host*.

    Same resolver the router uses, so this warning can never disagree with what the
    endpoint actually does. Best-effort — never blocks startup.
    """
    try:
        from gateway.platforms.base import is_network_accessible

        terminal_cfg = load_config().get("terminal") or {}
        backend = _resolve_shell_pty_backend(terminal_cfg)
        if not (is_network_accessible(host) and backend == "local" and _shell_pty_disabled_reason() is None):
            return
        if _shell_pty_allow_unsandboxed():
            _log.warning(
                "Dashboard is network-accessible (%s) and /api/shell-pty spawns an "
                "UNSANDBOXED interactive shell as the host user with full file access. "
                "Anyone with a valid session gets host code execution — permitted by "
                "terminal.allow_unsandboxed_shell. Firewall this port to trusted networks.",
                host,
            )
        else:
            _log.warning(
                "Dashboard is network-accessible (%s) and the shell backend is "
                "unsandboxed (local), so /api/shell-pty will REFUSE every connection. "
                "Set terminal.shell_pty_backend: docker/ssh, bind to loopback, or — on "
                "a trusted, auth-gated network — terminal.allow_unsandboxed_shell: true.",
                host,
            )
    except Exception:
        pass
