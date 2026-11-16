import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { cachedTextReader } from "../src/core/file-text.js";
import { buildInventory, discoverCandidates } from "../src/core/inventory.js";
import { findIdentifiers, findMentions } from "../src/core/mentions.js";
import { resolveProjects } from "../src/core/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE = path.resolve(HERE, "fixtures", "realistic", "before");

afterEach(() => vi.restoreAllMocks());

describe("cachedTextReader", () => {
  it("reads a file once, normalizes line endings and returns undefined when unreadable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-text-"));
    try {
      const file = path.join(tmp, "a.ts");
      fs.writeFileSync(file, "one\r\ntwo\r\n");
      const read = cachedTextReader();
      expect(read(file)).toBe("one\ntwo\n");
      fs.writeFileSync(file, "changed");
      // Same path spelled differently is the same entry.
      expect(read(path.join(tmp, ".", "a.ts"))).toBe("one\ntwo\n");
      expect(read(path.join(tmp, "missing.ts"))).toBeUndefined();
      expect(cachedTextReader()(file)).toBe("changed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("one workspace", () => {
  it("shares one reader across its projects", () => {
    const projects = resolveProjects(loadConfig({ quiet: true }, BEFORE));
    expect(projects.length).toBeGreaterThan(1);
    expect(new Set(projects.map(({ ctx }) => ctx.text)).size).toBe(1);
  });

  it("reads each project file once across discovery, inventory and the leftovers scans", async () => {
    const projects = resolveProjects(loadConfig({ quiet: true }, BEFORE));
    const spy = vi.spyOn(fs, "readFileSync");
    const contexts = projects.map(({ ctx }) => ctx);
    await discoverCandidates(projects);
    await buildInventory(projects);
    findMentions(contexts, ["NewCheckout"], [], { comments: true });
    findIdentifiers(contexts, ["NewCheckout"]);

    const projectFiles = new Set(contexts.flatMap((ctx) => ctx.files));
    const reads = new Map<string, number>();
    for (const [file] of spy.mock.calls) {
      if (typeof file !== "string" || !projectFiles.has(file)) continue;
      reads.set(file, (reads.get(file) ?? 0) + 1);
    }
    expect(reads.size).toBeGreaterThan(0);
    expect([...reads].filter(([, n]) => n > 1)).toEqual([]);
  });
});
