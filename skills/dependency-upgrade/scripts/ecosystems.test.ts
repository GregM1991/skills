import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  type Runner, adapterFor, detectManagers, nextConstraint, parseAuditJson, parseBundleOutdated,
  parseBunOutdated, parseCargoToml, parseGemfile, parseJsonStream, parseNpmOutdated,
  parsePyproject, parseRequirement, parseYarnOutdated, rewriteCargoToml,
} from "./ecosystems.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dep-upgrade-eco-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}
function recorder(reply: (command: string[]) => { code?: number; stdout?: string; stderr?: string } = () => ({})) {
  const calls: string[] = [];
  const run: Runner = async (command) => {
    calls.push(command.join(" "));
    const r = reply(command);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

describe("outdated parsers", () => {
  it("reads npm and pnpm JSON", () => {
    const npm = `{"ms":{"current":"2.1.1","wanted":"2.1.1","latest":"2.1.3","dependent":"x","location":"/x"}}`;
    expect(parseNpmOutdated(npm)).toEqual([{ name: "ms", current: "2.1.1", latest: "2.1.3" }]);
    const pnpm = `{"semver":{"current":"7.5.4","latest":"7.8.6","wanted":"7.5.4","isDeprecated":false,"dependencyType":"devDependencies"}}`;
    expect(parseNpmOutdated(pnpm)).toEqual([{ name: "semver", current: "7.5.4", latest: "7.8.6" }]);
    expect(parseNpmOutdated("")).toEqual([]);
    expect(() => parseNpmOutdated(`{"error":{"summary":"boom"}}`)).toThrow("boom");
  });

  it("reads the yarn classic table event", () => {
    const raw = [
      `{"type":"info","data":"Color legend"}`,
      `{"type":"table","data":{"head":["Package","Current","Wanted","Latest","Package Type","URL"],"body":[["is-number","6.0.0","6.0.0","7.0.0","dependencies","https://x"]]}}`,
    ].join("\n");
    expect(parseYarnOutdated(raw)).toEqual([{ name: "is-number", current: "6.0.0", latest: "7.0.0" }]);
  });

  it("reads the bun outdated table and drops the type tag", () => {
    const raw = `bun outdated v1.4.4 (38afee6c8)
|------------------------------------------|
| Package      | Current | Update | Latest |
|--------------|---------|--------|--------|
| is-number    | 6.0.0   | 6.0.0  | 7.0.0  |
|--------------|---------|--------|--------|
| semver (dev) | 7.5.4   | 7.5.4  | 7.8.6  |
|------------------------------------------|`;
    expect(parseBunOutdated(raw)).toEqual([
      { name: "is-number", current: "6.0.0", latest: "7.0.0" },
      { name: "semver", current: "7.5.4", latest: "7.8.6" },
    ]);
  });

  it("reads bundler parseable output and go module streams", () => {
    expect(parseBundleOutdated("rails (newest 7.1.0, installed 7.0.4, requested ~> 7.0)\nrack (newest 3.0.1, installed 2.2.8)\n")).toEqual([
      { name: "rails", latest: "7.1.0", current: "7.0.4" },
      { name: "rack", latest: "3.0.1", current: "2.2.8" },
    ]);
    const stream = `{\n\t"Path": "example.com/app",\n\t"Main": true\n}\n{\n\t"Path": "golang.org/x/text",\n\t"Version": "v0.3.0",\n\t"Update": {"Path": "golang.org/x/text", "Version": "v0.14.0"},\n\t"Note": "brace } in string"\n}\n`;
    expect(parseJsonStream(stream).map((m) => m.Path)).toEqual(["example.com/app", "golang.org/x/text"]);
  });
});

describe("parseAuditJson", () => {
  it("keeps the worst severity per package for each manager format", () => {
    expect(parseAuditJson(`{"vulnerabilities":{"minimist":{"severity":"critical"}},"metadata":{}}`)).toEqual({ minimist: "critical" });
    expect(parseAuditJson(`{"advisories":{"1":{"module_name":"minimist","severity":"moderate"},"2":{"module_name":"minimist","severity":"critical"}},"metadata":{"vulnerabilities":{"info":0}}}`)).toEqual({ minimist: "critical" });
    expect(parseAuditJson([
      `{"type":"auditAdvisory","data":{"advisory":{"module_name":"minimist","severity":"moderate"}}}`,
      `{"type":"auditSummary","data":{"vulnerabilities":{"info":0}}}`,
    ].join("\n"))).toEqual({ minimist: "moderate" });
    expect(parseAuditJson(`{"minimist":[{"severity":"critical","title":"x"}]}`)).toEqual({ minimist: "critical" });
  });
});

describe("detectManagers", () => {
  it("prefers lockfiles and ignores a bare manifest of the same ecosystem", () => {
    expect(detectManagers(project({ "package.json": "{}", "bun.lock": "" }))).toEqual(["bun"]);
    expect(detectManagers(project({ "package.json": "{}" }))).toEqual(["npm"]);
    expect(detectManagers(project({ "package.json": "{}", "yarn.lock": "__metadata:\n" }))).toEqual(["yarn-berry"]);
    expect(detectManagers(project({ "pyproject.toml": "", "uv.lock": "" }))).toEqual(["uv"]);
    expect(detectManagers(project({ "requirements.txt": "" }))).toEqual(["pip"]);
    expect(detectManagers(project({ "package.json": "{}", "pnpm-lock.yaml": "", "go.mod": "" }))).toEqual(["pnpm", "go"]);
  });
});

describe("node adapter", () => {
  it("keeps range style, writes package.json, and installs", async () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { ms: "2.1.1", hono: "^4.12.15" }, devDependencies: { semver: "~7.5.0" } }, null, 4) + "\n",
      "bun.lock": "",
    });
    const { run, calls } = recorder();
    const result = await adapterFor("bun").apply({ dir, run }, [
      { name: "ms", type: "runtime", to: "2.1.3" },
      { name: "hono", type: "runtime", to: "4.13.19" },
      { name: "semver", type: "dev", to: "7.8.6" },
    ]);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["bun install"]);
    const text = readFileSync(path.join(dir, "package.json"), "utf8");
    expect(text).toContain('    "ms": "2.1.3"');
    expect(JSON.parse(text)).toEqual({ dependencies: { ms: "2.1.3", hono: "^4.13.19" }, devDependencies: { semver: "~7.8.6" } });
  });

  it("types rows from package.json and picks checks from scripts", async () => {
    const dir = project({
      "package.json": JSON.stringify({
        scripts: { build: "x", lint: "x", test: "x", dev: "x" },
        dependencies: { ms: "2.1.1" },
        devDependencies: { semver: "~7.5.0" },
      }),
    });
    const { run } = recorder(() => ({
      code: 1,
      stdout: `{"ms":{"current":"2.1.1","latest":"2.1.3"},"semver":{"current":"7.5.4","latest":"7.8.6"},"transitive":{"current":"1.0.0","latest":"2.0.0"}}`,
    }));
    const adapter = adapterFor("npm");
    expect((await adapter.inventory({ dir, run })).outdated).toEqual([
      { name: "ms", type: "runtime", current: "2.1.1", latest: "2.1.3", spec: "2.1.1" },
      { name: "semver", type: "dev", current: "7.5.4", latest: "7.8.6", spec: "~7.5.0" },
    ]);
    expect(adapter.defaultChecks(dir).map((c) => c.command)).toEqual(["npm run build", "npm run lint", "npm run test"]);
    expect(adapterFor("pnpm").defaultChecks(project({ "package.json": `{"scripts":{"check":"x","test":"x"}}` }))).toEqual([
      { name: "check", command: "pnpm run check" },
    ]);
  });

  it("reports a failed outdated command", async () => {
    const { run } = recorder(() => ({ code: 1, stderr: "registry down" }));
    await expect(adapterFor("pnpm").inventory({ dir: project({ "package.json": "{}" }), run })).rejects.toThrow("registry down");
  });

  it("matches import forms with its search pattern", () => {
    const re = new RegExp(adapterFor("npm").importPattern("@scope/pkg"));
    expect(re.test(`import { x } from "@scope/pkg";`)).toBe(true);
    expect(re.test(`const x = require('@scope/pkg/sub')`)).toBe(true);
    expect(re.test(`await import("@scope/pkg")`)).toBe(true);
    expect(re.test(`import "@scope/pkg-other"`)).toBe(false);
  });
});

