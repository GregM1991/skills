// Package manager adapters: detect, list outdated packages, audit, apply a batch.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type DepType, type Outdated, rewriteConstraint } from "./core.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd: string; env?: Record<string, string>; timeoutMs?: number };
export type Runner = (command: string[], options: RunOptions) => Promise<RunResult>;
export type Ctx = { dir: string; run: Runner };

export type Manager = "npm" | "pnpm" | "yarn" | "yarn-berry" | "bun" | "uv" | "pip" | "cargo" | "bundler" | "go";
export type Check = { name: string; command: string };
export type Audit = { command: string; exitCode: number; advisories: Record<string, string>; raw: string };
export type ApplyItem = { name: string; type: DepType; to: string; spec?: string; meta?: Record<string, string> };
export type StepResult = { ok: boolean; commands: string[]; exitCode: number; output: string };
export type Inventory = { outdated: Outdated[]; transitive: number };

export type Adapter = {
  manager: Manager;
  ecosystem: "node" | "python" | "rust" | "ruby" | "go";
  /** Files that hold dependency versions, relative to the project root. */
  manifestFiles(dir: string): string[];
  inventory(ctx: Ctx): Promise<Inventory>;
  audit(ctx: Ctx): Promise<Audit | null>;
  defaultChecks(dir: string): Check[];
  apply(ctx: Ctx, items: ApplyItem[]): Promise<StepResult>;
  /** Brings installed packages back in line with the manifests after a restore. */
  sync(ctx: Ctx): Promise<StepResult>;
  /** Installed versions after apply, or null when the manager has no cheap lookup. */
  installed(dir: string, names: string[]): Record<string, string | null> | null;
  /** ripgrep regex that matches a source file that imports the package. */
  importPattern(name: string): string;
};

// ---------- detection ----------

const ECOSYSTEM: Record<Manager, Adapter["ecosystem"]> = {
  npm: "node", pnpm: "node", yarn: "node", "yarn-berry": "node", bun: "node",
  uv: "python", pip: "python", cargo: "rust", bundler: "ruby", go: "go",
};
const LOCKFILES: [string, Manager][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["uv.lock", "uv"],
  ["Cargo.lock", "cargo"],
  ["Gemfile.lock", "bundler"],
  ["go.mod", "go"],
];
/** Manifests without a lockfile. They count only when no lockfile names a manager for that ecosystem. */
const MANIFESTS: [string, Manager][] = [
  ["package.json", "npm"],
  ["Cargo.toml", "cargo"],
  ["Gemfile", "bundler"],
  ["requirements.txt", "pip"],
  ["pyproject.toml", "pip"],
];

/** Managers found in the project root, lockfiles first. */
export function detectManagers(dir: string): Manager[] {
  const found: Manager[] = [];
  const add = (manager: Manager) => { if (!found.includes(manager)) found.push(manager); };
  for (const [file, manager] of LOCKFILES) {
    if (!existsSync(path.join(dir, file))) continue;
    add(manager === "yarn" && isYarnBerry(dir) ? "yarn-berry" : manager);
  }
  for (const [file, manager] of MANIFESTS) {
    if (existsSync(path.join(dir, file)) && !found.some((m) => ECOSYSTEM[m] === ECOSYSTEM[manager])) add(manager);
  }
  return found;
}

function isYarnBerry(dir: string): boolean {
  if (existsSync(path.join(dir, ".yarnrc.yml"))) return true;
  const lock = path.join(dir, "yarn.lock");
  return existsSync(lock) && readFileSync(lock, "utf8").includes("__metadata:");
}

export function adapterFor(manager: Manager): Adapter {
  switch (manager) {
    case "npm": case "pnpm": case "yarn": case "yarn-berry": case "bun": return nodeAdapter(manager);
    case "uv": case "pip": return pythonAdapter(manager);
    case "cargo": return cargoAdapter();
    case "bundler": return bundlerAdapter();
    case "go": return goAdapter();
  }
}

