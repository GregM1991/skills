// pr-canvas: deterministic steps for the pr-review-canvas skill.
//   fetch <pr-url>      read the PR, its files and review comments; sort files into core and mechanical
//   build <dir>         assemble <dir>/body.html with the canvas template into <dir>/review.html
//   serve <html-file>   serve one file on this machine's Tailscale address, with a time limit
// Exit codes: 0 success, 1 failure, 2 usage error. Results print as JSON on stdout.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

export type CommandResult = { code: number; stdout: string; stderr: string };

export type Deps = {
	exec(command: string[]): Promise<CommandResult>;
	spawnDetached(command: string[]): number;
	fetch(url: string): Promise<{ status: number }>;
	portIsFree(host: string, port: number): Promise<boolean>;
	sleep(ms: number): Promise<void>;
	now(): Date;
	tmpRoot: string;
	scriptPath: string;
	stdout(text: string): void;
	stderr(text: string): void;
};

export class UsageError extends Error {}

const USAGE = `Usage:
  bun pr-canvas.ts fetch <pr-url> [--out <dir>]
  bun pr-canvas.ts build <dir> [--body <file>] [--canvas <pr-review-canvas dir>] [--out <file>]
  bun pr-canvas.ts serve <html-file> [--ttl <minutes>] [--port <first port>]
fetch writes <dir>/pr.json and <dir>/patches.json. build writes <dir>/review.html by default.
serve binds to the Tailscale IPv4 address only, checks the page through it, and stops after --ttl minutes (default 240).
Exit codes: 0 success, 1 failure, 2 usage error.`;

// ---------- fetch ----------

export type PrRef = { host: string; owner: string; repo: string; number: number };

export function parsePrUrl(input: string): PrRef {
	const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(input);
	if (short) return { host: "github.com", owner: short[1], repo: short[2], number: Number(short[3]) };
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new UsageError(`Not a pull request URL: "${input}".`);
	}
	const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
	if (!match) throw new UsageError(`Not a pull request URL: "${input}".`);
	return { host: url.hostname, owner: match[1], repo: match[2], number: Number(match[3]) };
}

type ApiFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes?: number;
	patch?: string;
	previous_filename?: string;
};

export type FileEntry = {
	filename: string;
	previousFilename?: string;
	status: string;
	additions: number;
	deletions: number;
	category: "core" | "mechanical";
	reason: string;
	diffKey: string;
	patchMissing: boolean;
};

const LOCKFILES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"deno.lock",
	"cargo.lock",
	"gemfile.lock",
	"poetry.lock",
	"pipfile.lock",
	"uv.lock",
	"pdm.lock",
	"composer.lock",
	"go.sum",
	"flake.lock",
	"podfile.lock",
	"package.resolved",
	"packages.lock.json",
	"mix.lock",
	"pubspec.lock",
	"gradle.lockfile",
]);

const GENERATED_DIRECTORY = /(^|\/)(dist|build|out|vendor|node_modules|__generated__|generated|__snapshots__)\//;
const GENERATED_FILE =
	/(\.min\.(js|css)|\.map|\.snap|\.pb\.go|_pb2(_grpc)?\.pyi?|\.pb\.(cc|h)|\.g\.dart|\.freezed\.dart|\.designer\.cs)$|\.generated\.[^/]+$|\.gen\.[^/]+$/;

export function categorize(file: ApiFile): { category: "core" | "mechanical"; reason: string } {
	const base = path.posix.basename(file.filename).toLowerCase();
	if (LOCKFILES.has(base)) return { category: "mechanical", reason: "lockfile" };
	if (GENERATED_DIRECTORY.test(file.filename)) return { category: "mechanical", reason: "generated or vendored directory" };
	if (GENERATED_FILE.test(base)) return { category: "mechanical", reason: "generated file name" };
	if (file.status === "renamed" && file.additions === 0 && file.deletions === 0) {
		return { category: "mechanical", reason: "rename without content change" };
	}
	if (file.patch === undefined) {
		return { category: "mechanical", reason: "no text patch (binary or too large)" };
	}
	return { category: "core", reason: "no mechanical rule matched" };
}

export function diffKeys(filenames: string[]): string[] {
	const used = new Set<string>();
	return filenames.map((name) => {
		const base = name.replace(/[^a-zA-Z0-9]/g, "_");
		let key = base;
		for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
		used.add(key);
		return key;
	});
}

