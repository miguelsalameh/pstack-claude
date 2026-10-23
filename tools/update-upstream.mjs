#!/usr/bin/env bun
// Bring the port up to upstream in one command, run by hand.
//
//   bun tools/update-upstream.mjs [<sha>] [--dry-run]
//   bun tools/update-upstream.mjs --continue
//
// Resolves upstream's default-branch HEAD (or <sha>), and for each component
// in tools/upstream.json whose upstream path changed since its pin, outside
// its exclude list, runs the tools/sync.mjs sync. --dry-run prints each sync's
// report and writes nothing. Otherwise it refuses a dirty tree, creates the
// branch upstream-sync/<short-sha>, syncs, and then does the follow-ups: a
// slash-command row in docs/reference.md for each new public skill (and none
// for a removed one), the counts and pins in tools/doc-facts.mjs, the
// upstream version labels, a patch bump of VERSION with a CHANGES.md entry
// from the sync report, bun tools/generate.mjs, bun test tests/, and one
// commit. It never pushes.
//
// A sync failure (denylist hit, undeclared fork, collision) stops the run.
// Conflicts stop it too, after the sync has written them with git's markers:
// resolve each, then run --continue, which does the follow-ups. So does a
// failing generator or test run once fixed. The sync report waits in the git
// directory between the two runs.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DOC_FILES, docFacts, factValues, stampDocFacts } from "./doc-facts.mjs";
import { agentSkills, COMMAND_TABLE_HEADER, COMMANDS_DOC, slashCommands, tableRows } from "./generate.mjs";
import { SKILLS } from "./plugin.mjs";
import { isExcluded, runSync } from "./sync.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

// The components whose upstream path changed between their pin and `target`,
// counting only paths the port carries.
export function changedComponents(clone, components, target) {
  return Object.entries(components)
    .filter(([, { sha, upstreamPath, exclude = [] }]) =>
      git(clone, ["diff", "--name-only", "-z", sha, target, "--", upstreamPath])
        .split("\0")
        .filter(Boolean)
        .some((path) => !isExcluded(relative(upstreamPath, path), exclude)),
    )
    .map(([name]) => name);
}

// A slash-menu line from a skill description: its first sentence, starting
// lower case unless it opens on an acronym, without the closing period.
export function menuText(description) {
  const [sentence] = description.trim().split(/(?<=[.!?])\s+/);
  const text = sentence.replace(/\.$/, "");
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

// Adds a row at the end of the slash-command table for each public skill
// without one, and drops each row whose skill is gone, keeping the rest in
// their editorial order. `skills` are agentSkills() entries.
export function syncCommandRows(markdown, skills) {
  const lines = markdown.split("\n");
  const range = tableRows(COMMAND_TABLE_HEADER, "|")(lines);
  if (!range) throw new Error(`${COMMANDS_DOC}: "${COMMAND_TABLE_HEADER}" table header not found`);
  const publicSkills = skills.filter((skill) => skill.userInvocable);
  const names = new Set(publicSkills.map(({ name }) => name));
  const rowName = (line) => line.match(/^\| `\/([^`]+)` \|/)?.[1];
  const rows = lines.slice(...range);
  const kept = rows.filter((line) => names.has(rowName(line)));
  const listed = new Set(rows.map(rowName));
  const added = publicSkills.filter(({ name }) => !listed.has(name));
  const removed = rows.map(rowName).filter((name) => !names.has(name));
  const newRows = added.map(({ name, description }) => `| \`/${name}\` | ${menuText(description)} |`);
  lines.splice(range[0], range[1] - range[0], ...kept, ...newRows);
  return { markdown: lines.join("\n"), added: added.map(({ name }) => name), removed };
}

// The upstream release each documented pin names, read from the component's
// plugin manifest at the synced SHA.
const VERSION_LABELS = {
  pstack: /(?<=synced against upstream `[0-9a-f]+` \(v)\d+\.\d+\.\d+(?= and later\))/g,
  thermos: /(?<=synced against `[0-9a-f]+` \(thermos )\d+\.\d+\.\d+(?=\))/g,
};

export function stampVersionLabels(text, versions) {
  return Object.entries(versions).reduce(
    (out, [component, version]) => (VERSION_LABELS[component] && version ? out.replace(VERSION_LABELS[component], version) : out),
    text,
  );
}

