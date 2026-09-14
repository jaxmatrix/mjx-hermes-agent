import base64
from pathlib import Path

import pytest

from hermes_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    previous_auth_required = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    test_client = TestClient(web_server.app)
    test_client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    try:
        yield test_client
    finally:
        if previous_auth_required is None:
            try:
                delattr(web_server.app.state, "auth_required")
            except AttributeError:
                pass
        else:
            web_server.app.state.auth_required = previous_auth_required


def test_fs_list_sorts_and_hides_noise(client, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "b.txt").write_text("b")
    (root / "a_dir").mkdir()
    (root / "a.txt").write_text("a")
    (root / "node_modules").mkdir()
    (root / ".git").mkdir()

    response = client.get("/api/fs/list", params={"path": str(root)})

    assert response.status_code == 200
    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == ["a_dir", "a.txt", "b.txt"]
    assert entries[0] == {"name": "a_dir", "path": str(root / "a_dir"), "isDirectory": True}
    assert all(entry["name"] not in {".git", "node_modules"} for entry in entries)


def test_fs_read_data_url_rejects_over_cap(client, tmp_path, monkeypatch):
    monkeypatch.setattr(web_server, "_FS_DATA_URL_MAX_BYTES", 3)
    target = tmp_path / "image.png"
    target.write_bytes(b"1234")

    response = client.get("/api/fs/read-data-url", params={"path": str(target)})

    assert response.status_code == 413


def test_fs_download_streams_file_without_data_url_cap(client, tmp_path, monkeypatch):
    monkeypatch.setattr(web_server, "_FS_DATA_URL_MAX_BYTES", 3)
    target = tmp_path / "report with spaces.pdf"
    target.write_bytes(b"123456")

    response = client.get("/api/fs/download", params={"path": str(target)})

    assert response.status_code == 200
    assert response.content == b"123456"
    assert response.headers["content-type"].startswith("application/pdf")
    assert "report%20with%20spaces.pdf" in response.headers["content-disposition"]


def test_fs_download_rejects_sensitive_files(client, tmp_path):
    target = tmp_path / ".env"
    target.write_text("SECRET=1")

    response = client.get("/api/fs/download", params={"path": str(target)})

    assert response.status_code == 403


@pytest.mark.parametrize("endpoint", ["/api/fs/read-text", "/api/fs/read-data-url", "/api/fs/download"])
@pytest.mark.parametrize("relative", [".env", "auth.json", "mcp-tokens/github.json"])
def test_fs_readers_reject_sensitive_paths(client, tmp_path, endpoint, relative):
    target = tmp_path / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("SECRET=1")

    response = client.get(endpoint, params={"path": str(target)})

    assert response.status_code == 403
    assert "SECRET" not in response.text


def test_fs_list_hides_sensitive_entries(client, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / ".env").write_text("SECRET=1")
    (root / "auth.json").write_text("{}")
    (root / "mcp-tokens").mkdir()
    (root / "notes.txt").write_text("ok")

    response = client.get("/api/fs/list", params={"path": str(root)})

    assert response.status_code == 200
    assert [entry["name"] for entry in response.json()["entries"]] == ["notes.txt"]


def test_fs_endpoints_require_auth(tmp_path):
    client = TestClient(web_server.app)
    target = tmp_path / "secret.txt"
    target.write_text("secret")

    list_response = client.get("/api/fs/list", params={"path": str(tmp_path)})
    read_response = client.get("/api/fs/read-text", params={"path": str(target)})
    default_response = client.get("/api/fs/default-cwd")

    assert list_response.status_code == 401
    assert read_response.status_code == 401
    assert default_response.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/fs/search — the file explorer's fuzzy search, on the TUI gateway's ranker
# ---------------------------------------------------------------------------


@pytest.fixture
def gateway_server(monkeypatch):
    """The ranker is ``tui_gateway.server._fuzzy_rank_paths``; clear its per-root listing cache so
    a reused tmp path can never serve a stale listing."""
    from tui_gateway import server

    server._fuzzy_cache.clear()
    yield server
    server._fuzzy_cache.clear()


def _tree(root: Path) -> None:
    (root / "widget.ts").write_text("x")
    (root / "src").mkdir()
    (root / "src" / "appChrome.tsx").write_text("x")
    # Matches "widget.ts" only as a subsequence (w-i-d-g-e-t-.-t-s in order).
    (root / "src" / "wild-dog-eats-toast.ts").write_text("x")
    (root / ".hidden.txt").write_text("x")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "widget.ts").write_text("x")