describe("python", () => {
  it("parses pyproject groups and requirement lines", () => {
    const deps = parsePyproject(`[project]
name = "app"
dependencies = [
  "httpx>=0.27.0",  # comment
  "pydantic[email]==2.5.0",
]
[project.optional-dependencies]
cli = ["typer>=0.9"]
[dependency-groups]
dev = ["pytest>=8.0", "ruff"]
`);
    expect(deps.map((d) => [d.name, d.extras, d.constraint, d.type, d.group ?? d.optional ?? ""])).toEqual([
      ["httpx", "", ">=0.27.0", "runtime", ""],
      ["pydantic", "[email]", "==2.5.0", "runtime", ""],
      ["typer", "", ">=0.9", "runtime", "cli"],
      ["pytest", "", ">=8.0", "dev", "dev"],
      ["ruff", "", "", "dev", "dev"],
    ]);
    expect(parseRequirement("Django==4.2.1 ; python_version > '3.8'")).toEqual({ name: "Django", extras: "", constraint: "==4.2.1" });
    expect(parseRequirement("-r base.txt")).toBeNull();
  });

  it("keeps direct packages and counts the rest as transitive", async () => {
    const dir = project({ "pyproject.toml": `[project]\ndependencies = ["httpx>=0.27.0"]\n[dependency-groups]\ndev = ["pytest>=8.0"]\n`, "uv.lock": "" });
    const { run } = recorder(() => ({
      stdout: JSON.stringify([
        { name: "httpx", version: "0.27.0", latest_version: "0.28.1" },
        { name: "anyio", version: "4.0.0", latest_version: "4.4.0" },
      ]),
    }));
    const adapter = adapterFor("uv");
    const inventory = await adapter.inventory({ dir, run });
    expect(inventory.transitive).toBe(1);
    expect(inventory.outdated[0]).toMatchObject({ name: "httpx", type: "runtime", spec: ">=0.27.0" });
    expect(adapter.defaultChecks(dir)).toEqual([{ name: "test", command: "uv run pytest" }]);
  });

  it("uses uv add per group", async () => {
    const { run, calls } = recorder();
    await adapterFor("uv").apply({ dir: project({}), run }, [
      { name: "httpx", type: "runtime", to: "0.28.1", spec: ">=0.27.0", meta: { requirement: "httpx" } },
      { name: "pytest", type: "dev", to: "8.3.0", spec: ">=8.0", meta: { requirement: "pytest", group: "dev" } },
      { name: "ruff", type: "dev", to: "0.6.0", spec: "", meta: { requirement: "ruff", group: "dev" } },
    ]);
    expect(calls).toEqual(["uv add httpx>=0.28.1", "uv add --group=dev pytest>=8.3 ruff>=0.6.0"]);
  });

  it("rewrites pinned requirement lines for pip", async () => {
    const dir = project({ "requirements.txt": "Django==4.2.1\nrequests\n" });
    const { run, calls } = recorder();
    await adapterFor("pip").apply({ dir, run }, [
      { name: "Django", type: "runtime", to: "4.2.9", spec: "==4.2.1", meta: { file: "requirements.txt", requirement: "Django" } },
      { name: "requests", type: "runtime", to: "2.32.0", spec: "", meta: { file: "requirements.txt", requirement: "requests" } },
    ]);
    expect(readFileSync(path.join(dir, "requirements.txt"), "utf8")).toBe("Django==4.2.9\nrequests\n");
    expect(calls).toEqual(["python3 -m pip install -r requirements.txt", "python3 -m pip install requests==2.32.0"]);
  });
});

