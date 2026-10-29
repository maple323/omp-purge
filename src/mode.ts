/**
 * 系统提示词合成（三模式）。
 *
 * 与 OMP 18.13.3 的真实行为对齐（已核实 src/system-prompt.ts:1037
 *   `const systemPrompt = [rendered];`  之后可能再 push guidance / project prompt）：
 * `before_agent_start` 的 event.systemPrompt 是**块数组**，渲染后的模板是单个大块，
 * 身份行 `You are omp's trusted coding assistant.`（src/prompts/system/system-prompt.md:5）
 * 位于该块**内部**。所以「剥身份段」是在块内部按行做手术，不是换数组元素。
 *
 * 三模式（概念来自 pi-purge，机制并到 dsh-purge 的注入链上）：
 *   append  —— 原生 prompt 数组 + 我方文本，追加在末尾。最安全，等同 dsh-purge 的 post prompt。
 *   replace —— 我方文本 + 剥掉身份行后的原生 prompt。匹配不到身份段则**回退 append**并记录。
 *   strict  —— 仅我方文本 + `Current working directory: <cwd>`。
 */

export type PurgeMode = "append" | "replace" | "strict";

export const PURGE_MODES: readonly PurgeMode[] = ["append", "replace", "strict"] as const;

export function isPurgeMode(value: unknown): value is PurgeMode {
  return typeof value === "string" && (PURGE_MODES as readonly string[]).includes(value);
}

/**
 * 身份行匹配（针对 OMP 真实模板，非猜）。
 * 命中即整行删除。可被配置的 identityPatterns 覆盖/追加。
 */
export const DEFAULT_IDENTITY_PATTERNS: readonly RegExp[] = [
  /^\s*§\s*Role\s*$/i,
  /^\s*You are omp's trusted coding assistant\.?\s*$/i,
  /^\s*You are .{0,80}(?:coding assistant|assistant|agent)\b.*$/i,
  /^\s*You're .{0,80}(?:coding assistant|assistant|agent)\b.*$/i,
];

/**
 * 工具文档段起点（replace 的 stripDocs 选项用）。
 * 命中行到「下一个同/更高级别 `# ` 标题」之间的内容会被删除。
 */
export const DEFAULT_DOC_PATTERNS: readonly RegExp[] = [
  /^\s*#\s*Tool Inventory\s*$/i,
  /^\s*#\s*xd:\/\/\s*Tool Devices\s*$/i,
];

/** `strict` 模式下唯一的运行上下文行。 */
export function currentCwdLine(cwd: string): string {
  const c = String(cwd || "").trim() || process.cwd();
  return `Current working directory: ${c}`;
}

/** 在块内部按行剥掉命中身份模式的行；返回新块与被删行数。 */
export function stripIdentityLines(block: string, patterns: readonly RegExp[]): { text: string; stripped: number } {
  const lines = String(block ?? "").split("\n");
  const kept: string[] = [];
  let stripped = 0;
  for (const line of lines) {
    if (patterns.some((re) => re.test(line))) {
      stripped += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), stripped };
}

/**
 * 剥掉一个 `# Heading` 段：从命中 docPatterns 的标题行起，到下一个同级或更高级 `# ` 标题为止。
 * 无匹配返回原块、删除 0 行。
 */
export function stripDocSections(block: string, docPatterns: readonly RegExp[]): { text: string; stripped: number } {
  const lines = String(block ?? "").split("\n");
  const kept: string[] = [];
  let stripped = 0;
  let skipping = false;
  for (const line of lines) {
    const isTopHeading = /^#\s+\S/.test(line);
    if (skipping) {
      if (isTopHeading) skipping = false;
      else {
        stripped += 1;
        continue;
      }
    }
    if (isTopHeading && docPatterns.some((re) => re.test(line))) {
      skipping = true;
      stripped += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), stripped };
}

export interface ComposeOptions {
  mode: PurgeMode;
  /** 我方注入正文（注入链解析结果）；空串表示不改写。 */
  ourText: string;
  /** 原生 prompt 块数组（event.systemPrompt）。 */
  nativePrompt: readonly string[];
  cwd: string;
  identityPatterns?: readonly RegExp[];
  /** replace 模式下是否同时剥掉工具文档段（默认 false）。 */
  stripDocs?: boolean;
  docPatterns?: readonly RegExp[];
}

export interface ComposeResult {
  /** 供 before_agent_start 返回的 systemPrompt 替换策略。 */
  systemPrompt: string[];
  /** 实际使用的模式（replace 回退时为 append）。 */
  effectiveMode: PurgeMode;
  /** replace 是否命中身份段。 */
  identityMatched: boolean;
  /** replace 未命中身份段而回退到 append。 */
  fellBackToAppend: boolean;
  /** 被删行数（身份行 + 可选文档段行）。 */
  strippedLines: number;
  /** 我方文本字节数。 */
  injectedBytes: number;
}

/**
 * 合成最终 systemPrompt。
 * ourText 为空时三模式都返回原生 prompt（不改写，避免无意义覆盖）。
 */
export function composeSystemPrompt(opts: ComposeOptions): ComposeResult {
  const native = [...(opts.nativePrompt ?? [])].map((b) => String(b ?? ""));
  const ourText = String(opts.ourText ?? "");
  const cwd = String(opts.cwd || "").trim() || process.cwd();
  const identityPatterns = opts.identityPatterns ?? DEFAULT_IDENTITY_PATTERNS;
  const docPatterns = opts.docPatterns ?? DEFAULT_DOC_PATTERNS;

  if (!ourText.trim()) {
    return {
      systemPrompt: native,
      effectiveMode: opts.mode,
      identityMatched: false,
      fellBackToAppend: false,
      strippedLines: 0,
      injectedBytes: 0,
    };
  }

  if (opts.mode === "strict") {
    return {
      systemPrompt: [ourText, currentCwdLine(cwd)],
      effectiveMode: "strict",
      identityMatched: false,
      fellBackToAppend: false,
      strippedLines: 0,
      injectedBytes: Buffer.byteLength(ourText, "utf8"),
    };
  }

  if (opts.mode === "replace") {
    let stripped = 0;
    let docsStripped = 0;
    const rewritten = native.map((block) => {
      const r = stripIdentityLines(block, identityPatterns);
      stripped += r.stripped;
      if (!opts.stripDocs) return r.text;
      const d = stripDocSections(r.text, docPatterns);
      docsStripped += d.stripped;
      return d.text;
    });
    if (stripped > 0) {
      return {
        systemPrompt: [ourText, ...rewritten],
        effectiveMode: "replace",
        identityMatched: true,
        fellBackToAppend: false,
        strippedLines: stripped + docsStripped,
        injectedBytes: Buffer.byteLength(ourText, "utf8"),
      };
    }
    // 未命中身份段 → 回退 append（pi-purge 同语义），并如实报告。
    return {
      systemPrompt: [...native, ourText],
      effectiveMode: "append",
      identityMatched: false,
      fellBackToAppend: true,
      strippedLines: 0,
      injectedBytes: Buffer.byteLength(ourText, "utf8"),
    };
  }

  // append（默认）：追加在末尾，等同 dsh-purge 的 post prompt 位置。
  return {
    systemPrompt: [...native, ourText],
    effectiveMode: "append",
    identityMatched: false,
    fellBackToAppend: false,
    strippedLines: 0,
    injectedBytes: Buffer.byteLength(ourText, "utf8"),
  };
}