// Plan state and the tick loop. All process and git calls go through the injected runner.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type Batch, type CheckResult, type PlannedPackage, type Skipped,
  buildBatches, bumpKind, commitMessage, riskOf, skipReason,
} from "./core.ts";
import type { Adapter, Check, Ctx, Manager, Runner } from "./ecosystems.ts";

export type Status = "pending" | "failed" | "verified" | "done" | "empty";
export type Failure = { step: string; command: string; exitCode: number; log: string; tail: string };
export type BatchState = Batch & {
  status: Status;
  baseCommit?: string;
  appliedSet?: string;
  failure?: Failure;
  checks?: CheckResult[];
  commit?: string;
};
export type Deferred = PlannedPackage & { batch: number; reason: string };
export type State = {
  version: 1;
  createdAt: string;
  project: string;
  manager: Manager;
  checks: Check[];
  batches: BatchState[];
  deferred: Deferred[];
  skipped: Skipped[];
  transitive: number;
  audit: { command: string; exitCode: number; advisories: Record<string, string>; log: string } | null;
  warnings: string[];
};

export type Deps = {
  dir: string;
  run: Runner;
  adapter: Adapter;
  stateDir: string;
  checkTimeoutMs?: number;
  now?: () => Date;
};

const TAIL_LINES = 40;
const statePath = (deps: Deps) => path.join(deps.stateDir, "state.json");
const ctx = (deps: Deps): Ctx => ({ dir: deps.dir, run: deps.run });

export function loadState(deps: Deps): State {
  const file = statePath(deps);
  if (!existsSync(file)) throw new Error(`No plan at ${file}. Run the plan command first.`);
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  if (state.version !== 1 || !Array.isArray(state.batches) || !Array.isArray(state.checks))
    throw new Error(`Plan at ${file} has an unknown shape.`);
  return state;
}

function save(deps: Deps, state: State) {
  mkdirSync(deps.stateDir, { recursive: true });
  writeFileSync(statePath(deps), JSON.stringify(state, null, 2) + "\n");
}

