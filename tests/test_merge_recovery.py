"""Run the trusted verdict and recovery scripts against a stateful fake GitHub."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SHA = "a" * 40
PENDING = "oma-merge-pending"
HANDOFF = "oma-merge-needs-maintainer"
RUN_FIELDS = '[.id, .head_sha, .run_attempt, .html_url, .updated_at, .conclusion, .display_title] | @tsv'

FAKE_GH = """#!/usr/bin/env python3
import base64, json, os, sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

path = Path(os.environ["FAKE_GITHUB_STATE"])
state = json.loads(path.read_text())
args = sys.argv[1:]
url = next((arg for arg in args if arg.startswith("repos/")), "")
route = urlsplit(url)
endpoint = route.path.removeprefix("repos/test/repo/")
query = parse_qs(route.query)

def reply(body):
    print(json.dumps(body))
    sys.exit(0)

def save():
    path.write_text(json.dumps(state))

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)

def pr():
    return {"state": state["pr_state"], "base": {"ref": "main"}, "head": {"sha": state["sha"]},
            "draft": False, "labels": [{"name": label} for label in state["labels"]]}

if endpoint == "pulls/42":
    reply(pr())
if endpoint == "pulls/42/files":
    reply([{"filename": "proofs/test-proof.lean", "status": "added"}])
if endpoint == "contents/proofs/test-proof.lean":
    if query.get("ref") == ["main"] and state["superseded"]:
        reply({})
    if query.get("ref") == [state["sha"]]:
        print(base64.b64encode(b"-- checked proof fixture").decode())
        sys.exit(0)
    fail("HTTP 404")
if endpoint == "pulls/42/merge":
    state["merge_calls"] += 1
    if state["allow_merge"]:
        state["pr_state"] = "closed"
        save()
        reply({"merged": True, "sha": "merge"})
    save()
    if state["unconfirmed"]:
        reply({"merged": False})
    fail("Resource not accessible by integration (HTTP 403)")
if args[:2] == ["pr", "merge"]:
    fail("Resource not accessible by integration (HTTP 403)")
if endpoint == "issues/42/comments":
    reply({})
if endpoint == "issues/42/labels":
    label = next(arg.split("=", 1)[1] for arg in args if arg.startswith("labels[]="))
    if label in state["refuse_labels"]:
        fail("HTTP 403")
    if label not in state["labels"]:
        state["labels"].append(label)
    save()
    reply(state["labels"])
if endpoint.startswith("issues/42/labels/"):
    state["labels"].remove(endpoint.rsplit("/", 1)[1])
    save()
    reply({})
if endpoint == "issues":
    assert query["state"] == ["open"]
    assert query["labels"] == ["oma-merge-pending"]
    if state["pr_state"] == "open" and "oma-merge-pending" in state["labels"]:
        print("42")
    sys.exit(0)
if url == "" and args[:2] == ["api", "rate_limit"]:
    print("999 0 999 0" if "graphql" in args[-1] else "999 0")
    sys.exit(0)
if endpoint in ("pulls", "actions/workflows/verdict.yml/runs"):
    sys.exit(0)
if endpoint == "actions/runs/11/jobs":
    print("1")
    sys.exit(0)
if endpoint == "actions/workflows/check-proof.yml/runs":
    if "head_sha" not in query:
        sys.exit(0)  # The normal time-window scan cannot see the old run.
    assert query["event"] == ["pull_request"]
    assert query["head_sha"] == [state["sha"]]
    reply({"workflow_runs": state["runs"]})
