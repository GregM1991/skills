import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type AppendIfMissingOperation = {
	type: "append-if-missing";
	target: string;
	content: string;
};

type PatchOperation = {
	type: "patch";
	patch: string;
};

type OverlayOperation = AppendIfMissingOperation | PatchOperation;

type OverlayManifest = {
	$schemaVersion: number;
	operations: OverlayOperation[];
};

type LoadedOverlay = {
	key: string;
	directory: string;
	operations: OverlayOperation[];
};

async function directoryNames(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	return (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort();
}

function requirePlainObject(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context} must be a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function requireRelativePath(value: unknown, context: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${context} must be a non-empty relative path.`);
	}
	if (path.isAbsolute(value)) throw new Error(`${context} must be relative, received "${value}".`);
	const normalized = path.normalize(value);
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
		throw new Error(`${context} escapes its allowed directory: "${value}".`);
	}
	return normalized;
}

function resolveInside(root: string, relativePath: string, context: string): string {
	const resolved = path.resolve(root, relativePath);
	const relative = path.relative(root, resolved);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`${context} must name a file inside "${root}".`);
	}
	return resolved;
}

function parseManifest(value: unknown, manifestPath: string): OverlayManifest {
	const object = requirePlainObject(value, manifestPath);
	if (object.$schemaVersion !== 1) {
		throw new Error(`${manifestPath} must declare $schemaVersion 1.`);
	}
	if (!Array.isArray(object.operations) || object.operations.length === 0) {
		throw new Error(`${manifestPath} must declare at least one operation.`);
	}

	const operations = object.operations.map((rawOperation, index): OverlayOperation => {
		const context = `${manifestPath} operation ${index + 1}`;
		const operation = requirePlainObject(rawOperation, context);
		if (operation.type === "append-if-missing") {
			return {
				type: "append-if-missing",
				target: requireRelativePath(operation.target, `${context} target`),
				content: requireRelativePath(operation.content, `${context} content`),
			};
		}
		if (operation.type === "patch") {
			return {
				type: "patch",
				patch: requireRelativePath(operation.patch, `${context} patch`),
			};
		}
		throw new Error(`${context} has unsupported type "${String(operation.type)}".`);
	});

	return { $schemaVersion: 1, operations };
}

async function requireFile(filePath: string, context: string): Promise<void> {
	let fileStat;
	try {
		fileStat = await stat(filePath);
	} catch {
		throw new Error(`${context} does not exist at "${filePath}".`);
	}
	if (!fileStat.isFile()) throw new Error(`${context} must be a file at "${filePath}".`);
}

async function requireFileInside(root: string, relativePath: string, context: string): Promise<string> {
	const filePath = resolveInside(root, relativePath, context);
	await requireFile(filePath, context);
	const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
	const relative = path.relative(realRoot, realFile);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`${context} resolves outside its allowed directory through a symbolic link.`);
	}
	return filePath;
}

async function applyAppendIfMissing(operation: AppendIfMissingOperation, overlay: LoadedOverlay, stagingDir: string): Promise<void> {
	const targetPath = await requireFileInside(stagingDir, operation.target, `${overlay.key} append target`);
	const contentPath = await requireFileInside(overlay.directory, operation.content, `${overlay.key} append content`);

	const fragment = (await readFile(contentPath, "utf8")).trim();
	if (fragment.length === 0) throw new Error(`${overlay.key} append content "${operation.content}" is empty.`);

	const current = await readFile(targetPath, "utf8");
	if (current.includes(fragment)) return;
	const separator = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
	await writeFile(targetPath, `${current}${separator}${fragment}\n`);
}

function commandFailureMessage(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const failure = error as { stderr?: string; message?: string };
	return failure.stderr?.trim() || failure.message || String(error);
}

async function applyPatch(operation: PatchOperation, overlay: LoadedOverlay, stagingDir: string): Promise<void> {
	const patchPath = await requireFileInside(overlay.directory, operation.patch, `${overlay.key} patch`);

	const args = ["apply", "--no-index", "--whitespace=nowarn"];
	try {
		await execFileAsync("git", [...args, "--check", patchPath], { cwd: stagingDir });
		await execFileAsync("git", [...args, patchPath], { cwd: stagingDir });
	} catch (error) {
		throw new Error(`${overlay.key} patch "${operation.patch}" failed: ${commandFailureMessage(error)}`);
	}
}

export type VendorOverlaySet = {
	apply(owner: string, skillName: string, stagingDir: string): Promise<void>;
	assertAllApplied(): void;
};

class LoadedVendorOverlaySet implements VendorOverlaySet {
	readonly #overlays: Map<string, LoadedOverlay>;
	readonly #applied = new Set<string>();

	constructor(overlays: Map<string, LoadedOverlay>) {
		this.#overlays = overlays;
	}

	async apply(owner: string, skillName: string, stagingDir: string): Promise<void> {
		const key = `${owner}/${skillName}`;
		const overlay = this.#overlays.get(key);
		if (!overlay || this.#applied.has(key)) return;

		await mkdir(stagingDir, { recursive: true });
		for (const operation of overlay.operations) {
			if (operation.type === "append-if-missing") await applyAppendIfMissing(operation, overlay, stagingDir);
			else await applyPatch(operation, overlay, stagingDir);
		}
		this.#applied.add(key);
	}

	assertAllApplied(): void {
		const orphaned = [...this.#overlays.keys()].filter((key) => !this.#applied.has(key)).sort();
		if (orphaned.length) {
			throw new Error(`Vendor overlays do not match any skill produced upstream:\n${orphaned.map((key) => `  - ${key}`).join("\n")}`);
		}
	}
}

export async function loadVendorOverlays(overlayRoot: string): Promise<VendorOverlaySet> {
	const overlays = new Map<string, LoadedOverlay>();
	for (const owner of await directoryNames(overlayRoot)) {
		if (owner !== owner.toLowerCase()) throw new Error(`Vendor overlay owner directory "${owner}" must be lowercase.`);
		for (const skillName of await directoryNames(path.join(overlayRoot, owner))) {
			const key = `${owner}/${skillName}`;
			if (overlays.has(key)) throw new Error(`Vendor overlay "${key}" is declared more than once.`);
			const directory = path.join(overlayRoot, owner, skillName);
			const manifestPath = path.join(directory, "overlay.json");
			await requireFile(manifestPath, `${key} overlay manifest`);
			let rawManifest: unknown;
			try {
				rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
			} catch (error) {
				throw new Error(`${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
			const manifest = parseManifest(rawManifest, manifestPath);
			overlays.set(key, { key, directory, operations: manifest.operations });
		}
	}
	return new LoadedVendorOverlaySet(overlays);
}
