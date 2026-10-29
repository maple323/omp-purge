/**
 * 装配级集成测试：用假宿主跑真实 install()，验证
 *   - 钩子 / 命令 / flag 都注册上了（OMP 契约面）
 *   - before_agent_start 真的返回 systemPrompt 替换策略
 *   - 三模式在真实装配下生效
 *   - /purge 命令与 --purge-off 生效
 *   - tool_call 门禁生效
 * 不依赖 omp 二进制、不发网络请求。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install } from "../src/install.ts";

/** 本文件创建的所有临时项目，测试结束统一删除。 */
const TMP_DIRS = [];
after(() => {
  for (const dir of TMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});

/** 假宿主：只实现本扩展用到的结构面，多出可观测的 _handlers/_commands/_flags。 */
function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const flagValues = new Map();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const api = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerFlag(name, options) {
      flags.set(name, options);
      if (options.default !== undefined) flagValues.set(name, options.default);
    },
    getFlag(name) {
      return flagValues.has(name) ? flagValues.get(name) : flags.get(name)?.default;
    },
    logger,
    _handlers: handlers,
    _commands: commands,
    _flags: flags,
    _setFlag(name, value) {
      flagValues.set(name, value);
    },
  };
  return api;
}

function tmpProject(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-purge-unit-"));
  TMP_DIRS.push(dir);
  fs.mkdirSync(path.join(dir, ".omp", "purge"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".omp", "purge", "config.json"), JSON.stringify(config), "utf8");
  return dir;
}

function fakeCtx(cwd, notes = []) {
  return {
    cwd,
    model: { id: "test-model" },
    ui: {
      notify(msg, level) {
        notes.push({ msg, level });
      },
    },
  };
}

const NATIVE = ["§ Role\nYou are omp's trusted coding assistant.\n# Engineering\n- do it"];

async function fire(pi, event, ctx, patch = {}) {
  const list = pi._handlers.get(event);
  assert.ok(list && list.length > 0, `handler for ${event} must be registered`);
  let result;
  for (const h of list) result = await h({ type: event, ...patch }, ctx);
  return result;
}

test("install: 注册了钩子、命令、flag", () => {
  const pi = makePi();
  install(pi);
  for (const ev of ["before_agent_start", "tool_call", "session_start", "agent_start"]) {
    assert.ok(pi._handlers.get(ev)?.length, `missing handler: ${ev}`);
  }
  assert.ok(pi._commands.has("purge"), "missing /purge command");
  assert.ok(pi._commands.has("rules"), "missing /rules command");
  for (const f of ["purge-off", "purge-verbose", "purge-mode", "purge-source"]) {
    assert.ok(pi._flags.has(f), `missing flag: ${f}`);
  }
});

test("before_agent_start: append 模式把注入正文追加在原生块之后", async () => {
  const pi = makePi();
  install(pi);
  const cwd = tmpProject({ capabilityProtocol: false, gate: false });
  fs.writeFileSync(path.join(cwd, ".omp", "prompt-inject.md"), "MARKER-PERSONA", "utf8");
  const ctx = fakeCtx(cwd);

  await fire(pi, "session_start", ctx);
  const out = await fire(pi, "before_agent_start", ctx, { systemPrompt: NATIVE, reason: "prompt" });

  assert.ok(out, "must return a result");
  assert.ok(Array.isArray(out.systemPrompt));
  assert.equal(out.systemPrompt[0], NATIVE[0]);
  assert.ok(out.systemPrompt.at(-1).includes("MARKER-PERSONA"));
});

test("before_agent_start: reason=revive 不改写", async () => {
  const pi = makePi();
  install(pi);
  const cwd = tmpProject({ capabilityProtocol: false, gate: false });
  const ctx = fakeCtx(cwd);
  await fire(pi, "session_start", ctx);
  const out = await fire(pi, "before_agent_start", ctx, { systemPrompt: NATIVE, reason: "revive" });
  assert.equal(out, undefined);
});

test("/purge mode replace 在真实装配下剥掉身份行", async () => {
  const pi = makePi();
  install(pi);
  const cwd = tmpProject({ capabilityProtocol: false, gate: false });
  fs.writeFileSync(path.join(cwd, ".omp", "prompt-inject.md"), "MARKER-PERSONA", "utf8");
  const notes = [];
  const ctx = fakeCtx(cwd, notes);
  await fire(pi, "session_start", ctx);

  await pi._commands.get("purge").handler("mode replace", ctx);
  const out = await fire(pi, "before_agent_start", ctx, { systemPrompt: NATIVE, reason: "prompt" });

  assert.equal(out.systemPrompt[0].includes("MARKER-PERSONA"), true);
  assert.equal(out.systemPrompt[1].includes("You are omp's trusted coding assistant."), false);

  await pi._commands.get("purge").handler("status", ctx);
  const status = notes.map((n) => n.msg).join("\n");
  assert.match(status, /mode: replace/);
  assert.match(status, /上一回合：已改写/);
});

test("--purge-off 放行一切（不改写）", async () => {
  const pi = makePi();
  install(pi);
  pi._setFlag("purge-off", true);
  const cwd = tmpProject({ capabilityProtocol: false, gate: false });
  const ctx = fakeCtx(cwd);
  await fire(pi, "session_start", ctx);
  const out = await fire(pi, "before_agent_start", ctx, { systemPrompt: NATIVE, reason: "prompt" });
  assert.equal(out, undefined);
});

test("/purge off 后不改写，/purge on 恢复", async () => {
  const pi = makePi();
  install(pi);
  const cwd = tmpProject({ capabilityProtocol: false, gate: false });
  fs.writeFileSync(path.join(cwd, ".omp", "prompt-inject.md"), "X", "utf8");
  const ctx = fakeCtx(cwd);
  await fire(pi, "session_start", ctx);

  await pi._commands.get("purge").handler("off", ctx);
  assert.equal(await fire(pi, "before_agent_start", ctx, { systemPrompt: NATIVE, reason: "prompt" }), undefined);

  await pi._commands.get("purge").handler("on", ctx);
  const out = await fire(pi, "before_agent_start", ctx, { systemPrompt: NATIVE, reason: "prompt" });
  assert.ok(out?.systemPrompt);
});

test("/purge source 指向不存在的文件 → 报错且不改状态", async () => {
  const pi = makePi();
  install(pi);
  const cwd = tmpProject({ capabilityProtocol: false, gate: false });
  const notes = [];
  const ctx = fakeCtx(cwd, notes);
  await fire(pi, "session_start", ctx);

  await pi._commands.get("purge").handler("source nope/missing.md", ctx);
  assert.equal(notes.at(-1).level, "error");

  await pi._commands.get("purge").handler("status", ctx);
  const status = notes.map((n) => n.msg).join("\n");
  assert.match(status, /source: chain/);
});

test("tool_call 门禁：公网攻击目标 block，本地放行", async () => {
  const pi = makePi();
  install(pi);
  const cwd = tmpProject({ gate: true });
  const ctx = fakeCtx(cwd);
  await fire(pi, "session_start", ctx);

  const blocked = await fire(pi, "tool_call", ctx, {
    toolName: "bash",
    input: { command: "渗透 http://8.8.8.8 拿权限" },
  });
  assert.equal(blocked?.block, true);

  const ok = await fire(pi, "tool_call", ctx, {
    toolName: "bash",
    input: { command: "curl http://127.0.0.1:8080/health" },
  });
  assert.equal(ok, undefined);
});