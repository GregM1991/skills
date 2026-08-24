#!/usr/bin/env bun
// Syncs vendored skills into skills/vendor/<owner>/<name> from the sources listed in
// sources.json. Started from gm-pi-environment's scripts/sync-matt-skills.ts and extended
// for multiple sources, category flattening, collision guarding, the agent-browser two-path
// merge, upstream deletion handling, and a per-source lastSyncedAt.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PathEntry = { from: string; to: string };
export type SourceSkill = { name: string; paths: PathEntry[] };
export type SourceConfig = {
	id: string;
	description: string;
	owner: string;
	repoName: string;
	url: string;
	ref: string;
	licensePaths: string[];
	lastSyncedAt: string | null;
	resolvedCommit: string | null;
	mode: "explicit" | "categories";
	skills?: SourceSkill[];
	categoryRoot?: string;
	includeCategories?: string[];
	excludeCategories?: string[];
};
export type SourcesFile = {
	$schemaVersion: number;
	$comment: string;
	vendorRoot: string;
	sources: SourceConfig[];
};

export type SkillEntry = {
	name: string;
	owner: string;
	sourceId: string;
	category: string | null;
	paths: PathEntry[];
};

export type ChangeKind = "added" | "removed" | "changed";
export type TreeChange = { path: string; kind: ChangeKind };

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SOURCES_PATH = path.join(REPO_ROOT, "sources.json");
const SKILLS_ROOT = path.join(REPO_ROOT, "skills");
const VENDOR_ROOT = path.join(SKILLS_ROOT, "vendor");

// ---------- sources.json ----------

export async function loadSourcesFile(sourcesPath: string): Promise<SourcesFile> {
	const raw = await readFile(sourcesPath, "utf8");
	return JSON.parse(raw) as SourcesFile;
}

