import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { type Runner, adapterFor } from "./ecosystems.ts";
import { type Deps, createPlan, defer, loadState, status, tick } from "./workflow.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const OUTDATED = `| Package      | Current | Update | Latest |
|--------------|---------|--------|--------|
| ms           | 2.1.1   | 2.1.1  | 2.1.3  |
| zod          | 3.25.76 | 3.25.76| 4.6.7  |
| prisma       | 7.2.0   | 7.2.0  | 8.0.0-rc.1 |
| semver (dev) | 7.5.4   | 7.5.4  | 7.8.6  |`;

/**
 * A fake project: a real package.json on disk, a fake bun, git, and rg.
 * `bun install` writes node_modules versions from the package.json ranges,
 * unless `installOverride` names a different version.
 */
function fakeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "dep-upgrade-flow-"));
  dirs.push(dir);
  const manifest = {
    scripts: { build: "x", test: "x" },
    dependencies: { ms: "2.1.1", zod: "^3.25.76", prisma: "7.2.0" },
    devDependencies: { semver: "~7.5.0" },
  };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(path.join(dir, "bun.lock"), "");

  const env = {
    head: "c0",
    dirty: [] as string[],
    checkExit: {} as Record<string, number>,
    installOverride: {} as Record<string, string>,
    calls: [] as string[],
  };
  const run: Runner = async (command) => {
    const line = command.join(" ");
    env.calls.push(line);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (line === "bun outdated") return ok(OUTDATED);
    if (line === "bun audit --json") return { code: 1, stdout: `{"zod":[{"severity":"high"}],"lodash":[{"severity":"moderate"}]}`, stderr: "" };
    if (command[0] === "rg") return command.includes(adapterFor("bun").importPattern("zod")) ? ok("a.ts\nb.ts\n") : { code: 1, stdout: "", stderr: "" };
    if (line === "git status --porcelain") return ok(env.dirty.join("\n"));
    if (line === "git rev-parse HEAD") return ok(env.head);
    if (command[0] === "git" && command[1] === "checkout") {
      writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
      return ok();
    }
    if (line === "bun install") {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      for (const [name, range] of Object.entries<string>({ ...pkg.dependencies, ...pkg.devDependencies })) {
        mkdirSync(path.join(dir, "node_modules", name), { recursive: true });
        const version = env.installOverride[name] ?? range.replace(/^[\^~]/, "");
        writeFileSync(path.join(dir, "node_modules", name, "package.json"), JSON.stringify({ version }));
      }
      return ok("installed");
    }
    if (command[0] === "sh") {
      const exit = env.checkExit[command[2]] ?? 0;
      return { code: exit, stdout: exit ? "line\n".repeat(60) + "TypeError: z.string is not a function" : "ok", stderr: "" };
    }
    throw new Error(`unexpected command: ${line}`);
  };
  const deps: Deps = { dir, run, adapter: adapterFor("bun"), stateDir: path.join(dir, ".git", "dep-upgrade"), now: () => new Date("2026-11-19T00:00:00Z") };
  const pkg = () => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return { dir, env, deps, pkg };
}

describe("plan", () => {
  it("writes batches, skips prereleases, and counts importers and advisories", async () => {
    const { deps } = fakeProject();
    const plan = await createPlan(deps);
    expect(plan.checks).toEqual([{ name: "build", command: "bun run build" }, { name: "test", command: "bun run test" }]);
    expect(plan.batches.map((b) => b.packages)).toEqual([
      ["semver 7.5.4 → 7.8.6 (minor, dev, low risk, importers: 0)"],
      ["ms 2.1.1 → 2.1.3 (patch, runtime, low risk, importers: 0)"],
      ["zod 3.25.76 → 4.6.7 (major, runtime, high risk, importers: 2, high advisory)"],
    ]);
    expect(plan.skipped).toEqual([{ name: "prisma", from: "7.2.0", latest: "8.0.0-rc.1", reason: "latest version is a prerelease" }]);
    expect(plan.audit).toMatchObject({ bySeverity: { high: 1, moderate: 1 }, inPlan: ["zod (high)"] });
    await expect(createPlan(deps)).rejects.toThrow("already exists");
  });

  it("uses checks given by the caller", async () => {
    const { deps } = fakeProject();
    const plan = await createPlan(deps, { checks: [{ name: "all", command: "make ci" }] });
    expect(plan.checks).toEqual([{ name: "all", command: "make ci" }]);
  });
});

describe("tick", () => {
  it("runs each batch to a commit, then reports done", async () => {
    const { deps, env, pkg } = fakeProject();
    await createPlan(deps);

    const first = await tick(deps);
    expect(first.action).toBe("commit");
    expect(pkg().devDependencies.semver).toBe("~7.8.6");
    expect(pkg().dependencies.ms).toBe("2.1.1");
    expect((first as any).message).toBe(
      "chore(deps): bump semver from 7.5.4 to 7.8.6\n\n- semver: 7.5.4 → 7.8.6 (minor, dev)\n\n" +
        "Verified: bun run build exit 0, bun run test exit 0.\n",
    );
    expect(readFileSync((first as any).messageFile, "utf8")).toBe((first as any).message);

    // Not committed yet: the same action comes back and nothing is applied again.
    env.dirty = [" M package.json"];
    const installs = env.calls.filter((c) => c === "bun install").length;
    expect((await tick(deps)).action).toBe("commit");
    expect(env.calls.filter((c) => c === "bun install").length).toBe(installs);

    // Committed: the batch closes and the next batch is applied in the same tick.
    env.dirty = [];
    env.head = "c1";
    const second = await tick(deps);
    expect(second.action).toBe("commit");
    expect((second as any).batch.id).toBe(2);
    expect(loadState(deps).batches[0]).toMatchObject({ status: "done", commit: "c1" });

    env.head = "c2";
    expect((await tick(deps)).action).toBe("commit");
    env.head = "c3";
    const done = await tick(deps);
    expect(done).toMatchObject({
      action: "done",
      completed: [{ id: 1, commit: "c1" }, { id: 2, commit: "c2" }, { id: 3, commit: "c3" }],
      skipped: [{ name: "prisma" }],
    });
  });

  it("blocks on a dirty tree before a batch starts", async () => {
    const { deps, env } = fakeProject();
    await createPlan(deps);
    env.dirty = ["?? notes.md"];
    expect(await tick(deps)).toMatchObject({ action: "blocked", files: ["?? notes.md"] });
    expect(env.calls).not.toContain("bun install");
  });

  it("blocks when the plan has no checks", async () => {
    const { deps } = fakeProject();
    await createPlan(deps, { checks: [] });
    expect(await tick(deps)).toMatchObject({ action: "blocked", reason: "The plan has no checks." });
  });

  it("returns the failed check with a bounded tail, then retries after a fix", async () => {
    const { deps, env } = fakeProject();
    await createPlan(deps);
    for (const head of ["c1", "c2"]) {
      await tick(deps);
      env.head = head;
    }
    env.checkExit["bun run test"] = 1;
    const failed = (await tick(deps)) as any;
    expect(failed.action).toBe("fix");
    expect(failed.failure).toMatchObject({ step: "test", command: "bun run test", exitCode: 1 });
    expect(failed.failure.tail.split("\n")).toHaveLength(40);
    expect(failed.failure.tail).toEndWith("TypeError: z.string is not a function");
    expect(readFileSync(failed.failure.log, "utf8")).toContain("line\n".repeat(60));

    // The agent fixes the code; tick does not ask for a clean tree on a retry.
    env.dirty = [" M package.json", " M src/form.ts"];
    env.checkExit["bun run test"] = 0;
    expect((await tick(deps)).action).toBe("commit");
  });

  it("restores manifests and applies the rest when a package is deferred", async () => {
    const { deps, env, pkg } = fakeProject();
    await createPlan(deps, { checks: [{ name: "test", command: "bun run test" }] });
    env.checkExit["bun run test"] = 1;
    expect((await tick(deps)).action).toBe("fix");
    expect(pkg().devDependencies.semver).toBe("~7.8.6");

    expect(defer(deps, "semver", "needs Node 22")).toMatchObject({ action: "deferred" });
    env.checkExit["bun run test"] = 0;
    env.dirty = [" M package.json"];
    const next = (await tick(deps)) as any;
    expect(env.calls).toContain("git checkout c0 -- package.json");
    expect(pkg().devDependencies.semver).toBe("~7.5.0");
    // Batch 1 is now empty. The fake tree stays dirty, so batch 2 waits.
    expect(env.calls.filter((c) => c === "bun install")).toHaveLength(2);
    expect(next.action).toBe("blocked");
    expect(status(deps).batches[0].status).toBe("empty");
    expect(status(deps).deferred).toEqual([
      { package: "semver 7.5.4 → 7.8.6 (minor, dev, low risk, importers: 0)", batch: 1, reason: "needs Node 22" },
    ]);
  });

  it("fails a batch when the installed version is not the target", async () => {
    const { deps, env } = fakeProject();
    await createPlan(deps);
    env.installOverride.semver = "7.8.5";
    const result = (await tick(deps)) as any;
    expect(result.failure).toMatchObject({ step: "verify-install" });
    expect(result.failure.tail).toContain("semver: expected 7.8.6, installed 7.8.5");
    expect(env.calls.some((c) => c.startsWith("sh "))).toBe(false);
  });

  it("refuses to defer from a committed batch", async () => {
    const { deps, env } = fakeProject();
    await createPlan(deps);
    await tick(deps);
    env.head = "c1";
    await tick(deps);
    expect(() => defer(deps, "semver", "x")).toThrow("already committed");
    expect(() => defer(deps, "left-pad", "x")).toThrow("No batch");
  });

  it("needs a plan first", async () => {
    const { deps } = fakeProject();
    expect(existsSync(deps.stateDir)).toBe(false);
    await expect(tick(deps)).rejects.toThrow("Run the plan command first");
  });
});
