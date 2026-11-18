import { describe, expect, it } from "bun:test";

import {
  type PlannedPackage, buildBatches, bumpKind, commitMessage, familyOf,
  parseVersion, rewriteConstraint, riskOf, skipReason,
} from "./core.ts";

const pkg = (name: string, from: string, to: string, type: "runtime" | "dev" = "runtime", importers = 0): PlannedPackage => {
  const bump = bumpKind(from, to)!;
  return { name, type, from, to, bump, risk: riskOf(type, bump, name), importers };
};

describe("versions", () => {
  it("marks semver and PEP 440 prereleases, and keeps post releases", () => {
    expect(parseVersion("1.0.0-rc.1")?.prerelease).toBe(true);
    expect(parseVersion("2.0.0rc1")?.prerelease).toBe(true);
    expect(parseVersion("8.0.0-rc.34")?.prerelease).toBe(true);
    expect(parseVersion("1.0.post1")?.prerelease).toBe(false);
    expect(parseVersion("v1.2.3+build")?.prerelease).toBe(false);
    expect(parseVersion("2.1")?.nums).toEqual([2, 1, 0]);
  });

  it("treats a 0.x minor and a 0.0.x patch as major", () => {
    expect(bumpKind("1.2.3", "1.2.9")).toBe("patch");
    expect(bumpKind("1.2.3", "1.4.0")).toBe("minor");
    expect(bumpKind("1.2.3", "2.0.0")).toBe("major");
    expect(bumpKind("0.545.0", "0.546.0")).toBe("major");
    expect(bumpKind("0.0.3", "0.0.4")).toBe("major");
    expect(bumpKind("v0.3.1", "v0.3.2")).toBe("patch");
  });
});

describe("risk and skips", () => {
  it("rates by type, bump, and package", () => {
    expect(riskOf("dev", "minor", "prettier")).toBe("low");
    expect(riskOf("runtime", "patch", "hono")).toBe("low");
    expect(riskOf("runtime", "minor", "hono")).toBe("medium");
    expect(riskOf("dev", "major", "eslint")).toBe("medium");
    expect(riskOf("runtime", "major", "zod")).toBe("high");
    expect(riskOf("dev", "major", "vite")).toBe("high");
    expect(riskOf("dev", "minor", "typescript")).toBe("high");
  });

  it("skips prereleases and ranges it cannot rewrite", () => {
    const base = { name: "x", type: "runtime" as const, current: "1.0.0", latest: "2.0.0" };
    expect(skipReason(base)).toBeNull();
    expect(skipReason({ ...base, latest: "2.0.0-beta.1" })).toContain("prerelease");
    expect(skipReason({ ...base, current: "1.0.0-alpha" })).toContain("prerelease");
    expect(skipReason({ ...base, spec: "workspace:*" })).toContain("not a simple");
    expect(skipReason({ ...base, spec: ">=1 <3" })).toContain("not a simple");
    expect(skipReason({ ...base, spec: "^1.0.0" })).toBeNull();
    expect(skipReason({ ...base, spec: "~> 1.0" })).toBeNull();
    expect(skipReason({ ...base, latest: "1.0.0" })).toContain("not newer");
  });
});

describe("rewriteConstraint", () => {
  it("keeps the operator and the precision", () => {
    expect(rewriteConstraint("^1.2.3", "2.0.1")).toBe("^2.0.1");
    expect(rewriteConstraint("~7.5.0", "7.8.6")).toBe("~7.8.6");
    expect(rewriteConstraint("2.1.1", "2.1.3")).toBe("2.1.3");
    expect(rewriteConstraint("~> 7.0", "8.0.1")).toBe("~> 8.0");
    expect(rewriteConstraint(">=1.2", "2.4.0")).toBe(">=2.4");
    expect(rewriteConstraint("==1.2.3", "1.3.0")).toBe("==1.3.0");
    expect(rewriteConstraint("1.0", "2.3.4")).toBe("2.3");
  });
});

describe("buildBatches", () => {
  it("groups families, isolates majors and TypeScript minors, and orders by risk", () => {
    expect(familyOf("@types/react-dom")).toBe("react");
    expect(familyOf("@react-router/dev")).toBe("react-router");
    expect(familyOf("@types/babel__core")).toBe("babel");

    const batches = buildBatches([
      pkg("react-router", "7.12.0", "8.5.2", "runtime", 60),
      pkg("@react-router/dev", "7.12.0", "8.5.2", "dev", 3),
      pkg("zod", "3.25.76", "4.6.7", "runtime", 38),
      pkg("lint-staged", "16.2.7", "17.6.1", "dev"),
      pkg("prettier", "3.8.1", "3.10.1", "dev"),
      pkg("typescript", "5.9.3", "5.10.0", "dev"),
      pkg("sonner", "2.0.7", "2.0.8"),
      pkg("hono", "4.12.15", "4.13.19"),
    ]);
    expect(batches.map((b) => [b.id, b.kind, b.packages.map((p) => p.name)])).toEqual([
      [1, "dev-minor", ["prettier"]],
      [2, "runtime-patch", ["sonner"]],
      [3, "runtime-minor", ["hono"]],
      [4, "isolated", ["lint-staged"]],
      [5, "isolated", ["zod"]],
      [6, "isolated", ["typescript"]],
      [7, "isolated", ["@react-router/dev", "react-router"]],
    ]);
    expect(batches[6].label).toBe("react-router family to v8 (2 packages)");
  });
});

describe("commitMessage", () => {
  it("writes a conventional subject, one line per package, and the checks", () => {
    const [batch] = buildBatches([pkg("prettier", "3.8.1", "3.10.1", "dev"), pkg("globals", "16.1.0", "16.5.0", "dev")]);
    const message = commitMessage(batch, [{ name: "test", command: "bun run test", exitCode: 0, durationMs: 5 }]);
    expect(message).toBe(
      "chore(deps): bump 2 dev dependency patches and minors\n\n" +
        "- globals: 16.1.0 → 16.5.0 (minor, dev)\n" +
        "- prettier: 3.8.1 → 3.10.1 (minor, dev)\n\n" +
        "Verified: bun run test exit 0.\n",
    );
    const [major] = buildBatches([pkg("zod", "3.25.76", "4.6.7")]);
    expect(commitMessage(major, []).split("\n")[0]).toBe("chore(deps): bump zod from 3.25.76 to 4.6.7");
  });
});