async function gh(deps: Deps, ref: PrRef, args: string[]): Promise<unknown> {
	const host = ref.host === "github.com" ? [] : ["--hostname", ref.host];
	const result = await deps.exec(["gh", "api", ...host, ...args]);
	if (result.code !== 0) {
		throw new Error(`gh api ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}. Check gh authentication and repository access.`);
	}
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`gh api ${args[0]} returned invalid JSON.`);
	}
}

function pages<T>(value: unknown, context: string): T[] {
	if (!Array.isArray(value) || !value.every(Array.isArray)) throw new Error(`Unexpected ${context} response from GitHub.`);
	return (value as T[][]).flat();
}

const SUMMARY_FILE_LIMIT = 200;

async function fetchCommand(args: string[], deps: Deps): Promise<unknown> {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { out: { type: "string" } } });
	if (positionals.length !== 1) throw new UsageError("fetch needs exactly one pull request URL.");
	const ref = parsePrUrl(positionals[0]);
	const endpoint = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
	const [rawPr, rawFiles, rawComments] = await Promise.all([
		gh(deps, ref, [endpoint]),
		gh(deps, ref, [`${endpoint}/files?per_page=100`, "--paginate", "--slurp"]),
		gh(deps, ref, [`${endpoint}/comments?per_page=100`, "--paginate", "--slurp"]),
	]);
	const pr = rawPr as Record<string, any>;
	if (!pr || typeof pr !== "object" || typeof pr.number !== "number") throw new Error("Unexpected pull request response from GitHub.");
	const apiFiles = pages<ApiFile>(rawFiles, "files");
	const comments = pages<Record<string, any>>(rawComments, "comments").map((comment) => ({
		user: comment.user?.login ?? null,
		body: comment.body ?? "",
		path: comment.path ?? null,
		line: comment.line ?? comment.original_line ?? null,
		url: comment.html_url ?? null,
	}));

	const keys = diffKeys(apiFiles.map((file) => file.filename));
	const patches: Record<string, string> = {};
	const entries: FileEntry[] = apiFiles.map((file, index) => {
		patches[keys[index]] = file.patch ?? "";
		return {
			filename: file.filename,
			...(file.previous_filename ? { previousFilename: file.previous_filename } : {}),
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			...categorize(file),
			diffKey: keys[index],
			patchMissing: file.patch === undefined,
		};
	});
	const files = [...entries.filter((f) => f.category === "core"), ...entries.filter((f) => f.category === "mechanical")];

	const dir = values.out ? path.resolve(values.out) : path.join(deps.tmpRoot, "pr-canvas", `${ref.owner}-${ref.repo}-${ref.number}`);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const metadata = {
		url: pr.html_url,
		owner: ref.owner,
		repo: ref.repo,
		number: pr.number,
		title: pr.title,
		body: pr.body ?? "",
		author: pr.user?.login ?? null,
		state: pr.merged_at ? "merged" : pr.state,
		draft: Boolean(pr.draft),
		additions: pr.additions,
		deletions: pr.deletions,
		changedFiles: pr.changed_files,
		base: pr.base?.ref,
		head: pr.head?.ref,
		fetchedAt: deps.now().toISOString(),
		// GitHub's files endpoint stops at 3000 files.
		filesTruncated: typeof pr.changed_files === "number" && apiFiles.length < pr.changed_files,
		comments,
		files,
	};
	await writeFile(path.join(dir, "pr.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
	await writeFile(path.join(dir, "patches.json"), `${JSON.stringify(patches)}\n`, { mode: 0o600 });

	const { body, comments: _comments, files: _files, ...summary } = metadata;
	return {
		dir,
		prJson: path.join(dir, "pr.json"),
		patchesJson: path.join(dir, "patches.json"),
		bodyHtml: path.join(dir, "body.html"),
		...summary,
		bodyCharacters: body.length,
		reviewComments: comments.length,
		counts: {
			core: files.filter((f) => f.category === "core").length,
			mechanical: files.filter((f) => f.category === "mechanical").length,
		},
		files: files.slice(0, SUMMARY_FILE_LIMIT),
		omittedFiles: Math.max(0, files.length - SUMMARY_FILE_LIMIT),
	};
}

// ---------- build ----------

const MARKERS = {
	css: "/* INJECT_CSS */",
	js: "/* INJECT_JS */",
	body: "<!-- INJECT_BODY -->",
	diffs: '{"__PR_DIFFS_PLACEHOLDER__":true}',
} as const;

export function scriptSafeJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function replaceOnce(text: string, marker: string, value: string, context: string): string {
	const first = text.indexOf(marker);
	if (first === -1 || text.indexOf(marker, first + 1) !== -1) {
		throw new Error(`${context} must contain the marker ${marker} exactly once.`);
	}
	// Plain concatenation: String.replace would expand "$&" and similar patterns in CSS, JS or HTML.
	return text.slice(0, first) + value + text.slice(first + marker.length);
}

export function assemble(parts: { template: string; css: string; js: string; body: string; patches: Record<string, string> }): string {
	let html = replaceOnce(parts.template, MARKERS.diffs, scriptSafeJson(parts.patches), "template.html");
	html = replaceOnce(html, MARKERS.body, parts.body, "template.html");
	html = replaceOnce(html, MARKERS.js, parts.js, "template.html");
	return replaceOnce(html, MARKERS.css, parts.css, "template.html");
}

export function diffKeysInBody(body: string): string[] {
	return [...new Set([...body.matchAll(/data-diff\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]))];
}

export function canvasCandidates(scriptPath: string): string[] {
	const skillsDir = path.resolve(path.dirname(scriptPath), "..", "..");
	return [path.join(skillsDir, "pr-review-canvas"), path.join(skillsDir, "vendor", "cursor", "pr-review-canvas")];
}

async function buildCommand(args: string[], deps: Deps): Promise<unknown> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		strict: true,
		options: { body: { type: "string" }, canvas: { type: "string" }, out: { type: "string" } },
	});
	if (positionals.length !== 1) throw new UsageError("build needs exactly one fetch directory.");
	const dir = path.resolve(positionals[0]);
	const bodyPath = path.resolve(values.body ?? path.join(dir, "body.html"));
	const outPath = path.resolve(values.out ?? path.join(dir, "review.html"));
	const candidates = values.canvas ? [path.resolve(values.canvas)] : canvasCandidates(deps.scriptPath);
	const canvas = candidates.find((candidate) => existsSync(path.join(candidate, "template.html")));
	if (!canvas) throw new Error(`pr-review-canvas template not found. Looked in: ${candidates.join(", ")}. Pass --canvas.`);

	const read = async (file: string, what: string) => {
		try {
			return await readFile(file, "utf8");
		} catch {
			throw new Error(`Cannot read ${what} at ${file}.`);
		}
	};
	const [template, css, js, body, patchesText] = await Promise.all([
		read(path.join(canvas, "template.html"), "template.html"),
		read(path.join(canvas, "styles.css"), "styles.css"),
		read(path.join(canvas, "renderer.js"), "renderer.js"),
		read(bodyPath, "body HTML"),
		read(path.join(dir, "patches.json"), "patches.json (run fetch first)"),
	]);
	const patches = JSON.parse(patchesText) as Record<string, string>;
	const used = diffKeysInBody(body);
	const unknown = used.filter((key) => !Object.prototype.hasOwnProperty.call(patches, key));
	if (unknown.length) {
		throw new Error(`body HTML uses data-diff keys that are not in patches.json: ${unknown.join(", ")}. Use the diffKey values from pr.json.`);
	}
	await writeFile(outPath, assemble({ template, css, js, body, patches }), { mode: 0o600 });
	return {
		html: outPath,
		canvas,
		diffsRendered: used.length,
		diffsNotShown: Object.keys(patches).filter((key) => !used.includes(key)),
	};
}

