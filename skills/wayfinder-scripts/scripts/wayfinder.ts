#!/usr/bin/env bun
// Deterministic tracker steps for Wayfinder maps and published tickets on GitHub.
// One CLI, no dependencies. Every command prints JSON on stdout.
// Exit codes: 0 = done, 1 = error or a write that did not verify, 2 = refused and wrote nothing.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// ---------- GitHub access ----------

export type Method = "GET" | "POST" | "PATCH";

export interface Gh {
	/** One REST call. Throws GhError on a non-2xx response. */
	api(method: Method, endpoint: string, body?: Record<string, unknown>): Promise<unknown>;
	/** GET every page of a list endpoint and flatten it. */
	list(endpoint: string): Promise<unknown[]>;
	/** owner/repo of the current directory. */
	currentRepo(): Promise<string>;
}

export class GhError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
	}
}

/** A refusal: the command wrote nothing. Exit 2. */
export class Refusal extends Error {}

async function run(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["gh", ...args], {
		stdin: input === undefined ? "ignore" : new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

function failure(endpoint: string, stderr: string): GhError {
	const status = /HTTP (\d{3})/.exec(stderr)?.[1];
	const message = stderr.trim().split("\n").pop() || "gh api failed";
	return new GhError(`${endpoint}: ${message}`, status ? Number(status) : null);
}

export const realGh: Gh = {
	async api(method, endpoint, body) {
		const args = ["api", "--method", method, endpoint];
		if (body) args.push("--input", "-");
		const result = await run(args, body ? JSON.stringify(body) : undefined);
		if (result.code !== 0) throw failure(endpoint, result.stderr);
		return result.stdout.trim() ? JSON.parse(result.stdout) : null;
	},
	async list(endpoint) {
		const result = await run(["api", endpoint, "--paginate", "--slurp"]);
		if (result.code !== 0) throw failure(endpoint, result.stderr);
		return (JSON.parse(result.stdout) as unknown[][]).flat();
	},
	async currentRepo() {
		const result = await run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
		if (result.code !== 0) throw new Error("Cannot infer the repository. Run inside a clone or pass --repo owner/repo.");
		return result.stdout.trim();
	},
};

// ---------- issue shapes ----------

export type Issue = {
	id: number;
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	state: "open" | "closed";
	labels: { name: string }[];
	assignees: { login: string }[];
	pull_request?: unknown;
	issue_dependencies_summary?: { blocked_by: number };
};

export type Comment = { id: number; body: string | null; html_url: string; user: { login: string } | null };

export type TicketView = {
	number: number;
	title: string;
	url: string;
	type: string | null;
	assignees: string[];
	openBlockers: number;
};

const TYPES = ["research", "prototype", "grilling", "task"];

function ticketType(issue: Issue): string | null {
	for (const label of issue.labels) {
		const match = /^wayfinder:(.+)$/.exec(label.name);
		if (match && TYPES.includes(match[1])) return match[1];
	}
	return null;
}

export class Tracker {
	#login: string | null = null;
	constructor(
		readonly gh: Gh,
		readonly repo: string,
	) {}

	issue(n: number): Promise<Issue> {
		return this.gh.api("GET", `repos/${this.repo}/issues/${n}`) as Promise<Issue>;
	}
	children(n: number): Promise<Issue[]> {
		return this.gh.list(`repos/${this.repo}/issues/${n}/sub_issues?per_page=100`) as Promise<Issue[]>;
	}
	blockers(n: number): Promise<Issue[]> {
		return this.gh.list(`repos/${this.repo}/issues/${n}/dependencies/blocked_by?per_page=100`) as Promise<Issue[]>;
	}
	comments(n: number): Promise<Comment[]> {
		return this.gh.list(`repos/${this.repo}/issues/${n}/comments?per_page=100`) as Promise<Comment[]>;
	}
	async parent(n: number): Promise<Issue | null> {
		try {
			return (await this.gh.api("GET", `repos/${this.repo}/issues/${n}/parent`)) as Issue;
		} catch (error) {
			if (error instanceof GhError && error.status === 404) return null;
			throw error;
		}
	}
	async login(): Promise<string> {
		this.#login ??= ((await this.gh.api("GET", "user")) as { login: string }).login;
		return this.#login;
	}
	async openBlockers(issue: Issue): Promise<number> {
		const summary = issue.issue_dependencies_summary?.blocked_by;
		if (typeof summary === "number") return summary;
		return (await this.blockers(issue.number)).filter((b) => b.state === "open").length;
	}
	async view(issue: Issue): Promise<TicketView> {
		return {
			number: issue.number,
			title: issue.title,
			url: issue.html_url,
			type: ticketType(issue),
			assignees: issue.assignees.map((a) => a.login),
			openBlockers: issue.state === "open" ? await this.openBlockers(issue) : 0,
		};
	}
}

// ---------- frontier ----------

export type Frontier = {
	map: { number: number; title: string; url: string; state: string; isMap: boolean };
	counts: { open: number; closed: number; frontier: number; blocked: number; claimed: number };
	frontier: TicketView[];
	blocked: TicketView[];
	claimed: TicketView[];
	closed: { number: number; title: string; url: string }[];
	first: number | null;
};

export async function frontier(tracker: Tracker, mapNumber: number): Promise<Frontier> {
	const [map, children] = await Promise.all([tracker.issue(mapNumber), tracker.children(mapNumber)]);
	const open = children.filter((c) => c.state === "open" && !c.pull_request);
	const views = await Promise.all(open.map((c) => tracker.view(c)));
	const blocked = views.filter((v) => v.openBlockers > 0);
	const claimed = views.filter((v) => v.openBlockers === 0 && v.assignees.length > 0);
	const front = views.filter((v) => v.openBlockers === 0 && v.assignees.length === 0);
	const closed = children
		.filter((c) => c.state === "closed")
		.map((c) => ({ number: c.number, title: c.title, url: c.html_url }));
	return {
		map: {
			number: map.number,
			title: map.title,
			url: map.html_url,
			state: map.state,
			isMap: map.labels.some((l) => l.name === "wayfinder:map"),
		},
		counts: { open: open.length, closed: closed.length, frontier: front.length, blocked: blocked.length, claimed: claimed.length },
		frontier: front,
		blocked,
		claimed,
		closed,
		first: front[0]?.number ?? null,
	};
}

// ---------- claim ----------

export type ClaimResult = { ok: boolean; login: string; claimed: number[]; alreadyMine: number[]; problems: string[] };

export async function claim(tracker: Tracker, numbers: number[], dryRun = false): Promise<ClaimResult> {
	const login = await tracker.login();
	const issues = await Promise.all(numbers.map((n) => tracker.issue(n)));
	const refusals: string[] = [];
	const todo: Issue[] = [];
	const alreadyMine: number[] = [];
	for (const issue of issues) {
		const others = issue.assignees.map((a) => a.login).filter((l) => l !== login);
		if (issue.pull_request) refusals.push(`#${issue.number} is a pull request.`);
		else if (issue.state !== "open") refusals.push(`#${issue.number} is closed.`);
		else if (others.length) refusals.push(`#${issue.number} is claimed by ${others.join(", ")}.`);
		else if ((await tracker.openBlockers(issue)) > 0) refusals.push(`#${issue.number} has open blockers.`);
		else if (issue.assignees.length) alreadyMine.push(issue.number);
		else todo.push(issue);
	}
	if (refusals.length) throw new Refusal(refusals.join(" "));
	if (dryRun) return { ok: true, login, claimed: todo.map((i) => i.number), alreadyMine, problems: [] };

	const problems: string[] = [];
	for (const issue of todo) {
		await tracker.gh.api("POST", `repos/${tracker.repo}/issues/${issue.number}/assignees`, { assignees: [login] });
	}
	for (const issue of todo) {
		const fresh = await tracker.issue(issue.number);
		const logins = fresh.assignees.map((a) => a.login);
		if (!logins.includes(login)) problems.push(`#${issue.number}: assignee ${login} not found after the write.`);
		else if (logins.length > 1) problems.push(`#${issue.number}: contested, also assigned to ${logins.filter((l) => l !== login).join(", ")}.`);
	}
	return { ok: problems.length === 0, login, claimed: todo.map((i) => i.number), alreadyMine, problems };
}

// ---------- map body sections ----------

export const SECTIONS = { decisions: "Decisions so far", outOfScope: "Out of scope" } as const;

function findSection(lines: string[], heading: string): { start: number; end: number } | null {
	const wanted = heading.toLowerCase();
	const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === wanted);
	if (start < 0) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,2}\s+/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return { start, end };
}

