import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

type Environment = "dev" | "prod";
type Outcome = "passed" | "failed" | "untested";
type Config = {
  environment: Environment;
  requestedEnvironment?: Environment;
  target: { environment: Environment; url: string; source: "request" | "project-config" };
  revision: string;
  credentialReferences: string[];
  checks: string[];
};
const invalid = (): never => { throw new Error("Invalid QA input; inspect the documented schema."); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) return invalid();
  return result;
}
function environment(value: unknown): Environment {
  return value === "dev" || value === "prod" ? value : invalid();
}
const isId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
function strings(value: unknown, valid: (item: unknown) => boolean): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string" && valid(item))) return invalid();
  return value as string[];
}
export function validateConfig(value: unknown): Config {
  const input = object(value, ["environment", "requestedEnvironment", "target", "revision", "credentialReferences", "checks"]);
  const selected = environment(input.environment);
  const requested = input.requestedEnvironment === undefined ? undefined : environment(input.requestedEnvironment);
  const target = object(input.target, ["environment", "url", "source"]);
  if (environment(target.environment) !== selected || (requested && requested !== selected)) return invalid();
  if (target.source !== "request" && target.source !== "project-config") return invalid();
  if (typeof target.url !== "string") return invalid();
  let url: URL;
  try { url = new URL(target.url); } catch { return invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalid();
  if (typeof input.revision !== "string" || !/^[A-Za-z0-9._/-]{1,120}$/.test(input.revision)) return invalid();
  const credentialReferences = strings(input.credentialReferences, item => typeof item === "string" && /^(?:env:[A-Z][A-Z0-9_]*|op:\/\/[^\s?#]+\/[^\s?#]+\/[^\s?#]+)$/.test(item));
  const checks = strings(input.checks, isId);
  if (new Set(checks).size !== checks.length || !checks.includes("target-route") || !checks.includes("final-state")) return invalid();
  return { environment: selected, requestedEnvironment: requested, target: { environment: selected, url: url.href, source: target.source }, revision: input.revision, credentialReferences, checks };
}
export async function initialize(config: Config, directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  const { credentialReferences: omitted, ...manifest } = config;
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
export async function reach(config: Config): Promise<{ reachable: boolean; status?: number; scope: "http-only" }> {
  try {
    const response = await fetch(config.target.url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return { reachable: true, status: response.status, scope: "http-only" };
  } catch { return { reachable: false, scope: "http-only" }; }
}
async function evidenceExists(root: string, name: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9._/-]+$/.test(name) || path.isAbsolute(name) || name.split("/").some(part => part === ".." || part === ".")) return false;
  try {
    const resolved = await realpath(path.join(root, name));
    if (!resolved.startsWith((await realpath(root)) + path.sep)) return false;
    const file = await stat(resolved);
    return file.isFile() && file.size > 0;
  } catch { return false; }
}
export async function summarize(config: Config, root: string, value: unknown) {
  if (!Array.isArray(value)) return invalid();
  const observations = new Map<string, { outcome: Outcome; evidence: string[] }>();
  for (const entry of value) {
    const input = object(entry, ["id", "outcome", "evidence"]);
    if (!isId(input.id) || !config.checks.includes(input.id) || observations.has(input.id)) return invalid();
    if (input.outcome !== "passed" && input.outcome !== "failed" && input.outcome !== "untested") return invalid();
    const evidence = strings(input.evidence, item => typeof item === "string" && /^[a-zA-Z0-9._/-]+$/.test(item));
    observations.set(input.id, { outcome: input.outcome, evidence });
  }
  const checks = await Promise.all(config.checks.map(async id => {
    const observed = observations.get(id);
    const complete = !!observed?.evidence.length && (await Promise.all(observed.evidence.map(file => evidenceExists(root, file)))).every(Boolean);
    const outcome: Outcome = observed?.outcome === "failed" ? "failed" : complete ? observed?.outcome ?? "untested" : "untested";
    return { id, outcome, evidenceComplete: complete };
  }));
  const counts = { passed: 0, failed: 0, untested: 0 };
  for (const check of checks) counts[check.outcome]++;
  const outcome: Outcome = counts.failed ? "failed" : counts.untested ? "untested" : "passed";
  return { outcome, counts, checks };
}
if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { config: { type: "string" }, evidence: { type: "string" }, observations: { type: "string" } } });
    if (!values.config || positionals.length !== 1) invalid();
    const config = validateConfig(JSON.parse(await readFile(values.config, "utf8")));
    if (positionals[0] === "reach") {
      const result = await reach(config);
      console.log(JSON.stringify(result));
      process.exitCode = result.reachable ? 0 : 1;
    } else if (positionals[0] === "init" && values.evidence) {
      await initialize(config, values.evidence);
      console.log("Evidence manifest created.");
    } else if (positionals[0] === "report" && values.evidence && values.observations) {
      const manifest = JSON.parse(await readFile(path.join(values.evidence, "manifest.json"), "utf8"));
      const { credentialReferences: omitted, ...expectedManifest } = config;
      if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) invalid();
      const summary = await summarize(config, values.evidence, JSON.parse(await readFile(values.observations, "utf8")));
      await writeFile(path.join(values.evidence, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
      console.log(JSON.stringify({ outcome: summary.outcome, counts: summary.counts }));
      process.exitCode = summary.outcome === "passed" ? 0 : 1;
    } else invalid();
  } catch {
    console.error("QA helper failed. Check input schema, file access and command arguments. No input values were logged.");
    process.exitCode = 2;
  }
}
