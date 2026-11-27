#!/usr/bin/env node
// Bump tCon's version everywhere it lives and open the CHANGELOG section for it.
//
//   npm run version:bump -- 0.2.0-alpha.1   explicit SemVer version
//   npm run version:bump -- alpha|beta|rc   next prerelease (alpha.1 -> alpha.2; 0.1.0 -> 0.1.1-alpha.1)
//   npm run version:bump -- patch|minor|major   bump that part, keep the prerelease channel (as .1)
//   npm run version:bump -- release         drop the prerelease tag (0.4.0-rc.2 -> 0.4.0)
//   npm run version:check                   fail if the files disagree
//
// Files: package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock,
// src-tauri/tauri.conf.json, CHANGELOG.md (the "Unreleased" notes move under the new version).
// No dependencies; add --dry-run to print what would change.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/Tomkoooo/tCon";
const CHANNELS = ["alpha", "beta", "rc"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;

const files = {
  pkg: "package.json",
  lock: "package-lock.json",
  cargo: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
  tauri: "src-tauri/tauri.conf.json",
  changelog: "CHANGELOG.md",
};
const read = (f) => readFileSync(join(root, f), "utf8");

function parse(v) {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], channel: m[4] ?? null, n: m[5] ? +m[5] : 0 };
}
const format = (p) => `${p.major}.${p.minor}.${p.patch}${p.channel ? `-${p.channel}.${p.n}` : ""}`;

function next(current, arg) {
  if (parse(arg)) return arg;
  const p = parse(current);
  if (!p) throw new Error(`current version ${current} is not of the form x.y.z or x.y.z-(alpha|beta|rc).N`);
  switch (arg) {
    case "major":
    case "minor":
    case "patch": {
      const q = { ...p, n: p.channel ? 1 : 0 };
      if (arg === "major") Object.assign(q, { major: p.major + 1, minor: 0, patch: 0 });
      if (arg === "minor") Object.assign(q, { minor: p.minor + 1, patch: 0 });
      if (arg === "patch") q.patch = p.patch + 1;
      return format(q);
    }
    case "alpha":
    case "beta":
    case "rc": {
      if (p.channel === arg) return format({ ...p, n: p.n + 1 });
      // moving up a channel on the same x.y.z (alpha -> beta -> rc)
      if (p.channel && CHANNELS.indexOf(arg) > CHANNELS.indexOf(p.channel)) return format({ ...p, channel: arg, n: 1 });
      // from a stable release (or backwards): start the next patch
      return format({ ...p, patch: p.patch + 1, channel: arg, n: 1 });
    }
    case "release":
      return format({ ...p, channel: null, n: 0 });
    default:
      throw new Error(`unknown bump "${arg}": use a version, major|minor|patch, alpha|beta|rc or release`);
  }
}

function currentVersions() {
  const lock = JSON.parse(read(files.lock));
  return {
    [files.pkg]: JSON.parse(read(files.pkg)).version,
    [files.lock]: lock.version,
    [`${files.lock} (packages[""])`]: lock.packages?.[""]?.version,
    [files.cargo]: /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(read(files.cargo))?.[1],
    [files.cargoLock]: /^name = "tcon"\nversion = "([^"]+)"/m.exec(read(files.cargoLock))?.[1],
    [files.tauri]: JSON.parse(read(files.tauri)).version,
  };
}

function check() {
  const v = currentVersions();
  const distinct = new Set(Object.values(v));
  if (distinct.size !== 1) {
    console.error("Versions are out of sync:");
    for (const [f, x] of Object.entries(v)) console.error(`  ${f}: ${x}`);
    process.exit(1);
  }
  const [only] = distinct;
  if (!parse(only)) {
    console.error(`Version ${only} does not follow x.y.z or x.y.z-(alpha|beta|rc).N`);
    process.exit(1);
  }
  console.log(only);
}

/** Replace exactly one match of `re` in `text`, or fail. */
function replaceOnce(text, re, by, what) {
  if (!re.test(text)) throw new Error(`could not find the version in ${what}`);
  return text.replace(re, by);
}

function changelog(text, version, prev) {
  const today = new Date().toISOString().slice(0, 10);
  if (text.includes(`## [${version}]`)) return text; // already has a section
  const head = /^## \[Unreleased\][^\n]*\n/m;
  if (!head.test(text)) throw new Error("CHANGELOG.md has no '## [Unreleased]' heading");
  const start = text.search(head);
  const afterHead = start + head.exec(text)[0].length;
  const nextSection = text.slice(afterHead).search(/^## \[|^\[[^\]]+\]: /m);
  const end = nextSection < 0 ? text.length : afterHead + nextSection;
  const unreleased = text.slice(afterHead, end).trim();
  const body = unreleased || "### Added\n\n- \n\n### Changed\n\n- \n\n### Fixed\n\n- ";
  let out = `${text.slice(0, start)}## [Unreleased]\n\n## [${version}] - ${today}\n\n${body}\n\n${text.slice(end)}`;
  // compare links at the bottom
  out = out.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${REPO}/compare/v${version}...HEAD`);
  if (!/^\[Unreleased\]: /m.test(out)) out = `${out.trimEnd()}\n\n[Unreleased]: ${REPO}/compare/v${version}...HEAD\n`;
  const link = prev && prev !== version ? `${REPO}/compare/v${prev}...v${version}` : `${REPO}/releases/tag/v${version}`;
  out = out.replace(/^(\[Unreleased\]: .*)$/m, `$1\n[${version}]: ${link}`);
  return out;
}

function bump(arg, dry) {
  const versions = currentVersions();
  const current = versions[files.tauri];
  const version = next(current, arg);
  if (!parse(version)) throw new Error(`${version} is not a valid tCon version`);

  const edits = {};
  const pkg = JSON.parse(read(files.pkg));
  pkg.version = version;
  edits[files.pkg] = `${JSON.stringify(pkg, null, 2)}\n`;

  const lock = JSON.parse(read(files.lock));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  edits[files.lock] = `${JSON.stringify(lock, null, 2)}\n`;

  edits[files.cargo] = replaceOnce(read(files.cargo), /^(\[package\][^[]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`, files.cargo);
  edits[files.cargoLock] = replaceOnce(read(files.cargoLock), /^(name = "tcon"\nversion = ")[^"]+(")/m, `$1${version}$2`, files.cargoLock);
  // tauri.conf.json: textual edit keeps the file's formatting
  edits[files.tauri] = replaceOnce(read(files.tauri), /^(  "version":\s*")[^"]+(")/m, `$1${version}$2`, files.tauri);
  edits[files.changelog] = changelog(read(files.changelog), version, current);

  for (const [f, text] of Object.entries(edits)) {
    if (dry) console.log(`would update ${f}`);
    else writeFileSync(join(root, f), text);
  }
  console.log(`${current} -> ${version}`);
  if (!dry) console.log(`Next: fill in the CHANGELOG section for ${version}, commit ("Release v${version}") and push to main.`);
}

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const arg = args.find((a) => !a.startsWith("--"));
try {
  if (args.includes("--check")) check();
  else if (!arg) {
    console.error("usage: npm run version:bump -- <version|major|minor|patch|alpha|beta|rc|release> [--dry-run]");
    process.exit(2);
  } else bump(arg, dry);
} catch (e) {
  console.error(`bump-version: ${e.message}`);
  process.exit(1);
}