function writeLog(deps: Deps, name: string, text: string): string {
  const dir = path.join(deps.stateDir, "logs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

export function tail(text: string, lines = TAIL_LINES): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
    .join("\n");
}

async function git(deps: Deps, args: string[]): Promise<string> {
  const result = await deps.run(["git", ...args], { cwd: deps.dir });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const dirtyFiles = async (deps: Deps) =>
  (await git(deps, ["status", "--porcelain"])).split("\n").filter(Boolean);

async function countImporters(deps: Deps, name: string): Promise<number | null> {
  const result = await deps.run(
    ["rg", "--files-with-matches", "--no-messages", "-e", deps.adapter.importPattern(name), "."],
    { cwd: deps.dir },
  );
  if (result.code === 1) return 0;
  if (result.code !== 0) return null;
  return result.stdout.split("\n").filter(Boolean).length;
}

const describe = (p: PlannedPackage) =>
  `${p.name} ${p.from} → ${p.to} (${p.bump}, ${p.type}, ${p.risk} risk` +
  `${p.importers === null ? "" : `, importers: ${p.importers}`}${p.advisory ? `, ${p.advisory} advisory` : ""})`;

const brief = (b: BatchState) => ({
  id: b.id, label: b.label, risk: b.risk, status: b.status,
  packages: b.packages.map(describe),
  ...(b.commit ? { commit: b.commit } : {}),
});

function countSeverity(advisories: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const severity of Object.values(advisories)) counts[severity] = (counts[severity] ?? 0) + 1;
  return counts;
}

const setKey = (b: BatchState) => b.packages.map((p) => `${p.name}@${p.to}`).sort().join(" ");

// ---------- plan ----------

export async function createPlan(deps: Deps, options: { checks?: Check[]; force?: boolean } = {}) {
  if (existsSync(statePath(deps)) && !options.force)
    throw new Error(`A plan already exists at ${statePath(deps)}. Pass --force to replace it and lose its progress.`);
  const { adapter } = deps;
  const inventory = await adapter.inventory(ctx(deps));
  const auditResult = await adapter.audit(ctx(deps));
  const advisories = auditResult?.advisories ?? {};

  const skipped: Skipped[] = [];
  const planned: PlannedPackage[] = [];
  for (const item of inventory.outdated) {
    const reason = skipReason(item);
    const bump = reason ? null : bumpKind(item.current, item.latest);
    if (!bump) {
      skipped.push({ name: item.name, from: item.current, latest: item.latest, reason: reason ?? "unknown bump" });
      continue;
    }
    planned.push({
      name: item.name, type: item.type, from: item.current, to: item.latest, bump,
      risk: riskOf(item.type, bump, item.name),
      ...(item.spec !== undefined ? { spec: item.spec } : {}),
      ...(item.meta ? { meta: item.meta } : {}),
      importers: await countImporters(deps, item.name),
      ...(advisories[item.name] ? { advisory: advisories[item.name] } : {}),
    });
  }

  const checks = options.checks ?? adapter.defaultChecks(deps.dir);
  const warnings: string[] = [];
  if (!checks.length) warnings.push("No checks found. Pass --check name=command for build, test, and lint.");
  if (planned.some((p) => p.importers === null)) warnings.push("ripgrep failed, so importing-file counts are missing.");

  const state: State = {
    version: 1,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    project: deps.dir,
    manager: adapter.manager,
    checks,
    batches: buildBatches(planned).map((b) => ({ ...b, status: "pending" })),
    deferred: [],
    skipped,
    transitive: inventory.transitive,
    audit: auditResult && {
      command: auditResult.command,
      exitCode: auditResult.exitCode,
      advisories,
      log: writeLog(deps, "audit.log", auditResult.raw),
    },
    warnings,
  };
  save(deps, state);
  return {
    action: "review-plan",
    manager: state.manager,
    stateFile: statePath(deps),
    checks: state.checks,
    batches: state.batches.map(brief),
    skipped: state.skipped,
    transitiveOutdated: state.transitive,
    audit: state.audit && {
      command: state.audit.command,
      bySeverity: countSeverity(state.audit.advisories),
      inPlan: planned.filter((p) => p.advisory).map((p) => `${p.name} (${p.advisory})`),
      log: state.audit.log,
    },
    warnings,
    next: "Read the changelog of each medium-risk and high-risk package. Show this plan to the user. Then run tick.",
  };
}

// ---------- tick ----------

export async function tick(deps: Deps) {
  const state = loadState(deps);
  for (;;) {
    const batch = state.batches.find((b) => b.status !== "done" && b.status !== "empty");
    if (!batch) return finish(deps, state);

    if (batch.packages.length === 0) {
      if (batch.status !== "pending") await restoreManifests(deps, batch);
      batch.status = "empty";
      save(deps, state);
      continue;
    }

    if (batch.status === "verified") {
      const dirty = await dirtyFiles(deps);
      const head = await git(deps, ["rev-parse", "HEAD"]);
      if (head !== batch.baseCommit && dirty.length === 0) {
        batch.status = "done";
        batch.commit = head;
        save(deps, state);
        continue;
      }
      return commitAction(deps, batch, dirty);
    }

    if (!state.checks.length)
      return { action: "blocked", reason: "The plan has no checks.", next: `Add checks to ${statePath(deps)}, then run tick.` };

    if (batch.status === "pending") {
      const dirty = await dirtyFiles(deps);
      if (dirty.length)
        return {
          action: "blocked",
          reason: "The working tree has changes. A batch starts from a clean tree.",
          files: dirty.slice(0, 30),
          next: "Commit or stash these changes, then run tick.",
        };
      batch.baseCommit = await git(deps, ["rev-parse", "HEAD"]);
    } else if (batch.appliedSet !== setKey(batch)) {
      // A package left the batch: undo the batch's manifest edits, then apply the rest again.
      await restoreManifests(deps, batch);
    }
    return applyAndVerify(deps, state, batch);
  }
}

async function restoreManifests(deps: Deps, batch: BatchState) {
  if (!batch.baseCommit) return;
  for (const file of deps.adapter.manifestFiles(deps.dir)) {
    await deps.run(["git", "checkout", batch.baseCommit, "--", file], { cwd: deps.dir });
  }
  const synced = await deps.adapter.sync(ctx(deps));
  writeLog(deps, `batch-${batch.id}-restore.log`, synced.output);
}

async function applyAndVerify(deps: Deps, state: State, batch: BatchState) {
  const fail = (step: string, command: string, exitCode: number, text: string) => {
    batch.status = "failed";
    batch.failure = { step, command, exitCode, log: writeLog(deps, `batch-${batch.id}-${step}.log`, text), tail: tail(text) };
    save(deps, state);
    return {
      action: "fix",
      batch: brief(batch),
      failure: batch.failure,
      next:
        "Read the log and the changelog. Fix the code for the breaking change, " +
        "or defer the package that causes the failure. Then run tick.",
    };
  };

  const applied = await deps.adapter.apply(ctx(deps), batch.packages);
  batch.appliedSet = setKey(batch);
  if (!applied.ok) return fail("install", applied.commands.at(-1) ?? "", applied.exitCode, applied.output);

  const installed = deps.adapter.installed(deps.dir, batch.packages.map((p) => p.name));
  if (installed) {
    const wrong = batch.packages.filter((p) => installed[p.name] && installed[p.name] !== p.to.replace(/^v/, ""));
    if (wrong.length)
      return fail(
        "verify-install",
        applied.commands.join(" && "),
        1,
        wrong.map((p) => `${p.name}: expected ${p.to}, installed ${installed[p.name]}`).join("\n") + `\n\n${applied.output}`,
      );
  }

  const results: CheckResult[] = [];
  for (const check of state.checks) {
    const started = Date.now();
    const result = await deps.run(["sh", "-c", check.command], {
      cwd: deps.dir,
      env: { CI: "true" },
      timeoutMs: deps.checkTimeoutMs,
    });
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.code !== 0) return fail(check.name, check.command, result.code, text);
    results.push({ name: check.name, command: check.command, exitCode: 0, durationMs: Date.now() - started });
  }

  batch.status = "verified";
  batch.checks = results;
  delete batch.failure;
  save(deps, state);
  return commitAction(deps, batch, await dirtyFiles(deps));
}