async function writeSourcesFile(sourcesPath: string, data: SourcesFile): Promise<void> {
	await writeFile(sourcesPath, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------- authored skills on disk ----------

export async function readAuthoredSkillNames(skillsRoot: string): Promise<string[]> {
	if (!existsSync(skillsRoot)) return [];
	return (await readdir(skillsRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name !== "vendor")
		.map((entry) => entry.name)
		.sort();
}

// ---------- byte-level diff, generalized per skill folder ----------

async function fileMap(root: string): Promise<Map<string, Uint8Array>> {
	const result = new Map<string, Uint8Array>();
	if (!existsSync(root)) return result;
	async function visit(current: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) await visit(absolute);
			else if (entry.isFile()) result.set(path.relative(root, absolute), new Uint8Array(await readFile(absolute)));
		}
	}
	await visit(root);
	return result;
}

function equalBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (!a || !b || a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

export function diffTrees(existing: Map<string, Uint8Array>, staged: Map<string, Uint8Array>): TreeChange[] {
	const changes: TreeChange[] = [];
	for (const relativePath of new Set([...existing.keys(), ...staged.keys()])) {
		const kind = !existing.has(relativePath)
			? "added"
			: !staged.has(relativePath)
				? "removed"
				: equalBytes(existing.get(relativePath), staged.get(relativePath))
					? undefined
					: "changed";
		if (kind) changes.push({ path: relativePath, kind });
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------- cloning ----------

async function cloneSource(source: SourceConfig, workRoot: string): Promise<{ cloneDir: string; resolvedCommit: string }> {
	const cloneDir = path.join(workRoot, source.id);
	if (source.ref === "HEAD") {
		await execFileAsync("git", ["clone", "--depth", "1", source.url, cloneDir]);
	} else {
		try {
			await execFileAsync("git", ["clone", "--depth", "1", "--branch", source.ref, source.url, cloneDir]);
		} catch {
			// ref is likely a raw commit sha, which --depth 1 --branch cannot fetch directly.
			await execFileAsync("git", ["clone", source.url, cloneDir]);
			await execFileAsync("git", ["-C", cloneDir, "checkout", source.ref]);
		}
	}
	const { stdout } = await execFileAsync("git", ["-C", cloneDir, "rev-parse", "HEAD"]);
	return { cloneDir, resolvedCommit: stdout.trim() };
}

// ---------- owner directory casing ----------

// Vendor destinations always use a lowercase owner segment, independent of the casing GitHub
// uses for the owner's real name. sources.json keeps the real casing ("NousResearch") as
// accurate provenance metadata; only the on-disk destination is lowercased here, so the two
// stay consistent through one conversion point instead of needing sources.json to be correct.
export function vendorOwnerDir(owner: string): string {
	return owner.toLowerCase();
}

// ---------- building skill entries per source ----------

async function directoryNames(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	return (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort();
}

export function buildExplicitEntries(source: SourceConfig): SkillEntry[] {
	if (!source.skills) throw new Error(`Source "${source.id}" has mode "explicit" but no skills[] list.`);
	return source.skills.map((skill) => ({
		name: skill.name,
		owner: vendorOwnerDir(source.owner),
		sourceId: source.id,
		category: null,
		paths: skill.paths,
	}));
}

async function buildCategoryEntries(source: SourceConfig, cloneDir: string): Promise<SkillEntry[]> {
	if (!source.categoryRoot || !source.includeCategories) {
		throw new Error(`Source "${source.id}" has mode "categories" but is missing categoryRoot or includeCategories.`);
	}
	const exclude = new Set(source.excludeCategories ?? []);
	const categoryRootAbs = path.join(cloneDir, source.categoryRoot);
	const entries: SkillEntry[] = [];
	for (const category of source.includeCategories) {
		if (exclude.has(category)) continue;
		const categoryAbs = path.join(categoryRootAbs, category);
		if (!existsSync(categoryAbs)) {
			throw new Error(`Source "${source.id}" lists category "${category}" but it no longer exists upstream at ${source.categoryRoot}/${category}.`);
		}
		for (const skillName of await directoryNames(categoryAbs)) {
			entries.push({
				name: skillName,
				owner: vendorOwnerDir(source.owner),
				sourceId: source.id,
				category,
				paths: [{ from: `${source.categoryRoot}/${category}/${skillName}`, to: "." }],
			});
		}
	}
	return entries;
}

export async function buildEntriesForSource(source: SourceConfig, cloneDir: string): Promise<SkillEntry[]> {
	if (source.mode === "explicit") return buildExplicitEntries(source);
	if (source.mode === "categories") return buildCategoryEntries(source, cloneDir);
	throw new Error(`Source "${source.id}" has unknown mode "${(source as SourceConfig).mode}".`);
}

// ---------- collision guard ----------

// Guards against three collision kinds, all fatal:
//   1. two sources producing the same skill name (different sourceId)
//   2. a skill name that would be shadowed under the CLI's first-found-wins rule because one
//      source (chiefly the Matt category source) produces the same name from two categories
//   3. a vendored skill colliding with one of the authored skills at skills/<name>/
export function detectCollisions(entries: SkillEntry[], authoredNames: string[]): string[] {
	const problems: string[] = [];
	const byName = new Map<string, SkillEntry[]>();
	for (const entry of entries) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);

	for (const [name, group] of byName) {
		if (group.length > 1) {
			const sourceIds = new Set(group.map((entry) => entry.sourceId));
			const origins = group.map((entry) => `${entry.sourceId}${entry.category ? `/${entry.category}` : ""}`).join(", ");
			if (sourceIds.size > 1) {
				problems.push(`"${name}" is produced by more than one source: ${origins}.`);
			} else {
				problems.push(`"${name}" collides with itself inside source "${group[0].sourceId}" across categories: ${origins}. The CLI's first-found-wins rule would silently drop one.`);
			}
		}
		if (authoredNames.includes(name)) {
			problems.push(`"${name}" is vendored from ${group.map((entry) => entry.sourceId).join(", ")} but also authored at skills/${name}/.`);
		}
	}
	return problems.sort();
}

// ---------- depth assertion ----------

// Vendor destinations must be exactly skills/vendor/<owner>/<name>, two segments below
// VENDOR_ROOT. Anything deeper (for example a category segment that failed to flatten) falls
// past the skills CLI's depth-3 discovery walk under skills/ and must fail the run.
export function assertVendorDepth(vendorRoot: string, destDir: string): void {
	const relative = path.relative(vendorRoot, destDir);
	const segments = relative.split(path.sep).filter(Boolean);
	if (segments.length !== 2) {
		throw new Error(`Vendor destination "${path.join("skills/vendor", relative)}" has depth ${segments.length + 1} under skills/vendor, expected 2 (owner/name).`);
	}
}

// ---------- copying / staging ----------

async function applyPathEntry(cloneDir: string, stagingDir: string, entry: PathEntry, context: string): Promise<void> {
	const from = path.join(cloneDir, entry.from);
	if (!existsSync(from)) throw new Error(`${context}: missing upstream path "${entry.from}".`);
	const to = entry.to === "." ? stagingDir : path.join(stagingDir, entry.to);
	await mkdir(path.dirname(to), { recursive: true });
	await cp(from, to, { recursive: true });
}

async function copyLicenses(entry: SkillEntry, source: SourceConfig, cloneDir: string, stagingDir: string): Promise<void> {
	if (!source.licensePaths.length || source.licensePaths.some((licensePath) => typeof licensePath !== "string" || licensePath.trim().length === 0)) {
		throw new Error(`Source "${source.id}" must define at least one usable licensePaths entry.`);
	}
	for (const licensePath of source.licensePaths) {
		const from = path.join(cloneDir, licensePath);
		if (!existsSync(from)) throw new Error(`Source "${source.id}" skill "${entry.name}": declared license path "${licensePath}" not found upstream.`);
		await cp(from, path.join(stagingDir, path.basename(licensePath)));
	}
}

async function stageEntry(entry: SkillEntry, source: SourceConfig, cloneDir: string, stagingRoot: string): Promise<string> {
	const stagingDir = path.join(stagingRoot, entry.owner, entry.name);
	await mkdir(stagingDir, { recursive: true });
	for (const pathEntry of entry.paths) {
		await applyPathEntry(cloneDir, stagingDir, pathEntry, `${entry.sourceId}:${entry.name}`);
	}
	await copyLicenses(entry, source, cloneDir, stagingDir);
	return stagingDir;
}

// ---------- zombie sweep ----------

async function listExistingVendorSkills(vendorRoot: string): Promise<Array<{ owner: string; name: string; destDir: string }>> {
	const result: Array<{ owner: string; name: string; destDir: string }> = [];
	for (const owner of await directoryNames(vendorRoot)) {
		for (const name of await directoryNames(path.join(vendorRoot, owner))) {
			result.push({ owner, name, destDir: path.join(vendorRoot, owner, name) });
		}
	}
	return result;
}

// ---------- reporting ----------

type PlanItem = { entry: SkillEntry; source: SourceConfig; destDir: string; stagingDir: string; changes: TreeChange[] };

function printReport(dryRun: boolean, resolvedCommits: Map<string, string>, plan: PlanItem[], zombies: Array<{ owner: string; name: string; destDir: string }>): void {
	console.log(dryRun ? "Would sync (dry run, nothing written):" : "Synced:");
	for (const [sourceId, commit] of resolvedCommits) console.log(`  ${sourceId} @ ${commit}`);
	console.log("");
	for (const item of plan) {
		const label = `skills/vendor/${item.entry.owner}/${item.entry.name}`;
		if (item.changes.length === 0) {
			console.log(`${label}: no changes`);
		} else {
			console.log(`${label}: ${item.changes.length} path change(s)`);
			for (const change of item.changes) console.log(`  ${change.kind} ${change.path}`);
		}
	}
	if (zombies.length) {
		console.log("");
		console.log(`${dryRun ? "Would remove" : "Removed"} ${zombies.length} skill(s) no longer produced by any source:`);
		for (const zombie of zombies) console.log(`  skills/vendor/${zombie.owner}/${zombie.name}`);
	}
}

// ---------- main ----------

async function main(): Promise<void> {
	const dryRun = new Set(process.argv.slice(2)).has("--dry-run");
	const sourcesFile = await loadSourcesFile(SOURCES_PATH);
	const authoredNames = await readAuthoredSkillNames(SKILLS_ROOT);

	const workRoot = await mkdtemp(path.join(tmpdir(), "sync-upstream-clone-"));
	const stagingRoot = await mkdtemp(path.join(tmpdir(), "sync-upstream-stage-"));
	try {
		const resolvedCommits = new Map<string, string>();
		const cloneDirs = new Map<string, string>();
		const allEntries: SkillEntry[] = [];

		for (const source of sourcesFile.sources) {
			const { cloneDir, resolvedCommit } = await cloneSource(source, workRoot);
			cloneDirs.set(source.id, cloneDir);
			resolvedCommits.set(source.id, resolvedCommit);
			allEntries.push(...(await buildEntriesForSource(source, cloneDir)));
		}

		const collisions = detectCollisions(allEntries, authoredNames);
		if (collisions.length) throw new Error(`Skill name collisions found, run aborted:\n${collisions.map((problem) => `  - ${problem}`).join("\n")}`);

		const sourcesById = new Map(sourcesFile.sources.map((source) => [source.id, source]));
		const plan: PlanItem[] = [];
		for (const entry of allEntries) {
			const destDir = path.join(VENDOR_ROOT, entry.owner, entry.name);
			assertVendorDepth(VENDOR_ROOT, destDir);
			const source = sourcesById.get(entry.sourceId);
			if (!source) throw new Error(`Internal error: no source config for "${entry.sourceId}".`);
			const stagingDir = await stageEntry(entry, source, cloneDirs.get(entry.sourceId)!, stagingRoot);
			const changes = diffTrees(await fileMap(destDir), await fileMap(stagingDir));
			plan.push({ entry, source, destDir, stagingDir, changes });
		}

		const plannedKeys = new Set(plan.map((item) => `${item.entry.owner}/${item.entry.name}`));
		const zombies = (await listExistingVendorSkills(VENDOR_ROOT)).filter((existing) => !plannedKeys.has(`${existing.owner}/${existing.name}`));

		if (!dryRun) {
			for (const item of plan) {
				await rm(item.destDir, { recursive: true, force: true });
				await mkdir(path.dirname(item.destDir), { recursive: true });
				await cp(item.stagingDir, item.destDir, { recursive: true });
			}
			for (const zombie of zombies) await rm(zombie.destDir, { recursive: true, force: true });
			for (const owner of await directoryNames(VENDOR_ROOT)) {
				const remaining = await directoryNames(path.join(VENDOR_ROOT, owner));
				if (remaining.length === 0) await rm(path.join(VENDOR_ROOT, owner), { recursive: true, force: true });
			}

			const now = new Date().toISOString();
			for (const source of sourcesFile.sources) {
				source.lastSyncedAt = now;
				source.resolvedCommit = resolvedCommits.get(source.id) ?? source.resolvedCommit;
			}
			await writeSourcesFile(SOURCES_PATH, sourcesFile);
		}

		printReport(dryRun, resolvedCommits, plan, zombies);
	} finally {
		await rm(workRoot, { recursive: true, force: true });
		await rm(stagingRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