export function nextPatch(version) {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`VERSION must be MAJOR.MINOR.PATCH, got "${version.trim()}"`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

const short = (sha) => sha.slice(0, 7);
const codeJoin = (items) => items.map((item) => `\`${item}\``).join(", ");

export function releaseTitle({ target, syncs, commands }) {
  const lead = syncs.find((s) => s.component === "pstack") ?? syncs[0];
  const version = lead.upstreamVersion ? ` (v${lead.upstreamVersion})` : "";
  const adds = commands.added.length ? `: add ${commands.added.map((name) => `/${name}`).join(", ")}` : "";
  return `Sync to upstream ${short(target)}${version}${adds}`;
}

// The CHANGES.md entry for a sync: one paragraph per component naming the
// pin it moved from, and the files the sync added, updated, merged, deleted,
// or left port-only. Files under a new skill's directory are counted under the
// skill rather than listed.
export function changesEntry({ version, target, syncs, commands, newSkills }) {
  const lines = [`## ${version} - ${releaseTitle({ target, syncs, commands })}`, ""];
  const skillOf = (path) => path.startsWith(`${SKILLS}/`) && path.slice(SKILLS.length + 1).split("/")[0];
  for (const sync of syncs) {
    const label = sync.upstreamVersion ? ` (${sync.component === "pstack" ? "v" : `${sync.component} `}${sync.upstreamVersion})` : "";
    const sentences = [`Syncs \`${sync.component}\` from upstream \`${short(sync.from)}\` to \`${short(target)}\`${label}.`];
    const byKind = (kind) => sync.written.filter((w) => w.kind === kind).map((w) => w.path);
    const added = byKind("added");
    const skills = newSkills.filter((name) => added.some((path) => skillOf(path) === name));
    for (const name of skills) {
      const files = added.filter((path) => skillOf(path) === name).length;
      sentences.push(`Adds the \`${name}\` skill (${files} file${files === 1 ? "" : "s"}).`);
    }
    const loose = added.filter((path) => !skills.includes(skillOf(path)));
    if (loose.length) sentences.push(`Added: ${codeJoin(loose)}.`);
    if (byKind("updated").length) sentences.push(`Updated to upstream's text: ${codeJoin(byKind("updated"))}.`);
    const merged = [...byKind("merged"), ...byKind("conflicted")];
    if (merged.length) sentences.push(`Merged with the port's forks: ${codeJoin(merged)}.`);
    if (sync.deleted.length) sentences.push(`Deleted with upstream: ${codeJoin(sync.deleted)}.`);
    if (sync.portOnly.length) sentences.push(`Now port-only, since upstream deleted them and the port had edited them: ${codeJoin(sync.portOnly)}.`);
    lines.push(sentences.join(" "), "");
  }
  if (commands.added.length || commands.removed.length) {
    const parts = [];
    if (commands.added.length) parts.push(`adds a row for ${codeJoin(commands.added.map((n) => `/${n}`))}, from the first sentence of the skill's description`);
    if (commands.removed.length) parts.push(`drops the row for ${codeJoin(commands.removed.map((n) => `/${n}`))}`);
    lines.push(`The slash-command table in \`${COMMANDS_DOC}\` ${parts.join(" and ")}.`, "");
  }
  return lines.join("\n");
}

// Puts `entry` above the newest release, replacing an entry for the same
// version, so a rerun of --continue writes it once.
export function insertChangesEntry(changelog, entry) {
  const heading = entry.split("\n")[0];
  const version = heading.split(" ")[1];
  const lines = changelog.split("\n");
  const isRelease = (line) => /^## \d+\.\d+\.\d+ /.test(line);
  const existing = lines.findIndex((line) => line.startsWith(`## ${version} `));
  if (existing !== -1) {
    const next = lines.findIndex((line, i) => i > existing && isRelease(line));
    lines.splice(existing, (next === -1 ? lines.length : next) - existing);
  }
  const newest = lines.findIndex(isRelease);
  const at = newest === -1 ? lines.length : newest;
  lines.splice(at, 0, ...entry.replace(/\n*$/, "\n").split("\n"));
  return lines.join("\n");
}

const CONFLICT_MARKER = /^(<<<<<<< local|=======|>>>>>>> upstream)$/m;

function stateFile() {
  return resolve(repo, git(repo, ["rev-parse", "--git-path", "pstack-update-upstream.json"]));
}

// Thrown rather than exiting, so the scratch clone's cleanup still runs.
function fail(message) {
  throw new Error(message);
}

function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, { cwd: repo, stdio: "inherit" }).status === 0;
}

