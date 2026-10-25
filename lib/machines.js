import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

let dataDir = "";
export function setDataDir(dir) { dataDir = dir; fs.mkdirSync(path.join(dir, "ssh"), { recursive: true, mode: 0o700 }); }
const keyFile = () => path.join(dataDir, "ssh", "id_ed25519");
const knownHosts = () => path.join(dataDir, "ssh", "known_hosts");

export function publicKey() {
  if (!fs.existsSync(keyFile())) execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "anyps5-orchestrator", "-f", keyFile()], { stdio: "ignore" });
  return fs.readFileSync(`${keyFile()}.pub`, "utf8").trim();
}

const vendorIds = { "0x1002": "amd", "0x8086": "intel", "0x10de": "nvidia" };
export const validHost = /^[A-Za-z0-9._-]{1,253}$/;
export const validUser = /^[a-z_][a-z0-9_-]{0,31}$/;

let passwordFor = () => "";
export function setPasswordResolver(resolver) { passwordFor = resolver; }

function sshArgs(machine, command, password) {
  const auth = password
    ? ["-o", "BatchMode=no", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "NumberOfPasswordPrompts=1"]
    : ["-i", keyFile(), "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no"];
  return [...auth, "-p", String(machine.port || 22), "-o", `UserKnownHostsFile=${knownHosts()}`, "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=20", `${machine.user}@${machine.host}`, command];
}

export function exec(machine, command, { timeout = 60000, input, password } = {}) {
  return new Promise((resolve) => {
    const secret = machine.kind === "ssh" ? password ?? (machine.auth === "password" ? passwordFor(machine) : "") : "";
    const [program, args, env] = machine.kind !== "ssh" ? ["bash", ["-c", command], process.env]
      : secret ? ["sshpass", ["-e", "ssh", ...sshArgs(machine, command, true)], { ...process.env, SSHPASS: secret }]
      : ["ssh", sshArgs(machine, command, false), process.env];
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }); });
    child.stdin.end(input ?? "");
  });
}

export function sections(text) {
  const out = {};
  let current = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^@@(\w+)$/);
    if (header) { current = header[1]; out[current] = []; continue; }
    if (current) out[current].push(line);
  }
  for (const name of Object.keys(out)) out[name] = out[name].join("\n").trim();
  return out;
}

const detectScript = `
echo @@os; . /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-$(uname -s)}"; uname -r
echo @@engine; if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker; fi; if command -v podman >/dev/null 2>&1; then echo podman; fi
echo @@nvidia; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,name,driver_version --format=csv,noheader
echo @@toolkit; (command -v nvidia-ctk || command -v nvidia-container-runtime) 2>/dev/null | head -1
echo @@drm; for d in /sys/class/drm/card[0-9]*; do [ -e "$d/device/vendor" ] && echo "$(cat $d/device/vendor) $(cat $d/device/device) $(readlink -f $d/device | xargs basename)"; done | sort -u
echo @@lspci; command -v lspci >/dev/null 2>&1 && lspci -nn | grep -Ei "vga|3d|display"
echo @@cpu; grep -m1 "model name" /proc/cpuinfo | cut -d: -f2; nproc
echo @@mem; free -m | awk '/Mem:/{print $2}'
echo @@disk; df -BG --output=avail "$HOME" | tail -1
echo @@tools; for t in git python3 rsync flock; do command -v $t >/dev/null 2>&1 && echo $t; done
echo @@whoami; id -un; echo $HOME
`;

export async function detect(machine) {
  const result = await exec(machine, detectScript, { timeout: 30000 });
  if (result.code !== 0 && !result.stdout) throw new Error(result.stderr.trim().split("\n").pop() || "could not reach the machine");
  const s = sections(result.stdout);
  const engines = (s.engine || "").split("\n").filter(Boolean);
  const nvidia = (s.nvidia || "").split("\n").filter(Boolean).map((line) => {
    const [index, name, driver] = line.split(",").map((part) => part.trim());
    return { vendor: "nvidia", index: Number(index), name, driver, select: { gpus: `device=${index}` } };
  });
  const lspci = (s.lspci || "").split("\n");
  const others = (s.drm || "").split("\n").filter(Boolean).map((line) => {
    const [vendorId, deviceId, slot] = line.split(" ");
    const vendor = vendorIds[vendorId] || "other";
    const described = lspci.find((entry) => slot && entry.startsWith(slot.replace(/^0000:/, ""))) || "";
    return { vendor, pci: `${vendorId}:${deviceId}`, slot, name: described.replace(/^\S+\s+[^:]+:\s*/, "").replace(/\s*\[[0-9a-f]{4}:[0-9a-f]{4}\].*$/, "") || `${vendor.toUpperCase()} ${deviceId}` };
  }).filter((gpu) => gpu.vendor !== "nvidia" && gpu.vendor !== "other")
    .map((gpu) => ({ ...gpu, name: gpu.name.replace(/^Advanced Micro Devices, Inc\. \[AMD\/ATI\]\s*/, "AMD ").replace(/^Intel Corporation\s*/, "Intel ") }));
  const cpu = (s.cpu || "").split("\n");
  const [user, home] = (s.whoami || "").split("\n");
  return {
    os: (s.os || "").split("\n")[0], kernel: (s.os || "").split("\n")[1] || "",
    engines, engine: machine.engine && engines.includes(machine.engine) ? machine.engine : engines[0] || null,
    nvidiaToolkit: Boolean(s.toolkit), gpus: [...nvidia, ...others],
    cpu: { model: (cpu[0] || "").trim(), cores: Number(cpu[1]) || 0 }, memMb: Number(s.mem) || 0, diskFreeGb: parseInt(s.disk) || 0,
    tools: (s.tools || "").split("\n").filter(Boolean), user, home, detected: new Date().toISOString(),
  };
}

