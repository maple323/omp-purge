/**
 * CWD 指令扫描 + workspace policy（移植自 dsh-purge rules.js）。
 *
 * 扫 cwd → repo root 的 AGENTS.md / CLAUDE.md / *.local.md，供配置勾选参与注入；
 * workspace policy 决定 DSH 原生 workspace 段是否保留（strict/fallback/always）。
 */
import fs from "node:fs";
import path from "node:path";
import { rulesDir, atomicWrite, ensureDir, readText } from "../paths.ts";

const CWD_CANDIDATE_FILES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"];
const PROJECT_ROOT_MARKERS = [".git", ".hg", ".svn"];
export const WORKSPACE_POLICIES = ["fallback", "strict", "always"] as const;
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number];
const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = "fallback";
const MAX_CWD_WALK_DEPTH = 32;
const MAX_LOCAL_INJECT_BYTES = 512 * 1024;

function cwdSelectionsPath(cwd: string): string {
  return path.join(rulesDir(cwd), "cwd-selections.json");
}
function workspacePolicyPath(cwd: string): string {
  return path.join(rulesDir(cwd), "workspace-policy.json");
}

/** 向上走到第一个含 .git/.hg/.svn 的目录；返回 [root ... cwd]。 */
export function ancestorChainForCwd(cwd: string): string[] {
  if (!cwd) return [];
  const normalized = path.resolve(cwd);
  let root: string | null = null;
  let cur = normalized;
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        if (fs.existsSync(path.join(cur, marker))) {
          root = cur;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (root) break;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  const chain: string[] = [];
  const pushed = new Set<string>();
  const stopAt = root ? path.resolve(root) : normalized;
  let walker = normalized;
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    if (!pushed.has(walker)) {
      chain.push(walker);
      pushed.add(walker);
    }
    if (walker === stopAt) break;
    const parent = path.dirname(walker);
    if (!parent || parent === walker) break;
    walker = parent;
  }
  return chain.reverse();
}

export interface CwdCandidate {
  path: string;
  name: string;
  dir: string;
  scope: "cwd" | "root" | "ancestor";
  size: number;
  mtime: number;
  preview: string;
}

export function scanCwdInstructions(cwd: string): CwdCandidate[] {
  const out: CwdCandidate[] = [];
  if (!cwd) return out;
  const chain = ancestorChainForCwd(cwd);
  const seen = new Set<string>();
  const leaf = path.resolve(cwd);
  for (const dir of chain) {
    for (const name of CWD_CANDIDATE_FILES) {
      const fp = path.join(dir, name);
      if (seen.has(fp)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fp);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seen.add(fp);
      let preview = "";
      try {
        preview = readText(fp).replace(/\s+/g, " ").trim().slice(0, 160);
      } catch {
        /* ignore */
      }
      const scope: CwdCandidate["scope"] = dir === leaf ? "cwd" : dir === chain[0] ? "root" : "ancestor";
      out.push({ path: fp, name, dir, scope, size: stat.size, mtime: stat.mtimeMs || 0, preview });
    }
  }
  return out;
}

export function readWorkspacePolicy(cwd: string): WorkspacePolicy {
  try {
    const parsed = JSON.parse(readText(workspacePolicyPath(cwd)));
    const policy = parsed?.policy;
    if (typeof policy === "string" && (WORKSPACE_POLICIES as readonly string[]).includes(policy)) {
      return policy as WorkspacePolicy;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_WORKSPACE_POLICY;
}

export function writeWorkspacePolicy(cwd: string, policy: WorkspacePolicy): WorkspacePolicy {
  if (!(WORKSPACE_POLICIES as readonly string[]).includes(policy)) {
    throw new Error(`invalid workspace policy: ${policy}`);
  }
  const fp = workspacePolicyPath(cwd);
  ensureDir(path.dirname(fp));
  atomicWrite(fp, JSON.stringify({ policy }, null, 2));
  return policy;
}

function normalizeSelectionList(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(input) ? input : []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const abs = path.resolve(trimmed);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export function readCwdSelections(cwd: string): string[] {
  try {
    return normalizeSelectionList(JSON.parse(readText(cwdSelectionsPath(cwd)))?.paths);
  } catch {
    return [];
  }
}

export function writeCwdSelections(cwd: string, paths: unknown): string[] {
  const unique = normalizeSelectionList(paths);
  const fp = cwdSelectionsPath(cwd);
  ensureDir(path.dirname(fp));
  atomicWrite(fp, JSON.stringify({ paths: unique }, null, 2));
  return unique;
}

/** 勾选的本地指令文件拼接内容；仅当文件仍在当前 cwd 扫描结果里才用；超 512KB 截断。 */
export function readSelectedCwdInject(cwdHome: string, cwd: string): string {
  const selections = readCwdSelections(cwdHome);
  if (selections.length === 0) return "";
  const candidates = cwd ? scanCwdInstructions(cwd) : [];
  const candidateSet = new Set(candidates.map((c) => c.path));
  const chosen = selections.filter((p) => candidateSet.has(p));
  if (chosen.length === 0) return "";
  const parts: string[] = [];
  let total = 0;
  for (const fp of chosen) {
    let text = "";
    try {
      text = readText(fp).trim();
    } catch {
      continue;
    }
    if (!text) continue;
    const header = `<!-- omp-purge:cwd-rule ${path.basename(fp)} -->`;
    const block = `${header}\n${text}`;
    total += Buffer.byteLength(block, "utf8");
    if (total > MAX_LOCAL_INJECT_BYTES) break;
    parts.push(block);
  }
  return parts.join("\n\n---\n\n");
}
