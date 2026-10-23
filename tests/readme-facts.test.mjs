// Documentation states counts and the upstream pins in prose. Each is derivable from
// the tree, so this pins every occurrence to its source instead of trusting a
// hand edit to keep up. tools/update-upstream.mjs stamps the same facts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOC_FILES, docFacts, factValues, promptStubCount } from "../tools/doc-facts.mjs";
import { publicSkills } from "../tools/generate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const documentation = DOC_FILES.map((file) => readFileSync(join(repoRoot, file), "utf8")).join("\n");

describe("README and reference facts match the tree", () => {
  test.each(docFacts(repoRoot).map((fact) => [fact.name, fact]))("%s", (_, fact) => {
    const found = factValues(documentation, fact);
    expect(found.length).toBeGreaterThan(0);
    for (const value of found) expect(value).toBe(fact.expected);
  });

  test("one Codex prompt stub per public skill", () => {
    expect(promptStubCount(repoRoot)).toBe(publicSkills(join(repoRoot, "plugins/pstack/skills")).length);
  });
});
