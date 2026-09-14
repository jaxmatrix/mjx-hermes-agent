"""The project-skill trust gate over REST (/api/skills/project[, /trust]).

The gate itself is covered by test_project_skills.py; this file covers the two
routes that make it reachable from a GUI client, where there is no terminal to
run ``hermes skills trust`` in.
"""

import asyncio
import contextlib
import threading
from pathlib import Path

import pytest
import yaml

import agent.skill_utils as su
import hermes_cli.web_routers.skills as skills_routes
from hermes_cli.web_models import ProjectSkillTrust


@pytest.fixture
def project_env(tmp_path, monkeypatch):
    """A temp HERMES_HOME + a git-marked repo carrying one project skill."""
    home = tmp_path / ".hermes"
    (home / "skills").mkdir(parents=True)
    config = home / "config.yaml"
    config.write_text("skills:\n  external_dirs: []\n")

    repo = tmp_path / "proj"
    (repo / ".git").mkdir(parents=True)
    skill = repo / ".hermes" / "skills" / "repo-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: repo-skill\ndescription: from repo\n---\nbody\n")

    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.chdir(repo)

    # The routes reach web_server-owned helpers through a late-binding seam;
    # bind them to this temp home instead of importing the whole web server.
    monkeypatch.setattr(skills_routes, "_profile_scope", lambda profile: contextlib.nullcontext())
    monkeypatch.setattr(skills_routes, "load_config", lambda: yaml.safe_load(config.read_text()) or {})
    monkeypatch.setattr(skills_routes, "save_config", lambda cfg: config.write_text(yaml.safe_dump(cfg)))
    monkeypatch.setattr(skills_routes, "_CONFIG_MUTATION_LOCK", threading.Lock())
    monkeypatch.setattr(skills_routes, "_clear_skills_prompt_cache", lambda: None)

    su._external_dirs_cache_clear()
    su._project_quarantine_cache_clear()
    yield {"config": config, "home": home, "repo": repo}
    su._external_dirs_cache_clear()


def _status(cwd, **kwargs):
    return asyncio.run(skills_routes.get_project_skills(cwd=str(cwd), **kwargs))


def _trust(path, trusted=True):
    return asyncio.run(skills_routes.set_project_skills_trust(ProjectSkillTrust(path=str(path), trusted=trusted)))


class TestProjectSkillsStatus:
    def test_reports_the_repo_and_its_skills_while_untrusted(self, project_env):
        # The fixture disagrees with the happy path on purpose: the skills are
        # there and the repo is NOT trusted, which is the state the gate exists
        # for and the one a client has to be able to render.
        payload = _status(project_env["repo"])

        assert payload["root"] == str(project_env["repo"].resolve())
        assert payload["trusted"] is False
        assert [entry["name"] for entry in payload["skills"]] == ["repo-skill"]

    def test_finds_the_root_from_a_subdirectory(self, project_env):
        nested = project_env["repo"] / "src" / "deep"
        nested.mkdir(parents=True)

        assert _status(nested)["root"] == str(project_env["repo"].resolve())

    def test_no_git_checkout_has_no_project(self, project_env, tmp_path):
        plain = tmp_path / "plain"
        plain.mkdir()

        payload = _status(plain)

        assert payload["root"] is None
        assert payload["skills"] == []

    def test_reports_discovery_disabled(self, project_env):
        project_env["config"].write_text("skills:\n  external_dirs: []\n  project_discovery: false\n")

        assert _status(project_env["repo"])["discovery_enabled"] is False

    def test_quarantine_verdict_rides_along_once_trusted(self, project_env, monkeypatch):
        _trust(project_env["repo"])
        monkeypatch.setattr(su, "is_quarantined_project_skill", lambda skill_md: True)

        payload = _status(project_env["repo"])

        assert payload["trusted"] is True
        assert payload["skills"][0]["quarantined"] is True


class TestProjectSkillsTrust:
    def test_trusting_makes_the_dirs_load(self, project_env):
        assert su.get_project_skills_dirs() == []

        result = _trust(project_env["repo"])

        assert result["trusted"] is True
        assert _status(project_env["repo"])["trusted"] is True
        assert su.get_project_skills_dirs() == [(project_env["repo"] / ".hermes" / "skills").resolve()]

    def test_untrusting_removes_it_again(self, project_env):
        _trust(project_env["repo"])

        _trust(project_env["repo"], trusted=False)

        assert _status(project_env["repo"])["trusted"] is False
        assert su.get_project_skills_dirs() == []

    def test_trusting_twice_does_not_duplicate_the_entry(self, project_env):
        _trust(project_env["repo"])
        _trust(project_env["repo"])

        config = yaml.safe_load(project_env["config"].read_text())

        assert config["skills"]["trusted_project_dirs"] == [str(project_env["repo"].resolve())]

    def test_writes_the_same_key_the_cli_writes(self, project_env):
        # Trusting from the app and from `hermes skills trust` have to be the
        # same decision, or a user would have to make it twice.
        _trust(project_env["repo"])

        config = yaml.safe_load(project_env["config"].read_text())

        assert config["skills"]["trusted_project_dirs"] == [str(project_env["repo"].resolve())]
        assert su.is_project_root_trusted(Path(project_env["repo"]).resolve()) is True

    def test_rejects_a_path_that_is_not_a_directory(self, project_env):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as excinfo:
            _trust(project_env["repo"] / ".hermes" / "skills" / "repo-skill" / "SKILL.md")

        assert excinfo.value.status_code == 400
