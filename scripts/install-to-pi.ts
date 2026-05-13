#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const EXCLUDED_SKILLS = new Set(["api-design", "github-workflows", "create-workflow", "openclaw-config"]);

type Options = {
  repo: string;
  target: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: process.cwd(),
    target: "/home/gm/.agents/skills",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--repo") {
      options.repo = resolve(requiredValue(argv, ++index, arg));
    } else if (arg.startsWith("--repo=")) {
      options.repo = resolve(arg.slice("--repo=".length));
    } else if (arg === "--target") {
      options.target = resolve(requiredValue(argv, ++index, arg));
    } else if (arg.startsWith("--target=")) {
      options.target = resolve(arg.slice("--target=".length));
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
  console.log(`Usage: install-to-pi.ts [--dry-run] [--repo PATH] [--target PATH]\n\nInstalls repo skills into Pi's user-managed skills directory. Refuses excluded skills.`);
}

function isSkillDir(path: string): boolean {
  return existsSync(join(path, "SKILL.md"));
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
      console.log(`${options.dryRun ? "would copy" : "copy"} ${relative(options.target, targetPath)}`);
      if (!options.dryRun) copyFileSync(sourcePath, targetPath);
    }
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.repo)) throw new Error(`Repo does not exist: ${options.repo}`);
  if (!options.dryRun) mkdirSync(options.target, { recursive: true });

  const repoEntries = readdirSync(options.repo, { withFileTypes: true });
  const skillNames = repoEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "scripts")
    .map((entry) => entry.name)
    .filter((name) => isSkillDir(join(options.repo, name)))
    .sort();

  for (const excluded of EXCLUDED_SKILLS) {
    if (existsSync(join(options.repo, excluded))) {
      throw new Error(`Refusing to install excluded skill present in repo: ${excluded}`);
    }
  }

  let installed = 0;
  for (const skill of skillNames) {
    if (EXCLUDED_SKILLS.has(skill)) {
      throw new Error(`Refusing to install excluded skill: ${skill}`);
    }

    const sourcePath = join(options.repo, skill);
    const targetPath = join(options.target, skill);
    console.log(`${options.dryRun ? "would install" : "install"} ${skill}`);
    if (!options.dryRun && existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
    copyDir(sourcePath, targetPath, options);
    installed += 1;
  }

  console.log(`\n${options.dryRun ? "Dry run complete" : "Install complete"}: ${installed} skill(s) processed.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