export function hasSection(body: string, heading: string): boolean {
	return findSection(body.split("\n"), heading) !== null;
}

export function sectionHas(body: string, heading: string, needle: string): boolean {
	const lines = body.split("\n");
	const section = findSection(lines, heading);
	return section ? lines.slice(section.start + 1, section.end).some((l) => l.includes(needle)) : false;
}

/** Append a list item at the end of a `## heading` section. A lone "- None" item is replaced. */
export function appendToSection(body: string, heading: string, item: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	const section = findSection(lines, heading);
	if (!section) throw new Refusal(`The map body has no "## ${heading}" section.`);
	const inner = lines.slice(section.start + 1, section.end);
	const items = inner.filter((l) => /^\s*[-*]\s+/.test(l));
	if (items.length === 1 && /^\s*[-*]\s+_?none\b/i.test(items[0])) {
		inner.splice(inner.indexOf(items[0]), 1);
	}
	while (inner.length && inner[inner.length - 1].trim() === "") inner.pop();
	const last = inner[inner.length - 1];
	const joinsList = last !== undefined && /^\s*[-*]\s+/.test(last);
	const added = joinsList ? [item] : ["", item];
	const tail = section.end < lines.length ? [""] : [];
	const next = [...lines.slice(0, section.start + 1), ...inner, ...added, ...tail, ...lines.slice(section.end)];
	let text = next.join("\n");
	if (body.endsWith("\n") && !text.endsWith("\n")) text += "\n";
	return text;
}

