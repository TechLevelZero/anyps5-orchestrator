const icons = "https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons";
const brand = { nvidia: "#76B900", amd: "#ED1C24", intel: "#0071C5", github: "#181717", docker: "#2496ED", podman: "#892CA0", linux: "#FCC624", ubuntu: "#E95420", fedora: "#51A2DA", debian: "#A81D33", archlinux: "#1793D1", anthropic: "#191919", openai: "#412991" };
const ui = { state: null, session: null, mineTab: "prs", settings: false, flash: null, newAgent: null, busy: {}, sshAuth: "password-key" };
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function logo(slug, size = 18, color) {
  const c = color || brand[slug] || "#57534e";
  return `<span class="inline-block shrink-0" style="width:${size}px;height:${size}px;background:${c};-webkit-mask:url(${icons}/${slug}.svg) center/contain no-repeat;mask:url(${icons}/${slug}.svg) center/contain no-repeat"></span>`;
}
function osLogo(os = "") { const lower = os.toLowerCase(); return ["ubuntu", "fedora", "debian", "arch"].find((name) => lower.includes(name))?.replace("arch", "archlinux") || "linux"; }
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
function avatar(person, size = 24) { return person ? `<img src="${esc(person.avatar)}${person.avatar?.includes("?") ? "&" : "?"}s=${size * 2}" alt="${esc(person.login)}" title="${esc(person.login)}" class="rounded-full ring-2 ring-white" style="width:${size}px;height:${size}px" loading="lazy">` : ""; }
function bar(fraction, warn = 0.85) { const pct = Math.round(Math.min(1, Math.max(0, fraction || 0)) * 100); return `<div class="bar"><span style="width:${pct}%;${fraction > warn ? "background:linear-gradient(90deg,#f97316,#dc2626)" : ""}"></span></div>`; }
const tone = {
  clean: "emerald", done: "emerald", ready: "emerald", open: "emerald", working: "brand", running: "brand", queued: "sky", pending: "stone", waiting: "sky", "awaiting-approval": "amber", needed: "amber", blocked: "rose",
  failed: "rose", regression: "rose", incomplete: "amber", cancelled: "stone", rejected: "stone", idle: "stone", closed: "stone", merged: "violet",
};
const toneClass = { emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200", brand: "bg-brand-50 text-brand-700 ring-brand-200", sky: "bg-sky-50 text-sky-700 ring-sky-200", stone: "bg-stone-50 text-stone-500 ring-stone-200", amber: "bg-amber-50 text-amber-700 ring-amber-200", rose: "bg-rose-50 text-rose-700 ring-rose-200", violet: "bg-violet-50 text-violet-700 ring-violet-200" };
const chip = (text, key = text) => `<span class="chip ${toneClass[tone[key] || "stone"]}">${esc(String(text).replace("-", " "))}</span>`;

async function call(method, url, payload) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "orchestrator" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}
async function act(key, work) {
  ui.busy[key] = true; ui.flash = null; render();
  try { await work(); } catch (error) { ui.flash = error.message; }
  ui.busy[key] = false;
  await refresh();
}
const busy = (key) => (ui.busy[key] ? "disabled" : "");
const spinner = `<span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"></span>`;

function shell(content, wide = true) {
  return `<header class="mx-auto flex max-w-[1500px] flex-wrap items-center gap-4 px-4 pt-6 pb-4 sm:px-6">
    <div class="flex items-center gap-3"><img src="/logo.svg" class="h-11 w-11 rounded-xl shadow-md" alt="">
      <div><h1 class="text-xl font-extrabold tracking-tight text-stone-900">AnyPS5 <span class="text-brand-600">Orchestrator</span></h1><p class="text-xs text-stone-500">${esc(ui.state?.repo || "Your AnyPS5 work, machines and AI agent in one place")}</p></div></div>
    ${ui.state?.setup?.done ? headerRight() : ""}
  </header>
  ${ui.flash ? `<div class="mx-auto mb-4 max-w-[1500px] px-4 sm:px-6"><div class="flex items-center gap-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-200"><b>Something went wrong:</b> ${esc(ui.flash)}<button class="ml-auto text-xs underline" data-action="dismiss">dismiss</button></div></div>` : ""}
  <main class="mx-auto ${wide ? "max-w-[1500px]" : "max-w-3xl"} space-y-6 px-4 pb-10 sm:px-6">${content}</main>
  <footer class="mx-auto max-w-[1500px] px-4 pb-8 text-center text-[11px] text-stone-400 sm:px-6">AnyPS5 Orchestrator ${esc(ui.state?.install?.version || ui.session?.version || "")} · self-hosted · it never posts to GitHub</footer>`;
}

function headerRight() {
  const s = ui.state;
  const g = s.github?.guardrails;
  return `<div class="ml-auto flex flex-wrap items-center gap-2">
    ${g ? `<span class="chip ${g.canOpenPr ? toneClass.emerald : toneClass.amber}" title="${esc(g.rule)}">${logo("github", 11)} open PRs ${g.openPrs}/${g.prLimit}</span>` : ""}
    <span class="chip bg-white text-stone-500 ring-stone-200">API ${s.github?.rate?.remaining ?? "?"} left</span>
    <button class="btn btn-ghost text-xs" data-action="settings">Settings</button>
    <button class="btn btn-ghost text-xs" data-action="logout">Log out</button>
    <a href="https://github.com/${esc(s.me)}" target="_blank" class="flex items-center gap-2 rounded-full bg-white py-1 pr-3 pl-1 text-sm font-semibold shadow-sm ring-1 ring-stone-200"><img src="${esc(s.avatar)}" class="h-7 w-7 rounded-full" alt="">${esc(s.me)}</a>
  </div>`;
}

function loginView() {
  return shell(`<form class="card mx-auto mt-10 max-w-sm space-y-4 p-6" data-form="login"><h2 class="text-lg font-bold">Log in</h2>
    <div><label class="label">Password</label><input class="input" type="password" name="password" autocomplete="current-password" required autofocus></div>
    <button class="btn btn-primary w-full justify-center" ${busy("login")}>${ui.busy.login ? spinner : ""}Log in</button></form>`, false);
}

const steps = [["password", "Password"], ["github", "GitHub"], ["mode", "Setup type"], ["machines", "Machines"], ["agents", "Connect your AI"]];
function stepper(current) {
  const index = steps.findIndex(([key]) => key === current);
  return `<ol class="mb-6 flex flex-wrap items-center gap-2">${steps.map(([key, label], i) => `<li class="flex items-center gap-2"><span class="step-dot ${i < index ? "bg-brand-500 text-white ring-brand-500" : i === index ? "bg-white text-brand-600 ring-brand-500" : "bg-white text-stone-400 ring-stone-200"}">${i < index ? "✓" : i + 1}</span><span class="text-sm font-semibold ${i === index ? "text-stone-900" : "text-stone-400"}">${label}</span>${i < steps.length - 1 ? `<span class="mx-1 h-px w-6 bg-stone-200"></span>` : ""}</li>`).join("")}</ol>`;
}

function wizard() {
  const step = ui.session?.hasPassword ? ui.state?.setup?.step || "github" : "password";
  const body = { password: stepPassword, github: stepGithub, mode: stepMode, machines: stepMachines, agents: stepConnect, assistant: stepConnect, agent: stepConnect }[step]?.() || "";
  return shell(`<section class="card p-6 sm:p-8">${stepper(step)}${body}</section>`, false);
}

function stepPassword() {
  return `<form class="space-y-4" data-form="password"><div><h2 class="text-xl font-extrabold">Welcome 👋</h2><p class="mt-1 text-sm text-stone-600">The orchestrator keeps track of your AnyPS5 issues and pull requests, the machines you test on and what your AI agent is doing. It can build and test other people's fix branches on your GPUs in sandboxes. First, choose a password for this dashboard.</p></div>
    <div><label class="label">Setup code</label><input class="input font-mono sm:w-1/2" name="code" autocomplete="off" required><p class="mt-1 text-xs text-stone-500">Proves this is your orchestrator. It's printed in the log when the server starts${ui.session?.container ? " (<code>docker logs anyps5-orchestrator</code>, or the name of your container)" : ""} and saved as <code>setup-code</code> in its data folder.</p></div>
    <div class="grid gap-3 sm:grid-cols-2"><div><label class="label">Password (10+ characters)</label><input class="input" type="password" name="password" minlength="10" autocomplete="new-password" required autofocus></div><div><label class="label">Repeat it</label><input class="input" type="password" name="repeat" minlength="10" autocomplete="new-password" required></div></div>
    <p class="text-xs text-stone-500">It listens on this computer only (127.0.0.1) unless you start it with <code>HOST=0.0.0.0</code>. Secrets are encrypted in its data folder.</p>
    <div class="flex justify-end"><button class="btn btn-primary" ${busy("password")}>${ui.busy.password ? spinner : ""}Continue</button></div></form>`;
}

