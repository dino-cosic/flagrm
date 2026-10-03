/**
 * The `leftovers` check: no recorded name of the flag (`baseline.names`) is
 * left anywhere in the projects. Code and config fail; comments warn.
 */

import { FEATURE_MANAGEMENT_SECTION } from "../discover.js";
import { discoverCandidates } from "../inventory.js";
import { findIdentifiers, findMentions } from "../mentions.js";
import type { CheckFinding, CheckResult, FlagCandidateSource } from "../types.js";
import { relativePath } from "../util.js";
import { checkResult, configFindings, plural, type VerifyContext } from "./context.js";
import { deletedTextFindings } from "./deleted-text.js";

const STILL: Record<FlagCandidateSource, string> = {
  config: "still configured",
  attribute: "still gated by attribute",
  eval: "still evaluated",
  constant: "still defined",
  "object-key": "still defined",
};

export async function leftoversCheck(v: VerifyContext): Promise<CheckResult> {
  const byKind = (kind: string) => v.baseline.names.filter((n) => n.kind === kind).map((n) => n.name);
  const literals = byKind("literal");
  const contexts = v.projects.map((p) => p.ctx);
  const findings: CheckFinding[] = [];
  const seen = new Set<string>();
  const add = (f: CheckFinding) => {
    const key = `${f.file}:${f.line}:${f.severity}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (const m of findMentions(contexts, literals, byKind("alias"), { comments: true })) {
    add({
      severity: m.inComment ? "warn" : "fail",
      project: m.project,
      file: m.file,
      line: m.line,
      message: `${m.inComment ? "comment mentions" : "still references"} ${m.token}`,
    });
  }
  const hits = findIdentifiers(
    contexts,
    [...byKind("wrapper"), ...literals],
    // `FeatureManagement__Flag=true` configures the flag through an environment variable (.env, docker-compose);
    // `GetValue<bool>("FeatureManagement:Flag")` reads it by its section-qualified key.
    literals.flatMap((name) => [`${FEATURE_MANAGEMENT_SECTION}__${name}`, `${FEATURE_MANAGEMENT_SECTION}:${name}`]),
  );
  // A local, parameter or field the flag's value travelled through is only checked in its own file.
  const scopes = new Map<string, Set<string> | "everywhere">();
  for (const n of v.baseline.names.filter((x) => x.kind === "wrapper")) {
    const current = scopes.get(n.name);
    if (!n.file || current === "everywhere") scopes.set(n.name, "everywhere");
    else scopes.set(n.name, new Set([...(current ?? []), n.file]));
  }
  for (const hit of hits) {
    const isLiteral = literals.includes(hit.token);
    const scope = isLiteral ? "everywhere" : scopes.get(hit.token);
    if (scope instanceof Set && !scope.has(relativePath(v.root, hit.file))) continue;
    // A bare literal name in code is an identifier that merely shares the name; only its comments and
    // config keys (`new-checkout: true`) count.
    if (isLiteral && !hit.inComment && !hit.isConfigKey) continue;
    add({
      severity: hit.inComment ? "warn" : "fail",
      project: hit.project,
      file: hit.file,
      line: hit.line,
      message: `${hit.inComment ? "comment mentions" : "still references"} ${hit.token}`,
    });
  }
  // Discovery only: the inventory's reference counts would scan every file again for every flag.
  for (const c of (await discoverCandidates(v.projects)).filter((c) => c.flag === v.flag)) {
    add({
      severity: "fail",
      project: c.project,
      file: c.file,
      line: c.line,
      message: `${STILL[c.source]} ${c.symbol ?? c.flag}`,
    });
  }

  const fails = findings.filter((f) => f.severity === "fail").length;
  const warns = findings.length - fails;
  const summary =
    findings.length === 0
      ? "no recorded name left in code or config"
      : [fails && `${plural(fails, "reference")} left`, warns && `${plural(warns, "comment")} naming the flag`]
          .filter(Boolean)
          .join(", ");
  const offTests = deletedTextFindings(v);
  const offCount = offTests.filter((f) => f.severity === "warn").length;
  const withOff = offCount ? `${summary}; ${plural(offCount, "warning")} about tests of deleted text` : summary;
  return checkResult("leftovers", withOff, [...findings, ...offTests, ...configFindings(v, "leftovers")]);
}
