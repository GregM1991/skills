#!/usr/bin/env bun
// CLI: plan | tick | defer <package> --reason <text> | status. Prints one JSON object.

import path from "node:path";
import { parseArgs } from "node:util";

import { type Check, type Manager, type Runner, adapterFor, detectManagers } from "./ecosystems.ts";
import { type Deps, createPlan, defer, status, tick } from "./workflow.ts";

const USAGE = `Usage: bun dep-upgrade.ts <plan|tick|defer|status> [options]
  --dir <path>            Project root (default: current directory)
  --manager <name>        npm, pnpm, yarn, yarn-berry, bun, uv, pip, cargo, bundler, or go
  --check <name=command>  Check to run after each batch; repeat for more (plan only)
  --state-dir <path>      Plan state folder (default: <git dir>/dep-upgrade)
  --force                 Replace an existing plan (plan only)
  --reason <text>         Why the package waits (defer only)
  --timeout-minutes <n>   Limit for each check (default 30)`;

export const realRunner: Runner = async (command, options) => {
  try {
    const child = Bun.spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs)
      : undefined;
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) return { code: 124, stdout, stderr: `${stderr}\nStopped after ${options.timeoutMs} ms.` };
    return { code: code ?? 1, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
};

function parseCheck(value: string): Check {
  const at = value.indexOf("=");
  if (at < 1) throw new Error(`--check needs name=command, got "${value}".`);
  return { name: value.slice(0, at).trim(), command: value.slice(at + 1).trim() };
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      manager: { type: "string" },
      check: { type: "string", multiple: true },
      force: { type: "boolean" },
      "state-dir": { type: "string" },
      reason: { type: "string" },
      "timeout-minutes": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, name] = positionals;
  if (values.help || !command) return { usage: USAGE };

  const dir = path.resolve(values.dir ?? process.cwd());
  const gitPath = await realRunner(["git", "rev-parse", "--git-path", "dep-upgrade"], { cwd: dir });
  if (gitPath.code !== 0) throw new Error(`${dir} is not in a git repository. Batches need git commits.`);
  const stateDir = path.resolve(values["state-dir"] ?? path.resolve(dir, gitPath.stdout.trim()));

  const managers = detectManagers(dir);
  const manager = (values.manager ?? managers[0]) as Manager | undefined;
  if (!manager) throw new Error(`No supported manifest or lockfile in ${dir}. Pass --manager.`);
  const deps: Deps = {
    dir,
    run: realRunner,
    adapter: adapterFor(manager),
    stateDir,
    checkTimeoutMs: Number(values["timeout-minutes"] ?? 30) * 60_000,
  };

  switch (command) {
    case "plan": {
      const result = await createPlan(deps, { checks: values.check?.map(parseCheck), force: values.force });
      return managers.length > 1 && !values.manager
        ? { ...result, warnings: [...result.warnings, `Found several managers (${managers.join(", ")}); used ${manager}.`] }
        : result;
    }
    case "tick": return tick(deps);
    case "status": return status(deps);
    case "defer":
      if (!name || !values.reason) throw new Error("defer needs <package> and --reason <text>.");
      return defer(deps, name, values.reason);
    default:
      return { usage: USAGE };
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exit(2);
  }
}
