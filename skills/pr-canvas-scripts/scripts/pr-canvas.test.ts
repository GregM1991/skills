import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assemble, categorize, type CommandResult, type Deps, diffKeys, parsePrUrl, run } from "./pr-canvas";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pr-canvas-test-"));
	roots.push(root);
	return root;
}

type Harness = { deps: Deps; calls: string[][]; out: string[]; err: string[]; spawned: string[][] };

function harness(root: string, responses: Record<string, CommandResult | ((cmd: string[]) => CommandResult)>, overrides: Partial<Deps> = {}): Harness {
	const calls: string[][] = [];
	const out: string[] = [];
	const err: string[] = [];
	const spawned: string[][] = [];
	const deps: Deps = {
		async exec(command) {
			calls.push(command);
			const key = Object.keys(responses).find((prefix) => command.join(" ").startsWith(prefix));
			if (!key) return { code: 1, stdout: "", stderr: `unexpected command: ${command.join(" ")}` };
			const response = responses[key];
			return typeof response === "function" ? response(command) : response;
		},
		spawnDetached(command) {
			spawned.push(command);
			return 4242;
		},
		fetch: async () => ({ status: 200 }),
		portIsFree: async () => true,
		sleep: async () => {},
		now: () => new Date("2026-11-19T00:00:00.000Z"),
		tmpRoot: root,
		scriptPath: path.join(root, "skills", "pr-canvas-scripts", "scripts", "pr-canvas.ts"),
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		...overrides,
	};
	return { deps, calls, out, err, spawned };
}

