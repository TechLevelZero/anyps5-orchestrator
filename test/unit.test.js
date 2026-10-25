import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Secrets } from "../lib/secrets.js";
import { setPassword, checkPassword, startSession, sessionValid, endSession } from "../lib/auth.js";
import { validate, toolNames } from "../lib/tools.js";
import { fixBranches } from "../lib/github.js";
import { gpuTargets, report } from "../lib/runner.js";
import { Store } from "../lib/store.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));

test("secrets round-trip and reject tampering", () => {
  const secrets = new Secrets(temp());
  const sealed = secrets.seal("github_pat_example");
  assert.notEqual(sealed, "github_pat_example");
  assert.equal(secrets.open(sealed), "github_pat_example");
  const parts = sealed.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => secrets.open(parts.join(":")));
  assert.equal(secrets.seal(""), null);
});

test("passwords and sessions", () => {
  const config = {};
  assert.throws(() => setPassword(config, "short"));
  setPassword(config, "a long enough password");
  assert.ok(checkPassword(config, "a long enough password"));
  assert.ok(!checkPassword(config, "wrong password here"));
  const session = startSession(config);
  assert.ok(sessionValid(config, session));
  assert.ok(!sessionValid(config, "made-up"));
  endSession(config, session);
  assert.ok(!sessionValid(config, session));
});

test("tool input validation", () => {
  assert.equal(validate("get_overview", {}), null);
  assert.match(validate("get_overview", { extra: 1 }), /unexpected field/);
  assert.match(validate("get_issue", {}), /missing number/);
  assert.match(validate("get_issue", { number: "12" }), /integer/);
  assert.match(validate("update_plan", { id: "p", lane: "soon" }), /one of/);
  assert.match(validate("nope", {}), /unknown tool/);
  assert.ok(toolNames.action.includes("run_command"));
  assert.ok(!toolNames.action.includes("get_job_log"));
});

test("fix branch links", () => {
  const text = "Fix: https://github.com/alice/AnyPS5/tree/fix/thing-1 and https://github.com/boykopovar/AnyPS5/tree/main, also https://github.com/bob/AnyPS5/tree/0123456789abcdef and (https://github.com/carol/anyps5/tree/feat/x).";
  assert.deepEqual(fixBranches(text, "boykopovar", "AnyPS5"), [{ owner: "alice", branch: "fix/thing-1" }, { owner: "carol", branch: "feat/x" }]);
});

test("GPU targets follow enabled GPUs and Vulkan names", () => {
  const machine = { gpus: [
    { vendor: "nvidia", index: 0, name: "NVIDIA A800", vulkanName: "NVIDIA A800", enabled: true },
    { vendor: "nvidia", index: 2, name: "NVIDIA A800", enabled: true },
    { vendor: "nvidia", index: 1, name: "NVIDIA A800", enabled: false },
    { vendor: "amd", name: "AMD Navi 48", vulkanName: "AMD Radeon RX 9070 XT (RADV GFX1201)", enabled: true },
    { vendor: "amd", name: "AMD Granite Ridge", enabled: true },
  ] };
  assert.deepEqual(gpuTargets(machine).map((target) => [target.id, target.spec, target.name]), [["nv0", "nvidia:0", ""], ["amd1", "dri:all", "AMD Radeon RX 9070 XT (RADV GFX1201)"]]);
});

test("reports name what failed and what was not covered", () => {
  const store = { data: { config: { repo: "boykopovar/AnyPS5" } } };
  const job = { owner: "alice", branch: "fix/x", stages: [
    { status: "done", machineName: "box", gpus: [{ vendor: "nvidia", label: "A800", result: { verdict: "regression", gpu: "NVIDIA A800", selected: 10, main: "a".repeat(40), head: "b".repeat(40), onlyDev: [{ test: "t1", recheckFailures: { dev: 3, main: 0 }, recheckRuns: 3 }], newTests: [], newVuids: ["VUID-x"], layerMissing: { main: false, dev: false } } }] },
  ] };
  const text = report(store, job);
  assert.match(text, /`t1` \(3\/3 serial reruns failed on the branch, 0\/3 on main\)/);
  assert.match(text, /new validation errors: `VUID-x`/);
  assert.match(text, /Not covered: AMD and Intel GPUs\./);
});

