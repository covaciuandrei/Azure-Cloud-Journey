import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { isMain } from "../review/data.js";

export function publicPathIssue(path: string): string | null {
  if (path.split("/").some((part) => part === "..") || path.startsWith("/")) return "Unexpected path";
  if (/^(?:\.data|\.firebase|\.playwright-mcp|\.test-output|node_modules|dist|dist-demo)\//.test(path)) return "Local data or build output";
  if (path.startsWith(".") && !path.startsWith(".github/") && ![".gitignore", ".firebaserc", ".env.example"].includes(path)) return "Unreviewed hidden file";
  if (/^public\/(?:content|data|teaching|courses|exams)\//.test(path)) return "Generated study content";
  if (/(^|\/)\.env(?:\.|$)/.test(path) && path !== ".env.example") return "Private environment file";
  if (/^tools\/firebase\/.+\.json$/.test(path) && path !== "tools/firebase/budget.json") return "Private Firebase report";
  if (/\.(?:log|pem|key|p12|db|sqlite|sqlite3)$/i.test(path) ||
      /(?:application_default_credentials|service[-_]account|credentials)\.json$/i.test(path)) return "Credential, log or database file";
  const allowed = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".html", ".svg", ".json", ".sh", ".yml", ".yaml", ".md", ".rules"]);
  if (!allowed.has(extname(path)) && ![".gitignore", ".firebaserc", ".env.example", "LICENSE"].includes(path)) return "Unreviewed file type";
  return null;
}

export function publicContentIssue(text: string): string | null {
  const patterns: Array<[string, RegExp]> = [
    ["Private key material", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
    ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
    ["OAuth token value", /["'](?:refresh_token|access_token|client_secret)["']\s*:\s*["'][A-Za-z0-9_.\/+-]{16,}["']/],
    ["Workstation-specific path", /\/(?:Users|home)\/(?!example(?:\/|$))[A-Za-z0-9_.-]+\//],
    ["Private administrative email", /\b[A-Za-z0-9._%+-]+@(?:gmail|outlook|yahoo)\.com\b/i],
  ];
  for (const [label, pattern] of patterns) if (pattern.test(text)) return label;
  return null;
}

export function checkPublication() {
  const files = execFileSync("git", ["ls-files", "--stage", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  if (!files.length) throw new Error("No tracked files. Stage the reviewed public source first.");
  const issues: string[] = [];
  let bytes = 0;
  for (const entry of files) {
    const [metadata, ...pathParts] = entry.split("\t");
    const path = pathParts.join("\t");
    if (!/^(100644|100755) [a-f0-9]+ 0$/.test(metadata ?? "")) {
      issues.push(`${path}: nonregular or conflicted Git entry`);
      continue;
    }
    const pathIssue = publicPathIssue(path);
    if (pathIssue) { issues.push(`${path}: ${pathIssue}`); continue; }
    const blob = execFileSync("git", ["cat-file", "blob", `:${path}`], { maxBuffer: 3 * 1024 * 1024 });
    bytes += blob.length;
    if (blob.length > 2 * 1024 * 1024 || blob.includes(0)) {
      issues.push(`${path}: large or binary content requires review`);
      continue;
    }
    const contentIssue = publicContentIssue(blob.toString("utf8"));
    if (contentIssue) issues.push(`${path}: ${contentIssue}`);
  }
  if (issues.length) throw new Error(`Public repository check blocked:\n${issues.join("\n")}`);
  return { files: files.length, bytes, status: "checked", note: "Checks tracked Git blobs, not ignored private files. Review content rights separately." };
}

if (isMain(import.meta.url)) console.log(JSON.stringify(checkPublication(), null, 2));
