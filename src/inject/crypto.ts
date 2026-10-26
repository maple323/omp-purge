/**
 * 加密槽：出厂默认 prompt 以 AES-256-GCM 密封存放，运行时解包。
 *
 * 移植自 dsh-purge 的 table-key.js / table-read.js，但换成 omp 专属域名，
 * 与上游密文不互通（各自独立）。
 *
 *   key = sha256( MIX.join(0x1e) + 0x1e + MASK )       // 32B，aes-256
 *   plain = inflate( AES-256-GCM-Decrypt(key, IV, TAG, SLOT) )
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

const MIX = Object.freeze([
  "omp-purge.slot.v1",
  "oh-my-pi",
  "surface:terminal",
  "ov.table.1",
]);

/** 由额外串（MASK）派生 32 字节 aes-256 key。 */
export function mixKey(extra: string): Buffer {
  return createHash("sha256")
    .update(`${MIX.join("\x1e")}\x1e${String(extra || "")}`)
    .digest();
}

export interface SealedSlot {
  SLOT: string; // base64 ciphertext（已 deflate 的明文）
  MASK: string; // base64，参与 key 派生
  TAG: string; // base64，GCM auth tag
  IV: string; // base64，12 字节
}

/** 密封一段明文（构建期用；运行时只解不开）。 */
export function sealSlot(text: string): SealedSlot {
  const mask = randomBytes(16).toString("base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mixKey(mask), iv);
  const packed = deflateSync(Buffer.from(String(text ?? ""), "utf8"), { level: 9 });
  const body = Buffer.concat([cipher.update(packed), cipher.final()]);
  return {
    SLOT: body.toString("base64"),
    MASK: mask,
    TAG: cipher.getAuthTag().toString("base64"),
    IV: iv.toString("base64"),
  };
}

/** 解包密封槽；任何失败返回 "" （与上游一致的 fail-soft）。 */
export function openSlot(sealed: SealedSlot): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", mixKey(sealed.MASK), Buffer.from(sealed.IV, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.TAG, "base64"));
    const raw = Buffer.concat([
      decipher.update(Buffer.from(sealed.SLOT, "base64")),
      decipher.final(),
    ]);
    return inflateSync(raw).toString("utf8");
  } catch {
    return "";
  }
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
