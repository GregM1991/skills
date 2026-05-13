#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXCLUDED_SKILLS = new Set(["api-design", "github-workflows", "create-workflow", "openclaw-config"]);
const DEFAULT_MAX_AUDIT_AGE_DAYS = 90;

type Options = {
  repo: string;
  maxAuditAgeDays: number;
  checkUpstream: boolean;
};

type CheckStatus = "pass" | "warn" | "fail";

type Check = {
  name: string;
  status: CheckStatus;
  details: string[];
};

type LockFile = {
  schemaVersion: number;
  lastAudited?: string;
  skills: LockSkill[];
  excludedSkills?: { name: string; status?: string; reason?: string }[];
};

type LockSkill = {
  name: string;
  source?: string;
  upstream?: {
    repo?: string;
    ref?: string;
    status?: string;
  };
  localPath: string;
  lastAudited: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: process.cwd(),
    maxAuditAgeDays: DEFAULT_MAX_AUDIT_AGE_DAYS,
    checkUpstream: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      options.repo = resolve(requiredValue(argv, ++index, arg));
    } else if (arg.startsWith("--repo=")) {
      options.repo = resolve(arg.slice("--repo=".length));
    } else if (arg === "--max-audit-age-days") {
      options.maxAuditAgeDays = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
    } else if (arg.startsWith("--max-audit-age-days=")) {
      options.maxAuditAgeDays = parsePositiveInteger(arg.slice("--max-audit-age-days=".length), "--max-audit-age-days");
    } else if (arg === "--check-upstream") {
      options.checkUpstream = true;
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

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: audit-skills.ts [options]

Audits repo skill inventory, excluded skills, runtime-only frontmatter, MANIFEST.md consistency, and skills.lock.json freshness.

Options:
  --repo PATH                  Repository root to audit. Defaults to the current directory.
  --max-audit-age-days DAYS    Warn when a locked skill's lastAudited date is older than DAYS. Defaults to ${DEFAULT_MAX_AUDIT_AGE_DAYS}.
  --check-upstream             For GitHub-style owner/repo lock entries, fetch candidate upstream SKILL.md content with built-in fetch and compare it to the local SKILL.md.
  -h, --help                   Show this help.

Without --check-upstream, tracked GitHub-style skills are reported as manual-review informational warnings, not failures.`);
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

function readLockFile(repo: string): LockFile {
  const lockPath = join(repo, "skills.lock.json");
  if (!existsSync(lockPath)) throw new Error(`Missing skills.lock.json at ${lockPath}`);
  return JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
}

function checkExcludedAbsent(repo: string, manifestAbsent: string[], lock: LockFile): Check {
  const details: string[] = [];
  const lockAbsent = new Set((lock.excludedSkills ?? []).map((skill) => skill.name));
  for (const skill of EXCLUDED_SKILLS) {
    if (existsSync(join(repo, skill))) details.push(`excluded skill directory exists: ${skill}`);
    if (!manifestAbsent.includes(skill)) details.push(`excluded skill missing from intentionally absent manifest table: ${skill}`);
    if (!lockAbsent.has(skill)) details.push(`excluded skill missing from skills.lock.json excludedSkills: ${skill}`);
  }
  return { name: "excluded skills absent and non-installable", status: details.length === 0 ? "pass" : "fail", details };
}

function checkNoRuntimeMetadata(repo: string): Check {
  const details = walkFiles(repo)
    .filter((path) => path.endsWith("SKILL.md"))
    .filter((path) => readFileSync(path, "utf8").includes("disable-model-invocation"))
    .map((path) => `runtime metadata found: ${relative(repo, path)}`);
  return { name: "repo SKILL.md files exclude runtime metadata", status: details.length === 0 ? "pass" : "fail", details };
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

  return { name: "manifest matches skill directories", status: details.length === 0 ? "pass" : "fail", details };
}

function checkLockFile(repo: string, skillDirs: string[], lock: LockFile): Check {
  const details: string[] = [];
  if (lock.schemaVersion !== 1) details.push(`unsupported skills.lock.json schemaVersion: ${String(lock.schemaVersion)}`);
  if (!Array.isArray(lock.skills)) details.push("skills.lock.json skills must be an array");
  if (!Array.isArray(lock.excludedSkills)) details.push("skills.lock.json excludedSkills must be an array");

  const names = new Set<string>();
  const dirSet = new Set(skillDirs);
  for (const skill of lock.skills ?? []) {
    if (!skill.name) details.push("locked skill missing name");
    if (skill.name && names.has(skill.name)) details.push(`duplicate locked skill: ${skill.name}`);
    if (skill.name) names.add(skill.name);
    if (skill.name && EXCLUDED_SKILLS.has(skill.name)) details.push(`excluded skill listed as installable lock entry: ${skill.name}`);
    if (!skill.localPath) details.push(`locked skill missing localPath: ${skill.name || "<unknown>"}`);
    if (skill.localPath && !existsSync(join(repo, skill.localPath, "SKILL.md"))) details.push(`locked skill localPath missing SKILL.md: ${skill.name} -> ${skill.localPath}`);
    if (skill.localPath && !dirSet.has(skill.localPath)) details.push(`locked skill localPath is not a current skill directory: ${skill.name} -> ${skill.localPath}`);
    if (!parseAuditDate(skill.lastAudited)) details.push(`locked skill has invalid lastAudited date: ${skill.name} -> ${String(skill.lastAudited)}`);
  }

  return { name: "skills.lock.json is valid", status: details.length === 0 ? "pass" : "fail", details };
}

function parseAuditDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function ageInDays(date: Date, now = new Date()): number {
  return Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - date.valueOf()) / 86_400_000);
}

function checkAuditAge(lock: LockFile, maxAgeDays: number): Check {
  const details: string[] = [];
  for (const skill of lock.skills) {
    const audited = parseAuditDate(skill.lastAudited);
    if (!audited) continue;
    const age = ageInDays(audited);
    if (age > maxAgeDays) details.push(`${skill.name} last audited ${age} day(s) ago on ${skill.lastAudited}; threshold is ${maxAgeDays}`);
  }
  return { name: "locked skill audit dates are fresh", status: details.length === 0 ? "pass" : "warn", details };
}

function isGitHubRepo(repo: string | undefined): repo is string {
  return typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function checkManualUpstreamReview(lock: LockFile): Check {
  const details = lock.skills
    .filter((skill) => isGitHubRepo(skill.upstream?.repo))
    .map((skill) => `${skill.name}: tracked upstream ${skill.upstream?.repo}/${skill.upstream?.ref ?? "<unknown>"}; run with --check-upstream to compare`);
  return { name: "upstream freshness requires manual review", status: details.length === 0 ? "pass" : "warn", details };
}

async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, { headers: { "User-Agent": "skills-audit-script" } });
  if (!response.ok) return null;
  return await response.text();
}

function normalizeContent(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function upstreamRawCandidates(repo: string, ref: string | undefined): string[] {
  const safeRef = (ref ?? "").replace(/^\/+|\/+$/g, "");
  const paths = safeRef ? [`${safeRef}/SKILL.md`, `skills/${safeRef}/SKILL.md`, `${safeRef}`] : ["SKILL.md"];
  const branches = ["main", "master"];
  const urls: string[] = [];
  for (const branch of branches) {
    for (const path of paths) urls.push(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`);
  }
  return urls;
}