def _search(client, root, q, **params):
    response = client.get("/api/fs/search", params={"path": str(root), "q": q, **params})
    assert response.status_code == 200, response.text
    return response.json()["entries"]


def test_search_exact_basename_outranks_subsequence(client, gateway_server, tmp_path):
    _tree(tmp_path)

    entries = _search(client, tmp_path, "widget.ts")
    names = [e["name"] for e in entries]

    assert names[0] == "widget.ts"
    assert entries[0]["rank"] == 0
    subsequence = [e for e in entries if e["name"].startswith("wild-dog")]
    assert subsequence and subsequence[0]["rank"] == 4
    assert names.index("widget.ts") < names.index(subsequence[0]["name"])


def test_search_tiers_cover_prefix_and_word_boundary(client, gateway_server, tmp_path):
    _tree(tmp_path)

    assert {e["name"]: e["rank"] for e in _search(client, tmp_path, "app")}["appChrome.tsx"] == 1
    assert {e["name"]: e["rank"] for e in _search(client, tmp_path, "chrome")}["appChrome.tsx"] == 2
    assert {e["name"]: e["rank"] for e in _search(client, tmp_path, "idget")}["widget.ts"] == 3


def test_search_finds_a_folder_with_no_matching_file_inside(client, gateway_server, tmp_path):
    """The listing is files-only, so `outer/Desktop` is reachable only through ancestor ranking."""
    nested = tmp_path / "outer" / "Desktop"
    nested.mkdir(parents=True)
    (nested / "notes.md").write_text("x")

    match = [e for e in _search(client, tmp_path, "Desktop") if e["name"] == "Desktop"]
    assert match
    assert match[0]["isDirectory"] is True
    assert match[0]["path"] == str(nested)


def test_search_hides_dotfiles_unless_the_query_starts_with_a_dot(client, gateway_server, tmp_path):
    _tree(tmp_path)

    assert not _search(client, tmp_path, "hidden")
    assert _search(client, tmp_path, ".hidden")


def test_search_caps_results(client, gateway_server, tmp_path):
    for i in range(40):
        (tmp_path / f"match{i}.txt").write_text("x")

    assert len(_search(client, tmp_path, "match", limit=5)) == 5
    # A nonsense limit neither blows the cap open nor returns nothing.
    assert len(_search(client, tmp_path, "match", limit=0)) >= 1
    assert len(_search(client, tmp_path, "match", limit=10_000)) == 40


def test_search_uses_the_gateway_ranker_not_a_second_one(client, gateway_server, tmp_path, monkeypatch):
    """One ranker for `@` completion and the explorer: swapping the gateway's changes both."""
    (tmp_path / "anything.txt").write_text("x")
    monkeypatch.setattr(
        gateway_server, "_fuzzy_rank_paths", lambda root, query: [((0, 1), "planted/x.md", "x.md", False)]
    )

    assert _search(client, tmp_path, "whatever") == [
        {"name": "x.md", "path": str(tmp_path / "planted" / "x.md"), "isDirectory": False, "rank": 0}
    ]


def test_fs_search_route_returns_fs_list_entry_shape(client, gateway_server, tmp_path):
    _tree(tmp_path)

    entry = _search(client, tmp_path, "widget.ts")[0]
    listing = client.get("/api/fs/list", params={"path": str(tmp_path)})

    assert set(entry) == set(listing.json()["entries"][0]) | {"rank"}
    assert entry == {"name": "widget.ts", "path": str(tmp_path / "widget.ts"), "isDirectory": False, "rank": 0}


def test_fs_search_hardens_path_like_fs_list(client, gateway_server, tmp_path):
    for bad in ("", "   ", "with\0nul"):
        search = client.get("/api/fs/search", params={"path": bad, "q": "a"})
        listing = client.get("/api/fs/list", params={"path": bad})
        assert search.status_code == 400, bad
        assert search.status_code == listing.status_code, bad


def test_fs_search_missing_path_is_200_not_404(client, gateway_server, tmp_path):
    """Feature detection is by body: a missing DIRECTORY answers 200 with `entries`, while an
    unmatched /api/* path 404s without one."""
    missing = client.get("/api/fs/search", params={"path": str(tmp_path / "nope"), "q": "x"})
    assert missing.status_code == 200
    assert missing.json() == {"entries": [], "error": "ENOENT"}

    a_file = tmp_path / "afile.txt"
    a_file.write_text("x")
    not_dir = client.get("/api/fs/search", params={"path": str(a_file), "q": "x"})
    assert not_dir.status_code == 200
    assert not_dir.json() == {"entries": [], "error": "ENOTDIR"}

    absent_route = client.get("/api/fs/search-that-does-not-exist", params={"path": "/"})
    assert absent_route.status_code == 404
    assert "entries" not in absent_route.json()


