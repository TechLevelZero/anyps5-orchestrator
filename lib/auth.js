import crypto from "node:crypto";
import { token, hash, equal } from "./secrets.js";

const sessionHours = 24 * 14;

export function setPassword(config, password) {
  if (typeof password !== "string" || password.length < 10) throw new Error("use a password of at least 10 characters");
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  config.auth = { salt: salt.toString("base64"), hash: derived.toString("base64"), sessions: [] };
}

export function checkPassword(config, password) {
  if (!config.auth?.hash || typeof password !== "string") return false;
  const derived = crypto.scryptSync(password, Buffer.from(config.auth.salt, "base64"), 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(derived, Buffer.from(config.auth.hash, "base64"));
}

export function startSession(config) {
  const value = token(32);
  const now = Date.now();
  config.auth.sessions = (config.auth.sessions || []).filter((session) => session.expires > now).slice(-9);
  config.auth.sessions.push({ hash: hash(value), expires: now + sessionHours * 3600 * 1000 });
  return value;
}

export function endSession(config, value) {
  if (!value || !config.auth) return;
  config.auth.sessions = (config.auth.sessions || []).filter((session) => session.hash !== hash(value));
}

export function sessionValid(config, value) {
  if (!value || !config.auth?.sessions) return false;
  const digest = hash(value);
  return config.auth.sessions.some((session) => session.expires > Date.now() && equal(session.hash, digest));
}

export function cookie(request, name) {
  for (const part of (request.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function agentFor(config, request) {
  const header = request.headers.authorization || "";
  const value = header.startsWith("Bearer ") ? header.slice(7) : request.headers["x-agent-token"] || "";
  if (!value) return null;
  const digest = hash(value);
  return (config.agents || []).find((agent) => !agent.revoked && equal(agent.tokenHash, digest)) || null;
}
