import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { bunRunner, main, type Runner } from "./impl-tick";

// Every test uses a throwaway repository in its own temporary directory.
let sandbox: string;
let repo: string;
let issues: string;

async function sh(cwd: string, ...args: string[]): Promise<string> {
	const result = await bunRunner(["git", ...args], { cwd });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

async function ticketFile(name: string, title: string, blockedBy: string, status = "ready-for-agent") {
	await writeFile(path.join(issues, name), `# ${name.slice(0, 2)}: ${title}\n\n**What to build:** x\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n`);
}

async function cli(args: string[], run: Runner = bunRunner) {
	const { code, output } = await main([...args, "--spec", issues, "--integration", "feat/x", "--worktree-root", path.join(sandbox, "wt")], run, repo);
	return { code, output: output as any };
}

async function commitIn(worktree: string, file: string, text: string) {
	await writeFile(path.join(worktree, file), text);
	await sh(worktree, "add", file);
	await sh(worktree, "commit", "-q", "-m", `add ${file}`);
}

beforeEach(async () => {
	sandbox = await mkdtemp(path.join(tmpdir(), "impl-tick-test-"));
	repo = path.join(sandbox, "repo");
	issues = path.join(sandbox, "spec", "issues");
	await mkdir(repo);
	await mkdir(issues, { recursive: true });
	await sh(repo, "init", "-q", "-b", "main");
	await sh(repo, "config", "user.email", "test@example.com");
	await sh(repo, "config", "user.name", "Test");
	await sh(repo, "config", "commit.gpgsign", "false");
	await writeFile(path.join(repo, "README.md"), "base\n");
	await sh(repo, "add", ".");
	await sh(repo, "commit", "-q", "-m", "base");
	await ticketFile("01-schema.md", "Schema", "None (can start immediately)");
	await ticketFile("02-api.md", "API", "01");
	await ticketFile("03-ui.md", "UI", "#1, API");
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

describe("tick", () => {
	test("asks for the integration branch first", async () => {
		const { code, output } = await cli(["tick"]);
		expect(code).toBe(0);
		expect(output.next).toEqual([expect.objectContaining({ action: "create-integration-branch" })]);
	});

	test("finds the frontier from blocking edges", async () => {
		await sh(repo, "branch", "feat/x");
		const { output } = await cli(["tick"]);
		const states = Object.fromEntries(output.tickets.map((t: any) => [t.id, t.state]));
		expect(states).toEqual({ "01": "ready", "02": "blocked", "03": "blocked" });
		expect(output.tickets.find((t: any) => t.id === "03").waitingOn).toEqual(["01", "02"]);
		expect(output.next).toEqual([expect.objectContaining({ action: "start", ticket: "01" })]);
	});

	test("treats closed tickets as done and flags blocker lines it cannot read", async () => {
		await ticketFile("01-schema.md", "Schema", "None", "done");
		await ticketFile("02-api.md", "API", "the auth rework");
		await sh(repo, "branch", "feat/x");
		const { output } = await cli(["tick"]);
		expect(output.tickets.map((t: any) => t.state)).toEqual(["closed", "blocked", "blocked"]);
		expect(output.tickets[1].unparsedBlockers).toBe("the auth rework");
		expect(output.next).toEqual([expect.objectContaining({ action: "stuck", tickets: ["02", "03"] })]);
	});
});

describe("full run", () => {
	test("start, merge and cleanup move the frontier to finish", async () => {
		await sh(repo, "branch", "feat/x");

		const dry = await cli(["start", "01", "--dry-run"]);
		expect(dry.output.dryRun).toBe(true);
		expect(await readdir(sandbox)).not.toContain("wt");

		const started = await cli(["start", "01"]);
		expect(started.code).toBe(0);
		expect(started.output).toMatchObject({ ok: true, branch: "feat/x-t01", verified: true });
		const worktree = started.output.worktree;

		const again = await cli(["start", "01"]);
		expect(again.code).toBe(2);

		const empty = await cli(["merge", "01"]);
		expect(empty.code).toBe(2);
		expect(empty.output.error).toContain("no commits");

		await commitIn(worktree, "schema.txt", "schema\n");
		const running = await cli(["tick"]);
		expect(running.output.tickets[0]).toMatchObject({ state: "running", commitsAhead: 1, hasIntegrationTip: true, dirty: false });
		expect(running.output.next).toEqual([expect.objectContaining({ action: "wait", ticket: "01" })]);

		// The integration branch is not checked out, so merge writes the commit with plumbing.
		const merged = await cli(["merge", "01"]);
		expect(merged.code).toBe(0);
		expect(merged.output).toMatchObject({ merged: true, method: "commit-tree" });
		expect(await sh(repo, "show", "feat/x:schema.txt")).toBe("schema");
		expect(await sh(repo, "log", "-1", "--format=%B", "feat/x")).toContain("Impl-Tick-Ticket: 01");
		const actions = merged.output.next.map((n: any) => `${n.action}:${n.ticket ?? n.tickets}`);
		expect(actions).toEqual(["start:02", "cleanup:01"]);

		const cleaned = await cli(["cleanup"]);
		expect(cleaned.output).toMatchObject({ removed: ["01"], remaining: [] });
		expect(await sh(repo, "branch", "--list", "feat/x-t01")).toBe("");

		// Ticket 02 merges through a checked-out integration worktree.
		await sh(repo, "worktree", "add", "-q", path.join(sandbox, "integration"), "feat/x");
		const second = await cli(["start", "02"]);
		await commitIn(second.output.worktree, "api.txt", "api\n");
		const viaWorktree = await cli(["merge", "02"]);
		expect(viaWorktree.output).toMatchObject({ merged: true, method: "merge-in-worktree" });

		const third = await cli(["start", "03"]);
		await commitIn(third.output.worktree, "ui.txt", "ui\n");
		await cli(["merge", "03"]);
		await cli(["cleanup"]);
		const done = await cli(["tick"]);
		expect(done.output.counts).toMatchObject({ merged: 3 });
		expect(done.output.next.map((n: any) => n.action)).toEqual(["finish"]);
	});

	test("merge refuses a branch without the integration tip and a dirty worktree", async () => {
		await ticketFile("02-api.md", "API", "None");
		await sh(repo, "branch", "feat/x");
		const one = await cli(["start", "01"]);
		const two = await cli(["start", "02"]);
		await commitIn(one.output.worktree, "a.txt", "a\n");
		await commitIn(two.output.worktree, "b.txt", "b\n");
		expect((await cli(["merge", "01"])).code).toBe(0);

		const behind = await cli(["merge", "02"]);
		expect(behind.code).toBe(2);
		expect(behind.output.action).toBe("update-branch");

		await sh(two.output.worktree, "merge", "-q", "--no-edit", "feat/x");
		await writeFile(path.join(two.output.worktree, "b.txt"), "changed\n");
		const dirty = await cli(["merge", "02"]);
		expect(dirty.code).toBe(2);
		expect(dirty.output.action).toBe("commit-or-discard");

		await sh(two.output.worktree, "commit", "-q", "-am", "more");
		expect((await cli(["merge", "02"])).code).toBe(0);
	});
});

describe("GitHub spec", () => {
	test("reads sub-issues and blockers through github-issue-reader", async () => {
		await sh(repo, "branch", "feat/x");
		const url = (n: number) => `https://github.com/o/r/issues/${n}`;
		const issue = (n: number, state = "open") => ({ number: n, title: `T${n}`, html_url: url(n), state });
		const snapshots: Record<string, unknown> = {
			"10": { repository: "o/r", issue: issue(10), relationships: { children: [issue(11), issue(12), issue(13, "closed")], blockers: [] } },
			"11": { repository: "o/r", issue: issue(11), relationships: { children: [], blockers: [issue(13, "closed")] } },
			"12": { repository: "o/r", issue: issue(12), relationships: { children: [], blockers: [issue(11), issue(99)] } },
			"13": { repository: "o/r", issue: issue(13, "closed"), relationships: { children: [], blockers: [] } },
		};
		const calls: string[][] = [];
		const fake: Runner = async (command, options) => {
			if (command[0] !== "bun") return bunRunner(command, options);
			calls.push(command);
			const directory = await mkdtemp(path.join(sandbox, "issue-"));
			const file = path.join(directory, "snapshot.json");
			await writeFile(file, JSON.stringify(snapshots[command[2]]));
			return { code: 0, stdout: JSON.stringify({ snapshot: file }), stderr: "" };
		};
		const { code, output } = (await main(["tick", "--spec", "o/r#10", "--integration", "feat/x"], fake, repo)) as any;
		expect(code).toBe(0);
		expect(output.tickets.map((t: any) => [t.id, t.state, t.waitingOn ?? []])).toEqual([
			["11", "ready", []],
			["12", "blocked", ["11", url(99)]],
			["13", "closed", []],
		]);
		expect(calls[0]).toEqual(["bun", expect.stringContaining("github-issue-reader/scripts/issue-read.ts"), "10", "--repo", "o/r"]);
		// Each snapshot directory is removed after the read.
		expect((await readdir(sandbox)).filter((name) => name.startsWith("issue-"))).toEqual([]);
	});

	test("reports a reader failure as an error", async () => {
		const fake: Runner = async (command, options) =>
			command[0] === "bun" ? { code: 1, stdout: "", stderr: "Cannot find package 'zod'" } : bunRunner(command, options);
		const { code, output } = (await main(["tick", "--spec", "10", "--integration", "feat/x"], fake, repo)) as any;
		expect(code).toBe(1);
		expect(output.hint).toContain("bun install");
	});
});
