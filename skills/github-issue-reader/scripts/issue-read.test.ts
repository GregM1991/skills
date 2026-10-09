import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

const directories: string[] = [];
const command = path.join(import.meta.dir, "issue-read.ts");

function relatedIssue(number: number, state: "open" | "closed" = "open") {
  return {
    number,
    title: `Related issue ${number}: ` + "c".repeat(1000),
    html_url: `https://github.com/owner/repo/issues/${number}`,
    state,
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "issue-reader-test-"));
  directories.push(directory);
  const relationships: {
    children: ReturnType<typeof relatedIssue>[];
    parent: ReturnType<typeof relatedIssue> | null;
    blockers: ReturnType<typeof relatedIssue>[];
  } = {
    children: Array.from({ length: 125 }, (_, i) =>
      relatedIssue(i + 100, i % 2 === 0 ? "open" : "closed"),
    ),
    parent: relatedIssue(10),
    blockers: Array.from({ length: 125 }, (_, i) =>
      relatedIssue(i + 300, i % 2 === 0 ? "open" : "closed"),
    ),
  };
  const snapshot = {
    repository: "owner/repo",
    fetchedAt: "2026-10-07T00:00:00.000Z",
    issue: {
      number: 12,
      title: "Large issue",
      html_url: "https://github.com/owner/repo/issues/12",
      state: "open",
      body: "a".repeat(20000) + "final requirement",
      labels: [{ name: "ready-for-agent" }],
      comments: 125,
    },
    comments: Array.from({ length: 125 }, (_, i) => ({
      id: i + 1,
      html_url: `https://github.com/owner/repo/issues/12#issuecomment-${i + 1}`,
      body: `Comment ${i + 1}: ` + "b".repeat(10000),
    })),
    relationships,
  };
  const file = path.join(directory, "input.json");
  await writeFile(file, JSON.stringify(snapshot));
  return { directory, snapshot, file };
}

async function fakeGitHub(
  source: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, { body: unknown; code?: number }> = {},
) {
  const { directory, snapshot } = source;
  const endpoint = "repos/owner/repo/issues/12";
  const responses = {
    repo: { body: { nameWithOwner: snapshot.repository } },
    [endpoint]: { body: snapshot.issue },
    [`${endpoint}/comments?per_page=100`]: {
      body: [snapshot.comments.slice(0, 100), snapshot.comments.slice(100)],
    },
    [`${endpoint}/sub_issues?per_page=100`]: {
      body: [
        snapshot.relationships.children.slice(0, 100),
        snapshot.relationships.children.slice(100),
      ],
    },
    [`${endpoint}/parent`]: {
      body: snapshot.relationships.parent ?? {
        message: "No parent issue found",
        status: "404",
      },
      code: snapshot.relationships.parent === null ? 1 : 0,
    },
    [`${endpoint}/dependencies/blocked_by?per_page=100`]: {
      body: [
        snapshot.relationships.blockers.slice(0, 100),
        snapshot.relationships.blockers.slice(100),
      ],
    },
    ...overrides,
  };
  const responsesFile = path.join(directory, "responses.json");
  const calls = path.join(directory, "calls.jsonl");
  const workingDirectories = path.join(directory, "working-directories.jsonl");
  await writeFile(responsesFile, JSON.stringify(responses));
  await writeFile(
    path.join(directory, "gh"),
    `#!/usr/bin/env bun
import { readFile, appendFile } from 'node:fs/promises';
const args = Bun.argv.slice(2);
await appendFile(process.env.ISSUE_TEST_CALLS, JSON.stringify(args) + '\\n');
await appendFile(process.env.ISSUE_TEST_CWD, JSON.stringify(process.cwd()) + '\\n');
const responses = JSON.parse(await readFile(process.env.ISSUE_TEST_RESPONSES, 'utf8'));
const response = responses[args[0] === 'repo' ? 'repo' : args[1]];
if (!response) process.exit(1);
if (args[1]?.includes('?per_page=100') && (!args.includes('--paginate') || !args.includes('--slurp'))) process.exit(1);
console.log(JSON.stringify(response.body));
process.exitCode = response.code ?? 0;
`,
    { mode: 0o700 },
  );
  return {
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      ISSUE_TEST_CALLS: calls,
      ISSUE_TEST_RESPONSES: responsesFile,
      ISSUE_TEST_CWD: workingDirectories,
    },
    calls,
    workingDirectories,
  };
}