// ---------- serve ----------

async function tailscaleAddress(deps: Deps): Promise<{ ip: string; dnsName: string | null }> {
	const ipResult = await deps.exec(["tailscale", "ip", "-4"]);
	const ip = ipResult.stdout.trim().split(/\s+/)[0];
	if (ipResult.code !== 0 || !/^100\.\d+\.\d+\.\d+$/.test(ip ?? "")) {
		throw new Error("No Tailscale IPv4 address. Check that Tailscale is up (tailscale status).");
	}
	let dnsName: string | null = null;
	const status = await deps.exec(["tailscale", "status", "--json", "--peers=false"]);
	if (status.code === 0) {
		try {
			const name = JSON.parse(status.stdout)?.Self?.DNSName;
			if (typeof name === "string" && name) dnsName = name.replace(/\.$/, "");
		} catch {
			// The IP URL still works without MagicDNS.
		}
	}
	return { ip, dnsName };
}

const DEFAULT_PORT = 8432;
const PORT_ATTEMPTS = 20;

async function serveCommand(args: string[], deps: Deps): Promise<unknown> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		strict: true,
		options: { ttl: { type: "string", default: "240" }, port: { type: "string" } },
	});
	if (positionals.length !== 1) throw new UsageError("serve needs exactly one HTML file.");
	const ttlMinutes = Number(values.ttl);
	if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 24 * 60) throw new UsageError("--ttl must be 1 to 1440 minutes.");
	const firstPort = values.port === undefined ? DEFAULT_PORT : Number(values.port);
	if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65535) throw new UsageError("--port must be 1024 to 65535.");
	const file = path.resolve(positionals[0]);
	if (!existsSync(file)) throw new Error(`File not found: ${file}.`);

	const { ip, dnsName } = await tailscaleAddress(deps);
	let port: number | undefined;
	for (let candidate = firstPort; candidate < firstPort + PORT_ATTEMPTS && candidate <= 65535; candidate++) {
		if (await deps.portIsFree(ip, candidate)) {
			port = candidate;
			break;
		}
	}
	if (port === undefined) throw new Error(`No free port on ${ip} from ${firstPort} to ${firstPort + PORT_ATTEMPTS - 1}.`);

	const ttlMs = ttlMinutes * 60_000;
	const pid = deps.spawnDetached([process.execPath, deps.scriptPath, "_serve-child", file, ip, String(port), String(ttlMs)]);
	const urlPath = `/${encodeURIComponent(path.basename(file))}`;
	const ipUrl = `http://${ip}:${port}${urlPath}`;
	let ready = false;
	for (let attempt = 0; attempt < 50 && !ready; attempt++) {
		try {
			ready = (await deps.fetch(ipUrl)).status === 200;
		} catch {
			// The child is still starting.
		}
		if (!ready) await deps.sleep(100);
	}
	if (!ready) {
		await deps.exec(["kill", String(pid)]);
		throw new Error(`The server did not answer at ${ipUrl}. It was stopped.`);
	}
	return {
		url: dnsName ? `http://${dnsName}:${port}${urlPath}` : ipUrl,
		ipUrl,
		checkedUrl: ipUrl,
		pid,
		port,
		expiresAt: new Date(deps.now().getTime() + ttlMs).toISOString(),
		expiresAtLocal: new Date(deps.now().getTime() + ttlMs).toLocaleString(),
		stopCommand: `kill ${pid}`,
		access: "Tailscale address only (tailnet-private)",
	};
}