// ---------- shared helpers ----------

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const output = (r: RunResult) => [r.stdout, r.stderr].filter(Boolean).join("\n");
const read = (dir: string, file: string) => {
  const full = path.join(dir, file);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
};

/** New manifest constraint. Falls back to the full version when truncation changes nothing. */
export function nextConstraint(spec: string | undefined, to: string): string {
  if (!spec) return to;
  const next = rewriteConstraint(spec, to);
  if (next !== spec.trim()) return next;
  const op = spec.trim().match(/^(\^|~>|~=|~|>=|==|=)?(\s*)/);
  return `${op?.[1] ?? ""}${op?.[2] ?? ""}${to.replace(/^v/, "")}`;
}

async function runSteps(ctx: Ctx, commands: string[][], env?: Record<string, string>): Promise<StepResult> {
  const logs: string[] = [];
  const done: string[] = [];
  for (const command of commands) {
    const result = await ctx.run(command, { cwd: ctx.dir, env });
    done.push(command.join(" "));
    logs.push(`$ ${command.join(" ")}\n${output(result)}`);
    if (result.code !== 0) return { ok: false, commands: done, exitCode: result.code, output: logs.join("\n") };
  }
  return { ok: true, commands: done, exitCode: 0, output: logs.join("\n") };
}

const SEVERITY = ["info", "low", "moderate", "high", "critical"];
function addAdvisory(map: Record<string, string>, name: string, severity: string) {
  const current = map[name];
  if (!current || SEVERITY.indexOf(severity) > SEVERITY.indexOf(current)) map[name] = severity;
}

/** Package names with their worst severity, from npm, pnpm, yarn classic, or bun audit JSON. */
export function parseAuditJson(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = raw.trim().startsWith("{") && !raw.includes("\n{") ? [raw] : raw.split("\n");
  for (const line of lines) {
    let data: any;
    try { data = JSON.parse(line); } catch { continue; }
    if (data?.type === "auditAdvisory") {
      addAdvisory(map, data.data.advisory.module_name, data.data.advisory.severity);
    } else if (data?.vulnerabilities && typeof data.vulnerabilities === "object" && !("info" in data.vulnerabilities)) {
      for (const [name, v] of Object.entries<any>(data.vulnerabilities)) addAdvisory(map, name, v.severity);
    } else if (data?.advisories && typeof data.advisories === "object") {
      for (const v of Object.values<any>(data.advisories)) addAdvisory(map, v.module_name, v.severity);
    } else if (data && typeof data === "object" && !data.type) {
      for (const [name, list] of Object.entries<any>(data))
        if (Array.isArray(list)) for (const v of list) if (v?.severity) addAdvisory(map, name, v.severity);
    }
  }
  return map;
}

// ---------- node ----------

type Row = { name: string; current: string; latest: string };
const NODE_SECTIONS: [string, DepType][] = [
  ["dependencies", "runtime"],
  ["optionalDependencies", "runtime"],
  ["devDependencies", "dev"],
];

export function parseNpmOutdated(raw: string): Row[] {
  if (!raw.trim()) return [];
  const data = JSON.parse(raw);
  if (data.error) throw new Error(`npm outdated failed: ${data.error.summary ?? JSON.stringify(data.error)}`);
  return Object.entries<any>(data).flatMap(([name, v]) =>
    (Array.isArray(v) ? v : [v]).map((x) => ({ name, current: x.current ?? "", latest: x.latest ?? "" })),
  );
}

export function parseYarnOutdated(raw: string): Row[] {
  for (const line of raw.split("\n")) {
    if (!line.includes('"type":"table"')) continue;
    const table = JSON.parse(line).data;
    const col = (n: string) => table.head.indexOf(n);
    return table.body.map((r: string[]) => ({ name: r[col("Package")], current: r[col("Current")], latest: r[col("Latest")] }));
  }
  return [];
}

