import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.OMA_VERDICT_TEST_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const modules = {
  "server-only": "",
  "next/server": "export const NextResponse = Response;",
  "@/lib/site": 'export const REPO = "test/repo";',
  "@/lib/catalog": 'export const getProblem = id => ({ id, kind: "open", difficulty: 40 });',
  "@/lib/db": `
    export const deskOnline = true;
    export const getStepsStrict = async () => [];
    export const writes = [];
    export const verdict2 = input => recordWrite("verdict", input);
    export const registerReduction = input => recordWrite("reduction", input);
    export const logEvent = (...input) => recordWrite("event", input);
    function recordWrite(kind, input) {
      writes.push({ kind, input });
      return { ok: true };
    }
  `,
  "@/lib/ghoidc": "export const verifyWorkflowToken = async () => false;",
  "@/lib/stepinfo": "export const reductionFile = async () => null;",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(modules, specifier)) {
      return { url: "data:text/javascript," + encodeURIComponent(modules[specifier]), shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(resolve(root, specifier.slice(2) + ".ts")).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { POST } = await import(pathToFileURL(resolve(root, "app/api/verdict/route.ts")));
const { writes } = await import("@/lib/db");
const sha = "a".repeat(40);
const api = "https://api.github.com/repos/test/repo/pulls/123";
const proof = "proofs/example.lean";
const disproofSource = "theorem OMA.disproof : ¬ False := not_false";
const verdictRequest = () => new Request("https://example.invalid/api/verdict", {
  method: "POST",
  body: JSON.stringify({ pr: 123 }),
});

function github(t, path, ...sources) {
  writes.length = 0;
  const sourceUrl = `https://raw.githubusercontent.com/test/repo/${sha}/${path}`;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === api) {
      return Response.json({
        merged: true,
        base: { ref: "main" },
        user: { login: "contributor" },
        html_url: "https://github.com/test/repo/pull/123",
        merge_commit_sha: sha,
      });
    }
    if (url === api + "/files") {
      return Response.json([{ filename: path, status: "added" }]);
    }
    assert.equal(url, sourceUrl, "must read at the actual merge commit");
    const response = sources.shift();
    assert.ok(response, "unexpected additional source read");
    return response();
  });
  return writes;
}

async function assertRetryable(writes, upstreamStatus) {
  const response = await POST(verdictRequest());
  const result = await response.json();
  assert.deepEqual(writes, [], "failed source reads must leave all records untouched");
  assert.equal(response.status, 503);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.equal(result.error, "github_unavailable");
  if (upstreamStatus !== undefined) assert.equal(result.status, upstreamStatus);
}

const sourceFailures = [
  ["GitHub 503", () => new Response("Service unavailable", { status: 503 }), 503],
  ["GitHub 404", () => new Response("Not found", { status: 404 }), 404],
  ["GitHub 204", () => new Response(null, { status: 204 }), 204],
  ["GitHub 206", () => new Response("import Mathlib\n", { status: 206 }), 206],
  ["blank successful response", () => new Response(" \n"), 200],
  ["transport error", () => { throw new TypeError("network reset"); }],
  ["interrupted response body", () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("stream reset")); },
  }))],
];

for (const [condition, fail, upstreamStatus] of sourceFailures) {
  test(`merged disproof remains unrecorded after ${condition} and is credited on retry`, async (t) => {
    const writes = github(t, proof, fail, () => new Response(disproofSource));
    await assertRetryable(writes, upstreamStatus);

    const response = await POST(verdictRequest());
    assert.equal(response.status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].kind, "verdict");
    assert.equal(writes[0].input.problem, "example");
    assert.equal(writes[0].input.verdict, "accepted");
    assert.equal(writes[0].input.polarity, "disproof");
  });
}

test("merged reduction is registered only when its source becomes readable", async (t) => {
  const source = "def H1 : Prop := True\ndef H2 : Prop := False\n";
  const writes = github(t, "reductions/example.R1.lean",
    () => new Response("Service unavailable", { status: 503 }),
    () => new Response(source));
  await assertRetryable(writes, 503);

  const response = await POST(verdictRequest());
  assert.equal(response.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "reduction");
  assert.equal(writes[0].input.id, "example.R1");
  assert.deepEqual(writes[0].input.statements, ["True", "False"]);
});

test("a readable ordinary proof still records proof polarity", async (t) => {
  const writes = github(t, proof, () => new Response("theorem OMA.solution : True := True.intro"));
  const response = await POST(verdictRequest());
  assert.equal(response.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "verdict");
  assert.equal(writes[0].input.polarity, "proof");
});
