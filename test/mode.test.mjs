/**
 * 三模式合成 / 会话状态的单测。
 * Node >= 22 直接跑 .ts（类型剥离）。运行：node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeSystemPrompt,
  stripIdentityLines,
  stripDocSections,
  currentCwdLine,
  isPurgeMode,
  DEFAULT_IDENTITY_PATTERNS,
} from "../src/mode.ts";
import { createSessionState } from "../src/state.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

// OMP 18.13.3 的真实首行（src/prompts/system/system-prompt.md:5）
const OMP_BLOCK = [
  "RFC 2119 keywords: MUST, REQUIRED.",
  "",
  "§ Role",
  "You are omp's trusted coding assistant.",
  "",
  "# Engineering",
  "- Correctness first.",
].join("\n");

test("isPurgeMode: 只认三模式", () => {
  assert.equal(isPurgeMode("append"), true);
  assert.equal(isPurgeMode("replace"), true);
  assert.equal(isPurgeMode("strict"), true);
  assert.equal(isPurgeMode("banana"), false);
  assert.equal(isPurgeMode(undefined), false);
});

test("append: 我方文本追加在原生块之后（dsh-purge 的 post-prompt 位置）", () => {
  const r = composeSystemPrompt({
    mode: "append",
    ourText: "PERSONA",
    nativePrompt: [OMP_BLOCK],
    cwd: "C:/lab",
  });
  assert.equal(r.effectiveMode, "append");
  assert.deepEqual(r.systemPrompt, [OMP_BLOCK, "PERSONA"]);
  assert.equal(r.injectedBytes, 7);
  assert.equal(r.strippedLines, 0);
});

test("append: ourText 为空时不改写", () => {
  const r = composeSystemPrompt({ mode: "append", ourText: "", nativePrompt: [OMP_BLOCK], cwd: "C:/lab" });
  assert.deepEqual(r.systemPrompt, [OMP_BLOCK]);
  assert.equal(r.injectedBytes, 0);
});

test("replace: 剥掉真实身份行，我方文本放最前", () => {
  const r = composeSystemPrompt({
    mode: "replace",
    ourText: "PERSONA",
    nativePrompt: [OMP_BLOCK],
    cwd: "C:/lab",
  });
  assert.equal(r.effectiveMode, "replace");
  assert.equal(r.identityMatched, true);
  assert.equal(r.fellBackToAppend, false);
  assert.equal(r.systemPrompt[0], "PERSONA");
  assert.ok(!r.systemPrompt[1].includes("You are omp's trusted coding assistant."));
  assert.ok(!r.systemPrompt[1].includes("§ Role"));
  assert.ok(r.systemPrompt[1].includes("# Engineering"));
  assert.equal(r.strippedLines, 2);
});

test("replace: 未命中身份段 → 回退 append 并标记", () => {
  const r = composeSystemPrompt({
    mode: "replace",
    ourText: "PERSONA",
    nativePrompt: ["no identity here"],
    cwd: "C:/lab",
  });
  assert.equal(r.effectiveMode, "append");
  assert.equal(r.identityMatched, false);
  assert.equal(r.fellBackToAppend, true);
  assert.deepEqual(r.systemPrompt, ["no identity here", "PERSONA"]);
});

test("strict: 仅我方文本 + cwd 行", () => {
  const r = composeSystemPrompt({ mode: "strict", ourText: "PERSONA", nativePrompt: [OMP_BLOCK], cwd: "C:/lab" });
  assert.equal(r.effectiveMode, "strict");
  assert.deepEqual(r.systemPrompt, ["PERSONA", currentCwdLine("C:/lab")]);
  assert.equal(r.systemPrompt[1], "Current working directory: C:/lab");
});

test("stripIdentityLines: 多块内部手术，计数正确", () => {
  const a = stripIdentityLines("x\nYou are a helpful assistant.\ny\n§ Role\nz", DEFAULT_IDENTITY_PATTERNS);
  assert.equal(a.stripped, 2);
  assert.equal(a.text, "x\ny\nz");
});

test("stripDocSections: 从标题剥到下一个顶级标题", () => {
  const block = "# Tool Inventory\n- a\n- b\n# Engineering\n- keep";
  const d = stripDocSections(block, [/^\s*#\s*Tool Inventory\s*$/i]);
  assert.equal(d.stripped, 3);
  assert.equal(d.text, "# Engineering\n- keep");
});

test("replace + stripDocs: 文档段也剥掉", () => {
  const block = "You are omp's trusted coding assistant.\n# Tool Inventory\n- t\n# Engineering\n- keep";
  const r = composeSystemPrompt({
    mode: "replace",
    ourText: "P",
    nativePrompt: [block],
    cwd: "C:/lab",
    stripDocs: true,
  });
  assert.equal(r.identityMatched, true);
  assert.ok(!r.systemPrompt[1].includes("# Tool Inventory"));
  assert.ok(r.systemPrompt[1].includes("# Engineering"));
});

test("createSessionState: 默认值 + 覆盖 + 非法值回落", () => {
  const s = createSessionState(DEFAULT_CONFIG);
  assert.equal(s.mode, "append");
  assert.equal(s.sourceKind, "chain");
  assert.equal(s.enabled, true);

  const over = createSessionState(DEFAULT_CONFIG, { mode: "strict", source: "C:/p.md" });
  assert.equal(over.mode, "strict");
  assert.equal(over.sourceKind, "file");
  assert.equal(over.sourcePath, "C:/p.md");

  const bad = createSessionState({ ...DEFAULT_CONFIG, mode: "nope", source: "embedded" }, { mode: "nonsense" });
  assert.equal(bad.mode, "append");
  assert.equal(bad.sourceKind, "embedded");
  assert.equal(bad.sourcePath, null);
});