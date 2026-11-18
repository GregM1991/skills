import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { main, type AnkiRequest, type Post } from "./anki";

// An in-memory AnkiConnect. No test talks to a real Anki collection.
type Note = { noteId: number; modelName: string; tags: string[]; fields: Record<string, string>; cards: number[] };
type Card = { cardId: number; note: number; deckName: string; suspended: boolean };

class FakeAnki {
	notes = new Map<number, Note>();
	cards = new Map<number, Card>();
	requests: AnkiRequest[] = [];
	ignoreFieldUpdates = false;
	nextId = 1000;

	seed(deckName: string, front: string, tags: string[] = []) {
		const noteId = this.nextId++;
		const cardId = this.nextId++;
		this.notes.set(noteId, { noteId, modelName: "Basic", tags, fields: { Front: front, Back: `${front} back` }, cards: [cardId] });
		this.cards.set(cardId, { cardId, note: noteId, deckName, suspended: false });
		return noteId;
	}

	match(query: string): Note[] {
		const [key, value] = query.split(":");
		return [...this.notes.values()].filter((note) =>
			key === "deck" ? note.cards.some((card) => this.cards.get(card)?.deckName === value) : key === "tag" ? note.tags.includes(value) : true,
		);
	}

	add(note: any): number | null {
		if (!note?.fields?.Front) return null;
		const noteId = this.nextId++;
		const cardId = this.nextId++;
		this.notes.set(noteId, { noteId, modelName: note.modelName, tags: note.tags ?? [], fields: { ...note.fields }, cards: [cardId] });
		this.cards.set(cardId, { cardId, note: noteId, deckName: note.deckName, suspended: false });
		return noteId;
	}

	handle(action: string, params: any = {}): unknown {
		switch (action) {
			case "version":
				return 6;
			case "findNotes":
				return this.match(params.query).map((note) => note.noteId);
			case "findCards":
				return this.match(params.query).flatMap((note) => note.cards);
			case "getDecks": {
				const decks: Record<string, number[]> = {};
				for (const id of params.cards) (decks[this.cards.get(id)!.deckName] ??= []).push(id);
				return decks;
			}
			case "notesInfo":
				return params.notes.map((id: number) => {
					const note = this.notes.get(id);
					if (!note) return {};
					return { ...note, fields: Object.fromEntries(Object.entries(note.fields).map(([name, value], order) => [name, { value, order }])) };
				});
			case "cardsInfo":
				return params.cards.map((id: number) => ({ cardId: id, deckName: this.cards.get(id)?.deckName }));
			case "canAddNotesWithErrorDetail":
				return params.notes.map((note: any) => (note?.fields?.Front ? { canAdd: true } : { canAdd: false, error: "cannot create note because it is empty" }));
			case "addNote":
				return this.add(params.note);
			case "addNotes":
				return params.notes.map((note: any) => this.add(note));
			case "updateNoteFields":
				if (!this.ignoreFieldUpdates) Object.assign(this.notes.get(params.note.id)!.fields, params.note.fields);
				return null;
			case "updateNoteTags":
				this.notes.get(params.note)!.tags = [...params.tags];
				return null;
			case "addTags":
				for (const id of params.notes) this.notes.get(id)!.tags.push(...params.tags.split(" "));
				return null;
			case "removeTags":
				for (const id of params.notes) {
					const note = this.notes.get(id)!;
					note.tags = note.tags.filter((tag) => !params.tags.split(" ").includes(tag));
				}
				return null;
			case "deleteNotes":
				for (const id of params.notes) this.notes.delete(id);
				return null;
			case "suspend":
			case "unsuspend":
				for (const id of params.cards) this.cards.get(id)!.suspended = action === "suspend";
				return true;
			case "areSuspended":
				return params.cards.map((id: number) => this.cards.get(id)?.suspended ?? null);
			case "createDeck":
				return 1;
			case "changeDeck":
				for (const id of params.cards) this.cards.get(id)!.deckName = params.deck;
				return null;
			default:
				throw new Error(`unsupported action: ${action}`);
		}
	}

	post: Post = async (request) => {
		this.requests.push(request);
		if (request.action === "multi") {
			return {
				result: (request.params!.actions as any[]).map((inner) => {
					try {
						return { result: this.handle(inner.action, inner.params), error: null };
					} catch (error) {
						return { result: null, error: (error as Error).message };
					}
				}),
				error: null,
			};
		}
		try {
			return { result: this.handle(request.action, request.params), error: null };
		} catch (error) {
			return { result: null, error: (error as Error).message };
		}
	};
}

let anki: FakeAnki;
let dir: string;

async function cli(...args: string[]) {
	const { code, output } = await main(args, anki.post);
	return { code, output: output as any };
}

async function plan(actions: unknown[]) {
	const file = path.join(dir, `plan-${Math.random()}.json`);
	await writeFile(file, JSON.stringify({ actions }));
	return file;
}

const writes = () => anki.requests.filter((request) => !["findNotes", "findCards", "getDecks", "notesInfo", "cardsInfo", "areSuspended", "canAddNotesWithErrorDetail", "version"].includes(request.action));

beforeEach(async () => {
	anki = new FakeAnki();
	dir = await mkdtemp(path.join(tmpdir(), "anki-test-"));
});

