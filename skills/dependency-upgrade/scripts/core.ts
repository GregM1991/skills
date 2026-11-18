// Pure rules: version math, classification, batch order, and commit text.

export type DepType = "runtime" | "dev";
export type Bump = "patch" | "minor" | "major";
export type Risk = "low" | "medium" | "high";

/** One outdated direct dependency as reported by a package manager. */
export type Outdated = {
  name: string;
  type: DepType;
  current: string;
  latest: string;
  /** Version constraint written in the manifest, when the manager exposes it. */
  spec?: string;
  /** Adapter data that apply needs, such as the requirement file or dependency group. */
  meta?: Record<string, string>;
};

export type PlannedPackage = {
  name: string;
  type: DepType;
  from: string;
  to: string;
  bump: Bump;
  risk: Risk;
  spec?: string;
  meta?: Record<string, string>;
  importers: number | null;
  advisory?: string;
};

export type Skipped = { name: string; from: string; latest: string; reason: string };

export type BatchKind = "dev-minor" | "runtime-patch" | "runtime-minor" | "isolated";

export type Batch = {
  id: number;
  kind: BatchKind;
  label: string;
  risk: Risk;
  packages: PlannedPackage[];
};

export type Parsed = { nums: [number, number, number]; prerelease: boolean };

export function parseVersion(raw: string): Parsed | null {
  const match = raw.trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/);
  if (!match) return null;
  const rest = match[4] ?? "";
  // A dash suffix (semver) or a letter tag such as rc1, b2, dev0 (PEP 440) marks a prerelease.
  // Build metadata (+...) and Python post releases (.post1) do not.
  const prerelease = /^-/.test(rest) || /^(\.?(a|b|c|rc|alpha|beta|pre|preview|dev)\d*)/i.test(rest);
  return {
    nums: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  return 0;
}

/** Semver bump kind. Under 1.0.0 a minor change counts as major, like a caret range. */
export function bumpKind(from: string, to: string): Bump | null {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return null;
  const [aMaj, aMin, aPat] = a.nums;
  const [bMaj, bMin, bPat] = b.nums;
  if (bMaj !== aMaj) return "major";
  if (aMaj === 0 && bMin !== aMin) return "major";
  if (aMaj === 0 && aMin === 0 && bPat !== aPat) return "major";
  if (bMin !== aMin) return "minor";
  return "patch";
}

/** Frameworks and compilers that get their own batch for a major bump. */
const FRAMEWORKS = new Set([
  "react", "react-dom", "next", "vue", "nuxt", "svelte", "@sveltejs/kit", "astro",
  "@angular/core", "react-router", "@remix-run/react", "vite", "webpack", "typescript",
  "django", "flask", "fastapi", "rails", "tokio", "actix-web", "axum",
]);

export function isFramework(name: string): boolean {
  return FRAMEWORKS.has(name);
}

export function riskOf(type: DepType, bump: Bump, name: string): Risk {
  // TypeScript does not follow semver: a minor release can break the build.
  if (name === "typescript" && bump !== "patch") return "high";
  if (bump === "major") return type === "runtime" || isFramework(name) ? "high" : "medium";
  if (type === "dev") return "low";
  return bump === "minor" ? "medium" : "low";
}

const SIMPLE_SPEC = /^(\^|~|~>|>=|==|=|~=)?\s*v?\d+(\.\d+){0,2}([-.+][0-9A-Za-z.-]+)?$/;

/** Returns why a package cannot go into a batch, or null when it can. */
export function skipReason(item: Outdated): string | null {
  const current = parseVersion(item.current);
  const latest = parseVersion(item.latest);
  if (!current) return `current version "${item.current}" is not a release version`;
  if (!latest) return `latest version "${item.latest}" is not a release version`;
  if (current.prerelease) return "current version is a prerelease";
  if (latest.prerelease) return "latest version is a prerelease";
  if (compareVersions(item.latest, item.current) <= 0) return "latest is not newer than current";
  if (item.spec !== undefined && item.spec !== "" && !SIMPLE_SPEC.test(item.spec.trim()))
    return `manifest range "${item.spec}" is not a simple version range`;
  return null;
}

/** Keeps the operator and the precision of a constraint and puts in the new version. */
export function rewriteConstraint(constraint: string, version: string): string {
  const match = constraint.trim().match(/^(\^|~>|~=|~|>=|==|=)?(\s*)v?(\d+(?:\.\d+){0,2})(.*)$/);
  const clean = version.replace(/^v/, "");
  if (!match) return clean;
  const [, op = "", space, digits] = match;
  const precision = digits.split(".").length;
  const parsed = parseVersion(clean);
  const target = parsed && !/[-+]/.test(clean)
    ? parsed.nums.slice(0, precision).join(".")
    : clean;
  return `${op}${space}${target}`;
}