def test_fs_search_requires_auth(tmp_path):
    response = TestClient(web_server.app).get("/api/fs/search", params={"path": str(tmp_path), "q": "a"})
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/fs/default-cwd — `home` + profile scoping
# ---------------------------------------------------------------------------


def _make_profile(name: str, *, terminal_cwd: Path | None = None) -> Path:
    """Create a real named profile home and return its directory."""
    import yaml

    from hermes_cli import profiles as profiles_mod

    profile_dir = profiles_mod.get_profile_dir(name)
    profile_dir.mkdir(parents=True, exist_ok=True)
    if terminal_cwd is not None:
        (profile_dir / "config.yaml").write_text(
            yaml.safe_dump({"terminal": {"cwd": str(terminal_cwd)}}), encoding="utf-8"
        )
    return profile_dir


def test_fs_default_cwd_reports_the_gateway_home(client):
    body = client.get("/api/fs/default-cwd").json()

    assert body["home"] == str(Path.home())
    assert Path(body["home"]).is_absolute()


def test_fs_default_cwd_is_profile_scoped(client, tmp_path):
    alpha_cwd = tmp_path / "alpha-workspace"
    beta_cwd = tmp_path / "beta-workspace"
    alpha_cwd.mkdir()
    beta_cwd.mkdir()
    _make_profile("alpha", terminal_cwd=alpha_cwd)
    _make_profile("beta", terminal_cwd=beta_cwd)

    alpha = client.get("/api/fs/default-cwd", params={"profile": "alpha"})
    beta = client.get("/api/fs/default-cwd", params={"profile": "beta"})

    assert alpha.status_code == 200 and beta.status_code == 200
    assert alpha.json()["cwd"] == str(alpha_cwd)
    assert beta.json()["cwd"] == str(beta_cwd)


def test_fs_default_cwd_prefers_the_profiles_active_project(client, tmp_path):
    from hermes_cli import projects_db as pdb

    config_cwd = tmp_path / "from-config"
    project_dir = tmp_path / "from-active-project"
    config_cwd.mkdir()
    project_dir.mkdir()
    profile_dir = _make_profile("alpha", terminal_cwd=config_cwd)

    with pdb.connect_closing(profile_dir / "projects.db") as conn:
        pdb.set_active(conn, pdb.create_project(conn, name="Alpha", folders=[str(project_dir)]))

    response = client.get("/api/fs/default-cwd", params={"profile": "alpha"})

    assert response.status_code == 200
    assert response.json()["cwd"] == str(project_dir)


def test_fs_default_cwd_falls_through_a_stale_active_project(client, tmp_path):
    """A project whose folder was deleted degrades to terminal.cwd, not a path that is gone."""
    from hermes_cli import projects_db as pdb

    config_cwd = tmp_path / "from-config"
    config_cwd.mkdir()
    stale = tmp_path / "deleted-repo"
    stale.mkdir()
    profile_dir = _make_profile("alpha", terminal_cwd=config_cwd)

    with pdb.connect_closing(profile_dir / "projects.db") as conn:
        pdb.set_active(conn, pdb.create_project(conn, name="Alpha", folders=[str(stale)]))
    stale.rmdir()

    response = client.get("/api/fs/default-cwd", params={"profile": "alpha"})

    assert response.status_code == 200
    assert response.json()["cwd"] == str(config_cwd)


def test_fs_default_cwd_degrades_without_a_projects_db(client, tmp_path):
    config_cwd = tmp_path / "from-config"
    config_cwd.mkdir()
    profile_dir = _make_profile("alpha", terminal_cwd=config_cwd)

    response = client.get("/api/fs/default-cwd", params={"profile": "alpha"})

    assert response.status_code == 200
    assert response.json()["cwd"] == str(config_cwd)
    # Reading a default cwd must never CREATE the profile's projects DB.
    assert not (profile_dir / "projects.db").exists()


def test_fs_default_cwd_rejects_an_unknown_profile(client):
    response = client.get("/api/fs/default-cwd", params={"profile": "no-such-profile"})
    assert response.status_code == 404
