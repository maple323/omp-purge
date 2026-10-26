/**
 * 规则激活 / 还原（移植自 dsh-purge rules.js 的 activateRule / resetToOriginal）。
 *
 * 激活 = 把 <rules>/<id>.md 内容写进目标 context-file；原文件先备份为 *.omp-purge-rule.bak。
 * 还原 = 用备份覆盖回去并删除备份；没有备份且内容仍是规则全文时直接删除目标文件。
 */
import fs from "node:fs";
import { atomicWrite, exists, readText } from "../paths.ts";
import {
  BACKUP_SUFFIX,
  RULE_TARGETS,
  readActive,
  readRule,
  readRuleMeta,
  setActive,
  stateFile,
  targetPath,
  type RuleMeta,
} from "./store.ts";

/** 激活规则：备份原目标 → 写入规则全文 → 记录 active。 */
export function activateRule(cwd: string, id: string): RuleMeta {
  const content = readRule(cwd, id);
  if (content === null) throw new Error(`rule not found: ${id}`);
  const meta = readRuleMeta(cwd, id);
  const target = targetPath(cwd, meta.target);
  const backup = `${target}${BACKUP_SUFFIX}`;
  if (!exists(backup)) {
    const existing = readText(target);
    if (existing && existing.trim()) {
      // 只在原文件非空且不是我们自己的规则时备份。
      atomicWrite(backup, existing);
    }
  }
  atomicWrite(target, content);
  setActive(cwd, id);
  return meta;
}

export interface ResetResult {
  removed: string[];
  skipped: string[];
  restored: string[];
}

/** 还原所有被激活写入的目标文件到备份状态，清空 active。 */
export function resetToOriginal(cwd: string): ResetResult {
  const active = readActive(cwd);
  const removed: string[] = [];
  const skipped: string[] = [];
  const restored: string[] = [];

  for (const target of RULE_TARGETS) {
    const fp = targetPath(cwd, target);
    const bak = `${fp}${BACKUP_SUFFIX}`;
    if (!exists(bak)) continue;
    try {
      atomicWrite(fp, readText(bak));
      fs.unlinkSync(bak);
      restored.push(fp);
    } catch {
      /* restore 失败时退回下面的逐文件判断 */
    }
  }

  if (active) {
    const meta = readRuleMeta(cwd, active);
    const fp = targetPath(cwd, meta.target);
    if (!restored.includes(fp)) {
      const rc = readRule(cwd, active);
      const fileContent = readText(fp);
      if (rc !== null && fileContent === rc) {
        try {
          fs.unlinkSync(fp);
          removed.push(fp);
        } catch {
          /* ignore */
        }
      } else if (fileContent) {
        skipped.push(fp);
      }
    }
  }
  try {
    fs.unlinkSync(stateFile(cwd));
  } catch {
    /* ignore */
  }
  return { removed, skipped, restored };
}
