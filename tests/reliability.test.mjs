// Node 22.15+ (native TypeScript and synchronous module hooks), Bash, Python 3, jq.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = process.env.OMA_TEST_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const deskFixture = fileURLToPath(new URL("./fixtures/desk-regression.mjs", import.meta.url));
const proofFile = "proofs/test-proof.lean";
const leaseFile = ".oma/leases/test-proof";

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, ...options });
  if (result.error) throw result.error;
  return result;
}

function desk(scenario) {
  const result = run(process.execPath, [deskFixture, root, scenario]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("known step can be claimed with a healthy database", () => {
  const { id, status, body, calls } = desk("healthy");
  assert.equal(status, 200);
  assert.equal(body.problem.id, id);
  assert.match(body.lease, /^[0-9a-f-]{36}$/);
  assert.match(body.skeleton, /H1/);
  assert.ok(calls.includes("claim2"));
});

test("failed step lookup is retryable, rather than a definitive missing step", () => {
  const { status, retryAfter, body, calls } = desk("steps-unavailable");
  assert.equal(status, 503, `Received ${status} ${body.error}`);
  assert.equal(body.error, "desk_unavailable");
  assert.ok(Number(retryAfter) > 0);
  assert.ok(calls.includes("steps"));
  assert.ok(!calls.includes("claim2"));
});

test("a failure reading crowd counts does not block a named step claim", () => {
  const { id, status, body, calls } = desk("live-unavailable");
  assert.equal(status, 200, `Received ${status} ${body.error}`);
  assert.equal(body.problem.id, id);
  assert.ok(!body.degraded);
  assert.ok(calls.includes("claim2"));
});

test("a genuinely missing step returns 404", () => {
  const { status, body, calls } = desk("step-missing");
  assert.equal(status, 404);
  assert.equal(body.error, "not_found_or_solved");
  assert.ok(!calls.includes("claim2"));
});

test("a known step gets an offline lease when the claim write fails", () => {
  const { id, status, body, calls } = desk("claim-unavailable");
  assert.equal(status, 200);
  assert.equal(body.problem.id, id);
  assert.equal(body.degraded, true);
  assert.match(body.lease, /^offline-[0-9a-f]{32}$/);
  assert.ok(calls.includes("claim2"));
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "oma-reliability-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const write = (file, contents, mode) => writeFileSync(join(cwd, file), contents, { mode });
  const shim = (name, script) => write("bin/" + name, "#!/usr/bin/env bash\nset -eu\n" + script, 0o755);
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, OMA_SITE: "https://test-desk.invalid" };
  return { cwd, write, shim, env, shell: (script, args = []) => run("bash", [script, ...args], { cwd, env }) };
}

function client(t) {
  const f = fixture(t);
  for (const dir of ["tools", "proofs", ".oma/leases"]) mkdirSync(join(f.cwd, dir), { recursive: true });
  copyFileSync(join(root, "tools/oma.sh"), join(f.cwd, "tools/oma.sh"));
  f.write(proofFile, "-- Test input\n");
  f.write(leaseFile, "11111111-1111-1111-1111-111111111111\n");
  return { ...f, command: (...args) => f.shell("tools/oma.sh", args) };
}

test("checker failure cannot reuse an accepted verdict from a different proof", (t) => {
  const f = client(t);
  f.env.OMA_CHECK = join(f.cwd, "bin/checker");
  f.shim("checker", `
    if [[ "$1" != "proofs/previous-proof.lean" ]]; then exit 2; fi
    printf '%s\\n' '{"verdict":"accepted","reason":"previous proof"}' > "$2"
  `);
  f.write("proofs/previous-proof.lean", "-- Previous input\n");
  const first = f.command("check", "previous-proof");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /ACCEPTED: previous proof/);

  const current = f.command("check", "test-proof");
  assert.notEqual(current.status, 0, current.stdout);
  assert.doesNotMatch(current.stdout + current.stderr, /ACCEPTED/);
});

test("checker must exit successfully to confirm an accepted verdict", (t) => {
  const f = client(t);
  f.env.OMA_CHECK = join(f.cwd, "bin/checker");
  f.shim("checker", `
    printf '%s\\n' '{"verdict":"accepted","reason":"incomplete check"}' > "$2"
    exit 2
  `);
  const result = f.command("check", "test-proof");
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /ACCEPTED/);
});

