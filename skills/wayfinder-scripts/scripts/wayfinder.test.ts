import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
	appendToSection,
	type Gh,
	GhError,
	main,
	type Method,
	orderTickets,
	parsePlan,
	Refusal,
	renderRefs,
} from "./wayfinder";

// ---------- in-memory GitHub ----------

type FakeIssue = {
	id: number;
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	state_reason: string | null;
	labels: string[];
	assignees: string[];
	parent: number | null;
	children: number[];
	blockedBy: number[];
	comments: { id: number; body: string; user: string }[];
};

const REPO = "owner/repo";

class FakeGh implements Gh {
	issues = new Map<number, FakeIssue>();
	labels = new Set(["wayfinder:map", "wayfinder:grilling", "wayfinder:research", "wayfinder:prototype", "wayfinder:task", "ready-for-agent"]);
	login = "greg";
	writes: string[] = [];
	failOn: ((method: Method, endpoint: string) => boolean) | null = null;
	#next = 1;
	#comment = 1000;

	add(partial: Partial<FakeIssue> & { title: string }): FakeIssue {
		const number = partial.number ?? this.#next;
		this.#next = Math.max(this.#next, number + 1);
		const issue: FakeIssue = {
			id: 9000 + number,
			number,
			body: "",
			state: "open",
			state_reason: null,
			labels: [],
			assignees: [],
			parent: null,
			children: [],
			blockedBy: [],
			comments: [],
			...partial,
		};
		this.issues.set(number, issue);
		if (issue.parent) this.get(issue.parent).children.push(number);
		return issue;
	}

	get(n: number): FakeIssue {
		const issue = this.issues.get(n);
		if (!issue) throw new GhError(`issue ${n}: Not Found (HTTP 404)`, 404);
		return issue;
	}

	render(i: FakeIssue) {
		return {
			id: i.id,
			number: i.number,
			title: i.title,
			body: i.body,
			html_url: `https://github.com/${REPO}/issues/${i.number}`,
			state: i.state,
			labels: i.labels.map((name) => ({ name })),
			assignees: i.assignees.map((login) => ({ login })),
			issue_dependencies_summary: { blocked_by: i.blockedBy.filter((b) => this.get(b).state === "open").length },
		};
	}

	renderComment(c: FakeIssue["comments"][number], n: number) {
		return { id: c.id, body: c.body, user: { login: c.user }, html_url: `https://github.com/${REPO}/issues/${n}#issuecomment-${c.id}` };
	}

	async currentRepo() {
		return REPO;
	}

	async list(endpoint: string): Promise<unknown[]> {
		const result = await this.api("GET", endpoint);
		return result as unknown[];
	}