function stepGithub() {
  return `<form class="space-y-4" data-form="github"><div class="flex items-start gap-4"><div class="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-stone-900">${logo("github", 26, "#fff")}</div><div><h2 class="text-xl font-extrabold">Link your GitHub account</h2><p class="mt-1 text-sm text-stone-600">Used to list your PRs, issues and the threads you're in, to show new comments, your open-PR limit, and to find issues that link a fix branch. The orchestrator never posts anything.</p></div></div>
    <ol class="list-decimal space-y-1 pl-5 text-sm text-stone-600"><li>Open <a class="font-semibold text-brand-700 underline" target="_blank" href="https://github.com/settings/personal-access-tokens/new">GitHub → Fine-grained token</a>.</li><li>Repository access: <b>Public repositories</b> (read-only). No permissions need to be added.</li><li>Generate it and paste it here.</li></ol>
    <div><label class="label">Token</label><input class="input font-mono" name="token" placeholder="github_pat_…" autocomplete="off" required></div>
    <div><label class="label">Project repository</label><input class="input font-mono" name="repo" value="${esc(ui.state?.repo || "boykopovar/AnyPS5")}"></div>
    <div class="flex justify-end"><button class="btn btn-primary" ${busy("github")}>${ui.busy.github ? spinner : ""}Link account</button></div></form>`;
}

function stepMode() {
  const container = ui.session?.container;
  const card = (mode, title, text, art) => `<button class="mode-card ${mode === "simple" && container ? "cursor-not-allowed opacity-50 hover:translate-y-0 hover:shadow-none" : ""}" data-mode="${mode}" ${busy("mode") || (mode === "simple" && container ? "disabled" : "")}><div class="flex h-28 items-center justify-center gap-3 rounded-xl bg-gradient-to-br from-brand-50 to-white ring-1 ring-brand-100">${art}</div><div><div class="text-base font-bold text-stone-900">${title}</div><p class="mt-1 text-sm text-stone-600">${text}</p></div></button>`;
  const box = (label, icon) => `<div class="flex flex-col items-center gap-1"><div class="grid h-12 w-12 place-items-center rounded-xl bg-white shadow ring-1 ring-stone-200">${icon}</div><span class="text-[10px] font-semibold text-stone-500">${label}</span></div>`;
  return `<div class="space-y-4"><div><h2 class="text-xl font-extrabold">How do you work?</h2><p class="mt-1 text-sm text-stone-600">You can switch later in Settings.</p></div>
    <div class="grid gap-4 sm:grid-cols-2">
      ${card("simple", "Simple: this computer", container ? "Not available here: the orchestrator runs in a container, which can't run builds itself. Choose Advanced and add this host over SSH." : "The dashboard and the builds run on this computer. Best if you have one machine.", box("this PC", logo("linux", 24)))}
      ${card("advanced", "Advanced: several machines", "Add servers over SSH. Each one builds and tests on its own GPUs, so one job covers NVIDIA, AMD and Intel.", `${box("this PC", logo("linux", 24))}<span class="text-brand-400">⟶</span>${box("GPU box", logo("nvidia", 24))}${box("AMD box", logo("amd", 24))}`)}
    </div></div>`;
}

function gpuRow(machine, gpu, index) {
  const vendor = gpu.vendor === "other" ? "linux" : gpu.vendor;
  return `<label class="flex items-center gap-3 rounded-xl bg-stone-50 px-3 py-2 ring-1 ring-stone-100">${logo(vendor, 18)}<div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold text-stone-800">${esc(gpu.vulkanName || gpu.name)}</div><div class="truncate text-[11px] text-stone-500">${esc(gpu.driver || (gpu.vendor === "nvidia" ? `driver ${gpu.driver || ""}` : gpu.pci || ""))}${gpu.vendor !== "nvidia" && !gpu.vulkanName ? " · name appears after preparing" : ""}</div></div>
    <input type="checkbox" class="accent-brand-500" data-gpu="${esc(machine.id)}" data-index="${index}" ${gpu.enabled ? "checked" : ""}><span class="text-[11px] text-stone-500">test on it</span></label>`;
}

const healthIcon = { ok: ["✓", "bg-emerald-100 text-emerald-700"], warn: ["!", "bg-amber-100 text-amber-800"], fail: ["✕", "bg-rose-100 text-rose-700"], info: ["i", "bg-stone-100 text-stone-500"] };
const riskTone = { low: toneClass.emerald, medium: toneClass.amber, high: toneClass.rose };

function healthList(machine) {
  const health = machine.health;
  if (machine.healthRunning) return `<div class="mt-3 flex items-center gap-2 rounded-xl bg-stone-50 p-3 text-xs text-stone-500 ring-1 ring-stone-100"><span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600"></span>Checking what ${esc(machine.name)} has…</div>`;
  if (!health) return `<div class="mt-3 flex items-center justify-between rounded-xl bg-stone-50 p-3 text-xs text-stone-500 ring-1 ring-stone-100">Not checked yet<button class="btn btn-ghost text-xs" data-check="${esc(machine.id)}">Check this machine</button></div>`;
  const failing = health.items.filter((item) => item.status === "fail").length;
  const rows = health.items.filter((item) => item.id !== "os").map((item) => {
    const [icon, tone] = healthIcon[item.status] || healthIcon.info;
    const fix = item.fix && item.status !== "ok" ? (item.fix.manual
      ? `<details class="mt-1"><summary class="cursor-pointer text-[11px] font-semibold text-brand-700">How to fix</summary><ol class="mt-1 list-decimal space-y-0.5 pl-5 text-[11px] text-stone-600">${item.fix.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>${item.fix.note ? `<p class="mt-1 text-[11px] text-stone-500">${esc(item.fix.note)}</p>` : ""}</details>`
      : `<button class="btn btn-primary mt-1 px-2 py-0.5 text-[11px]" data-fix="${esc(machine.id)}" data-check-id="${esc(item.id)}">Fix: ${esc(item.fix.title)}</button>`) : "";
    return `<li class="flex gap-2.5 py-1.5"><span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${tone}">${icon}</span><div class="min-w-0 flex-1"><div class="text-xs font-semibold text-stone-800">${esc(item.title)}</div><div class="text-[11px] text-stone-500">${esc(item.detail)}</div>${fix}</div></li>`;
  }).join("");
  return `<div class="mt-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-100"><div class="mb-1 flex items-center gap-2 text-xs font-bold text-stone-700">${failing ? `<span class="chip ${toneClass.rose}">${failing} to fix</span>` : `<span class="chip ${toneClass.emerald}">ready to build</span>`}<span class="font-normal text-stone-400">checked ${esc(ago(health.checked))}</span><button class="btn btn-ghost ml-auto px-2 py-0.5 text-[11px]" data-check="${esc(machine.id)}">Check again</button></div><ul class="divide-y divide-stone-200/70">${rows}</ul>
    ${failing ? `<p class="mt-2 text-[11px] text-stone-500">Your connected AI can do this for you: ask it to "get ${esc(machine.name)} ready". Each fix still comes here for your approval.</p>` : ""}</div>`;
}

function fixModal(machine, item) {
  const recipe = item.fix;
  const modal = $("#modal");
  modal.innerHTML = `<form method="dialog" class="space-y-3 p-6"><div class="flex items-center gap-2"><div class="text-lg font-extrabold text-stone-900">${esc(recipe.title)}</div><span class="chip ${riskTone[recipe.risk] || toneClass.stone}">${esc(recipe.risk)} risk</span></div>
    <p class="text-sm text-stone-600">On <b>${esc(machine.name)}</b>, as root:</p>
    <pre class="max-h-64 overflow-auto rounded-xl bg-stone-900 p-3 font-mono text-[12px] leading-relaxed text-stone-100">${esc(recipe.commands.join("\n"))}</pre>
    ${recipe.note ? `<p class="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">${esc(recipe.note)}</p>` : ""}
    ${machine.health.needsPassword ? `<div><label class="label">sudo password for ${esc(machine.health.user)}</label><input class="input" type="password" name="sudo" autocomplete="off" autofocus><p class="mt-1 text-[11px] text-stone-500">Used once for this fix and not saved.</p></div>` : machine.auth === "password" ? `<p class="text-[11px] text-stone-500">sudo uses the sign-in password saved for this machine.</p>` : ""}
    <div class="flex justify-end gap-2 pt-1"><button class="btn btn-ghost" value="cancel">Cancel</button><button class="btn btn-primary" value="go">Run it</button></div></form>`;
  modal.showModal();
  modal.onclose = () => {
    if (modal.returnValue !== "go") return;
    const password = modal.querySelector("[name=sudo]")?.value || "";
    act(`fix-${machine.id}`, async () => { const result = await call("POST", `/api/machines/${machine.id}/fix`, { check: item.id, password }); if (!result.fixed) ui.flash = `${recipe.title} ran, but the check still fails: ${result.health.items.find((entry) => entry.id === item.id)?.detail || ""}`; });
  };
}

