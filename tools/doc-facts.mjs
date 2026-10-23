// Documentation states counts and upstream pins in prose. Each fact here is
// derivable from the tree: tests/readme-facts.test.mjs fails when the prose
// disagrees, and tools/update-upstream.mjs rewrites the prose to match.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { agentSkills, publicSkills } from "./generate.mjs";
import { PLUGIN, SKILLS } from "./plugin.mjs";

export const DOC_FILES = ["README.md", "docs/reference.md"];

const shortSha = (sha) => sha.slice(0, 7);

// Each pattern matches only the value, through lookarounds, so a stamp
// replaces the match and leaves the prose around it alone.
export function docFacts(root) {
  const skillsDir = join(root, SKILLS);
  const total = agentSkills(skillsDir).length;
  const publicCount = publicSkills(skillsDir).length;
  const pins = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8")).components;
  return [
    {
      name: "skill directory count",
      expected: String(total),
      patterns: [/\d+(?= (?:skill directories|Agent Skills))/g, /(?<=pstack's )\d+(?= skills)/g],
    },
    {
      name: "public skill and stub counts",
      expected: String(publicCount),
      patterns: [
        /\d+(?= (?:are public workflows|public workflows|public skills|slash command stubs))/g,
        /(?<=The )\d+(?= `\.codex-plugin\/prompts)/g,
      ],
    },
    {
      name: "principle leaf count",
      expected: String(total - publicCount),
      patterns: [/\d+(?= `principle-\*`)/g],
    },
    {
      name: "pstack upstream pin",
      expected: shortSha(pins.pstack.sha),
      patterns: [/(?<=synced against upstream `)[0-9a-f]+(?=`)/g],
    },
    {
      name: "thermos upstream pin",
      expected: shortSha(pins.thermos.sha),
      patterns: [/(?<=thermos skills and agents are synced against `)[0-9a-f]+(?=`)/g],
    },
  ];
}

// Every value a fact's patterns find in `text`.
export function factValues(text, fact) {
  return fact.patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[0]));
}

export function stampDocFacts(text, facts) {
  return facts.reduce((out, fact) => fact.patterns.reduce((t, pattern) => t.replace(pattern, fact.expected), out), text);
}

export const promptStubCount = (root) =>
  readdirSync(join(root, PLUGIN, ".codex-plugin/prompts")).filter((f) => f.endsWith(".md")).length;
