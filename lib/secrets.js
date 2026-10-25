import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class Secrets {
  constructor(dir) {
    const file = path.join(dir, "secret.key");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
    this.key = fs.readFileSync(file);
  }

  seal(text) {
    if (text === undefined || text === null || text === "") return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
  }

  open(sealed) {
    if (!sealed) return "";
    const [version, iv, tag, data] = sealed.split(":");
    if (version !== "v1") throw new Error("unknown secret format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }
}

export function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function equal(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