async function checkUpstream(repo: string, lock: LockFile): Promise<Check> {
  const details: string[] = [];
  for (const skill of lock.skills) {
    const upstreamRepo = skill.upstream?.repo;
    if (!isGitHubRepo(upstreamRepo)) {
      details.push(`${skill.name}: manual-review; upstream repo is not GitHub owner/repo (${upstreamRepo ?? "missing"})`);
      continue;
    }

    const localSkillPath = join(repo, skill.localPath, "SKILL.md");
    if (!existsSync(localSkillPath)) continue;
    const local = normalizeContent(readFileSync(localSkillPath, "utf8"));
    let matched = false;
    let fetched = false;
    for (const url of upstreamRawCandidates(upstreamRepo, skill.upstream?.ref)) {
      const remote = await fetchText(url);
      if (remote === null) continue;
      fetched = true;
      if (normalizeContent(remote) === local) {
        matched = true;
        break;
      }
    }

    if (matched) {
      details.push(`${skill.name}: upstream SKILL.md matches`);
    } else if (fetched) {
      details.push(`${skill.name}: upstream SKILL.md differs; review for update (${upstreamRepo}/${skill.upstream?.ref ?? ""})`);
    } else {
      details.push(`${skill.name}: could not fetch upstream SKILL.md candidates; manual-review (${upstreamRepo}/${skill.upstream?.ref ?? ""})`);
    }
  }

  const hasDiffOrMissing = details.some((detail) => detail.includes("differs") || detail.includes("could not fetch") || detail.includes("manual-review"));
  return { name: "upstream SKILL.md comparison", status: hasDiffOrMissing ? "warn" : "pass", details };
}

function printCheck(check: Check): void {
  const label = check.status.toUpperCase();
  console.log(`${label} ${check.name}`);
  for (const detail of check.details) console.log(`  - ${detail}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.repo)) throw new Error(`Repo does not exist: ${options.repo}`);
  if (!statSync(options.repo).isDirectory()) throw new Error(`Repo is not a directory: ${options.repo}`);

  const skillDirs = listSkillDirs(options.repo);
  const manifest = parseManifestSkills(options.repo);
  const lock = readLockFile(options.repo);
  const checks: Check[] = [
    checkExcludedAbsent(options.repo, manifest.absent, lock),
    checkNoRuntimeMetadata(options.repo),
    checkManifestConsistency(options.repo, skillDirs, manifest.current),
    checkLockFile(options.repo, skillDirs, lock),
    checkAuditAge(lock, options.maxAuditAgeDays),
  ];

  checks.push(options.checkUpstream ? await checkUpstream(options.repo, lock) : checkManualUpstreamReview(lock));

  for (const check of checks) printCheck(check);
  const passed = checks.filter((check) => check.status === "pass").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  console.log(`\nSummary: ${passed}/${checks.length} passed; ${warned} warned; ${failed} failed; ${skillDirs.length} repo skill(s) found; ${lock.skills.length} locked upstream-tracked skill(s).`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
