#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXCLUDED_SKILLS = new Set(["api-design", "github-workflows", "create-workflow", "openclaw-config"]);

type Options = {
  repo: string;
};

type Check = {
  name: string;
  ok: boolean;
  details: string[];
};

function parseArgs(argv: string[]): Options {
  const options: Options = { repo: process.cwd() };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      options.repo = resolve(requiredValue(argv, ++index, arg));
    } else if (arg.startsWith("--repo=")) {
      options.repo = resolve(arg.slice("--repo=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: audit-skills.ts [--repo PATH]\n\nAudits repo skill inventory, excluded skills, runtime-only frontmatter, and MANIFEST.md consistency.`);
}

function listSkillDirs(repo: string): string[] {
  return readdirSync(repo, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "scripts")
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(repo, name, "SKILL.md")))
    .sort();
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function parseManifestSkills(repo: string): { current: string[]; absent: string[] } {
  const manifestPath = join(repo, "MANIFEST.md");
  if (!existsSync(manifestPath)) throw new Error(`Missing MANIFEST.md at ${manifestPath}`);
  const lines = readFileSync(manifestPath, "utf8").split("\n");
  const current: string[] = [];
  const absent: string[] = [];
  let section: "none" | "current" | "absent" = "none";

  for (const line of lines) {
    if (line.startsWith("## Current repo skills")) {
      section = "current";
      continue;
    }
    if (line.startsWith("## Intentionally absent skills")) {
      section = "absent";
      continue;
    }
    if (!line.startsWith("| ") || line.includes("---")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length === 0 || cells[0] === "Skill") continue;
    if (section === "current") current.push(cells[0]);
    if (section === "absent") absent.push(cells[0]);
  }

  return { current: current.sort(), absent: absent.sort() };
}

function checkExcludedAbsent(repo: string, manifestAbsent: string[]): Check {
  const details: string[] = [];
  for (const skill of EXCLUDED_SKILLS) {
    if (existsSync(join(repo, skill))) details.push(`excluded skill directory exists: ${skill}`);
    if (!manifestAbsent.includes(skill)) details.push(`excluded skill missing from intentionally absent manifest table: ${skill}`);
  }
  return { name: "excluded skills absent", ok: details.length === 0, details };
}

function checkNoRuntimeMetadata(repo: string): Check {
  const details = walkFiles(repo)
    .filter((path) => path.endsWith("SKILL.md"))
    .filter((path) => readFileSync(path, "utf8").includes("disable-model-invocation"))
    .map((path) => `runtime metadata found: ${relative(repo, path)}`);
  return { name: "repo SKILL.md files exclude runtime metadata", ok: details.length === 0, details };
}

function checkManifestConsistency(repo: string, skillDirs: string[], manifestCurrent: string[]): Check {
  const details: string[] = [];
  const dirSet = new Set(skillDirs);
  const manifestSet = new Set(manifestCurrent);

  for (const skill of manifestCurrent) {
    if (!dirSet.has(skill)) details.push(`manifest skill missing directory: ${skill}`);
  }
  for (const skill of skillDirs) {
    if (!manifestSet.has(skill)) details.push(`skill directory missing from manifest: ${skill}`);
  }
  for (const skill of EXCLUDED_SKILLS) {
    if (manifestSet.has(skill)) details.push(`excluded skill listed as current in manifest: ${skill}`);
  }

  return { name: "manifest matches skill directories", ok: details.length === 0, details };
}

function printCheck(check: Check): void {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
  for (const detail of check.details) console.log(`  - ${detail}`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.repo)) throw new Error(`Repo does not exist: ${options.repo}`);
  if (!statSync(options.repo).isDirectory()) throw new Error(`Repo is not a directory: ${options.repo}`);

  const skillDirs = listSkillDirs(options.repo);
  const manifest = parseManifestSkills(options.repo);
  const checks = [
    checkExcludedAbsent(options.repo, manifest.absent),
    checkNoRuntimeMetadata(options.repo),
    checkManifestConsistency(options.repo, skillDirs, manifest.current),
  ];

  for (const check of checks) printCheck(check);
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  console.log(`\nSummary: ${passed}/${checks.length} checks passed; ${failed} failed; ${skillDirs.length} repo skill(s) found.`);

  if (failed > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
