import { describe, expect, test } from "bun:test";
import {
	applyOutcome,
	buildQueue,
	DISCLAIMER,
	type Gh,
	type GhComment,
	type GhIssue,
	parseLabelMap,
	prsInScope,
} from "./triage";

const REPO = "owner/repo";
const { map: CANONICAL } = parseLabelMap(null);

function issue(number: number, overrides: Partial<GhIssue> = {}): GhIssue {
	return {
		number,
		title: `Issue ${number}`,
		html_url: `https://github.com/${REPO}/issues/${number}`,
		state: "open",
		body: "body",
		user: { login: "reporter" },
		author_association: "NONE",
		labels: [],
		created_at: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
		...overrides,
	};
}

function comment(login: string, createdAt: string, body = "text"): GhComment {
	return { user: { login }, body, created_at: createdAt, html_url: "https://example.test/c" };
}

/** In-memory GitHub: one repo, issues keyed by number, records every write. */
function fakeGh(issues: GhIssue[], comments: Record<number, GhComment[]> = {}) {
	const store = new Map(issues.map((item) => [item.number, structuredClone(item)]));
	const writes: string[] = [];
	const numberFrom = (apiPath: string) => Number(apiPath.split("/")[4]);
	const gh: Gh = {
		async get(apiPath) {
			return structuredClone(store.get(numberFrom(apiPath)));
		},
		async getAll(apiPath) {
			if (apiPath.includes("/comments")) return comments[numberFrom(apiPath)] ?? [];
			return [...store.values()].map((item) => structuredClone(item));
		},
		async send(method, apiPath, body) {
			writes.push(`${method} ${apiPath.replace(`repos/${REPO}/issues/`, "")}`);
			const item = store.get(numberFrom(apiPath))!;
			const names = item.labels.map((label) => (typeof label === "string" ? label : label.name));
			if (method === "DELETE") {
				const name = decodeURIComponent(apiPath.split("/labels/")[1]);
				item.labels = names.filter((label) => label !== name).map((name) => ({ name }));
			} else if (apiPath.endsWith("/labels")) {
				item.labels = [...names, ...(body as { labels: string[] }).labels].map((name) => ({ name }));
			} else if (apiPath.endsWith("/comments")) {
				return { html_url: "https://example.test/new-comment", body: (body as { body: string }).body };
			} else {
				Object.assign(item, body);
			}
			return null;
		},
	};
	return { gh, writes, store };
}

describe("config", () => {
	test("parses the label table and falls back to canonical names", () => {
		const { map, mapped } = parseLabelMap(
			[
				"| Label in mattpocock/skills | Label in our tracker | Meaning |",
				"| --- | --- | --- |",
				"| `needs-triage` | `triage: new` | x |",
				"| `ready-for-agent` | `afk` | x |",
			].join("\n"),
		);
		expect(map["needs-triage"]).toBe("triage: new");
		expect(map["ready-for-agent"]).toBe("afk");
		expect(map.wontfix).toBe("wontfix");
		expect(map.bug).toBe("bug");
		expect(mapped).toEqual(["needs-triage", "ready-for-agent"]);
	});

	test("reads the PR flag from issue-tracker.md", () => {
		expect(prsInScope("**PRs as a request surface: no.** _(Set to `yes` ...)_")).toBe(false);
		expect(prsInScope("**PRs as a request surface: yes.**")).toBe(true);
		expect(prsInScope("- Pull requests are not a triage request surface.")).toBe(false);
		expect(prsInScope(null)).toBe(false);
	});
});

describe("queue", () => {
	test("sorts items into buckets, oldest first, and keeps conflicts apart", async () => {
		const { gh } = fakeGh(
			[
				issue(5, { labels: [{ name: "needs-triage" }] }),
				issue(2),
				issue(3, { labels: [{ name: "bug" }] }),
				issue(4, { labels: [{ name: "needs-triage" }, { name: "wontfix" }] }),
				issue(6, { labels: [{ name: "ready-for-agent" }] }),
				issue(7, { labels: [{ name: "wayfinder:map" }] }),
				issue(8, { labels: [{ name: "wayfinder:task" }, { name: "needs-triage" }] }),
			],
		);
		const queue = await buildQueue(gh, REPO, CANONICAL, false);
		expect(queue.unlabeled.map((item) => item.number)).toEqual([2, 3]);
		expect(queue.needsTriage.map((item) => item.number)).toEqual([5, 8]);
		expect(queue.skippedWayfinder).toBe(1);
		expect(queue.conflicts.map((item) => item.stateRoles)).toEqual([["needs-triage", "wontfix"]]);
		expect(queue.counts).toEqual({ conflicts: 1, unlabeled: 2, needsTriage: 2, needsInfoActive: 0 });
	});

	test("lists needs-info only when the reporter replied after the last triage notes", async () => {
		const notes = `${DISCLAIMER}\n\n## Triage Notes\n...`;
		const { gh } = fakeGh(
			[
				issue(1, { labels: [{ name: "needs-info" }] }),
				issue(2, { labels: [{ name: "needs-info" }] }),
				issue(3, { labels: [{ name: "needs-info" }] }),
			],
			{
				1: [comment("reporter", "2026-02-01T00:00:00Z"), comment("bot", "2026-02-02T00:00:00Z", notes)],
				2: [comment("bot", "2026-02-02T00:00:00Z", notes), comment("reporter", "2026-02-03T00:00:00Z")],
				3: [comment("bot", "2026-02-02T00:00:00Z", notes), comment("someone-else", "2026-02-03T00:00:00Z")],
			},
		);
		const queue = await buildQueue(gh, REPO, CANONICAL, false);
		expect(queue.needsInfoActive.map((item) => item.number)).toEqual([2]);
		expect(queue.needsInfoActive[0].reporterRepliedAt).toBe("2026-02-03T00:00:00Z");
	});

	test("includes only external PRs, and only when PRs are in scope", async () => {
		const items = [
			issue(1, { pull_request: {}, author_association: "CONTRIBUTOR" }),
			issue(2, { pull_request: {}, author_association: "COLLABORATOR" }),
			issue(3),
		];
		expect((await buildQueue(fakeGh(items).gh, REPO, CANONICAL, false)).unlabeled.map((i) => i.number)).toEqual([3]);
		const withPrs = await buildQueue(fakeGh(items).gh, REPO, CANONICAL, true);
		expect(withPrs.unlabeled.map((i) => [i.number, i.kind])).toEqual([
			[1, "pr"],
			[3, "issue"],
		]);
	});
});

