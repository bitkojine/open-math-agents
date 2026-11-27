// Run the source route and DB client in a fresh isolate per scenario, with no live services.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [root, scenario] = process.argv.slice(2);
const stubs = {
  "server-only": "",
  "cloudflare:workers": "export const env = {};",
  "next/server": "export const NextResponse = Response;",
  "@/lib/catalog": `
    export const PROBLEMS = [];
    export const getProblem = () => undefined;
    export const getFull = () => undefined;
    export const skeleton = () => "";
    export const proofPath = () => "";
    export const statementSkeleton = () => "";
  `,
  "@/lib/pendingprs": "export const getPending = async () => new Map(); export const pendingError = () => undefined;",
  "@/lib/site": 'export const SITE = "https://example.invalid"; export const REPO = "test/repo";',
  "@/content/event.json": "export default {};",
  "@/content/impact.json": "export default { groups: [] };",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) {
      return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(resolve(root, specifier.slice(2) + ".ts")).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const id = "Erdos23.erdos_23.variants.n5.R2.H2.R1.H1";
const step = {
  id,
  reduction: "Erdos23.erdos_23.variants.n5.R2.H2.R1",
  parent: "Erdos23.erdos_23.variants.n5.R2.H2",
  k: 1,
  statement: "True",
  module: "OMAReductions.R_Erdos23_erdos_23_variants_n5_R2_H2_R1",
  points: 2,
  solved: false,
};
const calls = [];
process.env.SUPABASE_URL = "https://test-db.invalid";
process.env.SUPABASE_PUBLISHABLE_KEY = "test";
process.env.OMA_DB_SECRET = "test";
globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://test-db.invalid/rest/v1/rpc/oma_api");
  const { p_fn: fn, p_args: args } = JSON.parse(options.body);
  calls.push(fn);
  switch (fn) {
    case "live":
      return scenario === "live-unavailable" ? new Response(null, { status: 503 }) : Response.json([]);
    case "stats":
      return Response.json({ solved: [{ problem_id: "unrelated-solved-problem" }] });
    case "steps":
      if (scenario === "steps-unavailable") return new Response(null, { status: 503 });
      if (scenario === "step-missing") return Response.json([]);
      return Response.json([{ ...step, statement: args.parent ? step.statement : "" }]);
    case "claim2":
      assert.equal(args.problem, id);
      return scenario === "claim-unavailable"
        ? new Response(null, { status: 503 })
        : Response.json({ lease: "11111111-1111-1111-1111-111111111111", role: "lead" });
    default:
      assert.fail(`Unexpected RPC: ${fn}`);
  }
};

const { GET } = await import(pathToFileURL(resolve(root, "app/api/desk/next/route.ts")));
const response = await GET(new Request(`https://example.invalid/api/desk/next?handle=tester&problem=${id}`));
console.log(JSON.stringify({ id, status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json(), calls }));
