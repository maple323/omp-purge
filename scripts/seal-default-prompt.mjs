#!/usr/bin/env node
/**
 * 构建期脚本：把 src/inject/default-prompt.zh.md 密封成 src/inject/slot-table.ts。
 *
 * 明文源不进 npm 发布（package.json 的 files 排除它），只发布密封后的 slot。
 * 用法：node scripts/seal-default-prompt.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealSlot } from "../src/inject/crypto.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const src = path.join(root, "src", "inject", "default-prompt.zh.md");
const out = path.join(root, "src", "inject", "slot-table.ts");

const text = fs.readFileSync(src, "utf8");
const sealed = sealSlot(text);

const body = `/**
 * 自动生成，勿手改。由 scripts/seal-default-prompt.mjs 产出。
 * 明文源：src/inject/default-prompt.zh.md（不随 npm 发布）
 */
import type { SealedSlot } from "./crypto.ts";

export const DEFAULT_SLOT: SealedSlot = ${JSON.stringify(sealed, null, 2)};
`;

fs.writeFileSync(out, body, "utf8");
console.log(`sealed ${Buffer.byteLength(text, "utf8")} bytes -> ${path.relative(root, out)}`);
