// review-prep: deterministic preparation for the code-review skill.
//   review-prep <fixed-point> [--out <dir>]
// Pins the fixed point, lists commits and issue references, ranks candidate spec files, and saves
// each standards document as it exists at the merge-base. Run it inside the repository under review.
// Exit codes: 0 success, 1 failure (bad ref, empty diff, git error), 2 usage error. JSON on stdout.

import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

export type CommandResult = { code: number; stdout: string; stderr: string };

export type Deps = {
	exec(command: string[], cwd: string): Promise<CommandResult>;
	cwd: string;
	tmpRoot: string;
	stdout(text: string): void;
	stderr(text: string): void;
};

class UsageError extends Error {}

const USAGE = `Usage: bun review-prep.ts <fixed-point> [--out <dir>]
Run inside the repository under review. <fixed-point> is a commit, branch, tag, or expression such as HEAD~5.
Writes prep.json and standards/<path> snapshots (as of the merge-base) to --out or a new temp directory.
Exit codes: 0 success, 1 failure (bad ref, empty diff, git error), 2 usage error.`;

const LIST_LIMIT = 50;
const SPEC_LIMIT = 15;

// ---------- issue references ----------

export type IssueRef = { ref: string; kind: "issue" | "pull" | "merge-request" | "number"; closing: boolean; sources: string[] };

const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s*$/i;

export function findIssueRefs(texts: { source: string; text: string }[]): IssueRef[] {
	const refs = new Map<string, IssueRef>();
	const add = (ref: string, kind: IssueRef["kind"], closing: boolean, source: string) => {
		const entry = refs.get(ref) ?? { ref, kind, closing: false, sources: [] };
		entry.closing ||= closing;
		if (!entry.sources.includes(source)) entry.sources.push(source);
		refs.set(ref, entry);
	};
	for (const { source, text } of texts) {
		const withoutUrls = text.replace(/https?:\/\/[^\s/]+\/([\w.-]+)\/([\w.-]+)\/(?:-\/)?(issues|pull|merge_requests)\/(\d+)\S*/g, (match, owner, repo, type, number, offset) => {
			const kind = type === "issues" ? "issue" : type === "pull" ? "pull" : "merge-request";
			const sep = type === "merge_requests" ? "!" : "#";
			add(`${owner}/${repo}${sep}${number}`, kind, CLOSING.test(text.slice(0, offset)), source);
			return " ".repeat(match.length);
		});
		for (const match of withoutUrls.matchAll(/(^|[^\w&/])((?:[\w.-]+\/[\w.-]+)?)#(\d+)\b/g)) {
			const start = (match.index ?? 0) + match[1].length;
			add(`${match[2]}#${match[3]}`, "issue", CLOSING.test(withoutUrls.slice(0, start)), source);
		}
		for (const match of withoutUrls.matchAll(/(^|\s)!(\d+)\b/g)) {
			const start = (match.index ?? 0) + match[1].length;
			add(`!${match[2]}`, "merge-request", CLOSING.test(withoutUrls.slice(0, start)), source);
		}
	}
	return [...refs.values()];
}

export function branchNumbers(branch: string): string[] {
	return [...branch.matchAll(/(?:^|[/_-])(\d+)(?=[/_-]|$)/g)].map((m) => m[1]);
}

// ---------- spec candidates ----------

const SPEC_DIRECTORIES = ["docs", "doc", "specs", "spec", ".scratch"];
const SPEC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git"]);
const STOP_WORDS = new Set([
	"feat", "feature", "fix", "bugfix", "hotfix", "chore", "refactor", "docs", "test", "tests", "wip", "main", "master",
	"dev", "develop", "release", "the", "and", "for", "add", "update", "head",
]);

export function branchTokens(branch: string): string[] {
	return [...new Set(branch.toLowerCase().split(/[^a-z0-9]+/))].filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOP_WORDS.has(t));
}

