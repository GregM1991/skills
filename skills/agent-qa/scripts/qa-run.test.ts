import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initialize, reach, summarize, validateConfig } from "./qa-run";

const roots: string[] = [];
const fixture = () => ({ environment: "dev", requestedEnvironment: "dev", target: { environment: "dev", url: "http://localhost:3000", source: "project-config" }, revision: "abc123", credentialReferences: ["env:QA_PASSWORD"], checks: ["target-route", "final-state"] });
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "qa-run-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("accepts explicit dev and prod without inferring environment from hostname", () => {
  expect(validateConfig(fixture()).environment).toBe("dev");
  const input = fixture();
  input.environment = input.requestedEnvironment = input.target.environment = "prod";
  expect(validateConfig(input).environment).toBe("prod");
});
test("rejects conflicting targets, incomplete checks and secret-bearing input without echo", () => {
  for (const input of [
    { ...fixture(), environment: "prod" },
    { ...fixture(), requestedEnvironment: "prod" },
    { ...fixture(), checks: ["final-state"] },
    { ...fixture(), password: "CANARY_SECRET" },
    { ...fixture(), credentialReferences: ["CANARY_SECRET"] },
    { ...fixture(), target: { ...fixture().target, url: "https://user:CANARY_SECRET@example.com" } },
    { ...fixture(), target: { ...fixture().target, url: "https://example.com?token=CANARY_SECRET" } },
  ]) {
    expect(() => validateConfig(input)).toThrow("Invalid QA input");
    try { validateConfig(input); } catch (error) { expect(String(error)).not.toContain("CANARY_SECRET"); }
  }
});
test("creates private manifest without credentials and protects existing evidence", async () => {
  const root = await directory();
  const evidence = path.join(root, "evidence");
  await initialize(validateConfig(fixture()), evidence);
  const manifest = await readFile(path.join(evidence, "manifest.json"), "utf8");
  expect(manifest).not.toContain("QA_PASSWORD");
  expect(manifest).not.toContain("credentialReferences");
  await expect(initialize(validateConfig(fixture()), evidence)).rejects.toThrow();
});
test("HTTP login success stays transport-only", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("Login") });
  try {
    const input = fixture();
    input.target.url = server.url.href;
    expect(await reach(validateConfig(input))).toEqual({ reachable: true, status: 200, scope: "http-only" });
  } finally { server.stop(true); }
});
test("missing observations and artifacts are untested; failure is retained", async () => {
  const root = await directory();
  const config = validateConfig(fixture());
  const summary = await summarize(config, root, [{ id: "target-route", outcome: "passed", evidence: ["missing.png"] }]);
  expect(summary.outcome).toBe("untested");
  expect(summary.counts).toEqual({ passed: 0, failed: 0, untested: 2 });
  expect((await summarize(config, root, [{ id: "final-state", outcome: "failed", evidence: [] }])).outcome).toBe("failed");
});
test("passed report requires both browser observations with nonempty contained evidence", async () => {
  const root = await directory();
  const outside = await directory();
  await writeFile(path.join(root, "route.png"), "evidence");
  await writeFile(path.join(outside, "outside.png"), "evidence");
  await symlink(path.join(outside, "outside.png"), path.join(root, "escape.png"));
  const observations = [
    { id: "target-route", outcome: "passed", evidence: ["route.png"] },
    { id: "final-state", outcome: "passed", evidence: ["escape.png"] },
  ];
  expect((await summarize(validateConfig(fixture()), root, observations)).outcome).toBe("untested");
  observations[1].evidence = ["route.png"];
  const summary = await summarize(validateConfig(fixture()), root, observations);
  expect(summary.outcome).toBe("passed");
  expect(summary.counts).toEqual({ passed: 2, failed: 0, untested: 0 });
  expect(JSON.stringify(summary)).not.toContain("QA_PASSWORD");
});
test("CLI reports outcomes and refuses missing or mismatched manifests without exposing input", async () => {
  const root = await directory();
  const configPath = path.join(root, "config.json");
  const observationsPath = path.join(root, "observations.json");
  const evidence = path.join(root, "evidence");
  const script = path.join(import.meta.dir, "qa-run.ts");
  const input = fixture();
  await writeFile(configPath, JSON.stringify(input));
  await writeFile(observationsPath, "[]");
  async function run(command: string) {
    const child = Bun.spawn(["bun", script, command, "--config", configPath, "--evidence", evidence, "--observations", observationsPath], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout + stderr).not.toContain("QA_PASSWORD");
    expect(stdout + stderr).not.toContain("CANARY_SECRET");
    return { code, stdout };
  }
  expect((await run("report")).code).toBe(2);
  expect((await run("init")).code).toBe(0);
  const untested = await run("report");
  expect(untested.code).toBe(1);
  expect(JSON.parse(untested.stdout).outcome).toBe("untested");
  await writeFile(path.join(evidence, "state.png"), "observed browser state");
  await writeFile(observationsPath, JSON.stringify(input.checks.map(id => ({ id, outcome: "passed", evidence: ["state.png"] }))));
  const passed = await run("report");
  expect(passed.code).toBe(0);
  expect(JSON.parse(passed.stdout).outcome).toBe("passed");
  await writeFile(observationsPath, JSON.stringify([{ id: "final-state", outcome: "failed", evidence: [] }]));
  expect(JSON.parse((await run("report")).stdout).outcome).toBe("failed");
  await writeFile(configPath, JSON.stringify({ ...input, revision: "different-revision" }));
  expect((await run("report")).code).toBe(2);
  await writeFile(configPath, JSON.stringify({ ...input, password: "CANARY_SECRET" }));
  expect((await run("report")).code).toBe(2);
});