describe("call", () => {
	test("returns the result of a read-only action", async () => {
		expect(await cli("call", "version")).toEqual({ code: 0, output: { ok: true, action: "version", result: 6 } });
		expect(anki.requests[0]).toEqual({ action: "version", version: 6 });
	});

	test("turns an AnkiConnect error into exit 1", async () => {
		const { code, output } = await cli("call", "guiExitAnki", "--confirmed");
		expect(code).toBe(1);
		expect(output.error).toContain("unsupported action");
	});

	test("refuses a write without --confirmed and sends nothing", async () => {
		const noteId = anki.seed("French", "chat");
		const { code } = await cli("call", "deleteNotes", "--params", JSON.stringify({ notes: [noteId] }));
		expect(code).toBe(2);
		expect(anki.requests).toEqual([]);
		expect((await cli("call", "deleteNotes", "--params", JSON.stringify({ notes: [noteId] }), "--confirmed")).code).toBe(0);
		expect(anki.notes.has(noteId)).toBe(false);
	});

	test("treats multi with one write as a write", async () => {
		const params = JSON.stringify({ actions: [{ action: "deckNames" }, { action: "deleteNotes", params: { notes: [1] } }] });
		expect((await cli("call", "multi", "--params", params)).code).toBe(2);
	});

	test("writes long output to a file", async () => {
		const out = path.join(dir, "out.json");
		const { output } = await cli("call", "version", "--out", out);
		expect(output).toMatchObject({ ok: true, out });
		expect(JSON.parse(await readFile(out, "utf8")).result).toBe(6);
	});
});

describe("preview", () => {
	test("counts notes, cards and decks and shows a sample", async () => {
		for (const word of ["chat", "chien", "oiseau", "poisson"]) anki.seed("French", word, ["verbs"]);
		anki.seed("German", "Hund", ["verbs"]);
		const { code, output } = await cli("preview", "--query", "tag:verbs", "--sample", "2");
		expect(code).toBe(0);
		expect(output).toMatchObject({ notes: 5, cards: 5, decks: { French: 4, German: 1 }, omittedFromSample: 3 });
		expect(output.sample[0]).toMatchObject({ model: "Basic", fields: { Front: "chat" } });
		expect(writes()).toEqual([]);
	});
});

describe("apply", () => {
	const newNotes = [
		{ deckName: "French", modelName: "Basic", fields: { Front: "maison", Back: "house" }, tags: ["nouns"] },
		{ deckName: "French", modelName: "Basic", fields: { Front: "", Back: "empty" } },
	];

	test("dry run reports scope and preflight and changes nothing", async () => {
		const { code, output } = await cli("apply", "--plan", await plan([{ action: "addNotes", params: { notes: newNotes } }]), "--dry-run");
		expect(code).toBe(0);
		expect(output.scope).toEqual([{ action: "addNotes", notes: 2, decks: ["French"] }]);
		expect(output.preflight[0]).toMatchObject({ canAdd: 1, blocked: [{ note: 1, canAdd: false }] });
		expect(anki.notes.size).toBe(0);
	});

	test("refuses without --confirmed and returns the scope", async () => {
		const { code, output } = await cli("apply", "--plan", await plan([{ action: "addNotes", params: { notes: [newNotes[0]] } }]));
		expect(code).toBe(2);
		expect(output.scope).toEqual([{ action: "addNotes", notes: 1, decks: ["French"] }]);
		expect(anki.requests).toEqual([]);
	});

	test("sends one multi and verifies each change by reading it back", async () => {
		const a = anki.seed("French", "chat", ["old"]);
		const b = anki.seed("French", "chien");
		const c = anki.seed("French", "oiseau");
		const cardB = anki.notes.get(b)!.cards[0];
		const file = await plan([
			{ action: "addNotes", params: { notes: [newNotes[0]] } },
			{ action: "updateNoteFields", params: { note: { id: a, fields: { Back: "cat" } } } },
			{ action: "updateNoteTags", params: { note: a, tags: ["animals"] } },
			{ action: "addTags", params: { notes: [b], tags: "reviewed" } },
			{ action: "suspend", params: { cards: [cardB] } },
			{ action: "changeDeck", params: { cards: [cardB], deck: "Archive" } },
			{ action: "deleteNotes", params: { notes: [c] } },
			{ action: "createDeck", params: { deck: "Archive" } },
		]);
		const { code, output } = await cli("apply", "--plan", file, "--confirmed");
		expect(code).toBe(0);
		expect(output).toMatchObject({ verified: true, checks: 7, unverified: ["8:createDeck"] });
		expect(anki.requests.filter((request) => request.action === "multi")).toHaveLength(1);
		expect(anki.notes.get(a)!.fields.Back).toBe("cat");
	});

	test("exits 3 when a change does not read back", async () => {
		const a = anki.seed("French", "chat");
		anki.ignoreFieldUpdates = true;
		const { code, output } = await cli("apply", "--plan", await plan([{ action: "updateNoteFields", params: { note: { id: a, fields: { Back: "cat" } } } }]), "--confirmed");
		expect(code).toBe(3);
		expect(output.mismatches).toEqual([{ source: "1:updateNoteFields", noteId: a, field: "Back", expected: "cat", actual: "chat back" }]);
	});

	test("reports every result when one action in the batch fails", async () => {
		const { code, output } = await cli("apply", "--plan", await plan([{ action: "addNotes", params: { notes: [newNotes[0]] } }, { action: "noSuchAction" }]), "--confirmed");
		expect(code).toBe(1);
		expect(output.results.map((item: any) => item.error === null)).toEqual([true, false]);
	});

	test("rejects a malformed plan", async () => {
		expect((await cli("apply", "--plan", await plan([{ params: {} }]))).code).toBe(1);
		expect((await cli("apply", "--plan", await plan([{ action: "multi", params: { actions: [] } }]))).code).toBe(1);
	});
});

test("reports an unreachable AnkiConnect clearly", async () => {
	const { code, output } = (await main(["call", "version", "--url", "http://127.0.0.1:9"])) as any;
	expect(code).toBe(1);
	expect(output.error).toContain("not reachable");
});