test("an unreadable state file is kept, never overwritten", () => {
  const dir = temp();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => new Store(file, {}), /not valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("state.json.unreadable-")));
});

test("state is written readable by the owner only", () => {
  const dir = temp();
  const store = new Store(path.join(dir, "state.json"), { a: 1 });
  store.flush();
  assert.equal(fs.statSync(path.join(dir, "state.json")).mode & 0o777, 0o600);
});

import { recipeFor, rootCommand, shellQuote } from "../lib/recipes.js";
import { execFileSync } from "node:child_process";

test("fix recipes match the Linux family and the problem", () => {
  const debian = { family: "debian", user: "rea", items: [] };
  const install = recipeFor({ id: "engine", status: "fail", code: "missing" }, debian);
  assert.match(install.commands.join("\n"), /apt-get install -y docker\.io/);
  assert.match(install.commands.at(-1), /usermod -aG docker rea/);
  assert.equal(recipeFor({ id: "engine", status: "fail", code: "missing" }, { family: "fedora", user: "x", items: [] }).title, "Install Podman");
  const toolkit = recipeFor({ id: "nvidia-toolkit", status: "fail", code: "install-podman" }, { family: "fedora", user: "x", items: [] });
  assert.match(toolkit.commands.join("\n"), /nvidia-container-toolkit\.repo/);
  assert.match(toolkit.commands.at(-1), /cdi generate/);
  assert.equal(recipeFor({ id: "nvidia-toolkit", status: "fail", code: "configure-docker" }, debian).risk, "medium");
  assert.equal(recipeFor({ id: "nvidia-driver", status: "fail", code: "ubuntu" }, debian).manual, true);
  assert.equal(recipeFor({ id: "engine", status: "ok" }, debian), null);
  const vulkan = recipeFor({ id: "nvidia-vulkan", status: "fail", code: "cuda-repo" }, { family: "fedora", user: "x", items: [] });
  assert.ok(vulkan.commands[0].includes(`nvidia-driver-libs-$(rpm -q --qf '%{EPOCH}:%{VERSION}-%{RELEASE}.%{ARCH}' nvidia-driver-cuda)`));
  assert.match(recipeFor({ id: "nvidia-vulkan", status: "fail", code: "apt-server" }, debian).commands[1], /libnvidia-gl-.*-server/);
  assert.equal(recipeFor({ id: "nvidia-vulkan", status: "fail", code: "manual" }, debian).manual, true);
});

test("fix recipes never take shell text from the machine", () => {
  const recipe = recipeFor({ id: "gpu-access", status: "fail", code: "render; rm -rf /" }, { family: "debian", user: "rea", items: [] });
  assert.ok(recipe.commands.every((command) => !command.includes("rm -rf")));
  assert.equal(recipeFor({ id: "engine", status: "fail", code: "nogroup" }, { family: "debian", user: "bad user;", items: [] }), null);
});

test("root commands are quoted and choose sudo correctly", () => {
  const script = `echo "it's fine" > /dev/null\necho done`;
  const asRoot = rootCommand(script, { user: "root", items: [] });
  assert.equal(asRoot.needsPassword, false);
  assert.equal(execFileSync("bash", ["-c", asRoot.command]).toString().trim(), "done");
  assert.match(rootCommand(script, { user: "ben", items: [{ id: "sudo", status: "ok" }] }).command, /^sudo -n bash -c '/);
  const withPassword = rootCommand(script, { user: "ben", items: [{ id: "sudo", status: "warn" }] });
  assert.ok(withPassword.needsPassword);
  assert.match(withPassword.command, /^sudo -S -p '' bash -c '/);
  assert.equal(execFileSync("bash", ["-c", `printf %s ${shellQuote("a'b\"c $HOME")}`]).toString(), "a'b\"c $HOME");
});