function machineSetupCard(machine) {
  const prep = machine.prepare || {};
  const warnings = [];
  if (machine.gpus?.some((gpu) => gpu.vendor === "nvidia") && machine.engine === "docker" && !machine.nvidiaToolkit) warnings.push("NVIDIA GPU found but no NVIDIA Container Toolkit: install it so containers can use the GPU.");
  if (machine.gpus?.some((gpu) => gpu.vendor === "nvidia") && machine.engine === "podman") warnings.push("Podman uses CDI for NVIDIA: run <code>sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml</code> once.");
  if (!machine.gpus?.length) warnings.push("No GPU found: Vulkan tests will need a GPU (CPU-only machines come in a later version).");
  if ((machine.diskFreeGb || 0) < 40) warnings.push(`Only ${machine.diskFreeGb} GB free in the home folder; builds need about 40 GB.`);
  return `<article class="rounded-2xl bg-white p-4 ring-1 ring-stone-200">
    <div class="flex flex-wrap items-center gap-3"><div class="grid h-11 w-11 place-items-center rounded-xl bg-stone-50 ring-1 ring-stone-200">${logo(osLogo(machine.os), 24)}</div>
      <div class="min-w-0 flex-1"><div class="font-bold text-stone-900">${esc(machine.name)} <span class="text-xs font-normal text-stone-400">${machine.kind === "ssh" ? `${esc(machine.user)}@${esc(machine.host)}:${machine.port}` : "this computer"}</span></div>
        <div class="text-xs text-stone-500">${esc(machine.os)} · ${esc(machine.cpu?.model)} · ${machine.cpu?.cores} threads · ${Math.round((machine.memMb || 0) / 1024)} GB · ${machine.engine ? `${logo(machine.engine === "podman" ? "podman" : "docker", 11)} ${esc(machine.engine)}` : `<span class="font-semibold text-rose-600">no container engine yet</span>`}</div></div>
      ${machine.kind === "ssh" ? `<span class="chip ${machine.auth === "password" ? toneClass.amber : toneClass.stone}">${machine.auth === "password" ? "password sign-in" : "key sign-in"}</span>${machine.auth === "password" ? `<button class="btn btn-ghost text-xs" data-tokey="${esc(machine.id)}">Switch to key</button>` : ""}` : ""}
      ${chip(prep.status === "running" ? "preparing" : prep.status || "needed", prep.status === "running" ? "running" : prep.status || "needed")}
      <button class="btn btn-primary text-xs" data-prepare="${esc(machine.id)}" ${prep.status === "running" || !machine.engine ? "disabled" : ""} title="${machine.engine ? "" : "Install Docker or Podman first (see the health check below)"}">${prep.status === "running" ? `${spinner} Preparing…` : prep.status === "ready" ? "Re-check" : "Prepare"}</button>
      <button class="btn btn-ghost text-xs" data-remove="${esc(machine.id)}">Remove</button></div>
    <div class="mt-3 grid gap-2">${(machine.gpus || []).map((gpu, index) => gpuRow(machine, gpu, index)).join("")}</div>
    ${healthList(machine)}
    ${prep.status === "running" ? `<p class="mt-2 text-xs text-stone-500">Building the build image on ${esc(machine.name)}. The first time takes 5 to 15 minutes; it's cached afterwards.</p>` : ""}
    ${prep.error ? `<p class="mt-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-700">${esc(prep.error)}</p>` : ""}
    ${warnings.map((text) => `<p class="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">${text}</p>`).join("")}
  </article>`;
}

function stepMachines(inSettings = false) {
  const s = ui.state;
  const advanced = s.mode === "advanced";
  const ready = s.machines.some((machine) => machine.prepare?.status === "ready");
  return `<div class="space-y-4">
    <div><h2 class="text-xl font-extrabold">${advanced ? "Your machines" : "This computer"}</h2><p class="mt-1 text-sm text-stone-600">Each machine needs Docker or Podman. <b>Prepare</b> builds the AnyPS5 build image there and finds the Vulkan name of every GPU. Builds run as your user, and code from other people's branches runs with no network.</p></div>
    <div class="space-y-3">${s.machines.map(machineSetupCard).join("") || `<div class="rounded-xl border-2 border-dashed border-stone-200 p-6 text-center text-sm text-stone-400">No machines yet</div>`}</div>
    ${advanced ? `<details data-keep="add-machine" class="rounded-2xl bg-brand-50/50 p-4 ring-1 ring-brand-100" ${s.machines.length ? "" : "open"}><summary class="cursor-pointer text-sm font-bold text-brand-700">+ Add a machine over SSH</summary>
      <form class="mt-3 space-y-3" data-form="machine">
        <div class="grid gap-3 sm:grid-cols-4"><div><label class="label">Name</label><input class="input" name="name" placeholder="gpu-box"></div><div><label class="label">Host</label><input class="input" name="host" placeholder="192.168.1.20" required></div><div><label class="label">User</label><input class="input" name="user" placeholder="you" autocomplete="off" required></div><div><label class="label">Port</label><input class="input" name="port" value="22"></div></div>
        <div><label class="label">How should the orchestrator sign in?</label><div class="grid gap-2 sm:grid-cols-3">
          ${[["password-key", "Password, then a key", "Recommended. Your password is used once to add the orchestrator's key, then forgotten."], ["password", "Password every time", "The password is stored encrypted and used for every connection."], ["key", "Key only", "You add the key below to ~/.ssh/authorized_keys yourself."]].map(([value, title, text]) => `<label class="flex cursor-pointer gap-2 rounded-xl bg-white p-3 ring-1 ${ui.sshAuth === value ? "ring-brand-400" : "ring-stone-200"}"><input type="radio" name="auth" value="${value}" class="mt-1 accent-brand-500" data-auth="${value}" ${ui.sshAuth === value ? "checked" : ""}><span><span class="block text-sm font-semibold text-stone-800">${title}</span><span class="block text-xs text-stone-500">${text}</span></span></label>`).join("")}
        </div></div>
        ${ui.sshAuth === "key" ? `<div class="space-y-2"><p class="text-sm text-stone-600">Put this key in <code>~/.ssh/authorized_keys</code> for that user:</p><code class="code">${esc(ui.publicKey || "loading…")}</code><p class="text-xs text-stone-500">On the machine: <code>echo '${esc(ui.publicKey || "KEY")}' >> ~/.ssh/authorized_keys</code></p></div>`
          : `<div class="sm:w-1/2"><label class="label">Password for that user</label><input class="input" type="password" name="password" autocomplete="off" required></div>`}
        <div class="flex justify-end gap-2">${s.machines.some((machine) => machine.kind === "local") ? "" : `<button type="button" class="btn btn-ghost" data-action="add-local">Add this computer too</button>`}<button class="btn btn-primary" ${busy("machine")}>${ui.busy.machine ? spinner : ""}Connect and detect</button></div>
        <p class="text-xs text-stone-500">The first connection trusts the host key it sees and pins it. Passwords are never shown again or written to logs.</p>
      </form></details>` : ""}
    ${inSettings ? "" : `<div class="flex items-center justify-between"><button class="btn btn-ghost" data-step="mode">Back</button><button class="btn btn-primary" data-step="agents" ${s.machines.length ? "" : "disabled"}>${ready ? "Continue" : "Continue (prepare later)"}</button></div>`}
  </div>`;
}

const clients = [["claude-code", "Claude Code", "anthropic"], ["codex", "Codex", "openai"], ["cursor", "Cursor", "cursor"], ["other", "Other MCP client", "linux"]];
const toolTitles = { queue_verification: "Queue a verification", cancel_job: "Cancel a job", prepare_machine: "Prepare a machine", set_gpu_enabled: "Change a GPU", run_command: "Run a command", fix_machine: "Fix a machine" };

function connectSnippets(agent) {
  const url = `${location.origin}/mcp`;
  const tokenValue = agent.token;
  const block = (title, icon, code, note = "") => `<div class="space-y-1"><p class="flex items-center gap-1.5 text-xs font-semibold text-stone-700">${logo(icon, 13)}${title}</p><div class="group relative"><code class="code whitespace-pre-wrap break-all">${esc(code)}</code><button type="button" class="absolute top-2 right-2 rounded-md bg-white/90 px-2 py-0.5 text-[10px] font-semibold text-stone-600 opacity-0 group-hover:opacity-100" data-copy-text="${esc(code)}">Copy</button></div>${note ? `<p class="text-[11px] text-stone-500">${note}</p>` : ""}</div>`;
  const prompt = `Please connect yourself to my AnyPS5 Orchestrator. It is an MCP server over HTTP at ${url}; every request needs the header "Authorization: Bearer ${tokenValue}". Add it to your MCP configuration as "anyps5", then call get_overview and tell me what needs my attention. While you work, use report_status so I can follow along in the dashboard.`;
  const all = {
    "claude-code": block("Claude Code: run in a terminal", "anthropic", `claude mcp add --transport http anyps5 ${url} --header "Authorization: Bearer ${tokenValue}"`, "Add <code>--scope user</code> to use it in every project."),
    codex: block("Codex: add to ~/.codex/config.toml", "openai", `[mcp_servers.anyps5]\nurl = "${url}"\nbearer_token_env_var = "ANYPS5_ORCHESTRATOR_TOKEN"`, `Then set the token in your shell: <code>export ANYPS5_ORCHESTRATOR_TOKEN=${esc(tokenValue)}</code>. Needs a Codex version with HTTP MCP servers.`),
    cursor: block("Cursor: add to .cursor/mcp.json", "cursor", JSON.stringify({ mcpServers: { anyps5: { url, headers: { Authorization: `Bearer ${tokenValue}` } } } }, null, 2)),
    other: block("Any MCP client with HTTP (streamable) servers", "linux", `URL:    ${url}\nHeader: Authorization: Bearer ${tokenValue}`),
  };
  return `<div class="space-y-4 rounded-2xl bg-emerald-50/60 p-4 ring-1 ring-emerald-200"><p class="text-sm font-semibold text-emerald-800">Token for ${esc(agent.name)} created. Copy it now; it isn't shown again.</p>
    ${block("Easiest: paste this message to your AI and let it set itself up", "github", prompt)}
    ${all[agent.client] || all.other}
    <details><summary class="cursor-pointer text-xs font-semibold text-stone-500">Setup for other clients</summary><div class="mt-2 space-y-3">${Object.entries(all).filter(([key]) => key !== agent.client).map(([, html]) => html).join("")}</div></details>
    <p class="text-[11px] text-stone-500">The address is the one you opened this page with (${esc(location.origin)}); your AI must be able to reach it. On the internet, put the orchestrator behind HTTPS.</p></div>`;
}

function stepConnect(inSettings = false) {
  const s = ui.state;
  const created = ui.newAgent;
  return `<div class="space-y-4">
    <div class="flex items-start gap-4"><div class="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-2xl text-white shadow">✦</div><div><h2 class="text-xl font-extrabold">${inSettings ? "Connected AI" : "Connect your AI"}</h2><p class="mt-1 text-sm text-stone-600">Use the AI you already have, such as Claude Code, Codex or Cursor, signed in however you like. It connects to the orchestrator over MCP and gets your machines, GPUs, jobs, results, PRs, issues, fix branches and PR limit in one place. It can update your plans and report what it's doing here. Anything that acts on your machines, like queuing a verification or running a command, comes to this dashboard as a request for you to approve.</p></div></div>
    ${s.agents.length ? `<div class="space-y-2">${s.agents.map((entry) => {
      const client = clients.find(([key]) => key === entry.client) || clients[3];
      return `<div class="rounded-xl bg-stone-50 px-3 py-2 ring-1 ring-stone-100"><div class="flex items-center gap-3">${logo(client[2], 20)}<div class="flex-1"><div class="text-sm font-semibold">${esc(entry.name)} <span class="text-[11px] font-normal text-stone-400">${esc(client[1])}</span></div><div class="text-[11px] text-stone-500">${entry.lastSeen ? `last connected ${esc(ago(entry.lastSeen))}` : "hasn't connected yet"}</div></div><button class="btn btn-ghost text-xs" data-revoke="${esc(entry.id)}">Revoke</button></div>
        ${entry.allowed.length ? `<div class="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-stone-500">Always allowed: ${entry.allowed.map((tool) => `<span class="chip bg-amber-50 text-amber-800 ring-amber-200">${esc(toolTitles[tool] || tool)}<button class="ml-1" title="Ask again" data-disallow="${esc(entry.id)}" data-tool="${esc(tool)}">×</button></span>`).join("")}</div>` : ""}</div>`;
    }).join("")}</div>` : ""}
    <form class="grid gap-2 sm:grid-cols-[1fr_auto_auto]" data-form="agent"><input class="input" name="name" placeholder="Name it, e.g. Claude Code on my laptop" required><select class="input" name="client">${clients.map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select><button class="btn btn-primary" ${busy("agent")}>Create connection</button></form>
    ${created ? connectSnippets(created) : ""}
    ${inSettings ? "" : `<div class="flex items-center justify-between border-t border-stone-100 pt-4"><button class="btn btn-ghost" data-step="machines">Back</button><button class="btn ${s.agents.length ? "btn-primary" : "btn-ghost"}" data-step="done">${s.agents.length ? "Open the dashboard" : "Skip for now"}</button></div>`}
  </div>`;
}

function requestBody(request) {
  const input = request.input || {};
  const repoName = (ui.state.repo || "/AnyPS5").split("/")[1];
  switch (request.tool) {
    case "queue_verification": return `<p>Build <a class="font-mono font-semibold text-brand-700" target="_blank" href="https://github.com/${esc(input.owner)}/${esc(repoName)}/tree/${esc(input.branch)}">${esc(input.owner)}/${esc(input.branch)}</a> merged onto main and test it against main on every prepared, enabled GPU${input.issue ? ` (for <a class="text-brand-700" target="_blank" href="https://github.com/${esc(ui.state.repo)}/issues/${esc(input.issue)}">#${esc(input.issue)}</a>)` : ""}. The branch runs sandboxed with no network.</p>${input.reason ? `<p class="text-stone-500">“${esc(input.reason)}”</p>` : ""}`;
    case "run_command": return `${input.why ? `<p class="text-stone-500">${esc(input.why)}</p>` : ""}<p class="text-xs font-semibold text-stone-600">On ${esc(input.machine)}${input.sudo ? `, <span class="text-rose-700">as root</span>` : ""}:</p><pre class="overflow-x-auto rounded-lg bg-stone-900 p-2 font-mono text-[12px] text-stone-100">${esc(input.command)}</pre>${input.sudo ? sudoField(ui.state.machines.find((entry) => entry.id === input.machine || entry.name === input.machine)) : ""}`;
    case "fix_machine": {
      const target = ui.state.machines.find((entry) => entry.id === input.machine || entry.name === input.machine);
      const item = target?.health?.items.find((entry) => entry.id === input.check);
      return `<p>${esc(item?.fix?.title || input.check)} on <b>${esc(input.machine)}</b>, <b>as root</b>${item?.fix?.risk ? ` <span class="chip ${riskTone[item.fix.risk]}">${esc(item.fix.risk)} risk</span>` : ""}</p>${input.why ? `<p class="text-stone-500">${esc(input.why)}</p>` : ""}${item?.fix?.commands ? `<pre class="overflow-x-auto rounded-lg bg-stone-900 p-2 font-mono text-[11px] text-stone-100">${esc(item.fix.commands.join("\n"))}</pre>` : ""}${item?.fix?.note ? `<p class="text-xs text-amber-800">${esc(item.fix.note)}</p>` : ""}${sudoField(target)}`;
    }
    case "cancel_job": return `<p>Stop job <code>${esc(input.job)}</code>.</p>`;
    case "prepare_machine": return `<p>Build the build image on <b>${esc(input.machine)}</b> and detect its GPUs.</p>`;
    case "set_gpu_enabled": return `<p>${input.enabled ? "Include" : "Exclude"} GPU ${esc(input.gpu)} on <b>${esc(input.machine)}</b> ${input.enabled ? "in" : "from"} verification runs.</p>`;
    default: return `<pre class="font-mono text-[11px]">${esc(JSON.stringify(input, null, 1))}</pre>`;
  }
}

function sudoField(machine) {
  if (!machine?.health?.needsPassword) return machine?.auth === "password" ? `<p class="text-[11px] text-stone-500">sudo uses the sign-in password saved for this machine.</p>` : "";
  return `<div class="pt-1"><label class="label">sudo password for ${esc(machine.health.user)}</label><input class="input" type="password" data-sudo-password autocomplete="off"><p class="mt-1 text-[11px] text-stone-500">Used once for this request and not saved.</p></div>`;
}

function requestsPanel(s) {
  const pending = (s.requests || []).filter((request) => request.status === "pending");
  const recent = (s.requests || []).filter((request) => request.status !== "pending").slice(0, 6);
  if (!pending.length && !recent.length) return "";
  return `<section class="card p-5 ${pending.length ? "ring-2 ring-amber-300" : ""}"><h2 class="section-title mb-4"><span class="h-2 w-2 rounded-full ${pending.length ? "animate-pulse bg-amber-500" : "bg-brand-500"}"></span>Requests from your AI${pending.length ? `<span class="chip bg-amber-50 text-amber-800 ring-amber-200">${pending.length} waiting</span>` : ""}</h2>
    <div class="grid gap-3 lg:grid-cols-2">${pending.map((request) => `<article class="rounded-2xl bg-amber-50/70 p-4 ring-1 ring-amber-300"><div class="mb-2 flex items-center gap-2"><span class="text-lg">✋</span><div class="flex-1"><div class="text-sm font-bold text-stone-900">${esc(toolTitles[request.tool] || request.tool)}</div><div class="text-[11px] text-stone-500">${esc(request.agentName)} · ${esc(ago(request.created))}</div></div></div><div class="space-y-1 text-sm text-stone-700">${requestBody(request)}</div>
      <div class="mt-3 flex flex-wrap gap-2"><button class="btn btn-primary text-xs" data-decide="${esc(request.id)}" data-choice="approve">Approve</button><button class="btn btn-ghost text-xs" data-decide="${esc(request.id)}" data-choice="deny">Deny</button>${request.tool !== "run_command" && request.tool !== "fix_machine" ? `<button class="btn btn-ghost text-xs" data-decide="${esc(request.id)}" data-choice="approve" data-always="1">Always allow for ${esc(request.agentName)}</button>` : ""}</div></article>`).join("")}</div>
    ${recent.length ? `<ol class="mt-4 space-y-1 text-xs text-stone-500">${recent.map((request) => `<li class="flex gap-2"><span class="w-14 shrink-0 text-right text-stone-400">${esc(ago(request.decided || request.created))}</span>${chip(request.status, request.status === "done" ? "clean" : request.status === "denied" ? "cancelled" : request.status)}<span>${esc(request.agentName)}: ${esc(toolTitles[request.tool] || request.tool)}${request.status === "failed" ? ` (${esc(request.result?.error || "")})` : ""}</span></li>`).join("")}</ol>` : ""}</section>`;
}

function kpis(s) {
  const mine = s.github?.mine || { prs: [], issues: [] };
  const tiles = [
    ["Open PRs", mine.prs.filter((pr) => pr.state === "open").length, "github"],
    ["Open issues", mine.issues.filter((issue) => issue.state === "open").length, "github"],
    ["Need approval", s.jobs.filter((job) => job.status === "awaiting-approval").length + (s.requests || []).filter((request) => request.status === "pending").length, "anthropic"],
    ["Jobs running", s.jobs.filter((job) => job.status === "running").length, "docker"],
    ["Fix branches", (s.github?.candidates || []).filter((c) => c.branches.length && !(c.check?.pulls || []).some((p) => p.state === "open")).length, "github"],
    ["Machines online", `${s.machines.filter((m) => m.live?.online).length}/${s.machines.length}`, "linux"],
  ];
  return `<section class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">${tiles.map(([label, value, icon]) => `<div class="card flex items-center gap-3 p-4"><div class="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 ring-1 ring-brand-100">${logo(icon, 20, "#ea580c")}</div><div><div class="text-2xl leading-none font-extrabold text-stone-900">${esc(value)}</div><div class="mt-1 text-xs font-medium text-stone-500">${esc(label)}</div></div></div>`).join("")}</section>`;
}

function agentsPanel(s, compact = false) {
  if (!s.agents.length) return `<section class="card flex flex-wrap items-center gap-4 p-5"><span class="text-3xl">🤖</span><div class="flex-1"><div class="font-bold">No AI connected</div><p class="text-sm text-stone-500">Connect Claude Code, Codex, Cursor or another MCP client to give it your context and see what it's working on here.</p></div><button class="btn btn-primary" data-action="settings">Connect your AI</button></section>`;
  return `<section><h2 class="section-title mb-3"><span class="h-2 w-2 rounded-full bg-brand-500"></span>Your AI agents</h2><div class="grid gap-4 ${compact ? "" : "md:grid-cols-2 2xl:grid-cols-3"}">${s.agents.map((agent) => {
    const status = agent.status;
    const stale = !status || Date.now() - Date.parse(status.at) > 30 * 60 * 1000;
    const state = !status ? "idle" : stale ? "idle" : status.state;
    return `<article class="card p-4"><div class="flex items-center gap-3"><div class="relative grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-xl text-white shadow">🤖${state === "working" ? `<span class="absolute -top-1 -right-1 h-3 w-3 animate-ping rounded-full bg-emerald-400"></span>` : ""}</div>
      <div class="min-w-0 flex-1"><div class="font-bold text-stone-900">${esc(agent.name)}</div><div class="text-[11px] text-stone-500">${status ? `updated ${esc(ago(status.at))}${status.machine ? ` · on ${esc(status.machine)}` : ""}` : "hasn't reported yet"}</div></div>${chip(state)}</div>
      ${status?.task ? `<div class="mt-3 rounded-xl bg-gradient-to-br from-brand-50 to-white p-3 ring-1 ring-brand-100"><div class="text-sm font-semibold text-stone-800">${esc(status.task)}</div>${status.detail ? `<p class="mt-1 line-clamp-3 text-xs text-stone-600">${esc(status.detail)}</p>` : ""}</div>` : ""}
      ${(status?.history || []).length > 1 ? `<ol class="mt-3 space-y-1">${status.history.slice(1, 6).map((entry) => `<li class="flex gap-2 text-xs text-stone-500"><span class="w-14 shrink-0 text-right text-stone-400">${esc(ago(entry.at))}</span><span class="truncate">${esc(entry.task)}</span></li>`).join("")}</ol>` : ""}
    </article>`;
  }).join("")}</div></section>`;
}

function machinesPanel(s, compact = false) {
  return `<section><h2 class="section-title mb-3"><span class="h-2 w-2 rounded-full bg-brand-500"></span>Machines</h2><div class="grid gap-4 md:grid-cols-2 ${compact ? "" : "2xl:grid-cols-4"}">${s.machines.map((machine) => {
    const live = machine.live || {};
    const cores = live.cpu?.cores || machine.cpu?.cores || 1;
    const load = live.cpu?.load?.[0] ?? 0;
    const mem = live.mem?.total ? live.mem.used / live.mem.total : 0;
    const running = s.jobs.filter((job) => job.status === "running").flatMap((job) => job.stages.filter((stage) => stage.machine === machine.id && stage.status === "running").map(() => job));
    const agentsHere = s.agents.filter((agent) => agent.status?.machine && agent.status.machine === machine.name && Date.now() - Date.parse(agent.status.at) < 30 * 60 * 1000);
    const work = [...running.map((job) => `Verifying ${job.title}`), ...agentsHere.map((agent) => `${agent.name}: ${agent.status.task}`), ...(machine.prepare?.status === "running" ? ["Building the build image"] : [])];
    const gpus = (live.gpus || []).map((gpu) => `<div class="rounded-xl bg-stone-50 p-2.5 ring-1 ring-stone-100"><div class="mb-1.5 flex items-center gap-2 text-xs font-semibold text-stone-700">${logo(gpu.vendor, 14)}<span class="truncate">${esc(gpu.name)}</span><span class="ml-auto font-mono text-stone-400">${gpu.temp ? `${gpu.temp}°C` : ""} ${gpu.power ? `${Math.round(gpu.power)}W` : ""}</span></div><div class="grid grid-cols-[52px_1fr] items-center gap-x-2 gap-y-1 text-[11px] text-stone-500"><span>util ${gpu.util ?? 0}%</span>${bar((gpu.util || 0) / 100)}<span>vram</span>${bar(gpu.memTotal ? gpu.memUsed / gpu.memTotal : 0)}</div></div>`).join("");
    const vendor = machine.gpus?.find((gpu) => gpu.vendor !== "other")?.vendor || osLogo(machine.os);
    return `<article class="card flex flex-col gap-3 p-4"><div class="flex items-start gap-3"><div class="relative grid h-11 w-11 place-items-center rounded-xl bg-white ring-1 ring-stone-200">${logo(vendor, 26)}<span class="absolute -right-1.5 -bottom-1.5 grid h-5 w-5 place-items-center rounded-md bg-white ring-1 ring-stone-200">${logo(osLogo(machine.os), 12)}</span></div>
      <div class="min-w-0 flex-1"><div class="flex items-center gap-2"><h3 class="font-bold text-stone-900">${esc(machine.name)}</h3><span class="h-2 w-2 rounded-full ${live.online ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]" : "bg-rose-500"}"></span><span class="ml-auto text-[11px] text-stone-400">${esc(ago(live.checked))}</span></div><p class="truncate text-xs text-stone-500">${machine.kind === "ssh" ? `${esc(machine.user)}@${esc(machine.host)}` : "this computer"} · ${esc(machine.engine)} · ${chip(machine.prepare?.status || "needed")}</p></div></div>
      <div class="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-1.5 text-[11px] text-stone-500"><span>cpu ${Math.round((load / cores) * 100)}%</span>${bar(load / cores)}<span>mem ${Math.round(mem * 100)}%</span>${bar(mem)}</div>
      ${gpus ? `<div class="grid gap-2">${gpus}</div>` : ""}
      <div class="rounded-xl bg-gradient-to-br from-brand-50 to-white p-3 ring-1 ring-brand-100"><div class="mb-1 text-[11px] font-bold tracking-wider text-brand-700 uppercase">Working on</div><ul class="space-y-1 text-sm text-stone-700">${(work.length ? work : [live.online ? "Idle" : live.error || "Offline"]).map((line) => `<li class="flex gap-2"><span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400"></span><span>${esc(line)}</span></li>`).join("")}</ul></div>
      ${(live.containers || []).length ? `<div class="flex flex-wrap gap-1">${live.containers.slice(0, 8).map((c) => `<span class="chip bg-sky-50 text-sky-700 ring-sky-100">${logo("docker", 11)}${esc(c.name)}</span>`).join("")}</div>` : ""}
      <div class="mt-auto text-[11px] text-stone-400">${esc(machine.cpu?.model || "")} · ${esc(live.uptime || "")}</div></article>`;
  }).join("") || `<div class="text-sm text-stone-400">No machines. Add one in Settings.</div>`}</div></section>`;
}

