#!/usr/bin/env bun
// impl-tick: the deterministic half of implement-spec.
// It reads the ticket graph, derives each ticket's state from git, and prints the next actions.
// The agent keeps the judgment: plan checks, merge conflicts, merge checks and code review.
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (command: string[], options?: { cwd?: string }) => Promise<RunResult>;

export const bunRunner: Runner = async (command, options) => {
	const child = Bun.spawn(command, { cwd: options?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
};

/** Exit 1: error. Exit 2: refused because a precondition is not met; `details` says what to do. */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly exitCode: 1 | 2 = 1,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export const TRAILER = "Impl-Tick-Ticket";
const SCRIPT_PATH = path.resolve(import.meta.dir, "impl-tick.ts");
const DEFAULT_READER_DIR = process.env.ISSUE_READER_SKILL ?? path.resolve(import.meta.dir, "../../github-issue-reader");

// ---------- tickets ----------

export type Ticket = {
	id: string;
	title: string;
	url?: string;
	closed: boolean;
	/** Ids of tickets in this spec that block this ticket. */
	blockedBy: string[];
	/** Blockers outside this spec. Only open ones stop work. */
	externalBlockers: { ref: string; open: boolean }[];
	/** Text of a "Blocked by" line that names no known ticket. Needs a human or agent read. */
	unparsedBlockers?: string;
};

export type Spec = { kind: "github"; ref: string; url: string; title: string; tickets: Ticket[] } | { kind: "local"; ref: string; directory: string; tickets: Ticket[] };

type RelatedIssue = { number: number; title: string; html_url: string; state: string };
type IssueSnapshot = {
	repository: string;
	issue: { number: number; title: string; html_url: string; state: string };
	relationships?: { children: RelatedIssue[]; blockers: RelatedIssue[] };
};

function parseIssueRef(value: string, repo?: string): { number: number; repo?: string } | undefined {
	const url = value.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
	if (url) return { number: Number(url[2]), repo: url[1] };
	const short = value.match(/^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/);
	if (short) return { number: Number(short[2]), repo: short[1] ?? repo };
	return undefined;
}

async function readIssue(run: Runner, readerDir: string, number: number, repo: string | undefined, cwd: string): Promise<IssueSnapshot> {
	const command = ["bun", path.join(readerDir, "scripts", "issue-read.ts"), String(number)];
	if (repo) command.push("--repo", repo);
	const result = await run(command, { cwd });
	let printed: { snapshot?: unknown };
	try {
		printed = JSON.parse(result.stdout);
	} catch {
		printed = {};
	}
	if (result.code !== 0 || typeof printed.snapshot !== "string") {
		throw new ToolError(`github-issue-reader could not read issue #${number}: ${result.stderr.trim() || "no detail"}`, 1, {
			hint: `Check gh authentication. If dependencies are missing, run: bun install --cwd ${readerDir} --frozen-lockfile`,
		});
	}
	const snapshotPath = printed.snapshot;
	try {
		const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as IssueSnapshot;
		if (!snapshot.relationships) throw new ToolError(`Issue #${number} snapshot has no native relationships.`);
		return snapshot;
	} finally {
		// The tick runs often. Remove each snapshot so temporary storage stays small.
		await rm(path.dirname(snapshotPath), { recursive: true, force: true });
	}
}

export async function loadGithubSpec(run: Runner, readerDir: string, ref: string, repo: string | undefined, cwd: string): Promise<Spec> {
	const parsed = parseIssueRef(ref, repo);
	if (!parsed) throw new ToolError(`Spec "${ref}" is not an issue number, owner/repo#number, issue URL, or directory.`);
	const spec = await readIssue(run, readerDir, parsed.number, parsed.repo, cwd);
	const children = spec.relationships?.children ?? [];
	if (children.length === 0) {
		throw new ToolError(`Spec issue #${parsed.number} has no native sub-issues. Tickets must be sub-issues of the spec.`, 2);
	}
	const childUrls = new Map(children.map((child) => [child.html_url, String(child.number)]));
	const tickets = await Promise.all(
		children.map(async (child): Promise<Ticket> => {
			const childRef = parseIssueRef(child.html_url);
			const snapshot = await readIssue(run, readerDir, child.number, childRef?.repo ?? spec.repository, cwd);
			const blockedBy: string[] = [];
			const externalBlockers: Ticket["externalBlockers"] = [];
			for (const blocker of snapshot.relationships?.blockers ?? []) {
				const id = childUrls.get(blocker.html_url);
				if (id) blockedBy.push(id);
				else externalBlockers.push({ ref: blocker.html_url, open: blocker.state === "open" });
			}
			return {
				id: String(child.number),
				title: snapshot.issue.title,
				url: child.html_url,
				closed: snapshot.issue.state !== "open",
				blockedBy,
				externalBlockers,
			};
		}),
	);
	return { kind: "github", ref, url: spec.issue.html_url, title: spec.issue.title, tickets };
}

const LOCAL_FILE = /^(\d+)-.+\.md$/;
const CLOSED_STATUS = /\b(done|closed|complete|completed|resolved|merged)\b/i;

export async function loadLocalSpec(directory: string): Promise<Spec> {
	let issuesDir = directory;
	const nested = path.join(directory, "issues");
	if (await isDirectory(nested)) issuesDir = nested;
	const files = (await readdir(issuesDir)).filter((name) => LOCAL_FILE.test(name)).sort();
	if (files.length === 0) throw new ToolError(`No ticket files named NN-slug.md in ${issuesDir}.`, 2);
	const raw = await Promise.all(
		files.map(async (name) => {
			const text = await readFile(path.join(issuesDir, name), "utf8");
			const id = name.match(LOCAL_FILE)![1];
			const heading = text.match(/^#\s+(?:\d+\s*:\s*)?(.+)$/m);
			return {
				id,
				title: heading ? heading[1].trim() : name.replace(/\.md$/, ""),
				blockedLine: text.match(/^\*\*Blocked by:\*\*\s*(.*)$/im)?.[1].trim() ?? "",
				status: text.match(/^\*\*Status:\*\*\s*(.*)$/im)?.[1].trim() ?? "",
				file: path.join(issuesDir, name),
			};
		}),
	);
	const byNumber = new Map(raw.map((ticket) => [Number(ticket.id), ticket.id]));
	const tickets = raw.map((ticket): Ticket => {
		const line = ticket.blockedLine;
		const blockedBy = new Set<string>();
		if (line && !/^none\b/i.test(line)) {
			for (const match of line.matchAll(/(?:^|[^\w])#?(\d{1,4})(?!\w)/g)) {
				const id = byNumber.get(Number(match[1]));
				if (id && id !== ticket.id) blockedBy.add(id);
			}
			for (const other of raw) {
				if (other.id !== ticket.id && line.toLowerCase().includes(other.title.toLowerCase())) blockedBy.add(other.id);
			}
		}
		const result: Ticket = {
			id: ticket.id,
			title: ticket.title,
			url: ticket.file,
			closed: CLOSED_STATUS.test(ticket.status),
			blockedBy: [...blockedBy].sort(),
			externalBlockers: [],
		};
		if (line && !/^none\b/i.test(line) && blockedBy.size === 0) result.unparsedBlockers = line;
		return result;
	});
	return { kind: "local", ref: directory, directory: issuesDir, tickets };
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isDirectory();
	} catch {
		return false;
	}
}

// ---------- git ----------

async function git(run: Runner, cwd: string, args: string[]): Promise<string> {
	const result = await run(["git", ...args], { cwd });
	if (result.code !== 0) throw new ToolError(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout.trim();
}

async function gitOk(run: Runner, cwd: string, args: string[]): Promise<boolean> {
	return (await run(["git", ...args], { cwd })).code === 0;
}

async function revParse(run: Runner, cwd: string, ref: string): Promise<string | undefined> {
	const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

type Worktree = { path: string; head?: string; branch?: string };

async function listWorktrees(run: Runner, cwd: string): Promise<Worktree[]> {
	const output = await git(run, cwd, ["worktree", "list", "--porcelain"]);
	const worktrees: Worktree[] = [];
	for (const block of output.split(/\n\n+/)) {
		const entry: Worktree = { path: "" };
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) entry.path = line.slice(9);
			else if (line.startsWith("HEAD ")) entry.head = line.slice(5);
			else if (line.startsWith("branch ")) entry.branch = line.slice(7).replace(/^refs\/heads\//, "");
		}
		if (entry.path) worktrees.push(entry);
	}
	return worktrees;
}

async function isDirty(run: Runner, worktree: string): Promise<boolean> {
	return (await git(run, worktree, ["status", "--porcelain"])).length > 0;
}

export function ticketBranch(integration: string, id: string): string {
	return `${integration}-t${id}`;
}

// ---------- status ----------

export type TicketState = "ready" | "blocked" | "running" | "merged" | "closed";

export type TicketStatus = {
	id: string;
	title: string;
	url?: string;
	state: TicketState;
	branch: string;
	worktree?: string;
	waitingOn?: string[];
	unparsedBlockers?: string;
	commitsAhead?: number;
	hasIntegrationTip?: boolean;
	dirty?: boolean;
	leftovers?: boolean;
};

export type Options = {
	spec: string;
	integration: string;
	repo?: string;
	repoDir: string;
	worktreeRoot?: string;
	readerDir: string;
};

type Context = {
	options: Options;
	run: Runner;
	root: string;
	spec: Spec;
	integrationTip?: string;
	worktrees: Worktree[];
	tickets: TicketStatus[];
};

async function loadContext(options: Options, run: Runner): Promise<Context> {
	const root = await git(run, options.repoDir, ["rev-parse", "--show-toplevel"]);
	const localPath = path.resolve(options.repoDir, options.spec);
	const spec = (await isDirectory(localPath))
		? await loadLocalSpec(localPath)
		: await loadGithubSpec(run, options.readerDir, options.spec, options.repo, root);
	const integrationTip = await revParse(run, root, `refs/heads/${options.integration}`);
	const worktrees = await listWorktrees(run, root);
	const merged = new Set<string>();
	if (integrationTip) {
		const trailers = await git(run, root, ["log", "--merges", options.integration, `--format=%(trailers:key=${TRAILER},valueonly)`]);
		for (const line of trailers.split("\n")) if (line.trim()) merged.add(line.trim());
	}
	const done = new Set(spec.tickets.filter((ticket) => ticket.closed || merged.has(ticket.id)).map((ticket) => ticket.id));

	const tickets = await Promise.all(
		spec.tickets.map(async (ticket): Promise<TicketStatus> => {
			const branch = ticketBranch(options.integration, ticket.id);
			const branchTip = await revParse(run, root, `refs/heads/${branch}`);
			const worktree = worktrees.find((entry) => entry.branch === branch)?.path;
			const base: TicketStatus = { id: ticket.id, title: ticket.title, url: ticket.url, state: "ready", branch };
			if (worktree) base.worktree = worktree;
			if (merged.has(ticket.id)) return { ...base, state: "merged", leftovers: Boolean(branchTip || worktree) };
			if (ticket.closed) return { ...base, state: "closed" };
			if (branchTip && integrationTip) {
				const status: TicketStatus = {
					...base,
					state: "running",
					commitsAhead: Number(await git(run, root, ["rev-list", "--count", `${options.integration}..${branch}`])),
					hasIntegrationTip: await gitOk(run, root, ["merge-base", "--is-ancestor", integrationTip, branchTip]),
				};
				if (worktree) status.dirty = await isDirty(run, worktree);
				return status;
			}
			const waitingOn = [
				...ticket.blockedBy.filter((id) => !done.has(id)),
				...ticket.externalBlockers.filter((blocker) => blocker.open).map((blocker) => blocker.ref),
			];
			if (waitingOn.length || ticket.unparsedBlockers) {
				const blocked: TicketStatus = { ...base, state: "blocked", waitingOn };
				if (ticket.unparsedBlockers) blocked.unparsedBlockers = ticket.unparsedBlockers;
				return blocked;
			}
			return base;
		}),
	);
	return { options, run, root, spec, integrationTip, worktrees, tickets };
}

function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandFor(context: Context, subcommand: string, ticket?: string): string {
	const { options } = context;
	const parts = ["bun", SCRIPT_PATH, subcommand];
	if (ticket) parts.push(ticket);
	parts.push("--spec", options.spec, "--integration", options.integration);
	if (options.repo) parts.push("--repo", options.repo);
	if (options.worktreeRoot) parts.push("--worktree-root", options.worktreeRoot);
	return parts.map(shellQuote).join(" ");
}

export type NextAction = { action: string; ticket?: string; tickets?: string[]; command?: string; then?: string; note?: string };

export function nextActions(context: Context): NextAction[] {
	const { tickets, options } = context;
	if (!context.integrationTip) {
		return [
			{
				action: "create-integration-branch",
				command: `git branch ${shellQuote(options.integration)} <base>`,
				note: "Choose the base, usually the default branch. Then run the tick again.",
			},
		];
	}
	const next: NextAction[] = [];
	for (const ticket of tickets.filter((entry) => entry.state === "ready")) {
		next.push({
			action: "start",
			ticket: ticket.id,
			command: commandFor(context, "start", ticket.id),
			then: "Spawn a fresh implementer subagent in the printed worktree.",
		});
	}
	const leftovers = tickets.filter((entry) => entry.state === "merged" && entry.leftovers);
	if (leftovers.length) {
		next.push({ action: "cleanup", tickets: leftovers.map((entry) => entry.id), command: commandFor(context, "cleanup") });
	}
	for (const ticket of tickets.filter((entry) => entry.state === "running")) {
		next.push({
			action: "wait",
			ticket: ticket.id,
			command: commandFor(context, "merge", ticket.id),
			note: "When the implementer reports done, do the merge check, then run the command.",
		});
	}
	const finished = tickets.every((entry) => entry.state === "merged" || entry.state === "closed");
	if (finished) {
		next.push({
			action: "finish",
			note: "Every ticket is merged or closed. Do the simplification review and code-review on the integration branch.",
		});
	} else if (!tickets.some((entry) => entry.state === "ready" || entry.state === "running")) {
		next.push({
			action: "stuck",
			tickets: tickets.filter((entry) => entry.state === "blocked").map((entry) => entry.id),
			note: "No ticket can start. Examine the open blockers and unparsed blocker lines.",
		});
	}
	return next;
}

function summary(context: Context) {
	const counts: Record<TicketState, number> = { ready: 0, blocked: 0, running: 0, merged: 0, closed: 0 };
	for (const ticket of context.tickets) counts[ticket.state] += 1;
	const spec = context.spec.kind === "github" ? { kind: "github", url: context.spec.url, title: context.spec.title } : { kind: "local", directory: context.spec.directory };
	return {
		spec,
		integration: { branch: context.options.integration, tip: context.integrationTip ?? null },
		counts,
		tickets: context.tickets,
		next: nextActions(context),
	};
}

// ---------- commands ----------

export async function tick(options: Options, run: Runner) {
	return summary(await loadContext(options, run));
}

function requireTicket(context: Context, id: string): TicketStatus {
	const ticket = context.tickets.find((entry) => entry.id === id || Number(entry.id) === Number(id));
	if (!ticket) throw new ToolError(`Ticket ${id} is not part of this spec.`);
	return ticket;
}

function requireIntegration(context: Context): string {
	if (!context.integrationTip) throw new ToolError(`Integration branch ${context.options.integration} does not exist.`, 2, { next: nextActions(context) });
	return context.integrationTip;
}

export async function start(options: Options, run: Runner, id: string, dryRun: boolean) {
	const context = await loadContext(options, run);
	const integrationTip = requireIntegration(context);
	const ticket = requireTicket(context, id);
	if (ticket.state !== "ready") {
		throw new ToolError(`Ticket ${ticket.id} is ${ticket.state}, not ready.`, 2, { ticket });
	}
	const worktreeRoot = options.worktreeRoot
		? path.resolve(options.repoDir, options.worktreeRoot)
		: path.join(path.dirname(context.root), `${path.basename(context.root)}-worktrees`);
	const worktree = path.join(worktreeRoot, ticket.branch.replaceAll("/", "-"));
	const command = ["worktree", "add", "-b", ticket.branch, worktree, integrationTip];
	if (dryRun) return { dryRun: true, ticket: ticket.id, branch: ticket.branch, worktree, base: integrationTip, command: ["git", ...command] };
	await git(run, context.root, command);
	// Verify by reading the new state back.
	const head = await git(run, worktree, ["rev-parse", "HEAD"]);
	const branch = await git(run, worktree, ["symbolic-ref", "--short", "HEAD"]);
	if (head !== integrationTip || branch !== ticket.branch) {
		throw new ToolError(`Worktree ${worktree} is on ${branch} at ${head}, not ${ticket.branch} at ${integrationTip}.`);
	}
	return { ticket: ticket.id, title: ticket.title, url: ticket.url, branch: ticket.branch, worktree, base: integrationTip, verified: true };
}

export async function merge(options: Options, run: Runner, id: string, dryRun: boolean) {
	const context = await loadContext(options, run);
	const integrationTip = requireIntegration(context);
	const ticket = requireTicket(context, id);
	if (ticket.state !== "running") throw new ToolError(`Ticket ${ticket.id} is ${ticket.state}, so there is nothing to merge.`, 2, { ticket });
	if (!ticket.commitsAhead) throw new ToolError(`Branch ${ticket.branch} has no commits ahead of ${options.integration}.`, 2, { ticket });
	if (ticket.dirty) {
		throw new ToolError(`Worktree ${ticket.worktree} has uncommitted changes.`, 2, { ticket, action: "commit-or-discard", note: "The implementer commits its work, then run merge again." });
	}
	if (!ticket.hasIntegrationTip) {
		throw new ToolError(`Branch ${ticket.branch} does not contain the integration tip.`, 2, {
			ticket,
			action: "update-branch",
			note: `The implementer merges ${options.integration} into ${ticket.branch} in its worktree and resolves any conflicts. Then run merge again.`,
		});
	}
	const branchTip = (await revParse(run, context.root, `refs/heads/${ticket.branch}`))!;
	const subject = `Merge ticket ${ticket.id}: ${ticket.title}`;
	const trailer = `${TRAILER}: ${ticket.id}`;
	const integrationWorktree = context.worktrees.find((entry) => entry.branch === options.integration)?.path;
	const method = integrationWorktree ? "merge-in-worktree" : "commit-tree";
	if (integrationWorktree && (await isDirty(run, integrationWorktree))) {
		throw new ToolError(`The integration worktree ${integrationWorktree} has uncommitted changes.`, 2, { action: "clean-integration-worktree" });
	}
	if (dryRun) return { dryRun: true, ticket: ticket.id, branch: ticket.branch, integration: options.integration, method, worktree: integrationWorktree ?? null, subject };

	if (integrationWorktree) {
		// The branch contains the integration tip, so this merge has no conflicts.
		await git(run, integrationWorktree, ["merge", "--no-ff", "-m", subject, "-m", trailer, ticket.branch]);
	} else {
		// The integration branch is not checked out. Since the ticket branch contains its tip,
		// the merge result is the ticket tree with both tips as parents.
		const tree = await git(run, context.root, ["rev-parse", `${branchTip}^{tree}`]);
		const commit = await git(run, context.root, ["commit-tree", tree, "-p", integrationTip, "-p", branchTip, "-m", subject, "-m", trailer]);
		await git(run, context.root, ["update-ref", "-m", subject, `refs/heads/${options.integration}`, commit, integrationTip]);
	}

	// Verify by reading the new state back.
	const after = await loadContext(options, run);
	const merged = after.tickets.find((entry) => entry.id === ticket.id);
	const contains = await gitOk(run, context.root, ["merge-base", "--is-ancestor", branchTip, options.integration]);
	if (!contains || merged?.state !== "merged") throw new ToolError(`Merge of ${ticket.branch} did not verify on ${options.integration}.`);
	return { ticket: ticket.id, merged: true, method, integration: { branch: options.integration, tip: after.integrationTip }, next: nextActions(after) };
}

export async function cleanup(options: Options, run: Runner, dryRun: boolean) {
	const context = await loadContext(options, run);
	requireIntegration(context);
	const targets = context.tickets.filter((ticket) => ticket.state === "merged" && ticket.leftovers);
	if (dryRun) return { dryRun: true, remove: targets.map((ticket) => ({ ticket: ticket.id, branch: ticket.branch, worktree: ticket.worktree ?? null })) };
	const failed: { ticket: string; error: string }[] = [];
	for (const ticket of targets) {
		try {
			// Without --force, git refuses to remove a worktree with uncommitted changes.
			if (ticket.worktree) await git(run, context.root, ["worktree", "remove", ticket.worktree]);
			const tip = await revParse(run, context.root, `refs/heads/${ticket.branch}`);
			if (tip) {
				if (!(await gitOk(run, context.root, ["merge-base", "--is-ancestor", tip, options.integration]))) {
					throw new ToolError(`Branch ${ticket.branch} has commits that are not on ${options.integration}.`);
				}
				// -D is safe here: the check above proved the integration branch holds every commit.
				await git(run, context.root, ["branch", "-D", ticket.branch]);
			}
		} catch (error) {
			failed.push({ ticket: ticket.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const after = await loadContext(options, run);
	const remaining = after.tickets.filter((ticket) => ticket.state === "merged" && ticket.leftovers).map((ticket) => ticket.id);
	const result = { removed: targets.map((ticket) => ticket.id).filter((id) => !remaining.includes(id)), remaining, failed };
	if (failed.length || remaining.length) throw new ToolError("Cleanup did not remove every merged worktree and branch.", 1, result);
	return result;
}

// ---------- CLI ----------

const HELP = `Usage: bun impl-tick.ts <command> [ticket] --spec <spec> --integration <branch> [options]

Commands:
  tick              Print every ticket's state and the next actions. Read-only.
  start <ticket>    Create the ticket branch and worktree from the integration tip.
  merge <ticket>    Merge a finished ticket branch into the integration branch.
  cleanup           Remove the worktrees and branches of merged tickets.

Spec: a GitHub issue number, owner/repo#number or issue URL whose native sub-issues
are the tickets (read through github-issue-reader), or a local directory of
NN-slug.md ticket files (or its parent that holds issues/).

Options:
  --repo owner/repo     GitHub repository when the spec is a bare number.
  --repo-dir <path>     A checkout of the target repository. Default: current directory.
  --worktree-root <dir> Where start creates worktrees. Default: <checkout>-worktrees next to the checkout.
  --dry-run             Print the planned change for start, merge or cleanup. Change nothing.

Ticket branches are <integration>-t<ticket>. A merged ticket is one whose merge commit on the
integration branch carries the "${TRAILER}: <ticket>" trailer.

Output is JSON. Exit 0: success. Exit 1: error. Exit 2: refused; the JSON says what to do first.`;

export async function main(argv: string[], run: Runner = bunRunner, cwd = process.cwd()): Promise<{ code: number; output: unknown }> {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				spec: { type: "string" },
				integration: { type: "string" },
				repo: { type: "string" },
				"repo-dir": { type: "string" },
				"worktree-root": { type: "string" },
				"dry-run": { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		return { code: 1, output: { ok: false, error: error instanceof Error ? error.message : String(error) } };
	}
	const { values, positionals } = parsed;
	if (values.help) return { code: 0, output: HELP };
	const [command = "tick", ticket] = positionals;
	if (!values.spec || !values.integration) return { code: 1, output: { ok: false, error: "Supply --spec and --integration. Use --help." } };
	if (!/^[\w./-]+$/.test(values.integration)) return { code: 1, output: { ok: false, error: "The integration branch name has unsupported characters." } };
	const options: Options = {
		spec: values.spec,
		integration: values.integration,
		repo: values.repo,
		repoDir: path.resolve(cwd, values["repo-dir"] ?? "."),
		worktreeRoot: values["worktree-root"],
		readerDir: DEFAULT_READER_DIR,
	};
	try {
		let output: unknown;
		if (command === "tick" && positionals.length <= 1) output = await tick(options, run);
		else if (command === "start" && ticket && positionals.length === 2) output = await start(options, run, ticket, values["dry-run"]);
		else if (command === "merge" && ticket && positionals.length === 2) output = await merge(options, run, ticket, values["dry-run"]);
		else if (command === "cleanup" && positionals.length === 1) output = await cleanup(options, run, values["dry-run"]);
		else return { code: 1, output: { ok: false, error: `Unknown command or wrong arguments: ${positionals.join(" ")}. Use --help.` } };
		return { code: 0, output: { ok: true, ...(output as object) } };
	} catch (error) {
		if (error instanceof ToolError) return { code: error.exitCode, output: { ok: false, error: error.message, ...error.details } };
		return { code: 1, output: { ok: false, error: error instanceof Error ? error.message : String(error) } };
	}
}

if (import.meta.main) {
	const { code, output } = await main(Bun.argv.slice(2));
	console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2));
	process.exitCode = code;
}
