/**
 * 规则集存储（移植自 dsh-purge rules.js）。
 *
 * 布局：<project>/.omp/rules/<id>.md + <id>.json + state.json
 * 激活时把规则内容写进目标 context-file（默认 <project>/.omp/AGENTS.md，OMP native 优先级 100）。
 */
import fs from "node:fs";
import path from "node:path";
import { rulesDir, atomicWrite, ensureDir, exists, readText } from "../paths.ts";

const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_RULE_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 64;

export const RULE_TARGETS = ["AGENTS.md", "CLAUDE.md"] as const;
export type RuleTarget = (typeof RULE_TARGETS)[number];
export const BACKUP_SUFFIX = ".omp-purge-rule.bak";

export interface RuleMeta {
  name: string;
  target: RuleTarget;
}

export interface RuleInfo {
  id: string;
  name: string;
  target: RuleTarget;
  size: number;
}

export function rulePath(cwd: string, id: string): string {
  return path.join(rulesDir(cwd), id + ".md");
}
export function ruleMetaPath(cwd: string, id: string): string {
  return path.join(rulesDir(cwd), id + ".json");
}
export function stateFile(cwd: string): string {
  return path.join(rulesDir(cwd), "state.json");
}

/** 目标 context-file 的绝对路径。 */
export function targetPath(cwd: string, target: RuleTarget): string {
  if (target === "CLAUDE.md") return path.join(path.resolve(cwd), ".claude", "CLAUDE.md");
  return path.join(path.resolve(cwd), ".omp", "AGENTS.md");
}

export function validRuleId(id: unknown): id is string {
  return typeof id === "string" && RULE_ID_RE.test(id);
}
export function validTarget(target: unknown): target is RuleTarget {
  return typeof target === "string" && (RULE_TARGETS as readonly string[]).includes(target);
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
}

function normalizeMeta(id: string, meta: Partial<RuleMeta> | null): RuleMeta {
  const name = typeof meta?.name === "string" && meta.name.trim()
    ? meta.name.trim().slice(0, MAX_NAME_LENGTH)
    : id;
  const target = validTarget(meta?.target) ? meta.target : "AGENTS.md";
  return { name, target };
}

export function readRuleMeta(cwd: string, id: string): RuleMeta {
  try {
    return normalizeMeta(id, JSON.parse(readText(ruleMetaPath(cwd, id))));
  } catch {
    return normalizeMeta(id, null);
  }
}

function writeRuleMeta(cwd: string, id: string, meta: Partial<RuleMeta>): void {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  ensureDir(rulesDir(cwd));
  atomicWrite(ruleMetaPath(cwd, id), JSON.stringify(normalizeMeta(id, meta), null, 2));
}

export function listRules(cwd: string): RuleInfo[] {
  const dir = rulesDir(cwd);
  const out: RuleInfo[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const id = e.name.slice(0, -3);
    if (!validRuleId(id)) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, e.name)).size;
    } catch {
      /* ignore */
    }
    const meta = readRuleMeta(cwd, id);
    out.push({ id, name: meta.name, target: meta.target, size });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function readRule(cwd: string, id: string): string | null {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  try {
    return fs.readFileSync(rulePath(cwd, id), "utf8");
  } catch {
    return null;
  }
}

export function saveRule(cwd: string, id: string, content: string, meta: Partial<RuleMeta> = {}): void {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  if (Buffer.byteLength(content, "utf8") > MAX_RULE_BYTES) throw new Error("rule too large (max 256KB)");
  ensureDir(rulesDir(cwd));
  atomicWrite(rulePath(cwd, id), content);
  writeRuleMeta(cwd, id, meta);
  if (readActive(cwd) === id) {
    // 已激活则同步刷新目标文件。
    const m = readRuleMeta(cwd, id);
    atomicWrite(targetPath(cwd, m.target), content);
  }
}

export function deleteRule(cwd: string, id: string): void {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  for (const fp of [rulePath(cwd, id), ruleMetaPath(cwd, id)]) {
    try {
      fs.unlinkSync(fp);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (readActive(cwd) === id) {
    try {
      fs.unlinkSync(stateFile(cwd));
    } catch {
      /* ignore */
    }
  }
}

export function readActive(cwd: string): string | null {
  try {
    const parsed = JSON.parse(readText(stateFile(cwd)));
    return typeof parsed?.active === "string" && validRuleId(parsed.active) ? parsed.active : null;
  } catch {
    return null;
  }
}

export function setActive(cwd: string, id: string): void {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  ensureDir(rulesDir(cwd));
  atomicWrite(stateFile(cwd), JSON.stringify({ active: id }, null, 2));
}

export interface RulesStatus {
  rules: RuleInfo[];
  active: string | null;
  active_target: RuleTarget | null;
  agents_path: string;
  agents_exists: boolean;
  agents_synced: boolean;
  rules_dir: string;
}

export function rulesStatus(cwd: string): RulesStatus {
  const listed = listRules(cwd);
  const active = readActive(cwd);
  let active_target: RuleTarget | null = null;
  let agents_path = targetPath(cwd, "AGENTS.md");
  let agents_exists = false;
  let agents_synced = false;
  if (active) {
    const meta = readRuleMeta(cwd, active);
    active_target = meta.target;
    agents_path = targetPath(cwd, meta.target);
    try {
      const content = fs.readFileSync(agents_path, "utf8");
      agents_exists = true;
      const rc = readRule(cwd, active);
      agents_synced = rc !== null && rc === content;
    } catch {
      /* not present */
    }
  }
  return {
    rules: listed,
    active,
    active_target,
    agents_path,
    agents_exists,
    agents_synced,
    rules_dir: rulesDir(cwd),
  };
}