	async api(method: Method, endpoint: string, body?: Record<string, unknown>): Promise<unknown> {
		if (this.failOn?.(method, endpoint)) throw new GhError(`${endpoint}: Server Error (HTTP 500)`, 500);
		const route = endpoint.replace(/\?.*$/, "");
		if (method !== "GET") this.writes.push(`${method} ${route}`);
		if (route === "user") return { login: this.login };
		const prefix = `repos/${REPO}/`;
		if (!route.startsWith(prefix)) throw new GhError(`${route}: Not Found (HTTP 404)`, 404);
		const parts = route.slice(prefix.length).split("/");
		if (parts[0] === "labels") return [...this.labels].map((name) => ({ name }));
		if (parts[0] !== "issues") throw new GhError(`${route}: Not Found (HTTP 404)`, 404);
		if (parts.length === 1 && method === "POST") {
			const issue = this.add({ title: String(body?.title), body: String(body?.body ?? ""), labels: (body?.labels as string[]) ?? [] });
			return this.render(issue);
		}
		const issue = this.get(Number(parts[1]));
		const sub = parts.slice(2).join("/");
		if (sub === "" && method === "GET") return this.render(issue);
		if (sub === "" && method === "PATCH") {
			if (typeof body?.body === "string") issue.body = body.body;
			if (body?.state) {
				issue.state = body.state as "open" | "closed";
				issue.state_reason = (body.state_reason as string) ?? null;
			}
			return this.render(issue);
		}
		if (sub === "sub_issues" && method === "GET") return issue.children.map((c) => this.render(this.get(c)));
		if (sub === "sub_issues" && method === "POST") {
			const child = [...this.issues.values()].find((i) => i.id === body?.sub_issue_id);
			if (!child) throw new GhError("sub issue: Not Found (HTTP 404)", 404);
			child.parent = issue.number;
			issue.children.push(child.number);
			return this.render(issue);
		}
		if (sub === "parent") {
			if (!issue.parent) throw new GhError("No parent issue found (HTTP 404)", 404);
			return this.render(this.get(issue.parent));
		}
		if (sub === "dependencies/blocked_by" && method === "GET") return issue.blockedBy.map((b) => this.render(this.get(b)));
		if (sub === "dependencies/blocked_by" && method === "POST") {
			const blocker = [...this.issues.values()].find((i) => i.id === body?.issue_id);
			if (!blocker) throw new GhError("blocker: Not Found (HTTP 404)", 404);
			issue.blockedBy.push(blocker.number);
			return this.render(issue);
		}
		if (sub === "comments" && method === "GET") return issue.comments.map((c) => this.renderComment(c, issue.number));
		if (sub === "comments" && method === "POST") {
			const c = { id: this.#comment++, body: String(body?.body), user: this.login };
			issue.comments.push(c);
			return this.renderComment(c, issue.number);
		}
		if (sub === "assignees" && method === "POST") {
			for (const login of body?.assignees as string[]) if (!issue.assignees.includes(login)) issue.assignees.push(login);
			return this.render(issue);
		}
		throw new GhError(`${method} ${route}: Not Found (HTTP 404)`, 404);
	}
}

const MAP_BODY = `## Destination

A clear way.

## Notes

Use grilling.

## Decisions so far

<!-- the index -->

## Not yet specified

- Fog A.

## Out of scope
`;

function mapFixture() {
	const gh = new FakeGh();
	gh.add({ number: 1, title: "The map", body: MAP_BODY, labels: ["wayfinder:map"] });
	gh.add({ number: 2, title: "Pick the store", labels: ["wayfinder:grilling"], parent: 1 });
	gh.add({ number: 3, title: "Read the API docs", labels: ["wayfinder:research"], parent: 1 });
	gh.add({ number: 4, title: "Sketch the page", labels: ["wayfinder:prototype"], parent: 1 });
	gh.add({ number: 5, title: "Pick the cache", labels: ["wayfinder:grilling"], parent: 1, blockedBy: [2] });
	gh.add({ number: 6, title: "Someone else's", labels: ["wayfinder:grilling"], parent: 1, assignees: ["ann"] });
	gh.add({ number: 7, title: "Done already", labels: ["wayfinder:grilling"], parent: 1, state: "closed" });
	gh.add({ number: 8, title: "Unrelated", labels: ["wayfinder:grilling"] });
	return gh;
}

const directories: string[] = [];
async function scratch() {
	const dir = await mkdtemp(path.join(tmpdir(), "wayfinder-scripts-test-"));
	directories.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function cli(gh: Gh, ...args: string[]) {
	try {
		const { code, output } = await main(args, gh);
		return { code, output: output as Record<string, any> };
	} catch (error) {
		if (error instanceof Refusal) return { code: 2, output: { error: error.message } as Record<string, any> };
		throw error;
	}
}

// ---------- frontier and claim ----------

describe("frontier", () => {
	it("splits open children into frontier, blocked and claimed in map order", async () => {
		const { code, output } = await cli(mapFixture(), "frontier", "1");
		expect(code).toBe(0);
		expect(output.map.isMap).toBe(true);
		expect(output.frontier.map((t: any) => [t.number, t.type])).toEqual([
			[2, "grilling"],
			[3, "research"],
			[4, "prototype"],
		]);
		expect(output.blocked.map((t: any) => [t.number, t.openBlockers])).toEqual([[5, 1]]);
		expect(output.claimed.map((t: any) => t.number)).toEqual([6]);
		expect(output.closed.map((t: any) => t.number)).toEqual([7]);
		expect(output.first).toBe(2);
	});

	it("reads the repository from an issue URL", async () => {
		const { output } = await cli(mapFixture(), "frontier", `https://github.com/${REPO}/issues/1`);
		expect(output.map.number).toBe(1);
	});
});

describe("claim", () => {
	it("assigns the gh user and verifies the write", async () => {
		const gh = mapFixture();
		const { code, output } = await cli(gh, "claim", "2", "3");
		expect(code).toBe(0);
		expect(output.claimed).toEqual([2, 3]);
		expect(gh.get(2).assignees).toEqual(["greg"]);
	});

	it("refuses all tickets and writes nothing when one is claimed, blocked or closed", async () => {
		for (const bad of ["5", "6", "7"]) {
			const gh = mapFixture();
			const { code } = await cli(gh, "claim", "2", bad);
			expect(code).toBe(2);
			expect(gh.writes).toEqual([]);
		}
	});

	it("is idempotent for a ticket that is already mine", async () => {
		const gh = mapFixture();
		gh.get(2).assignees = ["greg"];
		const { code, output } = await cli(gh, "claim", "2");
		expect(code).toBe(0);
		expect(output.alreadyMine).toEqual([2]);
		expect(gh.writes).toEqual([]);
	});

	it("writes nothing on --dry-run", async () => {
		const gh = mapFixture();
		const { output } = await cli(gh, "claim", "2", "--dry-run");
		expect(output.claimed).toEqual([2]);
		expect(gh.writes).toEqual([]);
	});
});

// ---------- resolve ----------

describe("appendToSection", () => {
	it("adds the first item after a comment, and later items below it", () => {
		const once = appendToSection(MAP_BODY, "Decisions so far", "- [A](u1): a");
		expect(once).toContain("<!-- the index -->\n\n- [A](u1): a\n\n## Not yet specified");
		const twice = appendToSection(once, "Decisions so far", "- [B](u2): b");
		expect(twice).toContain("- [A](u1): a\n- [B](u2): b\n\n## Not yet specified");
	});

	it("appends to the last section and replaces a lone None item", () => {
		const body = "## Decisions so far\n\n- None.\n\n## Out of scope\n";
		expect(appendToSection(body, "Decisions so far", "- x")).toBe("## Decisions so far\n\n- x\n\n## Out of scope\n");
		expect(appendToSection(body, "Out of scope", "- y")).toBe("## Decisions so far\n\n- None.\n\n## Out of scope\n\n- y\n");
	});
});

describe("resolve", () => {
	async function answerFile(text = "Use SQLite.\n\nA stand-in for Greg reviewed this decision.") {
		const file = path.join(await scratch(), "answer.md");
		await writeFile(file, text);
		return file;
	}

	it("posts the answer, closes the ticket, and appends the pointer", async () => {
		const gh = mapFixture();
		const { code, output } = await cli(gh, "resolve", "2", "--map", "1", "--answer-file", await answerFile(), "--gist", "Use SQLite.");
		expect(code).toBe(0);
		expect(output.ok).toBe(true);
		expect(gh.get(2).state).toBe("closed");
		expect(gh.get(2).state_reason).toBe("completed");
		expect(gh.get(2).comments[0].body).toStartWith("Use SQLite.");
		expect(gh.get(1).body).toContain(`- [Pick the store](https://github.com/${REPO}/issues/2): Use SQLite.\n\n## Not yet specified`);
	});

	it("is safe to run again after a partial failure", async () => {
		const gh = mapFixture();
		const file = await answerFile();
		gh.failOn = (method, endpoint) => method === "PATCH" && endpoint.endsWith("/issues/1");
		await expect(cli(gh, "resolve", "2", "--map", "1", "--answer-file", file, "--gist", "Use SQLite.")).rejects.toThrow("HTTP 500");
		gh.failOn = null;
		const { code, output } = await cli(gh, "resolve", "2", "--map", "1", "--answer-file", file, "--gist", "Use SQLite.");
		expect(code).toBe(0);
		expect(output.comment.posted).toBe(false);
		expect(output.closed).toBe(false);
		expect(output.pointer.added).toBe(true);
		expect(gh.get(2).comments).toHaveLength(1);
		const again = await cli(gh, "resolve", "2", "--map", "1", "--answer-file", file, "--gist", "Use SQLite.");
		expect(again.output.pointer.added).toBe(false);
		expect(gh.get(1).body.match(/Pick the store/g)).toHaveLength(1);
	});

	it("rules a ticket out of scope", async () => {
		const gh = mapFixture();
		const { code } = await cli(gh, "resolve", "4", "--map", "1", "--answer-file", await answerFile("Past the destination."), "--gist", "Out: past the destination.", "--out-of-scope");
		expect(code).toBe(0);
		expect(gh.get(4).state_reason).toBe("not_planned");
		expect(gh.get(1).body).toEndWith(`## Out of scope\n\n- [Sketch the page](https://github.com/${REPO}/issues/4): Out: past the destination.\n`);
		expect(gh.get(1).body).not.toContain("Sketch the page](https://github.com/owner/repo/issues/4): Out: past the destination.\n\n## Not yet");
	});

	it("refuses and writes nothing for a ticket off the map, a closed ticket, or a bad gist", async () => {
		const cases = [
			["8", "--gist", "x"],
			["7", "--gist", "x"],
			["2", "--gist", "two\nlines"],
		];
		for (const [ticket, ...gist] of cases) {
			const gh = mapFixture();
			const { code } = await cli(gh, "resolve", ticket, "--map", "1", "--answer-file", await answerFile(), ...gist);
			expect(code).toBe(2);
			expect(gh.writes).toEqual([]);
		}
	});

	it("refuses when the map has no Decisions so far section", async () => {
		const gh = mapFixture();
		gh.get(1).body = "## Destination\n\nX\n";
		const { code } = await cli(gh, "resolve", "2", "--map", "1", "--answer-file", await answerFile(), "--gist", "x");
		expect(code).toBe(2);
		expect(gh.writes).toEqual([]);
	});

	it("reports what it would do on --dry-run", async () => {
		const gh = mapFixture();
		const { output } = await cli(gh, "resolve", "2", "--map", "1", "--answer-file", await answerFile(), "--gist", "x", "--dry-run");
		expect(output).toMatchObject({ dryRun: true, closed: true, comment: { posted: true }, pointer: { added: true } });
		expect(gh.writes).toEqual([]);
	});
});

// ---------- create-tickets ----------

const PLAN = {
	parent: 1,
	labels: ["wayfinder:grilling"],
	tickets: [
		{ key: "cache", title: "Pick the cache", body: "## Question\n\nWhich cache? See {{store}}.", blockedBy: ["store"] },
		{ key: "store", title: "Pick the store", body: "## Question\n\nWhich store? Later: {{cache:link}}." },
		{ key: "docs", title: "Read the docs", body: "## Question\n\nWhat does the API allow?", labels: ["wayfinder:research"] },
	],
	parentComment: "Owners: {{store:link}} owns the schema.",
};

describe("plan checks", () => {
	it("orders blockers first and keeps plan order otherwise", () => {
		expect(orderTickets(parsePlan(PLAN)).map((t) => t.key)).toEqual(["store", "cache", "docs"]);
	});

	it("refuses cycles, unknown keys, and unknown references", () => {
		const cycle = { tickets: [{ key: "a", title: "A", body: "a", blockedBy: ["b"] }, { key: "b", title: "B", body: "b", blockedBy: ["a"] }] };
		expect(() => orderTickets(parsePlan(cycle))).toThrow("cycle");
		expect(() => orderTickets(parsePlan({ tickets: [{ key: "a", title: "A", body: "a", blockedBy: ["z"] }] }))).toThrow("unknown key");
		expect(() => orderTickets(parsePlan({ tickets: [{ key: "a", title: "A", body: "see {{z}}" }] }))).toThrow("{{z}}");
		expect(() => parsePlan({ tickets: [{ key: "a", title: "A", body: "a" }], parentComment: "x" })).toThrow("needs plan.parent");
	});

	it("renders references as numbers or named links", () => {
		const created = { a: { number: 12, id: 1, url: "https://x/12", title: "Alpha" } };
		expect(renderRefs("{{a}} and {{a:link}} and {{b}}", created)).toBe("#12 and [Alpha](https://x/12) and {{b}}");
	});
});

describe("create-tickets", () => {
	async function planFile(plan: unknown = PLAN) {
		const file = path.join(await scratch(), "tickets.json");
		await writeFile(file, JSON.stringify(plan));
		return file;
	}

	it("creates, wires, resolves references, comments on the parent, and verifies", async () => {
		const gh = mapFixture();
		const file = await planFile();
		const { code, output } = await cli(gh, "create-tickets", "--plan", file);
		expect(code).toBe(0);
		expect(output.ok).toBe(true);
		const [store, cache, docs] = output.tickets.map((t: any) => gh.get(t.number));
		expect([store.title, cache.title, docs.title]).toEqual(["Pick the store", "Pick the cache", "Read the docs"]);
		expect(store.number).toBeLessThan(cache.number);
		expect(cache.blockedBy).toEqual([store.number]);
		expect(cache.body).toBe(`## Question\n\nWhich cache? See #${store.number}.`);
		expect(store.body).toBe(`## Question\n\nWhich store? Later: [Pick the cache](https://github.com/${REPO}/issues/${cache.number}).`);
		expect(docs.labels).toEqual(["wayfinder:grilling", "wayfinder:research"]);
		expect([store.parent, cache.parent, docs.parent]).toEqual([1, 1, 1]);
		expect(gh.get(1).comments[0].body).toBe(`Owners: [Pick the store](https://github.com/${REPO}/issues/${store.number}) owns the schema.`);
		expect(gh.get(1).body).toBe(MAP_BODY);
		const state = JSON.parse(await readFile(`${file}.state.json`, "utf8"));
		expect(Object.keys(state.created).sort()).toEqual(["cache", "docs", "store"]);
	});

	it("resumes from the state file without duplicates", async () => {
		const gh = mapFixture();
		const file = await planFile();
		gh.failOn = (method, endpoint) => method === "POST" && endpoint.endsWith("/dependencies/blocked_by");
		await expect(cli(gh, "create-tickets", "--plan", file)).rejects.toThrow("HTTP 500");
		gh.failOn = null;
		const before = gh.issues.size;
		const { code, output } = await cli(gh, "create-tickets", "--plan", file);
		expect(code).toBe(0);
		expect(output.ok).toBe(true);
		expect(gh.issues.size).toBe(before);
		expect(gh.get(1).children.length).toBe(new Set(gh.get(1).children).size);
		const again = await cli(gh, "create-tickets", "--plan", file);
		expect(again.output.ok).toBe(true);
		expect(gh.get(1).comments).toHaveLength(1);
	});

	it("refuses missing labels or a closed parent and writes nothing", async () => {
		const gh = mapFixture();
		gh.labels.delete("wayfinder:research");
		expect((await cli(gh, "create-tickets", "--plan", await planFile())).code).toBe(2);
		const closed = mapFixture();
		closed.get(1).state = "closed";
		expect((await cli(closed, "create-tickets", "--plan", await planFile())).code).toBe(2);
		expect([...gh.writes, ...closed.writes]).toEqual([]);
	});

	it("publishes to-tickets style without a parent", async () => {
		const gh = new FakeGh();
		const plan = {
			labels: ["ready-for-agent"],
			tickets: [
				{ key: "a", title: "Slice A", body: "## What to build\n\nA." },
				{ key: "b", title: "Slice B", body: "## What to build\n\nB, after {{a}}.", blockedBy: ["a"] },
			],
		};
		const { code, output } = await cli(gh, "create-tickets", "--plan", await planFile(plan));
		expect(code).toBe(0);
		expect(output.parent).toBeNull();
		expect(gh.get(2).blockedBy).toEqual([1]);
		expect(gh.get(2).labels).toEqual(["ready-for-agent"]);
	});

	it("validates and writes nothing on --dry-run", async () => {
		const gh = mapFixture();
		const { code, output } = await cli(gh, "create-tickets", "--plan", await planFile(), "--dry-run");
		expect(code).toBe(0);
		expect(output.tickets.map((t: any) => t.key)).toEqual(["store", "cache", "docs"]);
		expect(gh.writes).toEqual([]);
	});

	it("reports an unverified write with exit 1", async () => {
		// The write returns success, but the parent link does not hold.
		const broken = mapFixture();
		const brokenOriginal = broken.api.bind(broken);
		broken.api = async (method, endpoint, body) => {
			const result = await brokenOriginal(method, endpoint, body);
			if (method === "POST" && endpoint.endsWith("/sub_issues")) {
				const child = [...broken.issues.values()].find((i) => i.id === body?.sub_issue_id);
				if (child) child.parent = null;
			}
			return result;
		};
		const second = await cli(broken, "create-tickets", "--plan", await planFile());
		expect(second.code).toBe(1);
		expect(second.output.problems.join(" ")).toContain("not a sub-issue");
	});
});

// ---------- tick ----------

describe("tick", () => {
	async function tickArgs() {
		return ["--state", path.join(await scratch(), "tick.json")];
	}

	it("claims grilling and research tickets, then walks work, update-map and report", async () => {
		const gh = mapFixture();
		const state = await tickArgs();
		const answer = path.join(await scratch(), "a.md");
		await writeFile(answer, "Answer.");

		const first = await cli(gh, "tick", "1", ...state);
		expect(first.output.action).toBe("work");
		expect(first.output.claimedNow).toEqual([2, 3]);
		expect(first.output.tickets.map((t: any) => t.number)).toEqual([2, 3]);
		expect(gh.get(4).assignees).toEqual([]);

		await cli(gh, "resolve", "2", "--map", "1", "--answer-file", answer, "--gist", "Two.");
		const mid = await cli(gh, "tick", "1", ...state);
		expect(mid.output.action).toBe("work");
		expect(mid.output.tickets.map((t: any) => t.number)).toEqual([3]);
		expect(mid.output.claimedNow).toEqual([]);

		await cli(gh, "resolve", "3", "--map", "1", "--answer-file", answer, "--gist", "Three.");
		const update = await cli(gh, "tick", "1", ...state);
		expect(update.output.action).toBe("update-map");
		expect(update.output.resolvedThisSession.map((t: any) => t.number)).toEqual([2, 3]);
		expect(gh.get(5).assignees).toEqual([]);

		const next = await cli(gh, "tick", "1", "--map-updated", ...state);
		expect(next.output.action).toBe("work");
		expect(next.output.claimedNow).toEqual([5]);

		await cli(gh, "resolve", "5", "--map", "1", "--answer-file", answer, "--gist", "Five.");
		await cli(gh, "tick", "1", "--map-updated", ...state);
		const report = await cli(gh, "tick", "1", ...state);
		expect(report.output.action).toBe("report");
		expect(report.output.leftForGreg.map((t: any) => t.number)).toEqual([4]);
		expect(report.output.claimedElsewhere.map((t: any) => t.number)).toEqual([6]);
		expect(report.output.resolvedThisSession.map((t: any) => t.number)).toEqual([2, 3, 5]);
	});

	it("does not take tickets assigned to Greg before the session", async () => {
		const gh = mapFixture();
		gh.get(2).assignees = ["greg"];
		const { output } = await cli(gh, "tick", "1", ...(await tickArgs()));
		expect(output.claimedNow).toEqual([3]);
		expect(output.tickets.map((t: any) => t.number)).toEqual([3]);
	});

	it("writes nothing on --dry-run", async () => {
		const gh = mapFixture();
		const { output } = await cli(gh, "tick", "1", "--dry-run", ...(await tickArgs()));
		expect(output.action).toBe("work");
		expect(output.tickets.map((t: any) => t.number)).toEqual([2, 3]);
		expect(gh.writes).toEqual([]);
	});
});

describe("arguments", () => {
	it("refuses unknown commands and options with exit 2", async () => {
		expect((await cli(new FakeGh(), "nope")).code).toBe(2);
		expect((await cli(new FakeGh(), "frontier", "1", "--bogus")).code).toBe(2);
		expect((await cli(new FakeGh(), "frontier", "abc")).code).toBe(2);
	});
});
