import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Deps, findIssueRefs, rankSpecs, realDeps, run, standardsReason, standardsScope } from "./review-prep";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "review-prep-test-"));
	roots.push(root);
	return root;
}

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

async function put(root: string, file: string, contents: string) {
	await mkdir(path.dirname(path.join(root, file)), { recursive: true });
	await writeFile(path.join(root, file), contents);
}

// A repository with main, then a feature branch that edits code and changes a standards file.
async function repository() {
	const root = await tempRoot();
	const repo = path.join(root, "repo");
	await mkdir(repo);
	git(repo, "init", "--quiet");
	await put(repo, "src/app.ts", "export const a = 1;\n");
	await put(repo, "CONTRIBUTING.md", "Use tabs.\n");
	await put(repo, "docs/adr/0001-use-bun.md", "Use Bun.\n");
	await put(repo, "node_modules/pkg/AGENTS.md", "ignored\n");
	await put(repo, "docs/specs/checkout-flow.md", "Checkout spec.\n");
	await put(repo, "docs/specs/login.md", "Login spec.\n");
	await put(repo, "src/AGENTS.md", "Source rules.\n");
	await put(repo, "server/AGENTS.md", "Server rules.\n");
	await symlink("../src/AGENTS.md", path.join(repo, "docs", "CLAUDE.md"));
	git(repo, "add", "-A", "-f");
	git(repo, "commit", "--quiet", "-m", "init");
	git(repo, "switch", "--quiet", "-c", "feat/42-checkout-retry");
	await put(repo, "src/app.ts", "export const a = 2;\n");
	await put(repo, "CONTRIBUTING.md", "Use spaces.\n");
	await put(repo, "AGENTS.md", "New rules.\n");
	git(repo, "add", "-A");
	git(repo, "commit", "--quiet", "-m", "Retry checkout", "-m", "Closes #45. See acme/other#7 and https://github.com/acme/app/issues/9");
	await put(repo, ".scratch/checkout-retry/spec.md", "Scratch spec.\n");
	return { root, repo };
}

function harness(cwd: string, tmpRoot: string, exec: Deps["exec"] = realDeps.exec) {
	const out: string[] = [];
	const err: string[] = [];
	const deps: Deps = { exec, cwd, tmpRoot, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
	return { deps, out, err };
}

describe("review-prep", () => {
	test("pins the fixed point and returns commits, refs, ranked specs and merge-base standards", async () => {
		const { root, repo } = await repository();
		const h = harness(path.join(repo, "src"), root);
		expect(await run(["main"], h.deps)).toBe(0);
		expect(h.err).toEqual([]);
		const result = JSON.parse(h.out[0]);

		const mainSha = git(repo, "rev-parse", "main");
		expect(result.repository).toBe(repo);
		expect(result.mergeBase).toBe(mainSha);
		expect(result.fixedPointSha).toBe(mainSha);
		expect(result.head).toBe(git(repo, "rev-parse", "HEAD"));
		expect(result.branch).toBe("feat/42-checkout-retry");
		expect(result.diffCommand).toBe(`git diff ${mainSha}...${result.head}`);
		expect(result.commits.map((c: { subject: string }) => c.subject)).toEqual(["Retry checkout"]);
		expect(result.changedFiles.map((f: { path: string }) => f.path).sort()).toEqual(["AGENTS.md", "CONTRIBUTING.md", "src/app.ts"]);

		expect(result.issueRefs.map((r: { ref: string }) => r.ref)).toEqual(["acme/app#9", "#45", "acme/other#7", "#42"]);
		expect(result.issueRefs.find((r: { ref: string }) => r.ref === "#45").closing).toBe(true);

		expect(result.specCandidates[0].path).toBe(".scratch/checkout-retry/spec.md");
		expect(result.specCandidates[1].path).toBe("docs/specs/checkout-flow.md");
		expect(result.specCandidates.at(-1).score).toBe(0);

		expect(result.standards.map((s: { path: string; scope: string }) => [s.path, s.scope])).toEqual([
			["CONTRIBUTING.md", "repository"],
			["docs/CLAUDE.md", "repository"],
			["docs/adr/0001-use-bun.md", "repository"],
			["src/AGENTS.md", "src/"],
		]);
		const contributing = result.standards[0];
		expect(contributing.changedInDiff).toBe(true);
		expect(await readFile(contributing.snapshot, "utf8")).toBe("Use tabs.\n");
		expect(result.standards[1]).toMatchObject({ symlinkTo: "../src/AGENTS.md" });
		expect(result.standards[1].snapshot).toBeUndefined();
		expect(result.standardsAddedInDiff).toEqual(["AGENTS.md"]);
		expect(result.standardsOutOfScope).toBe(1);

		const saved = JSON.parse(await readFile(result.prepJson, "utf8"));
		expect(saved.mergeBase).toBe(mainSha);
	});

	test("fails with exit 1 on a ref that does not resolve or an empty diff", async () => {
		const { root, repo } = await repository();
		const bad = harness(repo, root);
		expect(await run(["no-such-branch"], bad.deps)).toBe(1);
		expect(bad.err[0]).toContain('"no-such-branch" does not resolve');

		const empty = harness(repo, root);
		expect(await run(["HEAD"], empty.deps)).toBe(1);
		expect(empty.err[0]).toContain("is empty");
	});

	test("fails with exit 1 outside a repository and exit 2 on bad arguments", async () => {
		const root = await tempRoot();
		const outside = harness(root, root, async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }));
		expect(await run(["main"], outside.deps)).toBe(1);
		expect(outside.err[0]).toContain("Not inside a git repository");
		expect(await run([], outside.deps)).toBe(2);
		expect(await run(["main", "extra"], outside.deps)).toBe(2);
		expect(await run(["main", "--bogus"], outside.deps)).toBe(2);
	});
});