function syncStep({ clone, target, components, dryRun }) {
  const upstream = JSON.parse(readFileSync(join(repo, "tools/upstream.json"), "utf8"));
  const changed = changedComponents(clone, upstream.components, target);
  if (!changed.length) {
    console.log(`already current: no component's upstream path changed between its pin and ${short(target)}`);
    return null;
  }
  const branch = `upstream-sync/${short(target)}`;
  if (!dryRun) {
    if (spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
      fail(`branch ${branch} already exists; delete it or check it out and run --continue`);
    }
    git(repo, ["checkout", "-b", branch]);
  }
  const base = git(repo, ["rev-parse", "HEAD"]);
  const descriptions = Object.fromEntries(agentSkills(join(repo, SKILLS)).map(({ name, description }) => [name, description]));
  const syncs = [];
  for (const component of changed) {
    const { sha: from, upstreamPath, localPath } = components[component];
    console.log(`\n== ${component}: ${short(from)} -> ${short(target)}`);
    const { report, failed } = runSync({ component, newSha: target, dryRun, clone, nextSteps: false });
    if (failed) {
      fail(
        `the ${component} sync failed on the FAIL lines above and wrote nothing for ${component}.` +
          (dryRun ? "" : ` Fix the cause on ${branch}, or abandon it, and rerun.`),
      );
    }
    const manifest = `${upstreamPath.split("/")[0]}/.cursor-plugin/plugin.json`;
    const shown = spawnSync("git", ["-C", clone, "show", `${target}:${manifest}`], { encoding: "utf8" });
    const at = (rel) => join(localPath, rel);
    syncs.push({
      component,
      from,
      upstreamVersion: shown.status === 0 ? JSON.parse(shown.stdout).version : null,
      written: report.written.map(({ kind, rel }) => ({ kind, path: at(rel) })),
      deleted: report.deleted.map(at),
      portOnly: report.conflicts.filter((c) => c.reason === "removed-upstream").map((c) => at(c.rel)),
      conflicts: report.conflicts.filter((c) => c.reason !== "removed-upstream").map((c) => ({ path: at(c.rel), reason: c.reason })),
      staleForks: report.stale.map(({ rel }) => at(rel)),
    });
  }
  if (dryRun) return null;
  // The skills before the sync, compared after it once any conflict in a
  // skill's frontmatter is resolved.
  return { branch, base, target, syncs, descriptions };
}