describe("rust, ruby, go", () => {
  it("reads and rewrites Cargo.toml", () => {
    const toml = `[dependencies]\nserde = "1.0"\ntokio = { version = "1.28", features = ["full"] }\n[dev-dependencies]\ninsta = "1.30.0"\n`;
    expect(parseCargoToml(toml)).toEqual([
      { name: "serde", spec: "1.0", type: "runtime" },
      { name: "tokio", spec: "1.28", type: "runtime" },
      { name: "insta", spec: "1.30.0", type: "dev" },
    ]);
    expect(rewriteCargoToml(rewriteCargoToml(toml, "tokio", "2.1.0"), "serde", "1.0.200")).toContain(
      `serde = "1.0.200"\ntokio = { version = "2.1", features = ["full"] }`,
    );
  });

  it("reads Gemfile groups", () => {
    const gemfile = `source "https://rubygems.org"\ngem "rails", "~> 7.0"\ngroup :development, :test do\n  gem "rspec-rails"\nend\ngem "rubocop", group: :development\n`;
    expect(parseGemfile(gemfile)).toEqual([
      { name: "rails", spec: "~> 7.0", type: "runtime" },
      { name: "rspec-rails", spec: undefined, type: "dev" },
      { name: "rubocop", spec: undefined, type: "dev" },
    ]);
  });

  it("applies go modules with go get and tidy", async () => {
    const { run, calls } = recorder();
    const result = await adapterFor("go").apply({ dir: project({}), run }, [{ name: "golang.org/x/text", type: "runtime", to: "v0.14.0" }]);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["go get golang.org/x/text@v0.14.0", "go mod tidy"]);
  });

  it("stops at the first failed step", async () => {
    const { run, calls } = recorder(() => ({ code: 1, stderr: "no route" }));
    const result = await adapterFor("go").apply({ dir: project({}), run }, [{ name: "a/b", type: "runtime", to: "v1.0.1" }]);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.output).toContain("no route");
    expect(calls).toHaveLength(1);
  });
});

describe("nextConstraint", () => {
  it("uses the full version when truncation would leave the range as it was", () => {
    expect(nextConstraint("^1.2", "1.2.9")).toBe("^1.2.9");
    expect(nextConstraint("^8.5.2", "8.5.2")).toBe("^8.5.2");
    expect(nextConstraint(undefined, "1.0.0")).toBe("1.0.0");
  });
});