fail("Unexpected gh call: " + repr(args))
"""


class MergeRecovery(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.state_path = self.tmp / "github.json"
        self.write(self.state_path, {
            "labels": [], "refuse_labels": [], "allow_merge": False, "superseded": False, "unconfirmed": False,
            "merge_calls": 0, "pr_state": "open", "sha": SHA, "runs": [self.run_record()],
        })
        fake_gh = self.tmp / "gh"
        fake_gh.write_text(FAKE_GH)
        fake_gh.chmod(0o755)
        fake_git = self.tmp / "git"
        fake_git.write_text("#!/usr/bin/env bash\nexit 1\n")
        fake_git.chmod(0o755)
        self.env = {
            **os.environ, "PATH": f"{self.tmp}:{os.environ['PATH']}",
            "FAKE_GITHUB_STATE": str(self.state_path), "REPO": "test/repo", "HEAD_SHA": SHA,
            "RUN_URL": "https://example.invalid/actions/runs/11", "RUN_ID": "11", "RUN_ATTEMPT": "1",
        }

    @staticmethod
    def run_record(**changes):
        return {
            "id": 11, "run_number": 20, "run_attempt": 1, "event": "pull_request",
            "head_sha": SHA, "status": "completed", "conclusion": "success",
            "display_title": "check-proof #42", "updated_at": "2000-01-01T12:00:00Z",
            "html_url": "https://example.invalid/actions/runs/11", **changes,
        }

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))

    def state(self):
        return json.loads(self.state_path.read_text())

    def update(self, **changes):
        self.write(self.state_path, {**self.state(), **changes})

    def bash(self, args, cwd, **changes):
        result = subprocess.run(["bash", *args], cwd=cwd, env={**self.env, **changes},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def job(self, runner):
        job = self.tmp / runner
        (job / "base/data").mkdir(parents=True)
        self.write(job / "base/data/catalog.json", {"problems": []})
        (job / "base/tools").mkdir()
        (job / "base/tools/lint.py").write_text(
            """print('{"kind":"known","type":"proof","polarity":"proof"}')\n""")
        (job / "base/tools/credit.sh").write_text("true\n")
        return job

    def verdict(self, runner, retry=0):
        job = self.job(runner)
        (job / "artifact").mkdir()
        (job / "artifact/pr.txt").write_text("42\n")
        self.write(job / "artifact/verdict.json", {"verdict": "accepted"})
        self.bash([str(ROOT / "tools/verdict_one.sh")], job,
                  REMERGE=str(retry), RELINT=str(job / "relint.json"))
        return (job / "remerge.flag").exists()

    def discover(self):
        return self.bash(["-c", 'source "$1"; discover_merge_retries "$2"', "bash",
                          str(ROOT / "tools/merge_recovery.sh"), RUN_FIELDS], self.tmp)

    def restart_merger(self):
        job = self.job("second")
        for script in ("merge_recovery.sh", "merger_loop.sh", "verdict_one.sh"):
            shutil.copyfile(ROOT / "tools" / script, job / "base/tools" / script)
        for script in ("ledger_post.sh", "backlog_pass.sh"):
            (job / "base/tools" / script).write_text("true\n")
        clock = self.tmp / "clock"
        clock.write_text("1760000000\n")
        stubs = {
            "date": 'if [[ "$*" == "-u +%s" ]]; then cat "$FIXTURE_CLOCK"; else exec /bin/date "$@"; fi',
            "sleep": 'echo 1760000010 > "$FIXTURE_CLOCK"',
            "curl": 'echo "{}"',
        }
        for command, script in stubs.items():
            path = self.tmp / command
            path.write_text("#!/usr/bin/env bash\n" + script + "\n")
            path.chmod(0o755)
        return self.bash(["base/tools/merger_loop.sh"], job, GITHUB_RUN_ID="", MERGER_RESUME="",
                         MERGER_SECONDS="5", SLOTS="1", FIXTURE_CLOCK=str(clock))

    def test_403_is_discoverable_on_a_new_runner_and_can_merge(self):
        self.assertTrue(self.verdict("first"))
        self.assertEqual(self.state()["labels"], [PENDING])
        self.assertEqual(self.state()["merge_calls"], 1)
        recovered = self.discover().strip().split("\t")
        self.assertEqual(recovered, [
            "11", SHA, "1", self.env["RUN_URL"], "2000-01-01T12:00:00Z",
            "success", "check-proof #42", "remerge",
        ])

        self.update(allow_merge=True)
        self.assertIn("#42 run 11.1: exit 0", self.restart_merger())
        self.assertEqual(self.state()["pr_state"], "closed")
        self.assertEqual(self.state()["labels"], [])
        self.assertEqual(self.discover(), "")

    def test_handoff_is_durable_and_stops_retries(self):
        self.assertTrue(self.verdict("first"))
        self.assertFalse(self.verdict("exhausted", retry=6))
        self.assertEqual(self.state()["labels"], [HANDOFF])
        self.assertEqual(self.discover(), "")
        self.assertFalse(self.verdict("rescanned"))
        self.assertEqual(self.state()["merge_calls"], 2)

    def test_a_failed_handoff_write_preserves_recovery(self):
        self.assertTrue(self.verdict("first"))
        self.update(refuse_labels=[HANDOFF])
        self.assertTrue(self.verdict("exhausted", retry=6))
        self.assertEqual(self.state()["labels"], [PENDING])
        self.assertIn("remerge", self.discover())

    def test_discovery_requires_a_green_check_for_the_current_head_and_pr(self):
        self.update(labels=[PENDING], sha="b" * 40)
        self.assertEqual(self.discover(), "")
        self.update(sha=SHA, runs=[self.run_record(display_title="check-proof #43")])
        self.assertEqual(self.discover(), "")
        self.update(runs=[self.run_record(), self.run_record(run_attempt=2, conclusion="failure")])
        self.assertEqual(self.discover(), "")

    def test_superseded_proof_leaves_the_queue(self):
        self.assertTrue(self.verdict("first"))
        self.update(superseded=True)
        self.assertFalse(self.verdict("superseded", retry=1))
        self.assertEqual(self.state()["labels"], [])
        self.assertEqual(self.discover(), "")

    def test_unconfirmed_rest_merge_stays_pending(self):
        self.update(unconfirmed=True)
        self.assertTrue(self.verdict("first"))
        self.assertEqual(self.state()["labels"], [PENDING])


if __name__ == "__main__":
    unittest.main()