export function parseBunOutdated(raw: string): Row[] {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[-|\s]+\|?$/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && cells[0] !== "Package")
    .map((cells) => ({
      name: cells[0].replace(/\s+\((dev|optional|peer)\)$/, ""),
      current: cells[1],
      latest: cells[3],
    }));
}

function nodeAdapter(manager: "npm" | "pnpm" | "yarn" | "yarn-berry" | "bun"): Adapter {
  const bin = manager === "yarn-berry" ? "yarn" : manager;
  const lockfiles = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
  const manifest = (dir: string) => JSON.parse(read(dir, "package.json") ?? "{}");
  const installCommand: Record<typeof manager, string[]> = {
    npm: ["npm", "install"],
    pnpm: ["pnpm", "install", "--no-frozen-lockfile"],
    yarn: ["yarn", "install"],
    "yarn-berry": ["yarn", "install"],
    bun: ["bun", "install"],
  };
  const install = (ctx: Ctx) => runSteps(ctx, [installCommand[manager]], { YARN_ENABLE_IMMUTABLE_INSTALLS: "false" });

  return {
    manager,
    ecosystem: "node",
    manifestFiles: (dir) => ["package.json", ...lockfiles.filter((f) => existsSync(path.join(dir, f)))],
    async inventory(ctx) {
      const command: Record<typeof manager, string[] | null> = {
        npm: ["npm", "outdated", "--json"],
        pnpm: ["pnpm", "outdated", "--format", "json"],
        yarn: ["yarn", "outdated", "--json"],
        "yarn-berry": null,
        bun: ["bun", "outdated"],
      };
      const cmd = command[manager];
      if (!cmd) throw new Error("Yarn Berry has no outdated command. List outdated packages by hand, or use a Yarn plugin.");
      const result = await ctx.run(cmd, { cwd: ctx.dir });
      // npm, pnpm, and yarn exit 1 when they find outdated packages.
      if (result.code > 1 || (result.code !== 0 && !result.stdout.trim() && result.stderr.trim()))
        throw new Error(`${cmd.join(" ")} failed with exit ${result.code}: ${result.stderr.trim().slice(-500)}`);
      const rows =
        manager === "yarn" ? parseYarnOutdated(result.stdout)
        : manager === "bun" ? parseBunOutdated(result.stdout)
        : parseNpmOutdated(result.stdout);
      const pkg = manifest(ctx.dir);
      const outdated: Outdated[] = [];
      for (const row of rows) {
        const section = NODE_SECTIONS.find(([key]) => pkg[key]?.[row.name] !== undefined);
        if (!section) continue;
        outdated.push({ name: row.name, type: section[1], current: row.current, latest: row.latest, spec: pkg[section[0]][row.name] });
      }
      return { outdated, transitive: 0 };
    },
    async audit(ctx) {
      if (manager === "yarn-berry") return null;
      const cmd = manager === "yarn" ? ["yarn", "audit", "--json"] : [bin, "audit", "--json"];
      const result = await ctx.run(cmd, { cwd: ctx.dir });
      return { command: cmd.join(" "), exitCode: result.code, advisories: parseAuditJson(result.stdout), raw: output(result) };
    },
    defaultChecks(dir) {
      const scripts: Record<string, string> = manifest(dir).scripts ?? {};
      const names = scripts.check ? ["build", "check"] : ["build", "typecheck", "lint", "test"];
      return names.filter((n) => scripts[n]).map((name) => ({ name, command: `${bin} run ${name}` }));
    },
    async apply(ctx, items) {
      const file = path.join(ctx.dir, "package.json");
      const text = readFileSync(file, "utf8");
      const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
      const pkg = JSON.parse(text);
      for (const item of items) {
        const section = NODE_SECTIONS.find(([key]) => pkg[key]?.[item.name] !== undefined);
        if (!section) continue;
        pkg[section[0]][item.name] = nextConstraint(pkg[section[0]][item.name], item.to);
      }
      writeFileSync(file, JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : ""));
      return install(ctx);
    },
    sync: (ctx) => install(ctx),
    installed(dir, names) {
      const out: Record<string, string | null> = {};
      for (const name of names) {
        const text = read(dir, path.join("node_modules", name, "package.json"));
        out[name] = text ? (JSON.parse(text).version ?? null) : null;
      }
      return out;
    },
    importPattern: (name) =>
      `(from\\s+|require\\(\\s*|import\\(\\s*|import\\s+)['"]${escapeRegex(name)}(/[^'"]*)?['"]`,
  };
}