// ---------- resolve ----------

export type ResolveOptions = {
	ticket: number;
	map: number;
	answer: string;
	gist: string;
	outOfScope?: boolean;
	dryRun?: boolean;
};

export type ResolveResult = {
	ok: boolean;
	ticket: { number: number; title: string; url: string };
	comment: { id: number | null; url: string | null; posted: boolean };
	closed: boolean;
	pointer: { section: string; line: string; added: boolean };
	problems: string[];
	dryRun?: boolean;
};

export async function resolve(tracker: Tracker, options: ResolveOptions): Promise<ResolveResult> {
	const answer = options.answer.trim();
	const gist = options.gist.trim();
	if (!answer) throw new Refusal("The answer file is empty.");
	if (!gist || gist.includes("\n")) throw new Refusal("--gist must be one non-empty line.");
	const heading = options.outOfScope ? SECTIONS.outOfScope : SECTIONS.decisions;

	const [login, ticket, parent, map, comments] = await Promise.all([
		tracker.login(),
		tracker.issue(options.ticket),
		tracker.parent(options.ticket),
		tracker.issue(options.map),
		tracker.comments(options.ticket),
	]);
	if (ticket.pull_request) throw new Refusal(`#${ticket.number} is a pull request.`);
	if (parent?.number !== options.map) throw new Refusal(`#${ticket.number} is not a sub-issue of map #${options.map}.`);
	if (!hasSection(map.body ?? "", heading)) throw new Refusal(`Map #${options.map} has no "## ${heading}" section.`);
	const existing = comments.find((c) => c.user?.login === login && (c.body ?? "").trim() === answer);
	if (ticket.state === "closed" && !existing) {
		throw new Refusal(`#${ticket.number} is already closed without this resolution comment. Resolve it by hand.`);
	}
	const line = `- [${ticket.title}](${ticket.html_url}): ${gist}`;
	const pointerPresent = sectionHas(map.body ?? "", heading, `](${ticket.html_url})`);
	const result: ResolveResult = {
		ok: true,
		ticket: { number: ticket.number, title: ticket.title, url: ticket.html_url },
		comment: { id: existing?.id ?? null, url: existing?.html_url ?? null, posted: false },
		closed: false,
		pointer: { section: heading, line, added: false },
		problems: [],
	};
	if (options.dryRun) {
		return {
			...result,
			dryRun: true,
			comment: { ...result.comment, posted: !existing },
			closed: ticket.state === "open",
			pointer: { ...result.pointer, added: !pointerPresent },
		};
	}

	const base = `repos/${tracker.repo}/issues`;
	if (!existing) {
		const posted = (await tracker.gh.api("POST", `${base}/${ticket.number}/comments`, { body: answer })) as Comment;
		result.comment = { id: posted.id, url: posted.html_url, posted: true };
	}
	if (ticket.state === "open") {
		await tracker.gh.api("PATCH", `${base}/${ticket.number}`, {
			state: "closed",
			state_reason: options.outOfScope ? "not_planned" : "completed",
		});
		result.closed = true;
	}
	// Re-read the map just before the write: other sessions edit it too.
	const freshMap = await tracker.issue(options.map);
	if (!sectionHas(freshMap.body ?? "", heading, `](${ticket.html_url})`)) {
		await tracker.gh.api("PATCH", `${base}/${options.map}`, { body: appendToSection(freshMap.body ?? "", heading, line) });
		result.pointer.added = true;
	}

	const [after, afterComments, afterMap] = await Promise.all([
		tracker.issue(ticket.number),
		tracker.comments(ticket.number),
		tracker.issue(options.map),
	]);
	if (after.state !== "closed") result.problems.push(`#${ticket.number} is still open.`);
	if (!afterComments.some((c) => c.id === result.comment.id && (c.body ?? "").trim() === answer)) {
		result.problems.push("The resolution comment was not found after the write.");
	}
	if (!sectionHas(afterMap.body ?? "", heading, `](${ticket.html_url})`)) {
		result.problems.push(`The map's "${heading}" section has no pointer to the ticket after the write.`);
	}
	result.ok = result.problems.length === 0;
	return result;
}