const probeScript = `
echo @@gpus; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits
echo @@amdgpu; for d in /sys/class/drm/card[0-9]*/device; do [ -e $d/gpu_busy_percent ] && echo "$(cat $d/gpu_busy_percent) $(cat $d/mem_info_vram_used 2>/dev/null || echo 0) $(cat $d/mem_info_vram_total 2>/dev/null || echo 0) $(cat $d/hwmon/hwmon*/temp1_input 2>/dev/null | head -1)"; done
echo @@load; cat /proc/loadavg; nproc
echo @@mem; free -m | awk '/Mem:/{print $2, $3}'
echo @@uptime; uptime -p
echo @@containers; { docker ps --format '{{.Names}}|{{.Image}}|{{.RunningFor}}' 2>/dev/null; podman ps --format '{{.Names}}|{{.Image}}|{{.RunningFor}}' 2>/dev/null; } | sort -u | head -20
`;

export async function probe(machine) {
  const result = await exec(machine, probeScript, { timeout: 25000 });
  if (result.code !== 0 && !result.stdout) return { online: false, error: result.stderr.trim().split("\n").pop() };
  const s = sections(result.stdout);
  const load = (s.load || "").split("\n");
  const [memTotal, memUsed] = (s.mem || "0 0").split(" ").map(Number);
  const nvidia = (s.gpus || "").split("\n").filter(Boolean).map((line) => {
    const [index, name, util, used, total, temp, power] = line.split(",").map((part) => part.trim());
    return { vendor: "nvidia", index: Number(index), name, util: Number(util), memUsed: Number(used), memTotal: Number(total), temp: Number(temp), power: Number(power) };
  });
  const amd = (s.amdgpu || "").split("\n").filter(Boolean).map((line, index) => {
    const [util, used, total, temp] = line.split(" ").map(Number);
    const known = (machine.gpus || []).filter((gpu) => gpu.vendor === "amd")[index];
    return { vendor: "amd", index, name: known?.vulkanName || known?.name || `AMD GPU ${index}`, util, memUsed: Math.round(used / 1048576), memTotal: Math.round(total / 1048576), temp: temp ? Math.round(temp / 1000) : null };
  });
  return {
    online: true, gpus: [...nvidia, ...amd],
    cpu: { load: (load[0] || "").split(" ").slice(0, 3).map(Number), cores: Number(load[1]) || 1 },
    mem: { total: memTotal, used: memUsed }, uptime: s.uptime || "",
    containers: (s.containers || "").split("\n").filter(Boolean).map((line) => { const [name, image, running] = line.split("|"); return { name, image, running }; }),
  };
}

export async function installKey(machine, password) {
  const key = publicKey();
  const result = await exec(machine, `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '${key}' ~/.ssh/authorized_keys || echo '${key}' >> ~/.ssh/authorized_keys) && echo key-installed`, { timeout: 30000, password });
  if (!result.stdout.includes("key-installed")) {
    const reason = result.code === 5 ? "Permission denied (wrong password)" : result.code === 6 ? "Host key verification failed" : result.stderr.trim().split("\n").pop() || `ssh exited with ${result.code}`;
    throw new Error(reason);
  }
  const check = await exec({ ...machine, auth: "key" }, "echo key-works", { timeout: 20000 });
  if (!check.stdout.includes("key-works")) throw new Error(`the key was added on ${machine.host} but signing in with it failed (the server may not allow key login): ${check.stderr.trim().split("\n").pop()}`);
}

export function localMachine() {
  return { id: "local", name: os.hostname(), kind: "local" };
}
