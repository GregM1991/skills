#!/usr/bin/env bun
// anki: the deterministic half of the anki-connect skill.
// It builds AnkiConnect requests, checks every `error`, counts scope before a change,
// sends a change as one `multi` batch, and verifies the change by reading it back.
// The agent keeps the judgment: the confirmation wording and the card content.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

export type AnkiRequest = { action: string; version: number; params?: Record<string, unknown> };
/** Sends one request and returns the parsed JSON response. Tests pass a fake. */
export type Post = (request: AnkiRequest) => Promise<unknown>;

export const DEFAULT_URL = "http://127.0.0.1:8765";
export const API_VERSION = 6;

export function httpPost(url: string): Post {
	return async (request) => {
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(60_000),
			});
		} catch {
			throw new ToolError(`AnkiConnect is not reachable at ${url}. Start Anki with the AnkiConnect add-on, then try again.`);
		}
		try {
			return await response.json();
		} catch {
			throw new ToolError(`AnkiConnect at ${url} sent a response that is not JSON (HTTP ${response.status}).`);
		}
	};
}

/** Exit 1: error. Exit 2: refused, confirmation missing. Exit 3: the change did not verify. */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly exitCode: 1 | 2 | 3 = 1,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

// Actions that only read. Every other action, including unknown ones, needs --confirmed.
export const READ_ONLY_ACTIONS = new Set([
	"requestPermission", "version", "apiReflect", "getProfiles", "getActiveProfile",
	"deckNames", "deckNamesAndIds", "getDecks", "getDeckConfig", "getDeckStats",
	"findNotes", "notesInfo", "notesModTime", "getNoteTags", "getTags", "canAddNotes", "canAddNotesWithErrorDetail",
	"findCards", "cardsInfo", "cardsModTime", "cardsToNotes", "getEaseFactors", "suspended", "areSuspended", "areDue", "getIntervals",
	"modelNames", "modelNamesAndIds", "findModelsById", "findModelsByName", "modelFieldNames", "modelFieldDescriptions",
	"modelFieldFonts", "modelFieldsOnTemplates", "modelTemplates", "modelStyling",
	"retrieveMediaFile", "getMediaFilesNames", "getMediaDirPath",
	"getNumCardsReviewedToday", "getNumCardsReviewedByDay", "getCollectionStatsHTML", "cardReviews", "getReviewsOfCards", "getLatestReviewID",
	"guiCurrentCard", "guiSelectedNotes",
]);

