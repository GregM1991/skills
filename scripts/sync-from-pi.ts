#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const EXCLUDED_SKILLS = new Set(["api-design", "github-workflows", "create-workflow", "openclaw-config"]);
const RUNTIME_FRONTMATTER_FIELDS = new Set(["disable-model-invocation"]);

type Options = {
  source: string;
  repo: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    source: "/home/gm/.agents/skills",
    repo: process.cwd(),
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--source") {
      options.source = resolve(requiredValue(argv, ++index, arg));
    } else if (arg.startsWith("--source=")) {
      options.source = resolve(arg.slice("--source=".length));
    } else if (arg === "--repo") {
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
  console.log(`Usage: sync-from-pi.ts [--dry-run] [--source PATH] [--repo PATH]\n\nCopies user-managed skills from Pi into the repo, skipping excluded skills and stripping runtime-only frontmatter.`);
}

function isSkillDir(path: string): boolean {
  return existsSync(join(path, "SKILL.md"));
}

function stripRuntimeFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;

  const frontmatter = content.slice(4, end).split("\n");
  const body = content.slice(end);
  const kept = frontmatter.filter((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):/);
    return !match || !RUNTIME_FRONTMATTER_FIELDS.has(match[1]);
  });

  return `---\n${kept.join("\n")}\n${body}`;
}

function copyDir(source: string, target: string, options: Options): void {
  const entries = readdirSync(source, { withFileTypes: true });
  if (!options.dryRun) mkdirSync(target, { recursive: true });

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);

    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath, options);
    } else if (entry.isFile()) {
      const rel = relative(options.repo, targetPath);
      if (basename(sourcePath) === "SKILL.md") {
        const stripped = stripRuntimeFrontmatter(readFileSync(sourcePath, "utf8"));
        console.log(`${options.dryRun ? "would write" : "write"} ${rel}`);
        if (!options.dryRun) writeFileSync(targetPath, stripped);
      } else {
        console.log(`${options.dryRun ? "would copy" : "copy"} ${rel}`);
        if (!options.dryRun) copyFileSync(sourcePath, targetPath);
      }
    }
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.source)) throw new Error(`Source does not exist: ${options.source}`);
  if (!existsSync(options.repo)) throw new Error(`Repo does not exist: ${options.repo}`);

  const skills = readdirSync(options.source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => isSkillDir(join(options.source, name)))
    .sort();

  let copied = 0;
  let skipped = 0;

  for (const skill of skills) {
    if (EXCLUDED_SKILLS.has(skill)) {
      console.log(`skip excluded ${skill}`);
      skipped += 1;
      continue;
    }

    const sourcePath = join(options.source, skill);
    const targetPath = join(options.repo, skill);
    console.log(`${options.dryRun ? "would sync" : "sync"} ${skill}`);
    if (!options.dryRun && existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
    copyDir(sourcePath, targetPath, options);
    copied += 1;
  }

  console.log(`\n${options.dryRun ? "Dry run complete" : "Sync complete"}: ${copied} skill(s) processed, ${skipped} excluded.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