describe("rules", () => {
	test("finds closing keywords, cross-repo refs, URLs and merge requests but not HTML entities", () => {
		const refs = findIssueRefs([{ source: "c1", text: "Fixes #3, refs #4\nhttps://gitlab.com/g/p/-/merge_requests/8 and !9 &#38;" }]);
		expect(refs).toEqual([
			{ ref: "g/p!8", kind: "merge-request", closing: false, sources: ["c1"] },
			{ ref: "#3", kind: "issue", closing: true, sources: ["c1"] },
			{ ref: "#4", kind: "issue", closing: false, sources: ["c1"] },
			{ ref: "!9", kind: "merge-request", closing: false, sources: ["c1"] },
		]);
	});

	test("ranks specs by branch words, issue number and presence in the diff", () => {
		const ranked = rankSpecs(["docs/a.md", "docs/issue-12.md", "docs/payments-retry.md"], "fix/12-payments", ["12"], new Set(["docs/a.md"]));
		expect(ranked.map((r) => [r.path, r.score])).toEqual([
			["docs/a.md", 3],
			["docs/issue-12.md", 3],
			["docs/payments-retry.md", 2],
		]);
	});

	test("recognises standards documents and skips vendored ones", () => {
		expect(standardsReason("CODING_STANDARDS.md")).toBe("coding standards");
		expect(standardsReason("packages/web/AGENTS.md")).toBe("agent instructions");
		expect(standardsReason(".cursor/rules/react.mdc")).toBe("agent instructions");
		expect(standardsReason("docs/testing-conventions.md")).toBe("standards document");
		expect(standardsReason("vendor/lib/CONTRIBUTING.md")).toBeNull();
		expect(standardsReason("docs/intro.md")).toBeNull();
	});

	test("scopes nested instruction files to their directory", () => {
		expect(standardsScope("AGENTS.md")).toBe("");
		expect(standardsScope("app/server/AGENTS.md")).toBe("app/server/");
		expect(standardsScope("docs/CONTRIBUTING.md")).toBe("");
		expect(standardsScope("docs/adr/0001-x.md")).toBe("");
		expect(standardsScope(".cursor/rules/react.mdc")).toBe("");
	});
});