function savedSnapshot(stdout: string) {
  const output = z
    .object({ snapshot: z.string(), fetchedAt: z.string() })
    .parse(JSON.parse(stdout));
  directories.push(path.dirname(output.snapshot));
  return output;
}

async function run(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      const child = spawn("bun", [command, ...args], {
        env,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code }));
    },
  );
}

describe("bounded issue reading", () => {
  it("infers the caller's repository while running the shared script outside its directory", async () => {
    const source = await fixture();
    const { env, workingDirectories } = await fakeGitHub(source);
    const result = await run(["12"], env, source.directory);
    expect(result.code).toBe(0);
    savedSnapshot(result.stdout);
    expect(JSON.parse(result.stdout)).toMatchObject({
      repository: "owner/repo",
      number: 12,
    });
    const locations = (await readFile(workingDirectories, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(locations.length).toBeGreaterThan(0);
    expect(locations.every((location) => location === source.directory)).toBe(
      true,
    );
  });

  it("reads an explicit repository from outside a checkout without repository discovery", async () => {
    const source = await fixture();
    const { env, calls } = await fakeGitHub(source);
    const result = await run(
      ["12", "--repo", "owner/repo"],
      env,
      source.directory,
    );
    expect(result.code).toBe(0);
    savedSnapshot(result.stdout);
    expect(JSON.parse(result.stdout)).toMatchObject({
      repository: "owner/repo",
    });
    const requests = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(requests).not.toContainEqual([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
    ]);
  });

  it("bounds default output and exposes how to retrieve omitted body and comments", async () => {
    const { file } = await fixture();
    const result = await run(["--snapshot", file]);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThan(11000);
    expect(JSON.parse(result.stdout)).toMatchObject({
      body: { totalCharacters: 20017, nextOffset: 3500 },
      comments: { total: 125, nextOffset: 20 },
    });
    const lastBody = await run([
      "--snapshot",
      file,
      "--section",
      "body",
      "--offset",
      "20000",
    ]);
    expect(JSON.parse(lastBody.stdout)).toMatchObject({
      body: { text: "final requirement", nextOffset: null },
    });
    const lastComments = await run([
      "--snapshot",
      file,
      "--section",
      "comments",
      "--offset",
      "120",
    ]);
    const index = z
      .object({ comments: z.object({ entries: z.array(z.unknown()) }) })
      .parse(JSON.parse(lastComments.stdout));
    expect(index.comments.entries).toHaveLength(5);
    const comment = await run([
      "--snapshot",
      file,
      "--comment",
      "125",
      "--limit",
      "20",
    ]);
    expect(JSON.parse(comment.stdout)).toMatchObject({
      id: 125,
      body: { text: "Comment 125: bbbbbbb", nextOffset: 20 },
    });
  });

  it("fetches all comment pages through gh and saves complete content with private permissions", async () => {
    const source = await fixture();
    const { snapshot } = source;
    const { env, calls } = await fakeGitHub(source);
    const result = await run(["12"], env);
    expect(result.code).toBe(0);
    const output = savedSnapshot(result.stdout);
    expect(JSON.parse(await readFile(output.snapshot, "utf8"))).toEqual({
      ...snapshot,
      fetchedAt: output.fetchedAt,
    });
    expect((await stat(output.snapshot)).mode & 0o777).toBe(0o600);
    const requests = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(requests).toContainEqual([
      "api",
      "repos/owner/repo/issues/12/comments?per_page=100",
      "--paginate",
      "--slurp",
    ]);
    expect(result.stdout.length).toBeLessThan(11000);
  });

  it("saves complete native relationships and pages child and blocker output without more GitHub reads", async () => {
    const source = await fixture();
    const { env, calls } = await fakeGitHub(source);
    const result = await run(["12", "--section", "children"], env);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThan(11000);
    expect(JSON.parse(result.stdout)).toMatchObject({
      children: {
        total: 125,
        open: 63,
        closed: 62,
        offset: 0,
        nextOffset: 20,
      },
    });
    const firstPage = z
      .object({ children: z.object({ entries: z.array(z.unknown()) }) })
      .parse(JSON.parse(result.stdout));
    expect(firstPage.children.entries).toHaveLength(20);
    expect(firstPage.children.entries[0]).toMatchObject({
      number: 100,
      state: "open",
      url: "https://github.com/owner/repo/issues/100",
      title: { nextOffset: 250 },
    });
    const output = savedSnapshot(result.stdout);
    expect(JSON.parse(await readFile(output.snapshot, "utf8"))).toMatchObject({
      relationships: source.snapshot.relationships,
    });
    const requests = await readFile(calls, "utf8");
    for (const section of ["children", "blockers"]) {
      const last = await run(
        [
          "--snapshot",
          output.snapshot,
          "--section",
          section,
          "--offset",
          "120",
        ],
        env,
      );
      expect(last.code).toBe(0);
      const page = z
        .object({ entries: z.array(z.object({ number: z.number() })) })
        .parse(z.record(z.unknown()).parse(JSON.parse(last.stdout))[section]);
      expect(page.entries).toHaveLength(5);
      expect(JSON.parse(last.stdout)).toMatchObject({
        [section]: {
          total: 125,
          open: 63,
          closed: 62,
          offset: 120,
          nextOffset: null,
        },
      });
      expect(page.entries.at(-1)?.number).toBe(
        section === "children" ? 224 : 424,
      );
    }
    const parent = await run(
      ["--snapshot", output.snapshot, "--section", "parent"],
      env,
    );
    expect(parent.code).toBe(0);
    expect(JSON.parse(parent.stdout)).toMatchObject({
      parent: {
        number: 10,
        state: "open",
        url: "https://github.com/owner/repo/issues/10",
      },
    });
    expect(await readFile(calls, "utf8")).toBe(requests);
  });

  it("reports confirmed empty relationships and a missing parent", async () => {
    const source = await fixture();
    source.snapshot.relationships = {
      children: [],
      parent: null,
      blockers: [],
    };
    const { env } = await fakeGitHub(source);
    const result = await run(["12"], env);
    expect(result.code).toBe(0);
    savedSnapshot(result.stdout);
    expect(JSON.parse(result.stdout)).toMatchObject({
      relationships: {
        available: true,
        parent: null,
        children: { total: 0, open: 0, closed: 0 },
        blockers: { total: 0, open: 0, closed: 0 },
      },
    });
  });

  it("reads legacy content but requires a fresh snapshot for native relationships", async () => {
    const { file, snapshot } = await fixture();
    await writeFile(
      file,
      JSON.stringify({
        repository: snapshot.repository,
        fetchedAt: snapshot.fetchedAt,
        issue: snapshot.issue,
        comments: snapshot.comments,
      }),
    );
    const result = await run(["--snapshot", file]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      body: { totalCharacters: 20017 },
      relationships: { available: false },
    });
    for (const section of ["children", "parent", "blockers"]) {
      const missing = await run(["--snapshot", file, "--section", section]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("Fetch the issue again");
    }
  });

  it.each([
    ["children", "sub_issues?per_page=100"],
    ["parent", "parent"],
    ["blockers", "dependencies/blocked_by?per_page=100"],
  ])(
    "rejects an unavailable native %s lookup instead of reporting no links",
    async (section, suffix) => {
      const source = await fixture();
      const { env } = await fakeGitHub(source, {
        [`repos/owner/repo/issues/12/${suffix}`]: {
          body: { message: "Not Found", status: "404" },
          code: 1,
        },
      });
      const result = await run(["12", "--section", section], env);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Native ${section} lookup failed`);
    },
  );

  it.each([
    ["children", "sub_issues?per_page=100"],
    ["parent", "parent"],
    ["blockers", "dependencies/blocked_by?per_page=100"],
  ])("rejects malformed native %s data", async (section, suffix) => {
    const source = await fixture();
    const { env } = await fakeGitHub(source, {
      [`repos/owner/repo/issues/12/${suffix}`]: {
        body: { unexpected: "data" },
      },
    });
    const result = await run(["12", "--section", section], env);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid issue data");
  });

  it("rejects unbounded limits and unknown comment IDs", async () => {
    const { file } = await fixture();
    expect((await run(["--snapshot", file, "--limit", "999999"])).code).toBe(1);
    expect(
      (await run(["--snapshot", file, "--comment", "999999"])).stderr,
    ).toContain("Comment ID not found");
  });
});
