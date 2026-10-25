import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(file, initial) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let text = null;
    try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (text === null) {
      this.data = structuredClone(initial);
    } else {
      try {
        this.data = { ...structuredClone(initial), ...JSON.parse(text) };
      } catch (error) {
        const kept = `${file}.unreadable-${Date.now()}`;
        fs.copyFileSync(file, kept);
        throw new Error(`${file} is not valid JSON (${error.message}). A copy was kept as ${kept}. Fix or remove the file, then start again.`);
      }
    }
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

export function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function stamp() {
  return new Date().toISOString();
}