// ---------- create-tickets ----------

export type PlanTicket = { key: string; title: string; body: string; labels?: string[]; blockedBy?: string[] };
export type Plan = { repo?: string; parent?: number; labels?: string[]; tickets: PlanTicket[]; parentComment?: string };
type Created = { number: number; id: number; url: string; title: string };
export type PlanState = { repo: string; parent: number | null; created: Record<string, Created>; parentComment?: { id: number; url: string } };

const REF = /\{\{([A-Za-z0-9_-]+)(:link)?\}\}/g;

export function parsePlan(raw: unknown): Plan {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refusal("The plan must be a JSON object.");
	const plan = raw as Record<string, unknown>;
	if (!Array.isArray(plan.tickets) || plan.tickets.length === 0) throw new Refusal("The plan needs a non-empty tickets array.");
	const strings = (value: unknown, context: string): string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) throw new Refusal(`${context} must be an array of strings.`);
		return value as string[];
	};
	if (plan.repo !== undefined && (typeof plan.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(plan.repo))) throw new Refusal("plan.repo must be owner/repo.");
	if (plan.parent !== undefined && (!Number.isInteger(plan.parent) || (plan.parent as number) < 1)) throw new Refusal("plan.parent must be an issue number.");
	if (plan.parentComment !== undefined && (typeof plan.parentComment !== "string" || !plan.parentComment.trim())) throw new Refusal("plan.parentComment must be non-empty text.");
	if (plan.parentComment !== undefined && plan.parent === undefined) throw new Refusal("plan.parentComment needs plan.parent.");
	const tickets = plan.tickets.map((rawTicket, i): PlanTicket => {
		const t = rawTicket as Record<string, unknown>;
		const context = `tickets[${i}]`;
		if (!t || typeof t !== "object") throw new Refusal(`${context} must be an object.`);
		if (typeof t.key !== "string" || !/^[A-Za-z0-9_-]+$/.test(t.key)) throw new Refusal(`${context}.key must match [A-Za-z0-9_-]+.`);
		if (typeof t.title !== "string" || !t.title.trim()) throw new Refusal(`${context}.title must be non-empty.`);
		if (typeof t.body !== "string" || !t.body.trim()) throw new Refusal(`${context}.body must be non-empty.`);
		return {
			key: t.key,
			title: t.title.trim(),
			body: t.body,
			labels: strings(t.labels, `${context}.labels`),
			blockedBy: strings(t.blockedBy, `${context}.blockedBy`),
		};
	});
	return {
		repo: plan.repo as string | undefined,
		parent: plan.parent as number | undefined,
		labels: strings(plan.labels, "plan.labels"),
		tickets,
		parentComment: plan.parentComment as string | undefined,
	};
}