/**
 * Packages that must move together: `@types/x` joins `x`, `@scope/y` joins
 * the unscoped `scope` package, and react-dom joins react.
 */
export function familyOf(name: string): string {
  let base = name;
  const types = base.match(/^@types\/(.+)$/);
  if (types) base = types[1].includes("__") ? `@${types[1].replace("__", "/")}` : types[1];
  if (base === "react-dom") return "react";
  const scoped = base.match(/^@([^/]+)\//);
  return scoped ? scoped[1] : base;
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const maxRisk = (items: PlannedPackage[]): Risk =>
  items.reduce<Risk>((acc, p) => (RISK_RANK[p.risk] > RISK_RANK[acc] ? p.risk : acc), "low");
const byName = (a: PlannedPackage, b: PlannedPackage) => a.name.localeCompare(b.name);

/**
 * Fixed batch order:
 * 1. dev patches and minors, 2. runtime patches, 3. runtime minors,
 * 4+. each major family (and each TypeScript minor) alone, lowest risk first.
 */
export function buildBatches(packages: PlannedPackage[]): Batch[] {
  const isolated = (p: PlannedPackage) =>
    p.bump === "major" || (p.name === "typescript" && p.bump !== "patch");
  const devMinor = packages.filter((p) => !isolated(p) && p.type === "dev").sort(byName);
  const runtimePatch = packages
    .filter((p) => !isolated(p) && p.type === "runtime" && p.bump === "patch")
    .sort(byName);
  const runtimeMinor = packages
    .filter((p) => !isolated(p) && p.type === "runtime" && p.bump === "minor")
    .sort(byName);

  const families = new Map<string, PlannedPackage[]>();
  for (const p of packages.filter(isolated)) {
    const key = familyOf(p.name);
    families.set(key, [...(families.get(key) ?? []), p]);
  }
  const groups = [...families.entries()].map(([family, items]) => ({
    family,
    items: items.sort(byName),
    risk: maxRisk(items),
    framework: items.some((p) => isFramework(p.name)),
    importers: items.reduce((sum, p) => sum + (p.importers ?? 0), 0),
  }));
  groups.sort(
    (a, b) =>
      RISK_RANK[a.risk] - RISK_RANK[b.risk] ||
      Number(a.framework) - Number(b.framework) ||
      a.importers - b.importers ||
      a.family.localeCompare(b.family),
  );

  const batches: Omit<Batch, "id">[] = [];
  if (devMinor.length)
    batches.push({ kind: "dev-minor", label: "dev dependency patches and minors", risk: maxRisk(devMinor), packages: devMinor });
  if (runtimePatch.length)
    batches.push({ kind: "runtime-patch", label: "runtime dependency patches", risk: maxRisk(runtimePatch), packages: runtimePatch });
  if (runtimeMinor.length)
    batches.push({ kind: "runtime-minor", label: "runtime dependency minors", risk: maxRisk(runtimeMinor), packages: runtimeMinor });
  for (const group of groups) {
    const only = group.items.length === 1 ? group.items[0] : null;
    const top = group.items.map((p) => parseVersion(p.to)?.nums[0] ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const label = only
      ? `${only.name} ${only.from} → ${only.to} (${only.bump})`
      : `${group.family} family to v${top} (${group.items.length} packages)`;
    batches.push({ kind: "isolated", label, risk: group.risk, packages: group.items });
  }
  return batches.map((batch, index) => ({ id: index + 1, ...batch }));
}

export type CheckResult = { name: string; command: string; exitCode: number; durationMs: number };

/** Conventional Commit message. `chore(deps)` passes commitlint's conventional config. */
export function commitMessage(batch: Batch, checks: CheckResult[]): string {
  const only = batch.packages.length === 1 ? batch.packages[0] : null;
  const subject = only
    ? `chore(deps): bump ${only.name} from ${only.from} to ${only.to}`
    : batch.kind === "isolated"
      ? `chore(deps): bump ${batch.label.replace(/ \(.*\)$/, "")}`
      : `chore(deps): bump ${batch.packages.length} ${batch.label}`;
  const lines = batch.packages.map((p) => `- ${p.name}: ${p.from} → ${p.to} (${p.bump}${p.type === "dev" ? ", dev" : ""})`);
  const verified = checks.map((c) => `${c.command} exit ${c.exitCode}`).join(", ");
  return `${subject}\n\n${lines.join("\n")}\n\nVerified: ${verified}.\n`;
}
