import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildEntriesForSource, type SourceConfig } from "./sync-upstream";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("category sync excludes only named skills, even after an upstream category move", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "skill-exclusions-test-"));
	roots.push(root);
	for (const directory of ["engineering/pr", "productivity/pr", "engineering/pr-review", "productivity/research"]) {
		await mkdir(path.join(root, "skills", directory), { recursive: true });
	}
	const source: SourceConfig = {
		id: "example",
		description: "Fixture",
		owner: "example",
		repoName: "skills",
		url: "https://example.invalid/skills",
		ref: "HEAD",
		licensePaths: [],
		lastSyncedAt: null,
		resolvedCommit: null,
		mode: "categories",
		categoryRoot: "skills",
		includeCategories: ["engineering", "productivity"],
		excludeSkills: ["pr"],
	};
	expect((await buildEntriesForSource(source, root)).map((entry) => entry.name)).toEqual(["pr-review", "research"]);
	expect((await buildEntriesForSource({ ...source, excludeSkills: undefined }, root)).map((entry) => entry.name)).toEqual(["pr", "pr-review", "pr", "research"]);
});
