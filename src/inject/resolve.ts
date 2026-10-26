/**
 * 注入解析（移植自 dsh-purge rules.js resolveInjectText + core.js 的槽读取）。
 *
 * 优先级：rolePrompts[role]（显式按角色覆盖）> <project>/.omp/prompt-inject.md > 密封默认槽。
 */
import { fileURLToPath } from "node:url";
import { agentDir, promptInjectPath, normalizeText, exists, readText } from "../paths.ts";
import { openSlot } from "./crypto.ts";
import { DEFAULT_SLOT } from "./slot-table.ts";

let slotCache: string | null = null;

// 未密封（或密封损坏）时的明文回退源。
const PLAINTEXT_FALLBACK = fileURLToPath(new URL("./default-prompt.zh.md", import.meta.url));

/** 解包内置密封默认 prompt（缓存）；槽为空时回退明文源。 */
export function defaultOverrideText(): string {
  if (slotCache === null) {
    const sealed = normalizeText(openSlot(DEFAULT_SLOT));
    slotCache = sealed || normalizeText(readText(PLAINTEXT_FALLBACK));
  }
  return slotCache;
}

export interface ResolvedInject {
  text: string;
  source: "role" | "prompt" | "default" | "none";
}

/** 读 <project>/.omp/prompt-inject.md 正文。 */
export function readProjectInject(cwd: string): string {
  const fp = promptInjectPath(cwd);
  if (!exists(fp)) return "";
  return normalizeText(readText(fp));
}

/** 解析某角色下要注入的正文。 */
export function resolveInjectText(
  cwd: string,
  role: string,
  rolePrompts?: Record<string, string>,
): ResolvedInject {
  const byRole =
    (role && rolePrompts?.[role]) ||
    rolePrompts?.["*"] ||
    "";
  const roleText = normalizeText(byRole);
  if (roleText) return { text: roleText, source: "role" };

  const disk = readProjectInject(cwd);
  if (disk) return { text: disk, source: "prompt" };

  const bundled = defaultOverrideText();
  if (bundled) return { text: bundled, source: "default" };

  return { text: "", source: "none" };
}

/** 用户级 prompt-inject.md（放在 agent dir 下），可作全局默认。 */
export function readUserInject(): string {
  return normalizeText(readText(`${agentDir()}/purge/prompt-inject.md`));
}