// The detached child: serve one file until the time limit.
async function serveChild(args: string[]): Promise<void> {
	const [file, host, port, ttlMs] = args;
	const name = `/${encodeURIComponent(path.basename(file))}`;
	Bun.serve({
		hostname: host,
		port: Number(port),
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname !== "/" && pathname !== name) return new Response("Not found\n", { status: 404 });
			return new Response(Bun.file(file), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		},
	});
	setTimeout(() => process.exit(0), Number(ttlMs));
}

// ---------- entry ----------

export async function run(argv: string[], deps: Deps): Promise<number> {
	const [command, ...rest] = argv;
	try {
		let result: unknown;
		if (command === "fetch") result = await fetchCommand(rest, deps);
		else if (command === "build") result = await buildCommand(rest, deps);
		else if (command === "serve") result = await serveCommand(rest, deps);
		else if (command === "--help" || command === "-h" || command === "help") {
			deps.stdout(USAGE);
			return 0;
		} else throw new UsageError(command ? `Unknown command "${command}".` : "Missing command.");
		deps.stdout(JSON.stringify(result, null, 2));
		return 0;
	} catch (error) {
		const isUsage = error instanceof UsageError || (error as { code?: string })?.code?.startsWith?.("ERR_PARSE_ARGS");
		deps.stderr(`${error instanceof Error ? error.message : String(error)}${isUsage ? `\n\n${USAGE}` : ""}`);
		return isUsage ? 2 : 1;
	}
}

export const realDeps: Deps = {
	async exec(command) {
		const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	},
	spawnDetached(command) {
		const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" });
		child.unref();
		if (child.pid === undefined) throw new Error("Could not start the server process.");
		return child.pid;
	},
	fetch: (url) => fetch(url, { signal: AbortSignal.timeout(2000) }),
	async portIsFree(host, port) {
		try {
			const server = Bun.serve({ hostname: host, port, fetch: () => new Response("") });
			server.stop(true);
			return true;
		} catch {
			return false;
		}
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => new Date(),
	tmpRoot: tmpdir(),
	scriptPath: import.meta.path,
	stdout: (text) => console.log(text),
	stderr: (text) => console.error(text),
};

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	if (argv[0] === "_serve-child") await serveChild(argv.slice(1));
	else process.exitCode = await run(argv, realDeps);
}