type Action = { action: string; params?: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWrite(action: Action): boolean {
	if (action.action === "multi") {
		const actions = action.params?.actions;
		return !Array.isArray(actions) || actions.some((inner) => !isObject(inner) || isWrite(inner as Action));
	}
	return !READ_ONLY_ACTIONS.has(action.action);
}

/** Sends one action and returns `result`. Throws when the response carries an `error`. */
export async function invoke(post: Post, action: string, params?: Record<string, unknown>): Promise<unknown> {
	const request: AnkiRequest = { action, version: API_VERSION };
	if (params) request.params = params;
	const response = await post(request);
	if (!isObject(response) || !("error" in response) || !("result" in response)) {
		throw new ToolError(`AnkiConnect answered ${action} without result and error fields.`);
	}
	if (response.error !== null) throw new ToolError(`AnkiConnect ${action} failed: ${String(response.error)}`, 1, { action });
	return response.result;
}

/** Splits a `multi` result into one {result, error} per action. Version 6 wraps each item. */
function unwrapMulti(result: unknown, count: number): { result: unknown; error: string | null }[] {
	if (!Array.isArray(result) || result.length !== count) throw new ToolError(`multi returned ${Array.isArray(result) ? result.length : "no"} results for ${count} actions.`);
	return result.map((item) =>
		isObject(item) && "result" in item && "error" in item && Object.keys(item).length === 2
			? { result: item.result, error: item.error === null ? null : String(item.error) }
			: { result: item, error: null },
	);
}

// ---------- call ----------

export async function call(post: Post, action: string, params: Record<string, unknown> | undefined, flags: { confirmed: boolean; dryRun: boolean }) {
	const write = isWrite({ action, params });
	const request: AnkiRequest = { action, version: API_VERSION, ...(params ? { params } : {}) };
	if (flags.dryRun) return { dryRun: true, write, request };
	if (write && !flags.confirmed) {
		throw new ToolError(`${action} changes the collection. Ask the user once, then run again with --confirmed.`, 2, { request });
	}
	const result = await invoke(post, action, params);
	if (action === "multi") {
		const items = unwrapMulti(result, (params?.actions as unknown[]).length);
		const failed = items.map((item, index) => ({ index, error: item.error })).filter((item) => item.error);
		if (failed.length) throw new ToolError("One or more actions in multi failed.", 1, { results: items });
		return { action, result: items.map((item) => item.result) };
	}
	return { action, result };
}

// ---------- preview ----------

function truncate(text: unknown, limit: number): string {
	const value = String(text ?? "");
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

type NoteInfo = { noteId?: number; modelName?: string; tags?: string[]; fields?: Record<string, { value: string; order: number }>; cards?: number[] };

export async function preview(post: Post, query: string, sampleSize: number) {
	const noteIds = (await invoke(post, "findNotes", { query })) as number[];
	const cardIds = (await invoke(post, "findCards", { query })) as number[];
	const decks = cardIds.length ? ((await invoke(post, "getDecks", { cards: cardIds })) as Record<string, number[]>) : {};
	const sampleIds = noteIds.slice(0, sampleSize);
	const sample = sampleIds.length ? ((await invoke(post, "notesInfo", { notes: sampleIds })) as NoteInfo[]) : [];
	return {
		query,
		notes: noteIds.length,
		cards: cardIds.length,
		decks: Object.fromEntries(Object.entries(decks).map(([name, ids]) => [name, ids.length])),
		sample: sample.map((note) => ({
			noteId: note.noteId,
			model: note.modelName,
			tags: note.tags,
			fields: Object.fromEntries(Object.entries(note.fields ?? {}).map(([name, field]) => [name, truncate(field.value, 160)])),
		})),
		omittedFromSample: Math.max(0, noteIds.length - sample.length),
	};
}

// ---------- apply ----------

export function parsePlan(value: unknown): Action[] {
	const actions = Array.isArray(value) ? value : isObject(value) ? value.actions : undefined;
	if (!Array.isArray(actions) || actions.length === 0) throw new ToolError("The plan must be {\"actions\": [{\"action\": ..., \"params\": {...}}, ...]} with at least one action.");
	return actions.map((raw, index) => {
		if (!isObject(raw) || typeof raw.action !== "string" || (raw.params !== undefined && !isObject(raw.params))) {
			throw new ToolError(`Plan action ${index + 1} must be {"action": string, "params"?: object}.`);
		}
		if (raw.action === "multi") throw new ToolError(`Plan action ${index + 1} is multi. List its actions directly; apply sends one multi itself.`);
		return { action: raw.action, ...(raw.params ? { params: raw.params as Record<string, unknown> } : {}) };
	});
}

function ids(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : typeof value === "number" ? [value] : [];
}

function tagList(value: unknown): string[] {
	const list = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\s+/) : [];
	return list.filter(Boolean).map((tag) => tag.toLowerCase());
}

type NoteSpec = { fields?: Record<string, string>; tags?: string[]; deckName?: string };

/** One line per action that states what it changes. The agent words the confirmation from this. */
export function scope(actions: Action[]) {
	return actions.map(({ action, params = {} }) => {
		const notes = Array.isArray(params.notes) ? params.notes : undefined;
		const entry: Record<string, unknown> = { action };
		if (action === "addNotes" && notes) {
			entry.notes = notes.length;
			entry.decks = [...new Set(notes.map((note) => (isObject(note) ? note.deckName : undefined)).filter(Boolean))];
		} else if (action === "addNote" && isObject(params.note)) {
			entry.notes = 1;
			entry.decks = [params.note.deckName];
		} else if (isObject(params.note) && "id" in params.note) entry.notes = 1;
		else if (action === "updateNoteTags") entry.notes = 1;
		else if (notes) entry.notes = notes.length;
		if (Array.isArray(params.cards)) entry.cards = params.cards.length;
		if (typeof params.deck === "string") entry.deck = params.deck;
		if (params.tags !== undefined) entry.tags = params.tags;
		return entry;
	});
}

type Check =
	| { kind: "note"; noteId: number; source: string; fields?: Record<string, string>; tags?: string[]; deckName?: string; exactTags?: boolean }
	| { kind: "tags"; noteIds: number[]; source: string; present: string[]; absent: string[] }
	| { kind: "deleted"; noteIds: number[]; source: string }
	| { kind: "suspended"; cardIds: number[]; source: string; expected: boolean }
	| { kind: "deck"; cardIds: number[]; source: string; deck: string };

function checksFor(action: Action, result: unknown, index: number): Check[] | undefined {
	const params = action.params ?? {};
	const source = `${index + 1}:${action.action}`;
	const noteCheck = (noteId: unknown, spec: unknown, exactTags: boolean): Check[] => {
		if (typeof noteId !== "number") throw new ToolError(`${source} did not return a note id.`, 3);
		const note = (isObject(spec) ? spec : {}) as NoteSpec;
		return [{ kind: "note", noteId, source, fields: note.fields, tags: note.tags, deckName: note.deckName, exactTags }];
	};
	switch (action.action) {
		case "addNote":
			return noteCheck(result, params.note, false);
		case "addNotes": {
			const notes = Array.isArray(params.notes) ? params.notes : [];
			const added = Array.isArray(result) ? result : [];
			return notes.flatMap((note, i) => noteCheck(added[i], note, false));
		}
		case "updateNoteFields":
		case "updateNote": {
			const note = isObject(params.note) ? params.note : {};
			return noteCheck(note.id, { fields: note.fields, tags: note.tags }, true);
		}
		case "updateNoteTags":
			return noteCheck(params.note, { tags: tagList(params.tags) }, true);
		case "addTags":
			return [{ kind: "tags", noteIds: ids(params.notes), source, present: tagList(params.tags), absent: [] }];
		case "removeTags":
			return [{ kind: "tags", noteIds: ids(params.notes), source, present: [], absent: tagList(params.tags) }];
		case "deleteNotes":
			return [{ kind: "deleted", noteIds: ids(params.notes), source }];
		case "suspend":
		case "unsuspend":
			return [{ kind: "suspended", cardIds: ids(params.cards), source, expected: action.action === "suspend" }];
		case "changeDeck":
			return [{ kind: "deck", cardIds: ids(params.cards), source, deck: String(params.deck) }];
		default:
			return undefined;
	}
}

const sameText = (a: string, b: string) => a.trim() === b.trim();

async function verify(post: Post, checks: Check[]) {
	const mismatches: Record<string, unknown>[] = [];
	const noteIds = [...new Set(checks.flatMap((check) => (check.kind === "note" ? [check.noteId] : check.kind === "tags" || check.kind === "deleted" ? check.noteIds : [])))];
	const notes = new Map<number, NoteInfo>();
	if (noteIds.length) {
		const info = (await invoke(post, "notesInfo", { notes: noteIds })) as NoteInfo[];
		info.forEach((note, i) => notes.set(noteIds[i], note));
	}
	const deckCardIds = [
		...new Set(
			checks.flatMap((check) => (check.kind === "deck" ? check.cardIds : check.kind === "note" && check.deckName ? (notes.get(check.noteId)?.cards ?? []) : [])),
		),
	];
	const deckOf = new Map<number, string>();
	if (deckCardIds.length) {
		const cards = (await invoke(post, "cardsInfo", { cards: deckCardIds })) as { cardId: number; deckName: string }[];
		for (const card of cards) deckOf.set(card.cardId, card.deckName);
	}
	for (const check of checks) {
		if (check.kind === "note") {
			const note = notes.get(check.noteId);
			if (!note?.noteId) {
				mismatches.push({ source: check.source, noteId: check.noteId, problem: "note not found" });
				continue;
			}
			for (const [name, expected] of Object.entries(check.fields ?? {})) {
				const actual = note.fields?.[name]?.value;
				if (actual === undefined || !sameText(actual, expected)) {
					mismatches.push({ source: check.source, noteId: check.noteId, field: name, expected: truncate(expected, 160), actual: truncate(actual, 160) });
				}
			}
			if (check.tags) {
				const actual = (note.tags ?? []).map((tag) => tag.toLowerCase()).sort();
				const expected = check.tags.map((tag) => tag.toLowerCase()).sort();
				const ok = check.exactTags ? actual.join(" ") === expected.join(" ") : expected.every((tag) => actual.includes(tag));
				if (!ok) mismatches.push({ source: check.source, noteId: check.noteId, tags: { expected, actual } });
			}
			if (check.deckName) {
				const wrong = (note.cards ?? []).filter((card) => deckOf.get(card) !== check.deckName);
				if (wrong.length || !note.cards?.length) mismatches.push({ source: check.source, noteId: check.noteId, deck: { expected: check.deckName, cards: wrong.map((card) => [card, deckOf.get(card)]) } });
			}
		} else if (check.kind === "tags") {
			for (const noteId of check.noteIds) {
				const actual = (notes.get(noteId)?.tags ?? []).map((tag) => tag.toLowerCase());
				const missing = check.present.filter((tag) => !actual.includes(tag));
				const extra = check.absent.filter((tag) => actual.includes(tag));
				if (missing.length || extra.length) mismatches.push({ source: check.source, noteId, missingTags: missing, unexpectedTags: extra });
			}
		} else if (check.kind === "deleted") {
			const left = check.noteIds.filter((noteId) => notes.get(noteId)?.noteId);
			if (left.length) mismatches.push({ source: check.source, problem: "notes still exist", noteIds: left });
		} else if (check.kind === "suspended") {
			const states = (await invoke(post, "areSuspended", { cards: check.cardIds })) as (boolean | null)[];
			const wrong = check.cardIds.filter((_, i) => states[i] !== check.expected);
			if (wrong.length) mismatches.push({ source: check.source, expectedSuspended: check.expected, cardIds: wrong });
		} else {
			const wrong = check.cardIds.filter((card) => deckOf.get(card) !== check.deck);
			if (wrong.length) mismatches.push({ source: check.source, expectedDeck: check.deck, cardIds: wrong });
		}
	}
	return mismatches;
}

export async function apply(post: Post, actions: Action[], flags: { confirmed: boolean; dryRun: boolean }) {
	const summary = scope(actions);
	const writes = actions.some((action) => isWrite(action));
	const request: AnkiRequest = { action: "multi", version: API_VERSION, params: { actions } };
	if (flags.dryRun) {
		// Preflight with read-only checks only.
		const preflight: Record<string, unknown>[] = [];
		for (const [index, action] of actions.entries()) {
			const notes = action.action === "addNotes" ? action.params?.notes : action.action === "addNote" ? [action.params?.note] : undefined;
			if (!Array.isArray(notes)) continue;
			const results = (await invoke(post, "canAddNotesWithErrorDetail", { notes })) as { canAdd: boolean; error?: string }[];
			const blocked = results.map((item, i) => ({ note: i, ...item })).filter((item) => !item.canAdd);
			preflight.push({ source: `${index + 1}:${action.action}`, canAdd: results.length - blocked.length, blocked });
		}
		return { dryRun: true, writes, scope: summary, preflight, request };
	}
	if (writes && !flags.confirmed) {
		throw new ToolError("The plan changes the collection. Ask the user once with this scope, then run again with --confirmed.", 2, { scope: summary });
	}
	const items = unwrapMulti(await invoke(post, "multi", { actions }), actions.length);
	const results = items.map((item, index) => ({ source: `${index + 1}:${actions[index].action}`, ...item }));
	const failed = results.filter((item) => item.error);
	if (failed.length) {
		// multi is not atomic. Report every result so the agent knows what did apply.
		throw new ToolError("One or more plan actions failed. Earlier actions may have applied.", 1, { results });
	}
	const checks: Check[] = [];
	const unverified: string[] = [];
	for (const [index, action] of actions.entries()) {
		if (!isWrite(action)) continue;
		const found = checksFor(action, items[index].result, index);
		if (found) checks.push(...found);
		else unverified.push(`${index + 1}:${action.action}`);
	}
	const mismatches = await verify(post, checks);
	const output = { scope: summary, results: results.map(({ source, result }) => ({ source, result })), verified: mismatches.length === 0, checks: checks.length, unverified };
	if (mismatches.length) throw new ToolError("The change did not verify. Read the mismatches.", 3, { ...output, mismatches });
	return output;
}

// ---------- CLI ----------

const HELP = `Usage: bun anki.ts <command> [options]

Commands:
  call <action> [--params JSON|@file]   Send one AnkiConnect action and print its result.
  preview --query <search> [--sample N] Count matching notes and cards, cards per deck, and show N sample notes (default 3).
  apply --plan <file>                   Send the plan's actions as one multi batch, then read the notes and cards back to verify.

Plan file: {"actions": [{"action": "addNotes", "params": {"notes": [...]}}, ...]}

Options:
  --confirmed     Required for any action that is not read-only. Pass it only after the user confirms.
  --dry-run       Print the request and scope. apply --dry-run also runs canAddNotesWithErrorDetail. Change nothing.
  --out <file>    Write the full JSON output to a file and print only a short summary.
  --url <url>     AnkiConnect URL. Default: $ANKI_CONNECT_URL or ${DEFAULT_URL}.

Output is JSON. Exit 0: success. Exit 1: error, including an AnkiConnect error.
Exit 2: refused, --confirmed is missing. Exit 3: the change applied but did not verify.`;

async function readJsonArgument(value: string): Promise<unknown> {
	const text = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
	try {
		return JSON.parse(text);
	} catch {
		throw new ToolError(`Not valid JSON: ${truncate(text, 80)}`);
	}
}

export async function main(argv: string[], post?: Post): Promise<{ code: number; output: unknown }> {
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				params: { type: "string" },
				query: { type: "string" },
				sample: { type: "string", default: "3" },
				plan: { type: "string" },
				confirmed: { type: "boolean", default: false },
				"dry-run": { type: "boolean", default: false },
				out: { type: "string" },
				url: { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
		if (values.help) return { code: 0, output: HELP };
		const send = post ?? httpPost(values.url ?? process.env.ANKI_CONNECT_URL ?? DEFAULT_URL);
		const flags = { confirmed: values.confirmed, dryRun: values["dry-run"] };
		const [command, action] = positionals;
		let output: unknown;
		if (command === "call" && action && positionals.length === 2) {
			const params = values.params === undefined ? undefined : await readJsonArgument(values.params);
			if (params !== undefined && !isObject(params)) throw new ToolError("--params must be a JSON object.");
			output = await call(send, action, params as Record<string, unknown> | undefined, flags);
		} else if (command === "preview" && positionals.length === 1 && values.query) {
			const sample = Number(values.sample);
			if (!Number.isInteger(sample) || sample < 0 || sample > 50) throw new ToolError("--sample must be an integer from 0 to 50.");
			output = await preview(send, values.query, sample);
		} else if (command === "apply" && positionals.length === 1 && values.plan) {
			output = await apply(send, parsePlan(await readJsonArgument(`@${values.plan}`)), flags);
		} else {
			throw new ToolError("Unknown command or missing arguments. Use --help.");
		}
		const full = { ok: true, ...(output as object) };
		if (values.out) {
			const text = JSON.stringify(full, null, 2);
			await writeFile(values.out, `${text}\n`);
			return { code: 0, output: { ok: true, out: values.out, bytes: text.length } };
		}
		return { code: 0, output: full };
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
