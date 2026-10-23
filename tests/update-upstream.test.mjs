import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOC_FILES, docFacts, stampDocFacts } from "../tools/doc-facts.mjs";
import { assertChangesHeading, slashCommands } from "../tools/generate.mjs";
import {
  changedComponents,
  changesEntry,
  insertChangesEntry,
  menuText,
  nextPatch,
  stampVersionLabels,
  syncCommandRows,
} from "../tools/update-upstream.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("menuText", () => {
  test("takes the first sentence, lower-cased, without its period", () => {
    const statechart =
      "Draw what an app's user sees as a Mermaid statechart from a TLA+ model. States are gray if they work. Use for /statechart.";
    expect(menuText(statechart)).toBe("draw what an app's user sees as a Mermaid statechart from a TLA+ model");
  });

  test("keeps an opening acronym", () => {
    expect(menuText("PR review canvas for the current branch.")).toBe("PR review canvas for the current branch");
  });
});

describe("syncCommandRows", () => {
  const table = [
    "# Reference",
    "",
    "| command | use it when |",
    "| --- | --- |",
    "| `/poteto-mode` | default entry point |",
    "| `/gone` | a skill upstream deleted |",
    "| `/how` | walk through a subsystem |",
    "",
    "after",
  ].join("\n");
  const skills = [
    { name: "how", description: "Walk through a subsystem.", userInvocable: true },
    { name: "poteto-mode", description: "Default entry point.", userInvocable: true },
    { name: "principle-x", description: "A leaf.", userInvocable: false },
    { name: "statechart", description: "Draw a statechart from a TLA+ model. More.", userInvocable: true },
  ];

  test("appends a row per new public skill and drops rows whose skill is gone, keeping the order", () => {
    const { markdown, added, removed } = syncCommandRows(table, skills);
    expect(added).toEqual(["statechart"]);
    expect(removed).toEqual(["gone"]);
    expect(markdown).toBe(
      [
        "# Reference",
        "",
        "| command | use it when |",
        "| --- | --- |",
        "| `/poteto-mode` | default entry point |",
        "| `/how` | walk through a subsystem |",
        "| `/statechart` | draw a statechart from a TLA+ model |",
        "",
        "after",
      ].join("\n"),
    );
    expect(slashCommands(markdown, ["how", "poteto-mode", "statechart"]).map((r) => r.name)).toEqual([
      "poteto-mode",
      "how",
      "statechart",
    ]);
  });

  test("leaves a table that matches the skills unchanged", () => {
    const once = syncCommandRows(table, skills).markdown;
    expect(syncCommandRows(once, skills)).toEqual({ markdown: once, added: [], removed: [] });
  });
});

describe("doc facts", () => {
  test("stamping the committed docs changes nothing", () => {
    const facts = docFacts(repoRoot);
    for (const file of DOC_FILES) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(stampDocFacts(text, facts)).toBe(text);
    }
  });

  test("stamping rewrites each stated count and pin to the tree's", () => {
    const facts = docFacts(repoRoot);
    const value = (name) => facts.find((f) => f.name === name).expected;
    const text =
      "The package includes 1 skill directories: 2 public skills and 3 `principle-*` references. " +
      "With pstack's 4 skills installed. The 5 `.codex-plugin/prompts` stubs. " +
      "The skill tree is synced against upstream `0000000` (v0.15.27 and later). " +
      "The thermos skills and agents are synced against `1111111` (thermos 1.0.0).";
    expect(stampDocFacts(text, facts)).toBe(
      `The package includes ${value("skill directory count")} skill directories: ` +
        `${value("public skill and stub counts")} public skills and ${value("principle leaf count")} \`principle-*\` references. ` +
        `With pstack's ${value("skill directory count")} skills installed. ` +
        `The ${value("public skill and stub counts")} \`.codex-plugin/prompts\` stubs. ` +
        `The skill tree is synced against upstream \`${value("pstack upstream pin")}\` (v0.15.27 and later). ` +
        `The thermos skills and agents are synced against \`${value("thermos upstream pin")}\` (thermos 1.0.0).`,
    );
  });

  test("the version labels follow each synced component's upstream release", () => {
    const text =
      "synced against upstream `8b3326d` (v0.15.27 and later). The thermos skills and agents are synced against `118e73b` (thermos 1.0.0).";
    expect(stampVersionLabels(text, { pstack: "0.15.30" })).toBe(
      "synced against upstream `8b3326d` (v0.15.30 and later). The thermos skills and agents are synced against `118e73b` (thermos 1.0.0).",
    );
    expect(stampVersionLabels(text, { thermos: "1.1.0", "cursor-team-kit": "2.0.0" })).toContain("(thermos 1.1.0)");
  });
});

