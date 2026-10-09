import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

const INDEX_PAGE_SIZE = 20;
const TITLE_LIMIT = 250;
const relatedIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
});
const relationshipsSchema = z.object({
  children: z.array(relatedIssueSchema),
  parent: relatedIssueSchema.nullable(),
  blockers: z.array(relatedIssueSchema),
});
const noParentSchema = z.object({
  message: z.literal("No parent issue found"),
  status: z.literal("404"),
});
const commentSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
});
const snapshotSchema = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  fetchedAt: z.string().datetime(),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    html_url: z.string().url(),
    state: z.string(),
    body: z.string().nullable(),
    labels: z.array(z.object({ name: z.string() })),
    comments: z.number().int().nonnegative(),
  }),
  comments: z.array(commentSchema),
  relationships: relationshipsSchema.optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type RelatedIssue = z.infer<typeof relatedIssueSchema>;
type RelationshipSection = keyof z.infer<typeof relationshipsSchema>;

async function github(
  args: string[],
  relationship?: RelationshipSection,
): Promise<unknown> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const failure = relationship
    ? `Native ${relationship} lookup failed. Check gh authentication and repository access.`
    : "GitHub read failed. Check gh authentication and repository access.";
  let response: unknown;
  try {
    response = JSON.parse(output);
  } catch {
    throw new Error(code === 0 ? "Invalid GitHub response." : failure);
  }
  if (code !== 0) {
    if (relationship === "parent" && noParentSchema.safeParse(response).success)
      return null;
    throw new Error(failure);
  }
  return response;
}