/** Blockers first, plan order otherwise. Refuses unknown keys, duplicates, and cycles. */
export function orderTickets(plan: Plan): PlanTicket[] {
	const byKey = new Map<string, PlanTicket>();
	for (const t of plan.tickets) {
		if (byKey.has(t.key)) throw new Refusal(`Duplicate ticket key "${t.key}".`);
		byKey.set(t.key, t);
	}
	const texts = [...plan.tickets.map((t) => t.body), plan.parentComment ?? ""];
	for (const t of plan.tickets) {
		for (const b of t.blockedBy ?? []) {
			if (!byKey.has(b)) throw new Refusal(`Ticket "${t.key}" is blocked by unknown key "${b}".`);
			if (b === t.key) throw new Refusal(`Ticket "${t.key}" blocks itself.`);
		}
	}
	for (const text of texts) {
		for (const match of text.matchAll(REF)) {
			if (!byKey.has(match[1])) throw new Refusal(`Reference {{${match[1]}}} names no ticket key.`);
		}
	}
	const done = new Set<string>();
	const ordered: PlanTicket[] = [];
	while (ordered.length < plan.tickets.length) {
		const next = plan.tickets.find((t) => !done.has(t.key) && (t.blockedBy ?? []).every((b) => done.has(b)));
		if (!next) {
			const left = plan.tickets.filter((t) => !done.has(t.key)).map((t) => t.key);
			throw new Refusal(`The blocking edges form a cycle among: ${left.join(", ")}.`);
		}
		done.add(next.key);
		ordered.push(next);
	}
	return ordered;
}

export function renderRefs(text: string, created: Record<string, Created>): string {
	return text.replace(REF, (whole, key: string, link?: string) => {
		const c = created[key];
		if (!c) return whole;
		return link ? `[${c.title}](${c.url})` : `#${c.number}`;
	});
}

export type CreateResult = {
	ok: boolean;
	dryRun?: boolean;
	repo: string;
	parent: number | null;
	stateFile: string;
	tickets: { key: string; number: number | null; url: string | null; title: string; labels: string[]; blockedBy: string[] }[];
	parentComment: { id: number; url: string } | null;
	problems: string[];
};

function sameText(a: string | null, b: string): boolean {
	const norm = (t: string) => t.replace(/\r\n/g, "\n").trimEnd();
	return norm(a ?? "") === norm(b);
}