function finishStep(state) {
  const unresolved = state.syncs
    .flatMap((s) => s.conflicts)
    .filter(({ path }) => existsSync(join(repo, path)) && CONFLICT_MARKER.test(readFileSync(join(repo, path), "utf8")));
  if (unresolved.length) {
    fail(
      `resolve the conflict markers in each file, then run bun tools/update-upstream.mjs --continue:\n` +
        unresolved.map(({ path }) => `  ${path}`).join("\n"),
    );
  }

  const reference = join(repo, COMMANDS_DOC);
  const skills = agentSkills(join(repo, SKILLS));
  const before = state.descriptions;
  const newSkills = skills.filter(({ name }) => !Object.hasOwn(before, name)).map(({ name }) => name);
  const redescribed = skills
    .filter(({ name, description }) => Object.hasOwn(before, name) && before[name] !== description)
    .map(({ name }) => name);
  const commands = syncCommandRows(readFileSync(reference, "utf8"), skills);
  writeFileSync(reference, commands.markdown);
  try {
    slashCommands(commands.markdown, skills.filter((s) => s.userInvocable).map(({ name }) => name));
  } catch (error) {
    fail(`${error.message}\nEdit the row by hand, then run bun tools/update-upstream.mjs --continue`);
  }

  const facts = docFacts(repo);
  const versions = Object.fromEntries(state.syncs.map((s) => [s.component, s.upstreamVersion]));
  for (const file of DOC_FILES) {
    const path = join(repo, file);
    writeFileSync(path, stampVersionLabels(stampDocFacts(readFileSync(path, "utf8"), facts), versions));
  }
  const documentation = DOC_FILES.map((file) => readFileSync(join(repo, file), "utf8")).join("\n");
  const unstated = facts.filter((fact) => !factValues(documentation, fact).length).map((fact) => fact.name);
  if (unstated.length) fail(`no sentence in ${DOC_FILES.join(" or ")} states: ${unstated.join(", ")}`);

  const version = nextPatch(git(repo, ["show", `${state.base}:VERSION`]));
  writeFileSync(join(repo, "VERSION"), `${version}\n`);
  const entry = changesEntry({ version, target: state.target, syncs: state.syncs, commands, newSkills });
  const changelog = join(repo, "CHANGES.md");
  writeFileSync(changelog, insertChangesEntry(readFileSync(changelog, "utf8"), entry));

  const resume = "fix it, then run bun tools/update-upstream.mjs --continue";
  if (!run(process.execPath, ["tools/generate.mjs"])) fail(`bun tools/generate.mjs failed above; ${resume}`);
  if (!run(process.execPath, ["test", "tests/"])) fail(`bun test tests/ failed above; ${resume}`);

  git(repo, ["add", "-A"]);
  const subject = `${releaseTitle({ target: state.target, syncs: state.syncs, commands })}, release ${version}`;
  git(repo, ["commit", "--quiet", "-m", subject, "-m", entry.split("\n").slice(2).join("\n").trim()]);
  rmSync(stateFile(), { force: true });

  console.log(`\ncommitted on ${state.branch}: ${subject}`);
  const stale = state.syncs.flatMap((s) => s.staleForks);
  if (stale.length) {
    console.log("tools/forks.json entries upstream absorbed; delete each and amend the commit:");
    for (const path of stale) console.log(`  ${path}`);
  }
  if (commands.added.length) console.log(`review the new ${COMMANDS_DOC} rows and move each to its place: ${commands.added.join(", ")}`);
  if (redescribed.length) console.log(`upstream rewrote these skills' descriptions; check their ${COMMANDS_DOC} rows: ${redescribed.join(", ")}`);
  console.log("review the CHANGES.md entry, then push the branch and open a PR yourself");
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const resume = args.includes("--continue");
  const rest = args.filter((a) => a !== "--dry-run" && a !== "--continue");
  const [sha, ...stray] = rest;
  if (stray.length || (sha && !/^[0-9a-f]{7,40}$/.test(sha)) || (resume && (dryRun || sha))) {
    console.error("usage: bun tools/update-upstream.mjs [<sha>] [--dry-run]\n       bun tools/update-upstream.mjs --continue");
    process.exit(2);
  }

  if (resume) {
    if (!existsSync(stateFile())) fail("no sync waits for --continue; run bun tools/update-upstream.mjs first");
    const state = JSON.parse(readFileSync(stateFile(), "utf8"));
    const branch = git(repo, ["branch", "--show-current"]);
    if (branch !== state.branch) fail(`the waiting sync is on ${state.branch}, but ${branch || "a detached HEAD"} is checked out`);
    finishStep(state);
    return;
  }

  if (!dryRun && git(repo, ["status", "--porcelain"])) fail("the working tree has changes; commit or stash them first");
  if (!dryRun && existsSync(stateFile())) fail("a sync waits for --continue; finish it, or delete " + relative(repo, stateFile()));
  const upstream = JSON.parse(readFileSync(join(repo, "tools/upstream.json"), "utf8"));
  const scratch = mkdtempSync(join(tmpdir(), "pstack-update-"));
  let state;
  try {
    const clone = join(scratch, "clone");
    console.log(`cloning ${upstream.remote} ...`);
    git(scratch, ["clone", "--quiet", "--filter=blob:none", upstream.remote, clone]);
    const target = git(clone, ["rev-parse", "--verify", `${sha ?? "HEAD"}^{commit}`]);
    console.log(`target: ${target}${sha ? "" : " (upstream HEAD)"}`);
    state = syncStep({ clone, target, components: upstream.components, dryRun });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!state) return;
  writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");
  const conflicts = state.syncs.flatMap((s) => s.conflicts);
  if (conflicts.length) {
    fail(
      `the sync left files that need a human on ${state.branch} (a conflict is written with git's markers); ` +
        `resolve each, then run bun tools/update-upstream.mjs --continue:\n` +
        conflicts.map(({ path, reason }) => `  ${path} (${reason})`).join("\n"),
    );
  }
  finishStep(state);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`\nSTOP: ${error.message}`);
    process.exit(1);
  }
}