test("degraded heartbeat tells the agent the lease was not refreshed", (t) => {
  const f = client(t);
  f.shim("curl", `
    while [[ "$1" != -o ]]; do shift; done
    printf '%s\\n' '{"ok":true,"degraded":true,"stop":false,"refreshed":false,"hint":"Your lease could not be refreshed."}' > "$2"
    printf 200
  `);
  const result = f.command("beat", "test-proof");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /could not be refreshed/i);
  assert.ok(existsSync(join(f.cwd, leaseFile)));
});

test("failed release reports failure and preserves the local lease for retry", (t) => {
  const f = client(t);
  f.shim("curl", `
    [[ "$*" == *test-desk.invalid/api/desk/release* ]]
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == -o ]]; then
        printf '%s\\n' '{"error":"desk_unavailable"}' > "$2"
        printf 503
        exit
      fi
      shift
    done
    printf '%s\\n' '{"error":"desk_unavailable"}'
  `);
  const result = f.command("release", "test-proof", "out_of_time");
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /desk_unavailable/);
  assert.equal(readFileSync(join(f.cwd, leaseFile), "utf8").trim(), "11111111-1111-1111-1111-111111111111");
});

function merger(t, outcome) {
  const f = fixture(t);
  Object.assign(f.env, {
    REPO: "test/repo",
    RUN_URL: "https://test.invalid/run",
    HEAD_SHA: "checked",
    MERGE_OUTCOME: outcome,
    RELINT: join(f.cwd, "relint.json"),
    REMERGE: "0",
  });
  for (const dir of ["artifact", "base/tools", "base/data"]) mkdirSync(join(f.cwd, dir), { recursive: true });
  f.write("artifact/pr.txt", "7433\n");
  f.write("artifact/verdict.json", '{"verdict":"accepted","kind":"open"}\n');
  f.write("base/data/catalog.json", '{"problems":[]}\n');
  f.write("base/tools/lint.py", 'print(\'{"polarity":"proof","type":"proof","kind":"open"}\')\n');
  f.write("base/tools/credit.sh", 'echo credit >> events\n');
  f.shim("git", "exit 1\n");
  f.shim("gh", `
    case "$*" in
      "api repos/test/repo/pulls/7433")
        echo '{"state":"open","base":{"ref":"main"},"head":{"sha":"checked"},"labels":[],"draft":false}' ;;
      "api repos/test/repo/pulls/7433/files")
        echo '[{"filename":"${proofFile}","status":"added"}]' ;;
      "api repos/test/repo/contents/${proofFile}?ref=checked --jq .content")
        printf '%s' '-- checked file' | base64 ;;
      "api repos/test/repo/issues/7433/comments "*)
        printf 'comment %s\\n' "$4" >> events ;;
      "api -X PUT repos/test/repo/pulls/7433/merge "*)
        echo merge >> events
        case "$MERGE_OUTCOME" in
          merged) echo '{"merged":true,"sha":"merged"}' ;;
          unmerged) echo '{"merged":false,"message":"Merge was not performed"}' ;;
          forbidden) echo 'Resource not accessible by integration (HTTP 403)' >&2; exit 1 ;;
        esac ;;
      "pr merge "*)
        echo 'Resource not accessible by integration (HTTP 403)' >&2; exit 1 ;;
      "api repos/test/repo/contents/${proofFile}?ref=main") exit 1 ;;
      *) echo "Unexpected gh command: $*" >&2; exit 2 ;;
    esac
  `);
  const result = f.shell(join(root, "tools/verdict_one.sh"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = readFileSync(join(f.cwd, "events"), "utf8").trim().split("\n");
  assert.ok(events.includes("merge"), "fixture must reach the GitHub merge call");
  return events;
}

const mergedAnnouncement = /^comment .*\b(?:Merged and credited|Merged now|has been merged)\b/i;

test("GitHub 403 never produces a merge-success announcement", (t) => {
  const events = merger(t, "forbidden");
  assert.match(events.join("\n"), /refused the merge/i);
  assert.ok(!events.some((line) => mergedAnnouncement.test(line)), events.join("\n"));
  assert.ok(!events.includes("credit"));
});

test("a successful HTTP response with merged false does not confirm a merge", (t) => {
  const events = merger(t, "unmerged");
  assert.ok(!events.some((line) => mergedAnnouncement.test(line)), events.join("\n"));
  assert.ok(!events.includes("credit"));
});

test("a merge-success announcement follows the actual merge", (t) => {
  const events = merger(t, "merged");
  const announcement = events.findIndex((line) => mergedAnnouncement.test(line));
  assert.ok(announcement > events.indexOf("merge"), events.join("\n"));
  assert.ok(events.indexOf("credit") > events.indexOf("merge"));
});
