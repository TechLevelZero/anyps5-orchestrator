import crypto from "node:crypto";

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const maxFrame = 64 * 1024;

export function acceptKey(key) {
  return crypto.createHash("sha1").update(key + guid).digest("base64");
}

export function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  return Buffer.concat([header, payload]);
}

export function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let start = offset + 2;
    if (length === 126) { if (buffer.length - start < 2) break; length = buffer.readUInt16BE(start); start += 2; }
    else if (length === 127) { if (buffer.length - start < 8) break; const big = buffer.readBigUInt64BE(start); length = big > BigInt(maxFrame) ? maxFrame + 1 : Number(big); start += 8; }
    if (length > maxFrame) return { frames, rest: Buffer.alloc(0), error: "frame too large" };
    const masked = Boolean(second & 0x80);
    if (!masked) return { frames, rest: Buffer.alloc(0), error: "client frames must be masked" };
    if (buffer.length - start < 4 + length) break;
    const mask = buffer.subarray(start, start + 4);
    const payload = Buffer.from(buffer.subarray(start + 4, start + 4 + length));
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
    frames.push({ opcode: first & 0x0f, payload });
    offset = start + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export class Live {
  constructor({ snapshot, allowed }) {
    this.snapshot = snapshot;
    this.allowed = allowed;
    this.clients = new Set();
    this.last = "";
    this.timer = null;
    setInterval(() => this.heartbeat(), 25000).unref();
  }

  get watching() { return this.clients.size > 0; }

  accept(request, socket) {
    const key = request.headers["sec-websocket-key"];
    if (!key || String(request.headers.upgrade || "").toLowerCase() !== "websocket" || request.headers["sec-websocket-version"] !== "13") {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    const client = { socket, request, buffer: Buffer.alloc(0), alive: true };
    this.clients.add(client);
    const drop = () => this.clients.delete(client);
    socket.on("close", drop);
    socket.on("error", () => { drop(); socket.destroy(); });
    socket.on("data", (chunk) => this.receive(client, chunk));
    this.send(client, this.message());
  }

  receive(client, chunk) {
    const { frames, rest, error } = readFrames(Buffer.concat([client.buffer, chunk]));
    client.buffer = rest;
    if (error) return this.close(client, 1002, error);
    for (const { opcode, payload } of frames) {
      if (opcode === 8) return this.close(client, 1000, "");
      if (opcode === 9) client.socket.write(frame(10, payload));
      if (opcode === 10) client.alive = true;
    }
  }

  send(client, text) {
    if (client.socket.writable) client.socket.write(frame(1, Buffer.from(text)));
  }

  close(client, code, reason) {
    this.clients.delete(client);
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code);
    payload.write(reason, 2);
    if (client.socket.writable) client.socket.end(frame(8, payload));
    else client.socket.destroy();
  }

  message() {
    return JSON.stringify({ type: "state", state: this.snapshot() });
  }

  changed() {
    if (!this.clients.size || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const client of this.clients) if (!this.allowed(client.request)) this.close(client, 4401, "signed out");
      if (!this.clients.size) return;
      const text = this.message();
      if (text === this.last) return;
      this.last = text;
      for (const client of this.clients) this.send(client, text);
    }, 150);
  }

  heartbeat() {
    for (const client of this.clients) {
      if (!client.alive) { this.clients.delete(client); client.socket.destroy(); continue; }
      client.alive = false;
      if (client.socket.writable) client.socket.write(frame(9));
    }
  }
}