// ---------- python ----------

export const normalizePy = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
export type PyDep = { name: string; extras: string; constraint: string; type: DepType; group?: string; optional?: string; file: string };

export function parseRequirement(line: string): { name: string; extras: string; constraint: string } | null {
  const clean = line.replace(/\s+#.*$/, "").trim();
  if (!clean || clean.startsWith("#") || clean.startsWith("-")) return null;
  const match = clean.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([^;]*?)\s*(;.*)?$/);
  return match ? { name: match[1], extras: match[2] ?? "", constraint: match[3] } : null;
}

/** Quoted strings in a TOML array that starts at `start` (the index of `[`). */
function tomlArray(text: string, start: number): string[] {
  const items: string[] = [];
  let quote = "";
  let current = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { items.push(current); current = ""; quote = ""; } else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") while (i < text.length && text[i] !== "\n") i++;
    else if (ch === "]") break;
  }
  return items;
}

export function parsePyproject(text: string, file = "pyproject.toml"): PyDep[] {
  const deps: PyDep[] = [];
  const sections = [...text.matchAll(/^\[([^\]]+)\]\s*$/gm)];
  sections.forEach((header, index) => {
    const start = header.index! + header[0].length;
    const body = text.slice(start, sections[index + 1]?.index ?? text.length);
    for (const key of body.matchAll(/^([A-Za-z0-9_."-]+)\s*=\s*\[/gm)) {
      const name = key[1].replace(/"/g, "");
      const values = tomlArray(body, key.index! + key[0].length - 1);
      let kind: Pick<PyDep, "type" | "group" | "optional"> | null = null;
      if (header[1] === "project" && name === "dependencies") kind = { type: "runtime" };
      else if (header[1] === "project.optional-dependencies") kind = { type: "runtime", optional: name };
      else if (header[1] === "dependency-groups") kind = { type: "dev", group: name };
      else if (header[1] === "tool.uv" && name === "dev-dependencies") kind = { type: "dev", group: "dev" };
      if (!kind) continue;
      for (const value of values) {
        const req = parseRequirement(value);
        if (req) deps.push({ ...req, ...kind, file });
      }
    }
  });
  return deps;
}

function pythonDeps(dir: string): PyDep[] {
  const deps: PyDep[] = [];
  const pyproject = read(dir, "pyproject.toml");
  if (pyproject) deps.push(...parsePyproject(pyproject));
  for (const [file, type] of [
    ["requirements.txt", "runtime"], ["requirements-dev.txt", "dev"], ["dev-requirements.txt", "dev"], ["requirements/dev.txt", "dev"],
  ] as [string, DepType][]) {
    const text = read(dir, file);
    if (!text) continue;
    for (const line of text.split("\n")) {
      const req = parseRequirement(line);
      if (req) deps.push({ ...req, type, file });
    }
  }
  return deps;
}

function pythonAdapter(manager: "uv" | "pip"): Adapter {
  const python = (dir: string) => (existsSync(path.join(dir, ".venv/bin/python")) ? ".venv/bin/python" : "python3");
  const runner = (dir: string) => (manager === "uv" ? ["uv", "run"] : [python(dir), "-m"]);
  return {
    manager,
    ecosystem: "python",
    manifestFiles: (dir) =>
      ["pyproject.toml", "uv.lock", "requirements.txt", "requirements-dev.txt", "dev-requirements.txt", "requirements/dev.txt"]
        .filter((f) => existsSync(path.join(dir, f))),
    async inventory(ctx) {
      const cmd = manager === "uv"
        ? ["uv", "pip", "list", "--outdated", "--format", "json"]
        : [python(ctx.dir), "-m", "pip", "list", "--outdated", "--format=json"];
      const result = await ctx.run(cmd, { cwd: ctx.dir });
      if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.trim().slice(-500)}`);
      const rows: { name: string; version: string; latest_version: string }[] = JSON.parse(result.stdout || "[]");
      const direct = new Map(pythonDeps(ctx.dir).map((d) => [normalizePy(d.name), d]));
      let transitive = 0;
      const outdated: Outdated[] = [];
      for (const row of rows) {
        const dep = direct.get(normalizePy(row.name));
        if (!dep) { transitive++; continue; }
        const meta: Record<string, string> = { file: dep.file, requirement: dep.name + dep.extras };
        if (dep.group) meta.group = dep.group;
        if (dep.optional) meta.optional = dep.optional;
        outdated.push({ name: dep.name, type: dep.type, current: row.version, latest: row.latest_version, spec: dep.constraint, meta });
      }
      return { outdated, transitive };
    },
    audit: async () => null,
    defaultChecks(dir) {
      const deps = pythonDeps(dir).map((d) => normalizePy(d.name));
      const checks: Check[] = [];
      if (deps.includes("ruff")) checks.push({ name: "lint", command: [...runner(dir), "ruff", "check", "."].join(" ") });
      if (deps.includes("pytest") || existsSync(path.join(dir, "tests")))
        checks.push({ name: "test", command: [...runner(dir), "pytest"].join(" ") });
      return checks;
    },
    async apply(ctx, items) {
      const requirement = (i: ApplyItem) =>
        `${i.meta?.requirement ?? i.name}${i.spec ? nextConstraint(i.spec, i.to) : `>=${i.to}`}`;
      if (manager === "uv") {
        const groups = new Map<string, string[]>();
        for (const item of items) {
          const flag = item.meta?.optional ? `--optional=${item.meta.optional}` : item.meta?.group ? `--group=${item.meta.group}` : "";
          groups.set(flag, [...(groups.get(flag) ?? []), requirement(item)]);
        }
        return runSteps(ctx, [...groups].map(([flag, reqs]) => ["uv", "add", ...(flag ? [flag] : []), ...reqs]));
      }
      // pip: rewrite pinned lines in requirement files, then install each changed file.
      const files = new Set<string>();
      const loose: string[] = [];
      for (const item of items) {
        const file = item.meta?.file;
        if (!file || file === "pyproject.toml" || !item.spec) { loose.push(`${item.name}==${item.to}`); continue; }
        const full = path.join(ctx.dir, file);
        const pattern = new RegExp(`^(\\s*${escapeRegex(item.meta?.requirement ?? item.name)}\\s*)${escapeRegex(item.spec)}`, "im");
        writeFileSync(full, readFileSync(full, "utf8").replace(pattern, `$1${nextConstraint(item.spec, item.to)}`));
        files.add(file);
      }
      const py = python(ctx.dir);
      return runSteps(ctx, [
        ...[...files].map((f) => [py, "-m", "pip", "install", "-r", f]),
        ...(loose.length ? [[py, "-m", "pip", "install", ...loose]] : []),
      ]);
    },
    sync: (ctx) => (manager === "uv" ? runSteps(ctx, [["uv", "sync"]]) : runSteps(ctx, [])),
    installed: () => null,
    importPattern: (name) => `^\\s*(from|import)\\s+${escapeRegex(normalizePy(name).replace(/-/g, "_"))}\\b`,
  };
}

// ---------- rust ----------

export type CargoDep = { name: string; spec: string; type: DepType };

export function parseCargoToml(text: string): CargoDep[] {
  const deps: CargoDep[] = [];
  let type: DepType | null = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const name = header[1].split(".").pop();
      type = name === "dependencies" || name === "build-dependencies" ? "runtime" : name === "dev-dependencies" ? "dev" : null;
      continue;
    }
    if (!type) continue;
    const match =
      line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/) ?? line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bversion\s*=\s*"([^"]+)"/);
    if (match) deps.push({ name: match[1], spec: match[2], type });
  }
  return deps;
}

export function rewriteCargoToml(text: string, name: string, to: string): string {
  const n = escapeRegex(name);
  return text
    .replace(new RegExp(`^(\\s*${n}\\s*=\\s*")([^"]+)(")`, "m"), (_, a, spec, c) => a + nextConstraint(spec, to) + c)
    .replace(new RegExp(`^(\\s*${n}\\s*=\\s*\\{[^}]*\\bversion\\s*=\\s*")([^"]+)(")`, "m"), (_, a, spec, c) => a + nextConstraint(spec, to) + c);
}

function cargoAdapter(): Adapter {
  return {
    manager: "cargo",
    ecosystem: "rust",
    manifestFiles: (dir) => ["Cargo.toml", "Cargo.lock"].filter((f) => existsSync(path.join(dir, f))),
    async inventory(ctx) {
      const cmd = ["cargo", "outdated", "--root-deps-only", "--format", "json"];
      const result = await ctx.run(cmd, { cwd: ctx.dir });
      if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed (install cargo-outdated?): ${result.stderr.trim().slice(-500)}`);
      const manifest = new Map(parseCargoToml(read(ctx.dir, "Cargo.toml") ?? "").map((d) => [d.name, d]));
      const report = JSON.parse(result.stdout.trim().split("\n")[0] || "{}");
      const outdated: Outdated[] = [];
      for (const dep of report.dependencies ?? []) {
        if (!/^\d/.test(dep.latest ?? "")) continue;
        const declared = manifest.get(dep.name);
        const type: DepType = dep.kind === "Development" ? "dev" : "runtime";
        outdated.push({ name: dep.name, type, current: dep.project, latest: dep.latest, spec: declared?.spec });
      }
      return { outdated, transitive: 0 };
    },
    audit: async () => null,
    defaultChecks: () => [
      { name: "build", command: "cargo build --all-targets" },
      { name: "test", command: "cargo test" },
    ],
    async apply(ctx, items) {
      const file = path.join(ctx.dir, "Cargo.toml");
      let text = readFileSync(file, "utf8");
      for (const item of items) text = rewriteCargoToml(text, item.name, item.to);
      writeFileSync(file, text);
      return runSteps(ctx, [["cargo", "update", ...items.flatMap((i) => ["-p", i.name])]]);
    },
    sync: (ctx) => runSteps(ctx, []),
    installed: () => null,
    importPattern: (name) => {
      const crate = escapeRegex(name.replace(/-/g, "_"));
      return `\\b(use|extern crate)\\s+${crate}\\b|\\b${crate}::`;
    },
  };
}

// ---------- ruby ----------

export function parseBundleOutdated(raw: string): Row[] {
  return [...raw.matchAll(/^\s*(?:\*\s*)?([A-Za-z0-9_.-]+) \(newest ([^,]+), installed ([^,)]+)/gm)].map((m) => ({
    name: m[1], latest: m[2].trim(), current: m[3].trim(),
  }));
}

export type GemDep = { name: string; spec?: string; type: DepType };

export function parseGemfile(text: string): GemDep[] {
  const deps: GemDep[] = [];
  const stack: boolean[] = [];
  for (const line of text.split("\n")) {
    const group = line.match(/^\s*group\s+(.+?)\s+do\b/);
    if (group) { stack.push(/:(development|test)\b/.test(group[1]) && !/:production\b/.test(group[1])); continue; }
    if (/^\s*(\w+\s+.*\bdo\b(\s*\|.*\|)?\s*$)/.test(line)) { stack.push(stack.at(-1) ?? false); continue; }
    if (/^\s*end\b/.test(line)) { stack.pop(); continue; }
    const gem = line.match(/^\s*gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?(.*)$/);
    if (!gem) continue;
    const dev = (stack.at(-1) ?? false) || /group:\s*\[?\s*:(development|test)/.test(gem[3] ?? "");
    deps.push({ name: gem[1], spec: gem[2], type: dev ? "dev" : "runtime" });
  }
  return deps;
}

function bundlerAdapter(): Adapter {
  return {
    manager: "bundler",
    ecosystem: "ruby",
    manifestFiles: (dir) => ["Gemfile", "Gemfile.lock"].filter((f) => existsSync(path.join(dir, f))),
    async inventory(ctx) {
      const cmd = ["bundle", "outdated", "--parseable", "--only-explicit"];
      const result = await ctx.run(cmd, { cwd: ctx.dir });
      if (result.code > 1) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.trim().slice(-500)}`);
      const gems = new Map(parseGemfile(read(ctx.dir, "Gemfile") ?? "").map((g) => [g.name, g]));
      const outdated = parseBundleOutdated(result.stdout).flatMap((row) => {
        const gem = gems.get(row.name);
        return gem ? [{ ...row, type: gem.type, spec: gem.spec }] : [];
      });
      return { outdated, transitive: 0 };
    },
    audit: async () => null,
    defaultChecks: (dir) =>
      existsSync(path.join(dir, "spec")) ? [{ name: "test", command: "bundle exec rspec" }]
      : existsSync(path.join(dir, "Rakefile")) ? [{ name: "test", command: "bundle exec rake" }]
      : [],
    async apply(ctx, items) {
      const file = path.join(ctx.dir, "Gemfile");
      let text = readFileSync(file, "utf8");
      for (const item of items) {
        if (!item.spec) continue;
        const pattern = new RegExp(`^(\\s*gem\\s+['"]${escapeRegex(item.name)}['"]\\s*,\\s*['"])([^'"]+)(['"])`, "m");
        text = text.replace(pattern, (_, a, spec, c) => a + nextConstraint(spec, item.to) + c);
      }
      writeFileSync(file, text);
      return runSteps(ctx, [["bundle", "update", ...items.map((i) => i.name)]]);
    },
    sync: (ctx) => runSteps(ctx, [["bundle", "install"]]),
    installed: () => null,
    importPattern: (name) => `require\\s*\\(?\\s*['"]${escapeRegex(name)}['"/]`,
  };
}

// ---------- go ----------

/** Splits the concatenated JSON objects that `go list -json` prints. */
export function parseJsonStream(raw: string): any[] {
  const values: any[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}" && --depth === 0) values.push(JSON.parse(raw.slice(start, i + 1)));
  }
  return values;
}

function goAdapter(): Adapter {
  return {
    manager: "go",
    ecosystem: "go",
    manifestFiles: (dir) => ["go.mod", "go.sum"].filter((f) => existsSync(path.join(dir, f))),
    async inventory(ctx) {
      const cmd = ["go", "list", "-m", "-u", "-json", "all"];
      const result = await ctx.run(cmd, { cwd: ctx.dir });
      if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.trim().slice(-500)}`);
      let transitive = 0;
      const outdated: Outdated[] = [];
      for (const mod of parseJsonStream(result.stdout)) {
        if (mod.Main || !mod.Update) continue;
        if (mod.Indirect) { transitive++; continue; }
        outdated.push({ name: mod.Path, type: "runtime", current: mod.Version, latest: mod.Update.Version });
      }
      return { outdated, transitive };
    },
    audit: async () => null,
    defaultChecks: () => [
      { name: "build", command: "go build ./..." },
      { name: "vet", command: "go vet ./..." },
      { name: "test", command: "go test ./..." },
    ],
    apply: (ctx, items) =>
      runSteps(ctx, [["go", "get", ...items.map((i) => `${i.name}@${i.to.startsWith("v") ? i.to : `v${i.to}`}`)], ["go", "mod", "tidy"]]),
    sync: (ctx) => runSteps(ctx, []),
    installed: () => null,
    importPattern: (name) => `"${escapeRegex(name)}(/[^"]*)?"`,
  };
}
