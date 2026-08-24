import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadVendorOverlays } from "./vendor-overlays";

const temporaryRoots: string[] = [];

async function makeTemporaryRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "vendor-overlays-test-"));
	temporaryRoots.push(root);
	return root;
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
	const filePath = path.join(root, relativePath);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
}

async function addOverlay(root: string, operations: unknown[], files: Record<string, string> = {}): Promise<void> {
	await write(
		root,
		"overlays/mattpocock/grilling/overlay.json",
		`${JSON.stringify({ $schemaVersion: 1, operations }, null, 2)}\n`,
	);
	for (const [relativePath, contents] of Object.entries(files)) {
		await write(root, `overlays/mattpocock/grilling/${relativePath}`, contents);
	}
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("vendor overlays", () => {
	test("leaves skills without overlays byte-for-byte unchanged", async () => {
		const root = await makeTemporaryRoot();
		await write(root, "stage/SKILL.md", "upstream\n");
		const overlays = await loadVendorOverlays(path.join(root, "overlays"));

		await overlays.apply("mattpocock", "grilling", path.join(root, "stage"));
		overlays.assertAllApplied();

		expect(await readFile(path.join(root, "stage/SKILL.md"), "utf8")).toBe("upstream\n");
	});

	test("appends missing content once and preserves declared operation order", async () => {
		const root = await makeTemporaryRoot();
		await write(root, "stage/SKILL.md", "stable before\nold wording\nstable after\n");
		await addOverlay(
			root,
			[
				{ type: "patch", patch: "001-reword.patch" },
				{ type: "append-if-missing", target: "SKILL.md", content: "addition.md" },
			],
			{
				"001-reword.patch": [
					"diff --git a/SKILL.md b/SKILL.md",
					"--- a/SKILL.md",
					"+++ b/SKILL.md",
					"@@ -1,3 +1,3 @@",
					" stable before",
					"-old wording",
					"+new wording",
					" stable after",
					"",
				].join("\n"),
				"addition.md": "Local instruction.\n",
			},
		);
		const overlays = await loadVendorOverlays(path.join(root, "overlays"));

		await overlays.apply("mattpocock", "grilling", path.join(root, "stage"));
		await overlays.apply("mattpocock", "grilling", path.join(root, "stage"));
		overlays.assertAllApplied();

		expect(await readFile(path.join(root, "stage/SKILL.md"), "utf8")).toBe(
			"stable before\nnew wording\nstable after\n\nLocal instruction.\n",
		);
	});

	test("does not duplicate append content already supplied upstream", async () => {
		const root = await makeTemporaryRoot();
		await write(root, "stage/SKILL.md", "Upstream now includes the local instruction.\n");
		await addOverlay(
			root,
			[{ type: "append-if-missing", target: "SKILL.md", content: "addition.md" }],
			{ "addition.md": "local instruction\n" },
		);
		const overlays = await loadVendorOverlays(path.join(root, "overlays"));

		await overlays.apply("mattpocock", "grilling", path.join(root, "stage"));

		expect(await readFile(path.join(root, "stage/SKILL.md"), "utf8")).toBe("Upstream now includes the local instruction.\n");
	});

	test("applies a strict patch when unrelated upstream lines change", async () => {
		const root = await makeTemporaryRoot();
		await write(root, "stage/SKILL.md", "new upstream heading\nstable before\nold wording\nstable after\nnew upstream footer\n");
		await addOverlay(root, [{ type: "patch", patch: "001-reword.patch" }], {
			"001-reword.patch": [
				"diff --git a/SKILL.md b/SKILL.md",
				"--- a/SKILL.md",
				"+++ b/SKILL.md",
				"@@ -2,3 +2,3 @@",
				" stable before",
				"-old wording",
				"+local wording",
				" stable after",
				"",
			].join("\n"),
		});
		const overlays = await loadVendorOverlays(path.join(root, "overlays"));

		await overlays.apply("mattpocock", "grilling", path.join(root, "stage"));

		expect(await readFile(path.join(root, "stage/SKILL.md"), "utf8")).toBe(
			"new upstream heading\nstable before\nlocal wording\nstable after\nnew upstream footer\n",
		);
	});

	test("fails when upstream changes the same patch hunk", async () => {
		const root = await makeTemporaryRoot();
		await write(root, "stage/SKILL.md", "stable before\nupstream replacement\nstable after\n");
		await addOverlay(root, [{ type: "patch", patch: "001-reword.patch" }], {
			"001-reword.patch": [
				"diff --git a/SKILL.md b/SKILL.md",
				"--- a/SKILL.md",
				"+++ b/SKILL.md",
				"@@ -1,3 +1,3 @@",
				" stable before",
				"-old wording",
				"+local wording",
				" stable after",
				"",
			].join("\n"),
		});
		const overlays = await loadVendorOverlays(path.join(root, "overlays"));

		await expect(overlays.apply("mattpocock", "grilling", path.join(root, "stage"))).rejects.toThrow(
			'patch "001-reword.patch" failed',
		);
		expect(await readFile(path.join(root, "stage/SKILL.md"), "utf8")).toBe(
			"stable before\nupstream replacement\nstable after\n",
		);
	});

	test("rejects missing targets and paths that escape their allowed directories", async () => {
		const missingRoot = await makeTemporaryRoot();
		await addOverlay(
			missingRoot,
			[{ type: "append-if-missing", target: "missing.md", content: "addition.md" }],
			{ "addition.md": "instruction\n" },
		);
		const missingOverlays = await loadVendorOverlays(path.join(missingRoot, "overlays"));
		await expect(missingOverlays.apply("mattpocock", "grilling", path.join(missingRoot, "stage"))).rejects.toThrow(
			"append target does not exist",
		);

		const escapingRoot = await makeTemporaryRoot();
		await addOverlay(escapingRoot, [{ type: "append-if-missing", target: "../outside.md", content: "addition.md" }], {
			"addition.md": "instruction\n",
		});
		await expect(loadVendorOverlays(path.join(escapingRoot, "overlays"))).rejects.toThrow("escapes its allowed directory");

		const symlinkRoot = await makeTemporaryRoot();
		await write(symlinkRoot, "outside.md", "must remain unchanged\n");
		await mkdir(path.join(symlinkRoot, "stage"), { recursive: true });
		await symlink(path.join(symlinkRoot, "outside.md"), path.join(symlinkRoot, "stage/SKILL.md"));
		await addOverlay(
			symlinkRoot,
			[{ type: "append-if-missing", target: "SKILL.md", content: "addition.md" }],
			{ "addition.md": "instruction\n" },
		);
		const symlinkOverlays = await loadVendorOverlays(path.join(symlinkRoot, "overlays"));
		await expect(symlinkOverlays.apply("mattpocock", "grilling", path.join(symlinkRoot, "stage"))).rejects.toThrow(
			"resolves outside its allowed directory",
		);
		expect(await readFile(path.join(symlinkRoot, "outside.md"), "utf8")).toBe("must remain unchanged\n");
	});

	test("rejects malformed manifests and overlays for removed upstream skills", async () => {
		const malformedRoot = await makeTemporaryRoot();
		await write(malformedRoot, "overlays/mattpocock/grilling/overlay.json", '{"$schemaVersion":2,"operations":[]}\n');
		await expect(loadVendorOverlays(path.join(malformedRoot, "overlays"))).rejects.toThrow("must declare $schemaVersion 1");

		const orphanRoot = await makeTemporaryRoot();
		await addOverlay(
			orphanRoot,
			[{ type: "append-if-missing", target: "SKILL.md", content: "addition.md" }],
			{ "addition.md": "instruction\n" },
		);
		const orphaned = await loadVendorOverlays(path.join(orphanRoot, "overlays"));
		expect(() => orphaned.assertAllApplied()).toThrow("mattpocock/grilling");
	});
});