function jobsPanel(s) {
  const jobs = s.jobs.filter((job) => !["rejected"].includes(job.status)).slice(0, 25);
  const body = jobs.map((job) => {
    const progress = job.stages.flatMap((stage) => (stage.progress || []).slice(-6).map((line) => `[${stage.machineName}] ${line}`));
    const cells = job.stages.flatMap((stage) => stage.gpus.map((gpu) => {
      const key = gpu.result?.verdict || (stage.status === "running" ? "running" : stage.status);
      return `<div class="flex min-w-0 items-center gap-2 rounded-xl bg-stone-50 px-2.5 py-2 ring-1 ring-stone-100" title="${esc(stage.reason || gpu.result?.gpu || "")}">${logo(gpu.vendor, 16)}<div class="min-w-0"><div class="truncate text-[11px] font-semibold text-stone-700">${esc(gpu.label)}</div><div class="truncate text-[10px] text-stone-400">${esc(stage.machineName)}</div>${chip(key)}</div></div>`;
    })).join("");
    return `<article class="rounded-2xl p-4 ring-1 ${job.status === "awaiting-approval" ? "bg-amber-50/50 ring-amber-200" : job.status === "running" ? "bg-gradient-to-br from-brand-50/60 to-white ring-stone-200" : "bg-white ring-stone-200"}">
      <div class="flex flex-wrap items-center gap-2"><img src="https://github.com/${esc(job.owner)}.png?size=48" class="h-7 w-7 rounded-full ring-2 ring-white" alt="">
        <div class="min-w-0 flex-1"><div class="truncate font-semibold text-stone-900">${esc(job.title)}</div><div class="truncate font-mono text-[11px] text-stone-500">${esc(job.owner)}/${esc(job.branch)}${job.issue ? ` · <a class="text-brand-600 hover:underline" target="_blank" href="https://github.com/${esc(s.repo)}/issues/${job.issue}">#${job.issue}</a>` : ""} · ${job.requestedBy === "you" ? "you" : `🤖 ${esc(job.requestedBy)}`} · ${esc(ago(job.created))}</div></div>
        ${chip(job.status)}
        ${job.status === "awaiting-approval" ? `<button class="btn btn-ghost text-xs" data-review="${esc(job.id)}">Review files</button><button class="btn btn-primary text-xs" data-approve="${esc(job.id)}">Approve</button><button class="btn btn-ghost text-xs" data-cancel="${esc(job.id)}">Reject</button>` : ["queued", "running"].includes(job.status) ? `<button class="btn btn-ghost text-xs" data-cancel="${esc(job.id)}">Cancel</button>` : `<button class="btn btn-ghost text-xs" data-retry="${esc(job.id)}">Run again</button><button class="btn btn-ghost text-xs" data-remove-job="${esc(job.id)}" title="Delete the job and its files on the machines">Delete</button>`}</div>
      ${job.stages.filter((stage) => stage.reason).map((stage) => `<p class="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 ring-1 ring-rose-100"><b>${esc(stage.machineName)}:</b> ${esc(stage.reason)}</p>`).join("")}
      ${job.reason ? `<p class="mt-2 text-xs text-stone-600">“${esc(job.reason)}”</p>` : ""}
      <div class="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">${cells}</div>
      ${progress.length ? `<details data-keep="progress-${esc(job.id)}" class="mt-3" ${job.status === "running" ? "open" : ""}><summary class="cursor-pointer text-xs font-semibold text-stone-500">Progress</summary><pre class="mt-2 max-h-44 overflow-auto rounded-xl bg-stone-900 p-3 font-mono text-[11px] leading-relaxed text-stone-200">${esc(progress.join("\n"))}</pre></details>` : ""}
      ${job.report ? `<details data-keep="report-${esc(job.id)}" class="mt-3"><summary class="cursor-pointer text-xs font-semibold text-brand-700">Draft report (not posted)</summary><textarea readonly class="mt-2 h-52 w-full rounded-xl bg-stone-50 p-3 font-mono text-[11px] ring-1 ring-stone-200">${esc(job.report)}</textarea><button class="btn btn-primary mt-2 text-xs" data-copy="${esc(job.id)}">Copy report</button></details>` : ""}
    </article>`;
  }).join("");
  return `<section class="card p-5"><div class="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 class="section-title"><span class="h-2 w-2 rounded-full bg-brand-500"></span>Verification work</h2><span class="text-xs text-stone-400">Branch code runs with no network, in its own copies, as your user</span></div>
    <div class="space-y-3">${body || `<div class="rounded-xl border-2 border-dashed border-stone-200 p-8 text-center text-sm text-stone-400">Nothing yet. Pick a fix branch below and press <b class="text-brand-600">Verify</b>, or let your agent ask for one.</div>`}</div></section>`;
}

function plansPanel(s) {
  const lanes = [["now", "Now"], ["next", "Next"], ["later", "Later"]];
  return `<section class="card p-5"><div class="mb-4 flex items-center justify-between"><h2 class="section-title"><span class="h-2 w-2 rounded-full bg-brand-500"></span>Plans</h2><button class="btn btn-ghost text-xs" data-action="add-plan">+ Add</button></div><div class="space-y-4">${lanes.map(([lane, label]) => {
    const items = s.plans.filter((entry) => entry.lane === lane && entry.status !== "done");
    return `<div><div class="mb-2 flex items-center gap-2 text-xs font-bold tracking-wider uppercase ${lane === "now" ? "text-brand-600" : "text-stone-400"}">${label}<span class="rounded-full bg-stone-100 px-1.5 text-[10px] text-stone-500">${items.length}</span></div><div class="space-y-2">${items.map((entry) => `
      <div class="group rounded-xl p-3 ring-1 ${lane === "now" ? "bg-brand-50/60 ring-brand-200" : "bg-white ring-stone-200"}"><div class="flex items-start gap-2"><input type="checkbox" class="mt-1 accent-brand-500" data-done="${esc(entry.id)}"><div class="min-w-0 flex-1"><div class="text-sm font-semibold text-stone-800">${esc(entry.title)}</div>${entry.detail ? `<p class="mt-0.5 text-xs text-stone-500">${esc(entry.detail)}</p>` : ""}<div class="mt-1 text-[10px] text-stone-400">${entry.by && entry.by !== "you" ? `🤖 ${esc(entry.by)} · ` : ""}${esc(ago(entry.created))}</div></div>
      <div class="flex gap-1 opacity-0 transition group-hover:opacity-100">${lanes.filter(([other]) => other !== lane).map(([other, name]) => `<button class="rounded-md px-1.5 text-[10px] font-semibold text-stone-500 ring-1 ring-stone-200 hover:bg-stone-50" data-lane="${esc(entry.id)}" data-to="${other}">${name}</button>`).join("")}<button class="rounded-md px-1.5 text-[10px] text-rose-500 ring-1 ring-rose-100" data-delete="${esc(entry.id)}">×</button></div></div></div>`).join("") || `<div class="text-xs text-stone-300">—</div>`}</div></div>`;
  }).join("")}</div></section>`;
}

function itemRow(s, entry, kind) {
  const status = entry.merged ? "merged" : entry.state;
  return `<a href="${esc(entry.url)}" target="_blank" class="flex items-center gap-3 py-2.5 hover:bg-brand-50/40"><img src="https://opengraph.githubassets.com/1/${esc(s.repo)}/${entry.pr ? "pull" : "issues"}/${entry.number}" class="hidden h-11 w-20 shrink-0 rounded-lg object-cover ring-1 ring-stone-200 sm:block" loading="lazy" alt="">
    <div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold text-stone-800"><span class="text-stone-400">#${entry.number}</span> ${esc(entry.title)}</div><div class="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-stone-500">${chip(status)}${kind === "threads" ? `${avatar(entry.author, 16)}<span>${esc(entry.author?.login)}</span>` : ""}${entry.labels.slice(0, 3).map((label) => `<span class="chip ring-stone-200" style="background:#${esc(label.color)}22;color:#57534e">${esc(label.name)}</span>`).join("")}<span>💬 ${entry.comments}</span><span>· ${esc(ago(entry.updated))}</span></div></div></a>`;
}

function githubPanels(s) {
  const data = s.github?.mine || { prs: [], issues: [], threads: [] };
  const tabs = [["prs", "Our PRs", data.prs], ["issues", "Our issues", data.issues], ["threads", "Threads we're in", data.threads]];
  const list = tabs.find(([key]) => key === ui.mineTab)[2];
  const comments = (s.github?.comments || []).slice(0, 12);
  return `<div class="grid gap-6 xl:grid-cols-2"><section class="card p-5"><div class="mb-4 flex flex-wrap items-center gap-2"><h2 class="section-title mr-auto">${s.avatar ? `<img src="${esc(s.avatar)}" class="h-5 w-5 rounded-full" alt="">` : ""}Ours</h2>${tabs.map(([key, label, items]) => `<button class="tab ${ui.mineTab === key ? "tab-on" : ""}" data-tab="${key}">${label} <span class="text-stone-400">${items.length}</span></button>`).join("")}</div>
      <div class="divide-y divide-stone-100">${list.map((entry) => itemRow(s, entry, ui.mineTab)).join("") || `<div class="py-6 text-center text-sm text-stone-400">${s.github ? "Nothing here" : "Loading from GitHub…"}</div>`}</div>
      <form class="mt-3 flex gap-2" data-form="track"><input class="input" name="number" placeholder="Track another issue or PR by number"><button class="btn btn-ghost shrink-0 text-xs">Track</button></form></section>
    <section class="card p-5"><h2 class="section-title mb-4"><span class="h-2 w-2 rounded-full bg-brand-500"></span>New comments on our threads</h2><div class="space-y-3">${comments.map((comment) => `<a href="${esc(comment.url)}" target="_blank" class="flex gap-3 rounded-xl p-2 hover:bg-brand-50/40">${avatar(comment.author, 32)}<div class="min-w-0 flex-1"><div class="text-xs text-stone-500"><b class="text-stone-800">${esc(comment.author?.login)}</b> on <span class="text-brand-700">#${comment.number}</span> · ${esc(ago(comment.at))}</div><p class="line-clamp-3 text-sm text-stone-700">${esc(comment.body)}</p></div></a>`).join("") || `<div class="py-6 text-center text-sm text-stone-400">No comments from others yet</div>`}</div></section></div>`;
}

function candidatesPanel(s) {
  const hide = ui.hidePr !== false;
  const queued = new Set(s.jobs.filter((job) => ["awaiting-approval", "queued", "running"].includes(job.status)).map((job) => `${job.owner}/${job.branch}`));
  const list = (s.github?.candidates || []).filter((c) => c.branches.length && (!hide || !(c.check?.pulls || []).some((p) => p.state === "open")));
  return `<section class="card p-5"><div class="mb-4 flex flex-wrap items-center gap-3"><h2 class="section-title mr-auto"><span class="h-2 w-2 rounded-full bg-brand-500"></span>Issues with a fix branch you could verify</h2><label class="flex items-center gap-2 text-xs text-stone-500"><input type="checkbox" data-action="hide-pr" ${hide ? "checked" : ""} class="accent-brand-500"> Hide branches that already have an open PR</label></div>
    <div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">${list.slice(0, 45).map((c) => {
      const branch = c.branches[0];
      const key = `${branch.owner}/${branch.branch}`;
      return `<article class="flex flex-col gap-2 rounded-2xl bg-white p-4 ring-1 ring-stone-200"><div class="flex items-center gap-2">${avatar(c.author, 26)}<a href="${esc(c.url)}" target="_blank" class="min-w-0 flex-1 truncate text-sm font-semibold text-stone-800 hover:text-brand-700"><span class="text-stone-400">#${c.number}</span> ${esc(c.title)}</a></div>
        <div class="flex flex-wrap items-center gap-1 text-[11px]"><img src="https://github.com/${esc(branch.owner)}.png?size=32" class="h-4 w-4 rounded-full" alt=""><a target="_blank" href="https://github.com/${esc(branch.owner)}/${esc(s.repo.split("/")[1])}/tree/${esc(branch.branch)}" class="font-mono text-stone-600 hover:text-brand-700">${esc(key)}</a>
          ${c.check?.error ? `<span class="chip bg-rose-50 text-rose-600 ring-rose-100">${esc(c.check.error.slice(0, 40))}</span>` : c.check ? `<span class="chip bg-stone-50 text-stone-600 ring-stone-200">+${c.check.ahead} / −${c.check.behind} vs main</span><span class="chip bg-stone-50 text-stone-600 ring-stone-200">${c.check.files.length} files</span>` : `<span class="chip bg-stone-50 text-stone-400 ring-stone-200">checking…</span>`}${(c.check?.pulls || []).map((p) => chip(`PR #${p.number} ${p.state}`, p.state)).join("")}</div>
        <div class="mt-auto flex items-center gap-2 pt-1"><span class="text-[11px] text-stone-400">updated ${esc(ago(c.updated))}</span><button class="btn btn-primary ml-auto text-xs" data-verify="${c.number}" ${queued.has(key) || c.check?.error || !c.check ? "disabled" : ""}>${queued.has(key) ? "Queued" : "Verify"}</button></div></article>`;
    }).join("") || `<div class="text-sm text-stone-400">${s.github ? "No open issue links a fix branch right now." : "Scanning issues…"}</div>`}</div></section>`;
}

function activityPanel(s) {
  return `<section class="card p-5"><h2 class="section-title mb-4"><span class="h-2 w-2 rounded-full bg-brand-500"></span>Activity</h2><ol class="space-y-2 text-sm">${s.activity.slice(0, 30).map((entry) => `<li class="flex gap-3"><span class="w-16 shrink-0 text-right text-[11px] text-stone-400">${esc(ago(entry.at))}</span><span class="text-stone-700">${entry.who && entry.who !== "orchestrator" && entry.who !== "you" ? "🤖 " : ""}${esc(entry.text)}</span></li>`).join("") || `<li class="text-stone-400">Nothing yet</li>`}</ol></section>`;
}

function dashboard() {
  const s = ui.state;
  const settings = ui.settings ? `<section class="card space-y-8 p-6"><div class="flex items-center justify-between"><h2 class="text-lg font-extrabold">Settings</h2><button class="btn btn-ghost text-xs" data-action="settings">Close</button></div>
    <div class="flex flex-wrap items-center gap-3 text-sm">Setup type: ${["simple", "advanced"].map((mode) => `<button class="tab ${s.mode === mode ? "tab-on" : ""}" data-mode="${mode}">${mode === "simple" ? "Simple (this computer)" : "Advanced (SSH machines)"}</button>`).join("")}</div>
    ${stepMachines(true)}${stepConnect(true)}</section>` : "";
  const compact = s.agents.length <= 1 && s.machines.length <= 2;
  const fleet = compact ? `<div class="grid items-start gap-6 xl:grid-cols-[1fr_2fr]">${agentsPanel(s, true)}${machinesPanel(s, true)}</div>` : `${agentsPanel(s)}${machinesPanel(s)}`;
  return shell(`${settings}${kpis(s)}${requestsPanel(s)}${fleet}<div class="grid gap-6 xl:grid-cols-[1.6fr_1fr]">${jobsPanel(s)}${plansPanel(s)}</div>${githubPanels(s)}${candidatesPanel(s)}${activityPanel(s)}
    ${Object.keys(s.errors || {}).length ? `<div class="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-200">${Object.entries(s.errors).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join("")}</div>` : ""}`);
}

function snapshot(app) {
  const fields = {};
  for (const field of app.querySelectorAll("form[data-form] [name]")) {
    const key = `${field.closest("form").dataset.form}:${field.name}`;
    if (field.type === "radio") { if (field.checked) fields[key] = field.value; }
    else if (field.type === "checkbox") fields[key] = field.checked;
    else if (field.value !== "") fields[key] = field.value;
  }
  const open = [...app.querySelectorAll("details[data-keep]")].map((details) => [details.dataset.keep, details.open]);
  const active = document.activeElement;
  const focus = active?.name && active.closest?.("form[data-form]") ? { key: `${active.closest("form").dataset.form}:${active.name}`, start: active.selectionStart, end: active.selectionEnd } : null;
  return { fields, open, focus };
}

function restore(app, saved) {
  const skip = ui.skipRestore;
  ui.skipRestore = null;
  for (const field of app.querySelectorAll("form[data-form] [name]")) {
    const key = `${field.closest("form").dataset.form}:${field.name}`;
    if (!(key in saved.fields) || field.closest("form").dataset.form === skip) continue;
    if (field.type === "radio") field.checked = field.value === saved.fields[key];
    else if (field.type === "checkbox") field.checked = saved.fields[key];
    else field.value = saved.fields[key];
  }
  for (const [key, open] of saved.open) { const details = app.querySelector(`details[data-keep="${key}"]`); if (details) details.open = open; }
  if (saved.focus) {
    const field = [...app.querySelectorAll("form[data-form] [name]")].find((entry) => `${entry.closest("form").dataset.form}:${entry.name}` === saved.focus.key);
    if (field) { field.focus(); try { if (saved.focus.start !== null && saved.focus.start !== undefined) field.setSelectionRange(saved.focus.start, saved.focus.end); } catch {} }
  }
}

function render() {
  const app = $("#app");
  const saved = snapshot(app);
  if (!ui.session) { app.innerHTML = shell(`<div class="py-20 text-center text-stone-400">Loading…</div>`); return; }
  if (ui.session.hasPassword && !ui.session.authed) app.innerHTML = loginView();
  else if (!ui.state?.setup?.done) app.innerHTML = wizard();
  else app.innerHTML = dashboard();
  restore(app, saved);
}

async function refresh() {
  try {
    ui.session = await (await fetch("/api/session", { cache: "no-store" })).json();
    if (ui.session.authed) {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (response.ok) ui.state = await response.json();
      if (!ui.publicKey && ui.state?.mode === "advanced") ui.publicKey = (await (await fetch("/api/ssh-key")).json()).publicKey;
    }
  } catch (error) { ui.flash = `offline: ${error.message}`; }
  render();
}

function reviewModal(files, title, onConfirm) {
  const modal = $("#modal");
  modal.innerHTML = `<form method="dialog" class="p-6"><div class="mb-2 text-xs text-stone-500">Before it builds</div><div class="mb-3 font-bold text-stone-900">${esc(title)}</div>
    <p class="mb-3 text-sm text-stone-600">The branch is merged onto main and built and tested on every prepared GPU. Its code runs only in containers with no network, but build scripts still run, so look over what it changes:</p>
    <ul class="mb-3 max-h-56 overflow-auto rounded-xl bg-stone-50 p-3 font-mono text-[11px] text-stone-700 ring-1 ring-stone-200">${files.map((file) => `<li class="${/CMakeLists|\.cmake$|\.sh$|\.py$|\.github\//.test(file) ? "font-bold text-brand-700" : ""}">${esc(file)}</li>`).join("") || "<li>file list not available yet</li>"}</ul>
    <p class="mb-4 text-xs text-stone-500">Highlighted files run during the build or tests: read them on GitHub first.</p>
    <div class="flex justify-end gap-2"><button class="btn btn-ghost" value="cancel">Cancel</button>${onConfirm ? `<button class="btn btn-primary" value="go">I've reviewed it, run it</button>` : ""}</div></form>`;
  modal.showModal();
  modal.onclose = () => { if (modal.returnValue === "go" && onConfirm) onConfirm(); };
}

function candidateFor(job) { return (ui.state.github?.candidates || []).find((c) => c.branches.some((b) => b.owner === job.owner && b.branch === job.branch)); }

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;
  if (kind === "login") act("login", () => call("POST", "/api/login", data));
  if (kind === "password") { if (data.password !== data.repeat) { ui.flash = "the passwords don't match"; render(); return; } act("password", () => call("POST", "/api/setup/password", { password: data.password, code: data.code })); }
  if (kind === "github") act("github", () => call("POST", "/api/setup/github", data));
  if (kind === "machine") act("machine", async () => { await call("POST", "/api/machines", { kind: "ssh", ...data, auth: ui.sshAuth }); form.reset(); });
  if (kind === "agent") act("agent", async () => { ui.newAgent = await call("POST", "/api/agents", data); });
  if (kind === "track") act("track", () => call("POST", "/api/tracked", data));
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("button, input[type=checkbox], [data-action]");
  if (!target) return;
  const d = target.dataset;
  if (d.action === "dismiss") { ui.flash = null; render(); }
  else if (d.action === "settings") { ui.settings = !ui.settings; render(); }
  else if (d.action === "logout") act("logout", () => call("POST", "/api/logout"));
  else if (d.action === "add-local") act("machine", () => call("POST", "/api/machines", { kind: "local" }));
  else if (d.action === "hide-pr") { ui.hidePr = target.checked; render(); }
  else if (d.action === "add-plan") { const title = prompt("Plan"); if (title) act("plan", () => call("POST", "/api/plans", { title, detail: prompt("Details (optional)") || "", lane: "next" })); }
  else if (d.mode) act("mode", () => call("POST", "/api/setup/mode", { mode: d.mode }));
  else if (d.step) act("step", () => call("POST", "/api/setup/step", { step: d.step }));
  else if (d.auth) { ui.sshAuth = d.auth; render(); }
  else if (d.decide) { const password = target.closest("article")?.querySelector("[data-sudo-password]")?.value || ""; act("decide", () => call("POST", `/api/requests/${d.decide}/decide`, { decision: d.choice, always: Boolean(d.always), password })); }
  else if (d.check) act(`check-${d.check}`, () => call("POST", `/api/machines/${d.check}/check`));
  else if (d.fix) { const machine = ui.state.machines.find((entry) => entry.id === d.fix); fixModal(machine, machine.health.items.find((item) => item.id === d.checkId)); }
  else if (d.disallow) { const agent = ui.state.agents.find((entry) => entry.id === d.disallow); act("agent", () => call("PATCH", `/api/agents/${d.disallow}`, { allowed: agent.allowed.filter((tool) => tool !== d.tool) })); }
  else if (d.copyText) { navigator.clipboard.writeText(d.copyText.replace(/\\n/g, "\n")); target.textContent = "Copied"; }
  else if (d.tokey) act("tokey", () => call("PATCH", `/api/machines/${d.tokey}`, { switchToKey: true }));
  else if (d.prepare) act(`prep-${d.prepare}`, () => call("POST", `/api/machines/${d.prepare}/prepare`));
  else if (d.remove && confirm("Remove this machine from the orchestrator?")) act("remove", () => call("DELETE", `/api/machines/${d.remove}`));
  else if (d.gpu) act("gpu", () => call("PATCH", `/api/machines/${d.gpu}`, { gpu: Number(d.index), gpuEnabled: target.checked }));
  else if (d.revoke && confirm("Revoke this agent's token?")) act("revoke", () => call("DELETE", `/api/agents/${d.revoke}`));
  else if (d.tab) { ui.mineTab = d.tab; render(); }
  else if (d.verify) {
    const c = ui.state.github.candidates.find((entry) => entry.number === Number(d.verify));
    const branch = c.branches[0];
    reviewModal(c.check?.files || [], `#${c.number} ${c.title} · ${branch.owner}/${branch.branch}`, () => act("verify", () => call("POST", "/api/jobs", { issue: c.number, owner: branch.owner, branch: branch.branch, title: `#${c.number} ${c.title}` })));
  }
  else if (d.review) { const job = ui.state.jobs.find((entry) => entry.id === d.review); reviewModal(candidateFor(job)?.check?.files || [], `${job.title} · ${job.owner}/${job.branch}`, null); }
  else if (d.approve) {
    const job = ui.state.jobs.find((entry) => entry.id === d.approve);
    reviewModal(candidateFor(job)?.check?.files || [], `${job.title} · requested by ${job.requestedBy}`, () => act("approve", () => call("POST", `/api/jobs/${d.approve}/approve`)));
  }
  else if (d.cancel && confirm("Stop this job?")) act("cancel", () => call("POST", `/api/jobs/${d.cancel}/cancel`));
  else if (d.retry) act("retry", () => call("POST", `/api/jobs/${d.retry}/retry`));
  else if (d.removeJob && confirm("Delete this job and its logs on the machines?")) act("job", () => call("DELETE", `/api/jobs/${d.removeJob}`));
  else if (d.copy) { navigator.clipboard.writeText(ui.state.jobs.find((job) => job.id === d.copy).report); target.textContent = "Copied"; }
  else if (d.done) act("plan", () => call("PATCH", `/api/plans/${d.done}`, { status: "done" }));
  else if (d.lane) act("plan", () => call("PATCH", `/api/plans/${d.lane}`, { lane: d.to }));
  else if (d.delete && confirm("Delete this plan?")) act("plan", () => call("DELETE", `/api/plans/${d.delete}`));
});

refresh();
setInterval(refresh, 8000);