const ok = (value: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

const PR = {
	number: 7,
	html_url: "https://github.com/acme/app/pull/7",
	title: "Add retry client",
	body: "Adds retries.",
	user: { login: "dev" },
	state: "closed",
	merged_at: "2026-11-01T00:00:00Z",
	draft: false,
	additions: 30,
	deletions: 4,
	changed_files: 5,
	base: { ref: "main" },
	head: { ref: "retry" },
};

const FILES_PAGE_1 = [
	{ filename: "bun.lock", status: "modified", additions: 10, deletions: 2, patch: "@@ lock" },
	{ filename: "src/retry-client.ts", status: "added", additions: 20, deletions: 0, patch: "@@ -0,0 +1 @@\n+</script><b>&" },
];
const FILES_PAGE_2 = [
	{ filename: "src/old.ts", previous_filename: "src/older.ts", status: "renamed", additions: 0, deletions: 0 },
	{ filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0 },
	{ filename: "src/retry_client.ts", status: "modified", additions: 0, deletions: 2, patch: "@@ -1 +0,0 @@\n-x" },
];

function githubResponses() {
	return {
		"gh api repos/acme/app/pulls/7/files": ok([FILES_PAGE_1, FILES_PAGE_2]),
		"gh api repos/acme/app/pulls/7/comments": ok([[{ user: { login: "rev" }, body: "nit", path: "src/retry-client.ts", line: 3, html_url: "u1" }], [{ user: { login: "rev2" }, body: "page two", path: "src/old.ts", original_line: 9, html_url: "u2" }]]),
		"gh api repos/acme/app/pulls/7": ok(PR),
	};
}

describe("parsePrUrl", () => {
	test("reads github.com, enterprise and short references", () => {
		expect(parsePrUrl("https://github.com/acme/app/pull/7/files")).toEqual({ host: "github.com", owner: "acme", repo: "app", number: 7 });
		expect(parsePrUrl("https://git.corp.example/team/svc/pull/12")).toEqual({ host: "git.corp.example", owner: "team", repo: "svc", number: 12 });
		expect(parsePrUrl("acme/app#3")).toEqual({ host: "github.com", owner: "acme", repo: "app", number: 3 });
		expect(() => parsePrUrl("https://github.com/acme/app/issues/7")).toThrow("Not a pull request URL");
	});
});

describe("categorize and diffKeys", () => {
	test("sorts lockfiles, generated files, pure renames and binary files as mechanical", () => {
		expect(categorize({ filename: "web/pnpm-lock.yaml", status: "modified", additions: 1, deletions: 1, patch: "x" }).reason).toBe("lockfile");
		expect(categorize({ filename: "dist/app.js", status: "modified", additions: 1, deletions: 1, patch: "x" }).category).toBe("mechanical");
		expect(categorize({ filename: "src/api.generated.ts", status: "modified", additions: 1, deletions: 1, patch: "x" }).category).toBe("mechanical");
		expect(categorize({ filename: "src/__snapshots__/a.test.ts.snap", status: "modified", additions: 1, deletions: 1, patch: "x" }).category).toBe("mechanical");
		expect(categorize({ filename: "src/a.ts", status: "renamed", additions: 0, deletions: 0 }).reason).toBe("rename without content change");
		expect(categorize({ filename: "src/a.ts", status: "renamed", additions: 2, deletions: 1, patch: "x" }).category).toBe("core");
		expect(categorize({ filename: "big.json", status: "modified", additions: 9000, deletions: 0 }).reason).toContain("no text patch");
		expect(categorize({ filename: "src/builder.ts", status: "modified", additions: 1, deletions: 0, patch: "x" }).category).toBe("core");
	});

	test("keeps the upstream key scheme and makes colliding keys unique", () => {
		expect(diffKeys(["src/a-b.ts", "src/a_b.ts", "src/a.b.ts"])).toEqual(["src_a_b_ts", "src_a_b_ts_2", "src_a_b_ts_3"]);
	});
});

describe("fetch", () => {
	test("reads every page, writes pr.json and patches.json, and lists core files first", async () => {
		const root = await tempRoot();
		const h = harness(root, githubResponses());
		const code = await run(["fetch", "https://github.com/acme/app/pull/7"], h.deps);
		expect(h.err).toEqual([]);
		expect(code).toBe(0);

		for (const call of h.calls.filter((c) => c[2]?.includes("/files") || c[2]?.includes("/comments"))) {
			expect(call).toContain("--paginate");
			expect(call).toContain("--slurp");
		}
		const summary = JSON.parse(h.out[0]);
		const dir = path.join(root, "pr-canvas", "acme-app-7");
		expect(summary.dir).toBe(dir);
		expect(summary.state).toBe("merged");
		expect(summary.reviewComments).toBe(2);
		expect(summary.counts).toEqual({ core: 2, mechanical: 3 });
		expect(summary.files.map((f: { filename: string }) => f.filename)).toEqual([
			"src/retry-client.ts",
			"src/retry_client.ts",
			"bun.lock",
			"src/old.ts",
			"assets/logo.png",
		]);
		expect(summary.files[1].diffKey).toBe("src_retry_client_ts_2");
		expect(summary.filesTruncated).toBe(false);

		const pr = JSON.parse(await readFile(path.join(dir, "pr.json"), "utf8"));
		expect(pr.comments[1]).toEqual({ user: "rev2", body: "page two", path: "src/old.ts", line: 9, url: "u2" });
		expect(pr.files.find((f: { filename: string }) => f.filename === "src/old.ts").previousFilename).toBe("src/older.ts");
		const patches = JSON.parse(await readFile(path.join(dir, "patches.json"), "utf8"));
		expect(patches.src_retry_client_ts).toContain("</script>");
		expect(patches.assets_logo_png).toBe("");
	});

	test("fails with exit 1 when gh fails, and exit 2 on a bad URL", async () => {
		const root = await tempRoot();
		const failing = harness(root, { ...githubResponses(), "gh api repos/acme/app/pulls/7": { code: 1, stdout: "", stderr: "HTTP 404" } });
		expect(await run(["fetch", "https://github.com/acme/app/pull/7"], failing.deps)).toBe(1);
		expect(failing.err[0]).toContain("HTTP 404");

		const usage = harness(root, {});
		expect(await run(["fetch", "not a url"], usage.deps)).toBe(2);
		expect(await run(["nope"], usage.deps)).toBe(2);
	});
});

describe("build", () => {
	async function canvas(root: string) {
		const dir = path.join(root, "skills", "pr-review-canvas");
		await mkdir(dir, { recursive: true });
		const upstream = path.join(import.meta.dir, "..", "..", "vendor", "cursor", "pr-review-canvas");
		for (const name of ["template.html", "styles.css", "renderer.js"]) {
			await writeFile(path.join(dir, name), await readFile(path.join(upstream, name), "utf8"));
		}
		return dir;
	}

	test("injects the parts once, keeps $ patterns literal, and escapes script-breaking text", () => {
		const html = assemble({
			template: "<style>/* INJECT_CSS */</style><script>/* INJECT_JS */</script><!-- INJECT_BODY --><script>{\"__PR_DIFFS_PLACEHOLDER__\":true}</script>",
			css: "a::after{content:\"$&\"}",
			js: "var s = '$1';",
			body: "<p>$'</p>",
			patches: { k: "+</script><img>&" },
		});
		expect(html).toContain('content:"$&"');
		expect(html).toContain("var s = '$1';");
		expect(html).toContain("<p>$'</p>");
		expect(html).toContain('{"k":"+\\u003c/script\\u003e\\u003cimg\\u003e\\u0026"}');
		expect(html.match(/<\/script>/g)?.length).toBe(2);
	});

	test("writes review.html from the sibling canvas skill and reports unused diffs", async () => {
		const root = await tempRoot();
		await canvas(root);
		const fetchDir = path.join(root, "out");
		await mkdir(fetchDir);
		await writeFile(path.join(fetchDir, "patches.json"), JSON.stringify({ a_ts: "@@\n+</script>", b_ts: "@@" }));
		await writeFile(path.join(fetchDir, "body.html"), '<h1>PR</h1><div data-diff="a_ts"></div>');
		const h = harness(root, {});
		expect(await run(["build", fetchDir], h.deps)).toBe(0);
		const result = JSON.parse(h.out[0]);
		expect(result).toMatchObject({ html: path.join(fetchDir, "review.html"), diffsRendered: 1, diffsNotShown: ["b_ts"] });
		const html = await readFile(result.html, "utf8");
		expect(html).toContain("<h1>PR</h1>");
		expect(html).toContain("function renderDiff");
		expect(html).not.toContain("INJECT_");
		expect(html).not.toContain("__PR_DIFFS_PLACEHOLDER__");
	});

	test("fails when the body names a diff key that fetch did not write", async () => {
		const root = await tempRoot();
		await canvas(root);
		const fetchDir = path.join(root, "out");
		await mkdir(fetchDir);
		await writeFile(path.join(fetchDir, "patches.json"), JSON.stringify({ a_ts: "@@" }));
		await writeFile(path.join(fetchDir, "body.html"), '<div data-diff="a.ts"></div>');
		const h = harness(root, {});
		expect(await run(["build", fetchDir], h.deps)).toBe(1);
		expect(h.err[0]).toContain("a.ts");
	});
});

describe("serve", () => {
	const tailscale = {
		"tailscale ip -4": { code: 0, stdout: "100.64.0.9\n", stderr: "" },
		"tailscale status --json": ok({ Self: { DNSName: "box.tailnet.ts.net." } }),
		kill: { code: 0, stdout: "", stderr: "" },
	};

	test("binds the Tailscale address, skips busy ports, and checks the page before it returns", async () => {
		const root = await tempRoot();
		const file = path.join(root, "review.html");
		await writeFile(file, "<p>hi</p>");
		const checked: string[] = [];
		const h = harness(root, tailscale, {
			portIsFree: async (host, port) => host === "100.64.0.9" && port === 8433,
			fetch: async (url) => {
				checked.push(url);
				return { status: checked.length < 3 ? 503 : 200 };
			},
		});
		expect(await run(["serve", file, "--ttl", "30"], h.deps)).toBe(0);
		const result = JSON.parse(h.out[0]);
		expect(result).toMatchObject({
			url: "http://box.tailnet.ts.net:8433/review.html",
			ipUrl: "http://100.64.0.9:8433/review.html",
			pid: 4242,
			port: 8433,
			expiresAt: "2026-11-19T00:30:00.000Z",
			stopCommand: "kill 4242",
		});
		expect(checked.every((url) => url === "http://100.64.0.9:8433/review.html")).toBe(true);
		expect(h.spawned[0].slice(-4)).toEqual([file, "100.64.0.9", "8433", "1800000"]);
	});

	test("stops the child and fails when the page never answers", async () => {
		const root = await tempRoot();
		const file = path.join(root, "review.html");
		await writeFile(file, "x");
		const h = harness(root, tailscale, { fetch: async () => { throw new Error("refused"); } });
		expect(await run(["serve", file], h.deps)).toBe(1);
		expect(h.calls.at(-1)).toEqual(["kill", "4242"]);
	});

	test("fails without a Tailscale address and rejects a bad ttl", async () => {
		const root = await tempRoot();
		const file = path.join(root, "review.html");
		await writeFile(file, "x");
		const down = harness(root, { "tailscale ip -4": { code: 1, stdout: "", stderr: "not running" } });
		expect(await run(["serve", file], down.deps)).toBe(1);
		expect(down.spawned).toEqual([]);
		expect(await run(["serve", file, "--ttl", "0"], down.deps)).toBe(2);
	});
});