function commitAction(deps: Deps, batch: BatchState, changed: string[]) {
  const message = commitMessage(batch, batch.checks ?? []);
  const messageFile = path.join(deps.stateDir, `commit-batch-${batch.id}.txt`);
  writeFileSync(messageFile, message);
  return {
    action: "commit",
    batch: brief(batch),
    changed: changed.slice(0, 30),
    messageFile,
    message,
    next:
      "Add changelog notes to the message file where they help. Stage all changes, " +
      "commit with `git commit -F <messageFile>`, then run tick.",
  };
}

async function finish(deps: Deps, state: State) {
  const after = await deps.adapter.audit(ctx(deps));
  return {
    action: "done",
    completed: state.batches.filter((b) => b.status === "done").map((b) => ({ id: b.id, label: b.label, commit: b.commit, packages: b.packages.map(describe) })),
    emptied: state.batches.filter((b) => b.status === "empty").map((b) => b.id),
    deferred: state.deferred.map((d) => ({ package: describe(d), batch: d.batch, reason: d.reason })),
    skipped: state.skipped,
    advisories: state.audit && after
      ? {
          before: countSeverity(state.audit.advisories),
          now: countSeverity(after.advisories),
          resolved: Object.keys(state.audit.advisories).filter((n) => !after.advisories[n]),
          open: Object.entries(after.advisories).slice(0, 50).map(([n, s]) => `${n} (${s})`),
          log: writeLog(deps, "audit-after.log", after.raw),
        }
      : null,
    next: "Write the summary report for the user.",
  };
}

// ---------- defer and status ----------

export function defer(deps: Deps, name: string, reason: string) {
  const state = loadState(deps);
  const batch = state.batches.find((b) => b.packages.some((p) => p.name === name));
  if (!batch) throw new Error(`No batch has the package ${name}.`);
  if (batch.status === "done") throw new Error(`Batch ${batch.id} is already committed.`);
  const item = batch.packages.find((p) => p.name === name)!;
  batch.packages = batch.packages.filter((p) => p.name !== name);
  // A verified batch must apply again without this package.
  if (batch.status === "verified") batch.status = "failed";
  state.deferred.push({ ...item, batch: batch.id, reason });
  save(deps, state);
  return { action: "deferred", package: describe(item), batch: brief(batch), next: "Run tick." };
}

export function status(deps: Deps) {
  const state = loadState(deps);
  return {
    manager: state.manager,
    stateFile: statePath(deps),
    checks: state.checks,
    batches: state.batches.map(brief),
    deferred: state.deferred.map((d) => ({ package: describe(d), batch: d.batch, reason: d.reason })),
    skipped: state.skipped.length,
    warnings: state.warnings,
  };
}