async function fetchSnapshot(
  issue: number,
  repository?: string,
): Promise<Snapshot> {
  const repo = snapshotSchema.shape.repository.parse(
    repository ??
      z
        .object({ nameWithOwner: z.string() })
        .parse(await github(["repo", "view", "--json", "nameWithOwner"]))
        .nameWithOwner,
  );
  const endpoint = `repos/${repo}/issues/${issue}`;
  const [metadata, comments, children, parent, blockers] = await Promise.all([
    github(["api", endpoint]),
    github([
      "api",
      `${endpoint}/comments?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
    github(
      ["api", `${endpoint}/sub_issues?per_page=100`, "--paginate", "--slurp"],
      "children",
    ),
    github(["api", `${endpoint}/parent`], "parent"),
    github(
      [
        "api",
        `${endpoint}/dependencies/blocked_by?per_page=100`,
        "--paginate",
        "--slurp",
      ],
      "blockers",
    ),
  ]);
  const issuePages = z.array(z.array(relatedIssueSchema)).min(1);
  return snapshotSchema.parse({
    repository: repo,
    fetchedAt: new Date().toISOString(),
    issue: metadata,
    comments: z.array(z.array(commentSchema)).parse(comments).flat(),
    relationships: {
      children: issuePages.parse(children).flat(),
      parent,
      blockers: issuePages.parse(blockers).flat(),
    },
  });
}

function excerpt(text: string, offset: number, limit: number) {
  return {
    text: text.slice(offset, offset + limit),
    totalCharacters: text.length,
    offset,
    nextOffset: offset + limit < text.length ? offset + limit : null,
  };
}

function renderRelatedIssue(issue: RelatedIssue) {
  return {
    number: issue.number,
    title: excerpt(issue.title, 0, TITLE_LIMIT),
    state: issue.state,
    url: issue.html_url,
  };
}

function relationshipCounts(issues: RelatedIssue[]) {
  const open = issues.filter((issue) => issue.state === "open").length;
  return { total: issues.length, open, closed: issues.length - open };
}

function relationshipPage(issues: RelatedIssue[], offset: number) {
  return {
    ...relationshipCounts(issues),
    offset,
    nextOffset:
      offset + INDEX_PAGE_SIZE < issues.length
        ? offset + INDEX_PAGE_SIZE
        : null,
    entries: issues
      .slice(offset, offset + INDEX_PAGE_SIZE)
      .map(renderRelatedIssue),
  };
}

function render(
  snapshot: Snapshot,
  section: string,
  offset: number,
  limit: number,
  comment?: number,
) {
  if (comment !== undefined) {
    const selected = snapshot.comments.find((entry) => entry.id === comment);
    if (!selected) throw new Error("Comment ID not found in this snapshot.");
    return {
      id: selected.id,
      url: selected.html_url,
      body: excerpt(selected.body ?? "", offset, limit),
    };
  }
  if (section === "body")
    return { body: excerpt(snapshot.issue.body ?? "", offset, limit) };
  const relationships = snapshot.relationships;
  if (
    section === "children" ||
    section === "parent" ||
    section === "blockers"
  ) {
    if (!relationships)
      throw new Error(
        "This snapshot has no native issue relationships. Fetch the issue again.",
      );
    if (section === "parent")
      return {
        parent: relationships.parent
          ? renderRelatedIssue(relationships.parent)
          : null,
      };
    return { [section]: relationshipPage(relationships[section], offset) };
  }
  const index = {
    total: snapshot.comments.length,
    nextOffset:
      offset + INDEX_PAGE_SIZE < snapshot.comments.length
        ? offset + INDEX_PAGE_SIZE
        : null,
    entries: snapshot.comments
      .slice(offset, offset + INDEX_PAGE_SIZE)
      .map((entry) => ({
        id: entry.id,
        preview: excerpt((entry.body ?? "").replace(/\s+/g, " "), 0, 100),
      })),
  };
  if (section === "comments") return { comments: index };
  return {
    url: snapshot.issue.html_url,
    title: excerpt(snapshot.issue.title, 0, TITLE_LIMIT),
    state: snapshot.issue.state,
    labels: snapshot.issue.labels
      .slice(0, 20)
      .map((label) => label.name.slice(0, 100)),
    omittedLabels: Math.max(0, snapshot.issue.labels.length - 20),
    body: excerpt(snapshot.issue.body ?? "", offset, limit),
    comments: index,
    sourceCommentCount: snapshot.issue.comments,
    relationships: relationships
      ? {
          available: true,
          parent: relationships.parent
            ? renderRelatedIssue(relationships.parent)
            : null,
          children: relationshipCounts(relationships.children),
          blockers: relationshipCounts(relationships.blockers),
        }
      : { available: false },
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      snapshot: { type: "string" },
      section: { type: "string", default: "summary" },
      comment: { type: "string" },
      offset: { type: "string", default: "0" },
      limit: { type: "string", default: "3500" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun /path/to/github-issue-reader/scripts/issue-read.ts <number> [--repo owner/repo] [--section summary|body|comments|children|parent|blockers]\nRun from the target project to infer its repository, or supply --repo.\nRead saved content: --snapshot <file> [--section summary|body|comments|children|parent|blockers] [--comment ID] [--offset N] [--limit 1..5000]\nBody/comment offsets count characters. Comment, child, and blocker index offsets count entries, with 20 entries per page. Body/comment excerpts default to 3500 characters; titles print up to 250 characters. Full content and native relationships are saved privately; omitted content is explicit. Only open blockers prevent work. Legacy snapshots need a fresh fetch for relationships.",
    );
    return;
  }
  const section = z
    .enum(["summary", "body", "comments", "children", "parent", "blockers"])
    .parse(values.section);
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .parse(values.offset);
  const limit = z.coerce.number().int().min(1).max(5000).parse(values.limit);
  const comment =
    values.comment === undefined
      ? undefined
      : z.coerce.number().int().positive().parse(values.comment);
  if (
    positionals.length > 1 ||
    (values.snapshot
      ? positionals.length !== 0 || values.repo !== undefined
      : positionals.length !== 1)
  )
    throw new Error(
      "Supply one issue number, or --snapshot without an issue number or --repo.",
    );
  let snapshot: Snapshot;
  let file = values.snapshot;
  if (file) {
    snapshot = snapshotSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } else {
    snapshot = await fetchSnapshot(
      z.coerce.number().int().positive().parse(positionals[0]),
      values.repo,
    );
    const root = path.join(tmpdir(), "github-issue-reader");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(root, "issue-"));
    await chmod(directory, 0o700);
    file = path.join(directory, "snapshot.json");
    await writeFile(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  }
  console.log(
    JSON.stringify(
      {
        snapshot: file,
        repository: snapshot.repository,
        fetchedAt: snapshot.fetchedAt,
        number: snapshot.issue.number,
        ...render(snapshot, section, offset, limit, comment),
      },
      null,
      2,
    ),
  );
}

await main().catch((error: unknown) => {
  console.error(
    error instanceof z.ZodError
      ? "Invalid issue data or arguments. Use --help."
      : error instanceof Error
        ? error.message
        : "Issue read failed.",
  );
  process.exitCode = 1;
});
