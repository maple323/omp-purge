/**
 * 网络门禁（移植自 dsh-purge net-scope.js）。
 *
 * 规则：解析域名→IP，只放行 loopback / RFC1918（本地靶场）；攻击词命中但目标解析到公网
 * 则拦；外挂任务硬拦。拒绝语固定。
 *
 * 与上游差异：上游挂在 Cordis 的 agent/pre-step + tools/pre-execute 上，本版挂在 OMP 的
 * tool_call 上——因此输入是工具调用参数（event.input），不是聊天消息。
 */
import dns from "node:dns/promises";

export const DENIAL = "不行，这是严令禁止的";

// ---------- IP 判定 ----------

function isLocalLabV4(value: number): boolean {
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    value = value * 256 + number;
  }
  return value >>> 0;
}

function parseIpv6(input: string): bigint | null {
  let text = String(input || "").trim().toLowerCase().split("%")[0];
  if (!text) return null;
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const tail = ipv4ToInt(text.slice(colon + 1));
    if (tail == null) return null;
    const hi = (tail >>> 16).toString(16);
    const lo = (tail & 0xffff).toString(16);
    text = `${text.slice(0, colon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out = (out << 16n) + BigInt(parseInt(part, 16));
  }
  return out;
}

const V4_TEXT = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const FILE_SUFFIX = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "md", "yml", "yaml",
  "css", "html", "map", "log", "txt", "png", "jpg", "jpeg", "gif", "svg",
  "woff", "woff2", "lock", "vue", "py", "go", "rs", "java", "xml", "toml",
  "ini", "bak", "patch", "diff", "sh", "ps1", "cmd", "exe",
]);

export function hostOf(raw: unknown): string {
  let host = String(raw || "").trim().toLowerCase();
  if (!host) return "";
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 1 ? host.slice(1, end) : "";
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(host)) return host.replace(/:\d+$/, "");
  if (/^[a-z0-9.-]+:\d+$/.test(host)) return host.replace(/:\d+$/, "");
  return host.replace(/\.$/, "");
}

function isIp(host: string): boolean {
  return V4_TEXT.test(host) || host.includes(":");
}

export function isLocalLabAddress(addr: string): boolean {
  const name = hostOf(addr);
  if (!name) return false;
  if (name.includes(":")) {
    const value = parseIpv6(name);
    if (value == null) return false;
    if ((value >> 32n) === 0xffffn) return isLocalLabV4(Number(value & 0xffffffffn) >>> 0);
    if (value === 0n || value === 1n) return true;
    if ((value >> 118n) === 0x3fan) return true; // fe80::/10
    if ((value >> 121n) === 0x7en) return true; // fc00::/7
    return false;
  }
  const value = ipv4ToInt(name);
  return value != null && isLocalLabV4(value);
}

// ---------- 文本 → host 收集 ----------

function inFilePath(sample: string, index: number): boolean {
  const prev = sample[index - 1];
  return prev === "/" || prev === "\\";
}

function keepBareDomain(sample: string, index: number, name: string): boolean {
  if (inFilePath(sample, index)) return false;
  const labels = name.split(".");
  const tail = labels[labels.length - 1];
  if (FILE_SUFFIX.has(tail)) return false;
  if (labels.length === 2 && tail === "mo") return false;
  return true;
}

function addHost(raw: string, hosts: Set<string>): void {
  const host = hostOf(raw);
  if (!host || host.length > 253) return;
  hosts.add(host);
}

function collectFromText(text: string, hosts: Set<string>): void {
  const sample = String(text || "").slice(0, 32768);
  const url = /\b(?:[a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)/gi;
  for (const match of sample.matchAll(url)) addHost(match[1], hosts);
  const mappedRe = /(?:[0-9a-f]{0,4}:){1,6}ffff:(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)/gi;
  const mapped: Array<{ start: number; end: number }> = [];
  for (const match of sample.matchAll(mappedRe)) {
    hosts.add(match[0].toLowerCase());
    mapped.push({ start: match.index, end: match.index + match[0].length });
  }
  const covered = (index: number, length: number) => mapped.some((s) => index >= s.start && index + length <= s.end);
  const ipv4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
  for (const match of sample.matchAll(ipv4)) {
    if (covered(match.index, match[0].length)) continue;
    hosts.add(match[0]);
  }
  const ipv6 = /(?<![\d:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\d])/gi;
  for (const match of sample.matchAll(ipv6)) {
    const value = match[0];
    if (/^[\d:]+$/.test(value)) continue;
    if (covered(match.index, value.length)) continue;
    hosts.add(value);
  }
  const domain = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
  for (const match of sample.matchAll(domain)) {
    const name = match[0].toLowerCase();
    if (!keepBareDomain(sample, match.index, name)) continue;
    hosts.add(name);
  }
  if (/\blocalhost\b/i.test(sample)) hosts.add("localhost");
}

export function hostsInText(text: string): Set<string> {
  const hosts = new Set<string>();
  const sample = String(text || "");
  const cap = Math.min(sample.length, 256 * 1024);
  const win = 32768;
  const hop = 28672;
  const labeled = /(?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59}|[一-鿿]{2,12})/giu;
  for (let i = 0; i < cap; i += hop) {
    const chunk = sample.slice(i, i + win);
    collectFromText(chunk, hosts);
    for (const match of chunk.matchAll(labeled)) {
      const name = match[0].toLowerCase().replace(/\.$/, "");
      if (!keepBareDomain(chunk, match.index ?? 0, name)) continue;
      addHost(name, hosts);
    }
  }
  return hosts;
}

// ---------- 攻击 / 外挂词 ----------

const ATTACK =
  /渗透测试|红队|打点|拿站|渗透(?!测试)|打穿|打下|打站|入侵|拿壳|拿权限|爆破|提权|webshell|getshell|端口扫描|pentest|\bexploit\b(?![-a-z0-9])|\bbreach\b|\bpwn\b|(?<!防御)攻击(?!面)|(?<!surface\s)\battack\b(?!\s+surface)/i;

const CHEAT_STRONG =
  /外挂|游戏辅助|自瞄|自动瞄准|无后座|无限弹药|人物透视|物品透视|透视挂|开透视|加速挂|飞天挂|瞬移挂|锁头|压枪挂|改血|过反作弊|注入游戏|aimbot|wallhack|triggerbot|spinbot|silent\s*aim|game\s*cheat|anti-?cheat|cheat\s*engine/i;
const CHEAT_GAME =
  /游戏|网游|端游|手游|\bgame\b|steam|csgo|\bcs2\b|pubg|valorant|和平精英|王者荣耀|原神/i;
const CHEAT_WEAK =
  /内存修改|读内存|写内存|dll注入/i;

const NET_TOPIC =
  /(?:代理|\bproxy\b|socks|vpn|frp|clash|v2ray|小飞机|机场|出口\s*ip|本机\s*ip|内网\s*ip|公网\s*ip|ip\s*地址|ip\s*归属|ip\s*查询|ip\s*相关|dns|域名解析|网卡|隧道|反向代理|正向代理|http[s]?\s*代理)/i;

const ATTACK_SCAN_CAP = 256 * 1024;
const ATTACK_WINDOW = 8192;

function scanHas(re: RegExp, text: string): boolean {
  const sample = String(text || "");
  const cap = Math.min(sample.length, ATTACK_SCAN_CAP);
  if (!cap) return false;
  if (cap <= ATTACK_WINDOW) return re.test(sample.slice(0, cap));
  const hop = ATTACK_WINDOW - 256;
  for (let i = 0; i < cap; i += hop) {
    if (re.test(sample.slice(i, i + ATTACK_WINDOW))) return true;
  }
  return false;
}

export function isBenignNetworkTopic(text: string): boolean {
  const t = String(text || "").trim();
  if (!t || !NET_TOPIC.test(t)) return false;
  return !scanHas(ATTACK, t);
}

export function isAttackTask(text: string): boolean {
  const sample = String(text || "");
  if (isBenignNetworkTopic(sample)) return false;
  return scanHas(ATTACK, sample);
}

export function isCheatTask(text: string): boolean {
  const sample = String(text || "");
  const cap = sample.length > ATTACK_SCAN_CAP ? sample.slice(0, ATTACK_SCAN_CAP) : sample;
  if (CHEAT_STRONG.test(cap)) return true;
  return CHEAT_GAME.test(cap) && CHEAT_WEAK.test(cap);
}

// ---------- 公网目标判定 ----------

const LOOKUP_MS = 2000;
const LOOKUP_TTL_MS = 5000;
const lookupCache = new Map<string, { at: number; ips: string[] }>();

async function lookupIps(name: string): Promise<string[]> {
  const key = String(name || "").toLowerCase();
  const cached = lookupCache.get(key);
  if (cached && cached.at > Date.now() - LOOKUP_TTL_MS) return cached.ips;
  let ips: string[] = [];
  try {
    const rows = await Promise.race([
      dns.lookup(key, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("lookup-timeout")), LOOKUP_MS);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    ips = [...new Set((Array.isArray(rows) ? rows : [rows]).map((row) => row && row.address).filter(Boolean))];
  } catch {
    ips = [];
  }
  lookupCache.set(key, { at: Date.now(), ips });
  if (lookupCache.size > 256) lookupCache.delete(lookupCache.keys().next().value as string);
  return ips;
}

async function isRangeTarget(name: string): Promise<boolean> {
  if (!name) return false;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (isIp(name)) return isLocalLabAddress(name);
  const ips = await lookupIps(name);
  if (!ips.length) return false;
  return ips.every((ip) => isLocalLabAddress(ip));
}

export interface HostHit {
  label: string;
  kind: "ip" | "domain" | "cheat" | "bank";
}

/** 若文本里出现解析到公网的 host，返回第一个；全本地/无 host 返回 null。 */
export async function publicHostHit(text: string): Promise<HostHit | null> {
  const hosts = hostsInText(text);
  if (!hosts.size) return null;
  for (const host of hosts) {
    const name = hostOf(host);
    if (!name) continue;
    if (await isRangeTarget(name)) continue;
    return { label: name, kind: isIp(name) ? "ip" : "domain" };
  }
  return null;
}

/** 门禁主判定：外挂硬拦；否则攻击词命中 → 公网目标拦。 */
export async function taskTargetHit(text: string): Promise<HostHit | null> {
  if (isCheatTask(text)) return { label: "cheat", kind: "cheat" };
  if (!isAttackTask(text)) return null;
  const hosts = hostsInText(text);
  let found = false;
  for (const host of hosts) if (hostOf(host)) found = true;
  if (!found) return { label: "unspecified", kind: "domain" };
  return publicHostHit(text);
}

// ---------- 工具调用参数 → 文本 ----------

function blobOf(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => blobOf(item, depth + 1)).join("\n");
  if (typeof value !== "object") return "";
  const skip = new Set(["ctx", "signal", "context", "agent", "session"]);
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !skip.has(key))
    .map(([, item]) => blobOf(item, depth + 1))
    .join("\n")
    .slice(0, 32768);
}

/** 从 OMP tool_call 事件里抽出可扫描文本（命令/路径/URL/参数）。 */
export function toolCallText(event: unknown): string {
  const e = event as { toolName?: string; input?: unknown } | null;
  if (!e || typeof e !== "object") return "";
  const parts: string[] = [];
  if (typeof e.toolName === "string") parts.push(e.toolName);
  if (e.input != null) parts.push(blobOf(e.input));
  return parts.join("\n");
}
