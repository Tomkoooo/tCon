#!/usr/bin/env node
// Print the CHANGELOG.md section for a version (used as the GitHub release body).
//   node scripts/release-notes.mjs 0.1.0-alpha.1
// Falls back to a generic text when the version has no section.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const REPO = "https://github.com/Tomkoooo/tCon";
const fallback = `tCon ${version}. Download the installer for your platform from the assets below.\n\nSee [CHANGELOG.md](${REPO}/blob/main/CHANGELOG.md) for details.`;

let text = "";
try {
  text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md"), "utf8");
} catch {
  /* no changelog: fall back */
}
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const m = new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]: |(?![\\s\\S]))`, "m").exec(text);
// drop the skeleton's empty bullets and the headings left without entries
const body = (m?.[1] ?? "")
  .replace(/^-\s*$/gm, "")
  .split(/(?=^### )/m)
  .filter((part) => !/^### /.test(part) || part.replace(/^### .*$/m, "").trim())
  .join("")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
process.stdout.write(`${body || fallback}\n`);