describe("apply", () => {
	test("swaps the state label, sets the category, comments with the disclaimer, and verifies", async () => {
		const { gh, writes, store } = fakeGh([issue(7, { labels: [{ name: "needs-triage" }, { name: "enhancement" }] })]);
		const result = await applyOutcome(gh, REPO, CANONICAL, {
			number: 7,
			state: "ready-for-agent",
			category: "bug",
			comment: "## Agent Brief\n...",
		});
		expect(result.status).toBe("applied");
		expect(writes).toEqual([
			"DELETE 7/labels/needs-triage",
			"DELETE 7/labels/enhancement",
			"POST 7/labels",
			"POST 7/comments",
		]);
		expect(result.plan.comment?.startsWith(`${DISCLAIMER}\n\n## Agent Brief`)).toBe(true);
		expect(store.get(7)!.labels).toEqual([{ name: "ready-for-agent" }, { name: "bug" }]);
	});

	test("does not add the disclaimer twice", async () => {
		const { gh } = fakeGh([issue(1)]);
		const result = await applyOutcome(gh, REPO, CANONICAL, {
			number: 1,
			state: "needs-info",
			comment: `${DISCLAIMER}\n\n## Triage Notes`,
			dryRun: true,
		});
		expect(result.plan.comment).toBe(`${DISCLAIMER}\n\n## Triage Notes`);
	});

	test("closes wontfix items as not planned", async () => {
		const { gh, writes, store } = fakeGh([issue(4, { labels: [{ name: "needs-triage" }, { name: "bug" }] })]);
		const result = await applyOutcome(gh, REPO, CANONICAL, { number: 4, state: "wontfix", comment: "Not a bug." });
		expect(result.status).toBe("applied");
		expect(writes.at(-1)).toBe("PATCH 4");
		expect(store.get(4)!.state).toBe("closed");
		expect(store.get(4)!).toMatchObject({ state_reason: "not_planned" });
	});

	test("uses mapped label strings", async () => {
		const { map } = parseLabelMap("| `ready-for-human` | `human` | x |");
		const { gh, store } = fakeGh([issue(1, { labels: [{ name: "needs-triage" }] })]);
		await applyOutcome(gh, REPO, map, { number: 1, state: "ready-for-human" });
		expect(store.get(1)!.labels).toEqual([{ name: "human" }]);
	});

	test("refuses conflicting state labels unless allowed, and writes nothing", async () => {
		const labels = [{ name: "needs-info" }, { name: "ready-for-agent" }];
		const refused = fakeGh([issue(1, { labels })]);
		const result = await applyOutcome(refused.gh, REPO, CANONICAL, { number: 1, state: "ready-for-agent" });
		expect(result.status).toBe("refused");
		expect(refused.writes).toEqual([]);

		const allowed = fakeGh([issue(1, { labels })]);
		const fixed = await applyOutcome(allowed.gh, REPO, CANONICAL, {
			number: 1,
			state: "ready-for-agent",
			allowConflict: true,
		});
		expect(fixed.status).toBe("applied");
		expect(allowed.writes).toEqual(["DELETE 1/labels/needs-info"]);
	});

	test("refuses needs-info and wontfix without a comment", async () => {
		for (const state of ["needs-info", "wontfix"] as const) {
			const { gh, writes } = fakeGh([issue(1)]);
			expect((await applyOutcome(gh, REPO, CANONICAL, { number: 1, state })).status).toBe("refused");
			expect(writes).toEqual([]);
		}
	});

	test("dry run returns the plan and writes nothing", async () => {
		const { gh, writes } = fakeGh([issue(1, { labels: [{ name: "needs-triage" }] })]);
		const result = await applyOutcome(gh, REPO, CANONICAL, { number: 1, state: "ready-for-agent", dryRun: true });
		expect(result.status).toBe("planned");
		expect(result.plan).toMatchObject({ removeLabels: ["needs-triage"], addLabels: ["ready-for-agent"], close: false });
		expect(result.plan.warnings).toContain("No category role on this item. Pass --category.");
		expect(writes).toEqual([]);
	});

	test("reports unverified when GitHub does not end in the expected state", async () => {
		const { gh } = fakeGh([issue(1)]);
		const broken: Gh = { ...gh, send: async () => null };
		const result = await applyOutcome(broken, REPO, CANONICAL, { number: 1, state: "ready-for-agent" });
		expect(result.status).toBe("unverified");
		expect(result).toMatchObject({ problems: ['Expected state role "ready-for-agent", found [].'] });
	});
});