async function walk(root: string, relative: string, found: string[], limit: number): Promise<void> {
	if (found.length >= limit) return;
	let entries;
	try {
		entries = await readdir(path.join(root, relative), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const child = path.posix.join(relative, entry.name);
		if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) await walk(root, child, found, limit);
		else if (entry.isFile() && SPEC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(child);
		if (found.length >= limit) return;
	}
}

export type SpecCandidate = { path: string; score: number; reasons: string[] };

export function rankSpecs(files: string[], branch: string, numbers: string[], changed: Set<string>): SpecCandidate[] {
	const tokens = branchTokens(branch);
	return files
		.map((file) => {
			const lower = file.toLowerCase();
			const reasons: string[] = [];
			let score = 0;
			const hits = tokens.filter((token) => lower.includes(token));
			if (hits.length) {
				score += 2 * hits.length;
				reasons.push(`branch words: ${hits.join(", ")}`);
			}
			const numberHits = numbers.filter((n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(path.posix.basename(file)));
			if (numberHits.length) {
				score += 3;
				reasons.push(`issue number: ${numberHits.join(", ")}`);
			}
			if (changed.has(file)) {
				score += 3;
				reasons.push("added or changed in the diff");
			}
			return { path: file, score, reasons };
		})
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

// ---------- standards sources ----------

const STANDARDS_NAMES = new Map<string, string>([
	["coding_standards.md", "coding standards"],
	["coding-standards.md", "coding standards"],
	["contributing.md", "contributing guide"],
	["agents.md", "agent instructions"],
	["claude.md", "agent instructions"],
	["gemini.md", "agent instructions"],
	["copilot-instructions.md", "agent instructions"],
	[".cursorrules", "agent instructions"],
	[".windsurfrules", "agent instructions"],
	["styleguide.md", "style guide"],
	["style-guide.md", "style guide"],
	["style_guide.md", "style guide"],
	["conventions.md", "conventions"],
	["standards.md", "standards"],
	["guidelines.md", "guidelines"],
	["glossary.md", "glossary"],
	["glossary-map.md", "glossary"],
]);
const STANDARDS_EXCLUDED = /(^|\/)(node_modules|vendor|third_party)\//;

export function standardsReason(file: string): string | null {
	if (STANDARDS_EXCLUDED.test(file)) return null;
	const base = path.posix.basename(file).toLowerCase();
	const named = STANDARDS_NAMES.get(base);
	if (named) return named;
	if (/(^|\/)\.cursor\/rules\//.test(file)) return "agent instructions";
	if (/(^|\/)\.github\/instructions\/.+\.instructions\.md$/.test(file)) return "agent instructions";
	if (/\.(md|mdx)$/i.test(base)) {
		if (/(^|\/)(adr|adrs|decisions)\//i.test(file)) return "architecture decision record";
		if (/(^|\/)docs?\//i.test(file) && /(standard|convention|guideline|style-?guide|coding)/i.test(base)) return "standards document";
	}
	return null;
}

// A named instruction file below the root (for example app/server/AGENTS.md) governs only its own
// directory. Files under docs/ and .github/, ADRs and Cursor rules apply to the whole repository.
export function standardsScope(file: string): string {
	const directory = path.posix.dirname(file);
	if (directory === ".") return "";
	if (!STANDARDS_NAMES.has(path.posix.basename(file).toLowerCase())) return "";
	if (/^(docs?|\.github)(\/|$)/i.test(directory)) return "";
	return `${directory}/`;
}

// ---------- main ----------

async function git(deps: Deps, args: string[], failure: string): Promise<string> {
	const result = await deps.exec(["git", ...args], deps.cwd);
	if (result.code !== 0) throw new Error(`${failure}${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`);
	return result.stdout;
}

function nulList(text: string): string[] {
	return text.split("\0").filter(Boolean);
}

async function prepare(args: string[], deps: Deps): Promise<unknown> {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { out: { type: "string" } } });
	if (positionals.length !== 1) throw new UsageError("Supply exactly one fixed point.");
	const fixedPoint = positionals[0];
	if (fixedPoint.startsWith("-")) throw new UsageError(`Fixed point "${fixedPoint}" looks like an option.`);

	const root = (await git(deps, ["rev-parse", "--show-toplevel"], "Not inside a git repository")).trim();
	const run = (gitArgs: string[], failure: string) => git({ ...deps, cwd: root }, gitArgs, failure);
	const resolved = await deps.exec(["git", "rev-parse", "--verify", "--quiet", `${fixedPoint}^{commit}`], root);
	if (resolved.code !== 0) throw new Error(`Fixed point "${fixedPoint}" does not resolve to a commit.`);
	const fixedSha = resolved.stdout.trim();
	const headSha = (await run(["rev-parse", "HEAD"], "HEAD does not resolve")).trim();
	const mergeBase = (await run(["merge-base", fixedSha, headSha], `"${fixedPoint}" and HEAD have no common ancestor`)).trim();

	const nameStatus = nulList(await run(["diff", "--name-status", "-z", "-M", mergeBase, headSha], "git diff failed"));
	const changedFiles: { status: string; path: string; previousPath?: string }[] = [];
	for (let i = 0; i < nameStatus.length; ) {
		const status = nameStatus[i++];
		if (/^[RC]/.test(status)) {
			const previousPath = nameStatus[i++];
			changedFiles.push({ status: status[0], path: nameStatus[i++], previousPath });
		} else changedFiles.push({ status, path: nameStatus[i++] });
	}
	if (changedFiles.length === 0) {
		throw new Error(`The diff ${fixedPoint}...HEAD is empty: HEAD adds nothing since the merge-base ${mergeBase.slice(0, 12)}.`);
	}
	const changed = new Set(changedFiles.map((file) => file.path));
	const shortstat = (await run(["diff", "--shortstat", mergeBase, headSha], "git diff failed")).trim();

	const log = await run(["log", "--format=%H%x1f%s%x1f%b%x1e", `${fixedSha}..${headSha}`], "git log failed");
	const commits = log
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [sha, subject, body = ""] = record.split("\x1f");
			return { sha, subject, body: body.trim() };
		});
	const branchResult = await deps.exec(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], root);
	const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
	const status = await deps.exec(["git", "status", "--porcelain", "--untracked-files=no"], root);
	const uncommittedFiles = status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : null;

	const issueRefs = findIssueRefs(commits.map((c) => ({ source: c.sha.slice(0, 12), text: `${c.subject}\n${c.body}` })));
	const numbers = new Set(issueRefs.map((r) => r.ref.split(/[#!]/).pop() as string));
	for (const number of branch ? branchNumbers(branch) : []) {
		numbers.add(number);
		if (!issueRefs.some((r) => r.ref === `#${number}`)) issueRefs.push({ ref: `#${number}`, kind: "number", closing: false, sources: ["branch name"] });
	}

	const specFiles: string[] = [];
	for (const directory of SPEC_DIRECTORIES) await walk(root, directory, specFiles, 2000);
	const specCandidates = rankSpecs(specFiles, branch ?? "", [...numbers], changed);

	const out = values.out ? path.resolve(values.out) : await mkdtemp(path.join(deps.tmpRoot, "code-review-prep-"));
	await mkdir(out, { recursive: true, mode: 0o700 });
	const baseEntries = nulList(await run(["ls-tree", "-r", "-z", mergeBase], "git ls-tree failed")).map((line) => {
		const [meta, file] = line.split("\t");
		return { mode: meta.split(" ")[0], file };
	});
	const baseFiles = baseEntries.map((entry) => entry.file);
	const standards = [];
	const standardsOutOfScope: string[] = [];
	for (const { mode, file } of baseEntries) {
		const reason = standardsReason(file);
		if (!reason || mode === "160000") continue;
		const scope = standardsScope(file);
		if (scope && ![...changed].some((changedPath) => changedPath.startsWith(scope))) {
			standardsOutOfScope.push(file);
			continue;
		}
		const content = await run(["show", `${mergeBase}:${file}`], `git show ${file} failed`);
		if (mode === "120000") {
			standards.push({ path: file, symlinkTo: content.trim(), reason, scope: scope || "repository", changedInDiff: changed.has(file) });
			continue;
		}
		const snapshot = path.join(out, "standards", file);
		await mkdir(path.dirname(snapshot), { recursive: true });
		await writeFile(snapshot, content);
		standards.push({ path: file, snapshot, reason, scope: scope || "repository", changedInDiff: changed.has(file) });
	}
	const baseSet = new Set(baseFiles);
	const standardsAddedInDiff = changedFiles
		.filter((file) => file.status !== "D" && !baseSet.has(file.path) && standardsReason(file.path))
		.map((file) => file.path);

	const result = {
		repository: root,
		fixedPoint,
		fixedPointSha: fixedSha,
		head: headSha,
		mergeBase,
		branch,
		diffCommand: `git diff ${fixedSha}...${headSha}`,
		diffStat: shortstat,
		uncommittedFiles,
		changedFiles,
		commits: commits.map(({ sha, subject }) => ({ sha, subject })),
		issueRefs,
		specCandidates,
		standards,
		standardsAddedInDiff,
		standardsOutOfScope,
	};
	const prepJson = path.join(out, "prep.json");
	await writeFile(prepJson, `${JSON.stringify(result, null, 2)}\n`);

	const cap = <T>(list: T[], limit: number) => ({ shown: list.slice(0, limit), omitted: Math.max(0, list.length - limit) });
	const changedCap = cap(changedFiles, LIST_LIMIT);
	const commitCap = cap(result.commits, LIST_LIMIT);
	const specCap = cap(specCandidates, SPEC_LIMIT);
	const standardsCap = cap(standards, LIST_LIMIT);
	return {
		prepJson,
		...result,
		changedFiles: changedCap.shown,
		omittedChangedFiles: changedCap.omitted,
		commits: commitCap.shown,
		omittedCommits: commitCap.omitted,
		specCandidates: specCap.shown,
		omittedSpecCandidates: specCap.omitted,
		standards: standardsCap.shown,
		omittedStandards: standardsCap.omitted,
		standardsOutOfScope: standardsOutOfScope.length,
	};
}

export async function run(argv: string[], deps: Deps): Promise<number> {
	if (argv[0] === "--help" || argv[0] === "-h") {
		deps.stdout(USAGE);
		return 0;
	}
	try {
		deps.stdout(JSON.stringify(await prepare(argv, deps), null, 2));
		return 0;
	} catch (error) {
		const isUsage = error instanceof UsageError || String((error as { code?: unknown })?.code ?? "").startsWith("ERR_PARSE_ARGS");
		deps.stderr(`${error instanceof Error ? error.message : String(error)}${isUsage ? `\n\n${USAGE}` : ""}`);
		return isUsage ? 2 : 1;
	}
}

export const realDeps: Deps = {
	async exec(command, cwd) {
		const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	},
	cwd: process.cwd(),
	tmpRoot: tmpdir(),
	stdout: (text) => console.log(text),
	stderr: (text) => console.error(text),
};

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2), realDeps);