function sameSet(a: number[], b: number[]): boolean {
	return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

export async function createTickets(
	gh: Gh,
	plan: Plan,
	stateFile: string,
	options: { repo?: string; dryRun?: boolean } = {},
): Promise<CreateResult> {
	const ordered = orderTickets(plan);
	const repo = options.repo ?? plan.repo ?? (await gh.currentRepo());
	const tracker = new Tracker(gh, repo);
	const parent = plan.parent ?? null;
	let state: PlanState = { repo, parent, created: {} };
	if (existsSync(stateFile)) {
		state = JSON.parse(await readFile(stateFile, "utf8")) as PlanState;
		if (state.repo !== repo || state.parent !== parent) {
			throw new Refusal(`State file ${stateFile} belongs to ${state.repo} parent ${state.parent}. Move it or use another plan file.`);
		}
	}
	const labelsFor = (t: PlanTicket) => [...new Set([...(plan.labels ?? []), ...(t.labels ?? [])])];

	// Read-only checks first. Nothing is written when one fails.
	const known = new Set(((await gh.list(`repos/${repo}/labels?per_page=100`)) as { name: string }[]).map((l) => l.name.toLowerCase()));
	const missing = [...new Set(ordered.flatMap(labelsFor))].filter((l) => !known.has(l.toLowerCase()));
	if (missing.length) throw new Refusal(`Missing labels in ${repo}: ${missing.join(", ")}. Create them first.`);
	if (parent !== null) {
		const p = await tracker.issue(parent);
		if (p.pull_request) throw new Refusal(`Parent #${parent} is a pull request.`);
		if (p.state !== "open") throw new Refusal(`Parent #${parent} is closed.`);
	}
	for (const [key, c] of Object.entries(state.created)) {
		const issue = await tracker.issue(c.number);
		if (issue.title !== c.title) throw new Refusal(`State file says "${key}" is #${c.number}, but its title is now "${issue.title}".`);
	}

	const view = (t: PlanTicket) => ({
		key: t.key,
		number: state.created[t.key]?.number ?? null,
		url: state.created[t.key]?.url ?? null,
		title: t.title,
		labels: labelsFor(t),
		blockedBy: t.blockedBy ?? [],
	});
	if (options.dryRun) {
		return { ok: true, dryRun: true, repo, parent, stateFile, tickets: ordered.map(view), parentComment: state.parentComment ?? null, problems: [] };
	}

	const save = () => writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
	const base = `repos/${repo}/issues`;

	// Pass 1: create in dependency order. Known references render now.
	for (const t of ordered) {
		if (state.created[t.key]) continue;
		const issue = (await gh.api("POST", `repos/${repo}/issues`, {
			title: t.title,
			body: renderRefs(t.body, state.created),
			labels: labelsFor(t),
		})) as Issue;
		state.created[t.key] = { number: issue.number, id: issue.id, url: issue.html_url, title: issue.title };
		await save();
	}

	// Pass 2: sub-issues, blocking edges, then bodies with every reference resolved.
	if (parent !== null) {
		const children = new Set((await tracker.children(parent)).map((c) => c.number));
		for (const t of ordered) {
			const c = state.created[t.key];
			if (!children.has(c.number)) await gh.api("POST", `${base}/${parent}/sub_issues`, { sub_issue_id: c.id });
		}
	}
	for (const t of ordered) {
		if (!t.blockedBy?.length) continue;
		const c = state.created[t.key];
		const have = new Set((await tracker.blockers(c.number)).map((b) => b.number));
		for (const key of t.blockedBy) {
			const blocker = state.created[key];
			if (!have.has(blocker.number)) await gh.api("POST", `${base}/${c.number}/dependencies/blocked_by`, { issue_id: blocker.id });
		}
	}
	for (const t of ordered) {
		const c = state.created[t.key];
		const body = renderRefs(t.body, state.created);
		const current = await tracker.issue(c.number);
		if (!sameText(current.body, body)) await gh.api("PATCH", `${base}/${c.number}`, { body });
	}
	if (plan.parentComment && parent !== null && !state.parentComment) {
		const posted = (await gh.api("POST", `${base}/${parent}/comments`, { body: renderRefs(plan.parentComment, state.created) })) as Comment;
		state.parentComment = { id: posted.id, url: posted.html_url };
		await save();
	}

	// Verify every write by reading it back.
	const problems: string[] = [];
	for (const t of ordered) {
		const c = state.created[t.key];
		const [issue, issueParent, blockers] = await Promise.all([
			tracker.issue(c.number),
			parent !== null ? tracker.parent(c.number) : Promise.resolve(null),
			tracker.blockers(c.number),
		]);
		const names = issue.labels.map((l) => l.name.toLowerCase());
		const lost = labelsFor(t).filter((l) => !names.includes(l.toLowerCase()));
		if (lost.length) problems.push(`#${c.number}: labels missing: ${lost.join(", ")}.`);
		if (!sameText(issue.body, renderRefs(t.body, state.created))) problems.push(`#${c.number}: body differs from the plan.`);
		if (parent !== null && issueParent?.number !== parent) problems.push(`#${c.number}: not a sub-issue of #${parent}.`);
		const want = (t.blockedBy ?? []).map((k) => state.created[k].number);
		const got = blockers.map((b) => b.number);
		if (!sameSet(want, got)) problems.push(`#${c.number}: blocked by [${got.join(", ")}], expected [${want.join(", ")}].`);
	}
	if (plan.parentComment && parent !== null && state.parentComment) {
		const comments = await tracker.comments(parent);
		const body = renderRefs(plan.parentComment, state.created).trim();
		if (!comments.some((cm) => cm.id === state.parentComment?.id && (cm.body ?? "").trim() === body)) {
			problems.push(`The parent comment on #${parent} was not found after the write.`);
		}
	}
	return { ok: problems.length === 0, repo, parent, stateFile, tickets: ordered.map(view), parentComment: state.parentComment ?? null, problems };
}

// ---------- tick (wayfinder-stand-in) ----------

export type TickState = { repo: string; map: number; claimed: number[]; mapUpdated: number[] };

export type TickResult = {
	action: "work" | "update-map" | "report";
	map: Frontier["map"];
	stateFile: string;
	claimedNow: number[];
	claimRefused: string[];
	tickets: TicketView[];
	resolvedThisSession: { number: number; title: string; url: string }[];
	leftForGreg: TicketView[];
	blocked: TicketView[];
	claimedElsewhere: TicketView[];
	openTickets: number;
	next: string;
	dryRun?: boolean;
};

const STAND_IN_TYPES = ["grilling", "research"];

export function defaultTickStateFile(repo: string, map: number): string {
	return path.join(tmpdir(), "wayfinder-tick", `${repo.replace("/", "__")}__${map}.json`);
}

export async function tick(
	tracker: Tracker,
	mapNumber: number,
	stateFile: string,
	options: { dryRun?: boolean; mapUpdated?: boolean; script?: string } = {},
): Promise<TickResult> {
	let state: TickState = { repo: tracker.repo, map: mapNumber, claimed: [], mapUpdated: [] };
	if (existsSync(stateFile)) state = JSON.parse(await readFile(stateFile, "utf8")) as TickState;
	if (state.repo !== tracker.repo || state.map !== mapNumber) throw new Refusal(`State file ${stateFile} belongs to another map.`);
	const save = async () => {
		if (options.dryRun) return;
		await mkdir(path.dirname(stateFile), { recursive: true });
		await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
	};
	const script = options.script ?? "wayfinder.ts";
	const repoFlag = ` --repo ${tracker.repo}`;

	let view = await frontier(tracker, mapNumber);
	const closedSession = () => view.closed.filter((c) => state.claimed.includes(c.number));
	if (options.mapUpdated) {
		state.mapUpdated = [...new Set([...state.mapUpdated, ...closedSession().map((c) => c.number)])];
		await save();
	}

	const login = await tracker.login();
	const openSession = () => [...view.claimed, ...view.blocked].filter((t) => state.claimed.includes(t.number) && t.assignees.includes(login));
	const base = (action: TickResult["action"], next: string, extra: Partial<TickResult> = {}): TickResult => ({
		action,
		map: view.map,
		stateFile,
		claimedNow: [],
		claimRefused: [],
		tickets: [],
		resolvedThisSession: closedSession(),
		leftForGreg: [],
		blocked: [],
		claimedElsewhere: [],
		openTickets: view.counts.open,
		next,
		...(options.dryRun ? { dryRun: true } : {}),
		...extra,
	});

	// 1. Tickets this session claimed and has not resolved.
	let mine = openSession();
	const workNext = `Work each ticket by its type. Resolve each one with: bun ${script} resolve <ticket> --map ${mapNumber} --answer-file <file> --gist "<one line>"${repoFlag}. Then run tick again.`;
	if (mine.length) return base("work", workNext, { tickets: mine });

	// 2. All session tickets are closed: update the map one time.
	const pending = closedSession().filter((c) => !state.mapUpdated.includes(c.number));
	if (pending.length) {
		return base(
			"update-map",
			`Read the map body again. Update the fog and Out of scope, and add new tickets with create-tickets. Then run: bun ${script} tick ${mapNumber} --map-updated${repoFlag}`,
			{ resolvedThisSession: closedSession() },
		);
	}

	// 3. Claim every grilling and research ticket on the frontier.
	const claimable = view.frontier.filter((t) => t.type && STAND_IN_TYPES.includes(t.type));
	const claimedNow: number[] = [];
	const claimRefused: string[] = [];
	if (claimable.length && !options.dryRun) {
		for (const t of claimable) {
			try {
				const result = await claim(tracker, [t.number]);
				if (!result.ok) throw new Error(result.problems.join(" "));
				claimedNow.push(t.number);
				state.claimed.push(t.number);
				await save();
			} catch (error) {
				if (!(error instanceof Refusal)) throw error;
				claimRefused.push(error.message);
			}
		}
		view = await frontier(tracker, mapNumber);
		mine = openSession();
		if (mine.length) return base("work", workNext, { tickets: mine, claimedNow, claimRefused });
	}
	if (claimable.length && options.dryRun) {
		return base("work", `Dry run: tick would claim these tickets. ${workNext}`, { tickets: claimable });
	}

	// 4. Nothing left for a stand-in.
	return base(
		"report",
		view.counts.open === 0
			? "The map has no open tickets. Report, then follow wayfinder's Specification destinations if the destination needs an unpublished specification."
			: "No grilling or research ticket is on the frontier. Report to Greg.",
		{
			claimedNow,
			claimRefused,
			leftForGreg: view.frontier.filter((t) => !t.type || !STAND_IN_TYPES.includes(t.type)),
			blocked: view.blocked,
			claimedElsewhere: view.claimed.filter((t) => !state.claimed.includes(t.number)),
		},
	);
}

// ---------- CLI ----------

export function parseIssueRef(value: string | undefined, label: string): { number: number; repo?: string } {
	if (!value) throw new Refusal(`Supply ${label}.`);
	const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(value);
	if (url) return { repo: url[1], number: Number(url[2]) };
	const n = Number(value.replace(/^#/, ""));
	if (!Number.isInteger(n) || n < 1) throw new Refusal(`${label} must be an issue number or URL, received "${value}".`);
	return { number: n };
}

const USAGE = `Usage: bun wayfinder.ts <command> [options]
  frontier <map>                         Open children of the map: frontier, blocked, claimed, closed.
  claim <ticket>... [--dry-run]          Assign tickets to the gh user. Refuses closed, blocked, or claimed tickets.
  resolve <ticket> --map <map> --answer-file <file> --gist "<line>" [--out-of-scope] [--dry-run]
                                         Post the answer, close the ticket, append the map pointer.
  create-tickets --plan <plan.json> [--dry-run]
                                         Create tickets in dependency order, wire sub-issues and blocked-by,
                                         resolve {{key}} references, post plan.parentComment. Resumable.
  tick <map> [--map-updated] [--dry-run] [--state <file>]
                                         wayfinder-stand-in loop: claims, then prints one next action.
Common: --repo owner/repo (default: the current clone, or the repo in an issue URL).
Exit: 0 done, 1 error or unverified write, 2 refused and nothing written.`;

export async function main(argv: string[], gh: Gh = realGh): Promise<{ code: number; output: unknown }> {
	let parsed;
	try {
		parsed = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			repo: { type: "string" },
			map: { type: "string" },
			"answer-file": { type: "string" },
			gist: { type: "string" },
			"out-of-scope": { type: "boolean" },
			plan: { type: "string" },
			state: { type: "string" },
			"map-updated": { type: "boolean" },
			"dry-run": { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	} catch (error) {
		throw new Refusal(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
	}
	const { values, positionals } = parsed;
	const [command, ...rest] = positionals;
	if (values.help || !command) return { code: values.help ? 0 : 2, output: USAGE };
	const dryRun = values["dry-run"] ?? false;
	const tracker = async (urlRepo?: string) => new Tracker(gh, values.repo ?? urlRepo ?? (await gh.currentRepo()));
	const script = import.meta.path;

	switch (command) {
		case "frontier": {
			const map = parseIssueRef(rest[0], "a map");
			return { code: 0, output: await frontier(await tracker(map.repo), map.number) };
		}
		case "claim": {
			if (!rest.length) throw new Refusal("Supply at least one ticket.");
			const refs = rest.map((r) => parseIssueRef(r, "a ticket"));
			const result = await claim(await tracker(refs[0].repo), refs.map((r) => r.number), dryRun);
			return { code: result.ok ? 0 : 1, output: dryRun ? { ...result, dryRun: true } : result };
		}
		case "resolve": {
			const ticket = parseIssueRef(rest[0], "a ticket");
			const map = parseIssueRef(values.map, "--map");
			if (!values["answer-file"]) throw new Refusal("Supply --answer-file.");
			if (values.gist === undefined) throw new Refusal("Supply --gist.");
			const result = await resolve(await tracker(ticket.repo ?? map.repo), {
				ticket: ticket.number,
				map: map.number,
				answer: await readFile(values["answer-file"], "utf8"),
				gist: values.gist,
				outOfScope: values["out-of-scope"],
				dryRun,
			});
			return { code: result.ok ? 0 : 1, output: result };
		}
		case "create-tickets": {
			if (!values.plan) throw new Refusal("Supply --plan <file>.");
			let raw: unknown;
			try {
				raw = JSON.parse(await readFile(values.plan, "utf8"));
			} catch (error) {
				throw new Refusal(`Cannot read the plan: ${error instanceof Error ? error.message : String(error)}`);
			}
			const result = await createTickets(gh, parsePlan(raw), values.state ?? `${values.plan}.state.json`, { repo: values.repo, dryRun });
			return { code: result.ok ? 0 : 1, output: result };
		}
		case "tick": {
			const map = parseIssueRef(rest[0], "a map");
			const t = await tracker(map.repo);
			const result = await tick(t, map.number, values.state ?? defaultTickStateFile(t.repo, map.number), {
				dryRun,
				mapUpdated: values["map-updated"],
				script,
			});
			return { code: 0, output: result };
		}
		default:
			throw new Refusal(`Unknown command "${command}".\n${USAGE}`);
	}
}

if (import.meta.main) {
	try {
		const { code, output } = await main(Bun.argv.slice(2));
		console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2));
		process.exitCode = code;
	} catch (error) {
		const refused = error instanceof Refusal;
		console.log(JSON.stringify({ ok: false, refused, error: error instanceof Error ? error.message : String(error) }, null, 2));
		process.exitCode = refused ? 2 : 1;
	}
}