describe("release", () => {
  test("nextPatch bumps the patch and rejects anything else", () => {
    expect(nextPatch("0.9.102\n")).toBe("0.9.103");
    expect(() => nextPatch("0.9")).toThrow("MAJOR.MINOR.PATCH");
  });

  const sync = {
    component: "pstack",
    from: "7b353f78f6ec193bdbe48ed8059444eb09b6878e",
    upstreamVersion: "0.15.30",
    written: [
      { kind: "updated", path: "plugins/pstack/skills/sharpen/SKILL.md" },
      { kind: "merged", path: "plugins/pstack/skills/poteto-help/SKILL.md" },
      { kind: "conflicted", path: "plugins/pstack/skills/ketchup/SKILL.md" },
      { kind: "added", path: "plugins/pstack/skills/statechart/SKILL.md" },
      { kind: "added", path: "plugins/pstack/skills/statechart/scripts/lib.mjs" },
      { kind: "added", path: "plugins/pstack/skills/how/references/new.md" },
    ],
    deleted: ["plugins/pstack/skills/old/SKILL.md"],
    portOnly: ["plugins/pstack/skills/kept/SKILL.md"],
    conflicts: [],
    staleForks: [],
  };
  const entry = changesEntry({
    version: "0.9.103",
    target: "8b3326d99fd4b993cb33a24dad8af03175c642c5",
    syncs: [sync],
    commands: { added: ["statechart"], removed: [] },
    newSkills: ["statechart"],
  });

  test("the CHANGES entry names the pins, the new skill, and every other file by outcome", () => {
    expect(entry).toBe(
      [
        "## 0.9.103 - Sync to upstream 8b3326d (v0.15.30): add /statechart",
        "",
        "Syncs `pstack` from upstream `7b353f7` to `8b3326d` (v0.15.30). " +
          "Adds the `statechart` skill (2 files). " +
          "Added: `plugins/pstack/skills/how/references/new.md`. " +
          "Updated to upstream's text: `plugins/pstack/skills/sharpen/SKILL.md`. " +
          "Merged with the port's forks: `plugins/pstack/skills/poteto-help/SKILL.md`, `plugins/pstack/skills/ketchup/SKILL.md`. " +
          "Deleted with upstream: `plugins/pstack/skills/old/SKILL.md`. " +
          "Now port-only, since upstream deleted them and the port had edited them: `plugins/pstack/skills/kept/SKILL.md`.",
        "",
        "The slash-command table in `docs/reference.md` adds a row for `/statechart`, from the first sentence of the skill's description.",
        "",
      ].join("\n"),
    );
  });

  test("the entry lands above the newest release, once, and passes the generator's heading check", () => {
    const changelog = "# CHANGES\n\nPreamble.\n\n## 0.9.102 - Older\n\nText.\n";
    const once = insertChangesEntry(changelog, entry);
    expect(once.indexOf("## 0.9.103")).toBeLessThan(once.indexOf("## 0.9.102"));
    expect(once.startsWith("# CHANGES\n\nPreamble.\n\n## 0.9.103 - ")).toBe(true);
    expect(insertChangesEntry(once, entry)).toBe(once);
    expect(() => assertChangesHeading(once, "0.9.103")).not.toThrow();
  });
});

describe("changedComponents", () => {
  test("counts a component only when a path it carries changed since its pin", () => {
    const repo = mkdtempSync(join(tmpdir(), "pstack-update-test-"));
    mkdirSync(join(repo, "a/skills"), { recursive: true });
    mkdirSync(join(repo, "b"), { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: process.env }).trim();
    git("init", "--quiet");
    const commit = () => {
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "c");
      return git("rev-parse", "HEAD");
    };
    writeFileSync(join(repo, "a/skills/x.md"), "1");
    writeFileSync(join(repo, "a/README.md"), "1");
    writeFileSync(join(repo, "b/y.md"), "1");
    const pin = commit();
    writeFileSync(join(repo, "a/README.md"), "2");
    const readmeOnly = commit();
    writeFileSync(join(repo, "b/y.md"), "2");
    const target = commit();
    const components = {
      a: { upstreamPath: "a", sha: pin, exclude: ["README.md"] },
      b: { upstreamPath: "b", sha: pin },
    };
    try {
      expect(changedComponents(repo, components, readmeOnly)).toEqual([]);
      expect(changedComponents(repo, components, target)).toEqual(["b"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
