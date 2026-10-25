const cache = new Map();
export const rate = { remaining: null, reset: null };

export class GitHub {
  constructor(token, repo) {
    this.token = token;
    this.repo = repo;
  }

  async get(path) {
    const url = `https://api.github.com/${path}`;
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "anyps5-orchestrator", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const key = `${this.token ? "t" : "a"}:${url}`;
    const cached = cache.get(key);
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (response.headers.get("x-ratelimit-remaining") !== null) {
      rate.remaining = Number(response.headers.get("x-ratelimit-remaining"));
      rate.reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    }
    if (response.status === 304 && cached) return cached.body;
    if (!response.ok) throw new Error(`GitHub ${response.status} on ${path.split("?")[0]}`);
    const body = await response.json();
    cache.set(key, { etag: response.headers.get("etag"), body });
    return body;
  }

  search(kind, query, per = 50) {
    return this.get(`search/issues?q=${encodeURIComponent(`repo:${this.repo}${kind ? ` is:${kind}` : ""} ${query}`)}&per_page=${per}&sort=updated&order=desc`);
  }

  user() { return this.get("user"); }
}

const branchLink = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([\w./%-]+?)(?=[)\s"'>\]`]|$)/g;

export function fixBranches(text, upstreamOwner, project) {
  const found = [];
  for (const [, user, name, branch] of (text || "").matchAll(branchLink)) {
    if (user.toLowerCase() === upstreamOwner.toLowerCase() || name.toLowerCase() !== project.toLowerCase()) continue;
    const clean = decodeURIComponent(branch).replace(/[.,;:]+$/, "");
    if (/^[0-9a-f]{7,40}$/.test(clean)) continue;
    if (!found.some((entry) => entry.owner === user && entry.branch === clean)) found.push({ owner: user, branch: clean });
  }
  return found;
}

function person(user) {
  return user ? { login: user.login, avatar: user.avatar_url, url: user.html_url } : null;
}

function item(raw) {
  return {
    number: raw.number, title: raw.title, url: raw.html_url, state: raw.state, author: person(raw.user), pr: Boolean(raw.pull_request),
    merged: Boolean(raw.pull_request?.merged_at), draft: Boolean(raw.draft), comments: raw.comments,
    labels: (raw.labels || []).map((label) => ({ name: label.name, color: label.color })), created: raw.created_at, updated: raw.updated_at,
  };
}

export async function collect(store, cache) {
  const config = store.data.config;
  const login = config.github?.login;
  if (!login) return;
  const gh = new GitHub(store.secret(config.github.token), config.repo);
  const [upstreamOwner, project] = config.repo.split("/");
  const github = cache.github || { candidates: [], comments: [] };
  const [prs, issues, threadIssues, threadPrs, merged] = await Promise.all([
    gh.search("pr", `author:${login}`), gh.search("issue", `author:${login}`), gh.search("issue", `commenter:${login} -author:${login}`, 30), gh.search("pr", `commenter:${login} -author:${login}`, 30), gh.search("pr", `author:${login} is:merged`, 1),
  ]);
  const threads = { items: [...threadIssues.items, ...threadPrs.items] };
  const tracked = (config.tracked || []).filter((number) => !threads.items.some((raw) => raw.number === number));
  const extra = [];
  for (const number of tracked.slice(0, 15)) { try { extra.push(await gh.get(`repos/${config.repo}/issues/${number}`)); } catch {} }
  github.mine = { prs: prs.items.map(item), issues: issues.items.map(item), threads: [...threads.items, ...extra].map(item).sort((a, b) => b.updated.localeCompare(a.updated)) };
  const openPrs = github.mine.prs.filter((pr) => pr.state === "open").length;
  const limit = merged.total_count > 0 ? 20 : 1;
  github.guardrails = { openPrs, mergedPrs: merged.total_count, prLimit: limit, canOpenPr: openPrs < limit, rule: "CONTRIBUTING.md: 1 open PR until one has merged, then 20" };

  const seen = store.data.seen ||= {};
  const comments = [];
  for (const entry of [...github.mine.prs, ...github.mine.issues, ...github.mine.threads].filter((entry) => entry.state === "open").slice(0, 20)) {
    if (seen[entry.number]?.updated !== entry.updated) {
      try {
        const list = await gh.get(`repos/${config.repo}/issues/${entry.number}/comments?per_page=100`);
        seen[entry.number] = { updated: entry.updated, comments: list.filter((comment) => comment.user.login !== login).slice(-5).map((comment) => ({ number: entry.number, title: entry.title, author: person(comment.user), body: comment.body.slice(0, 600), url: comment.html_url, at: comment.created_at })) };
      } catch { continue; }
    }
    comments.push(...seen[entry.number].comments);
  }
  github.comments = comments.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  const keep = new Set([...github.mine.prs, ...github.mine.issues, ...github.mine.threads].map((entry) => String(entry.number)));
  for (const key of Object.keys(seen)) if (!keep.has(key)) delete seen[key];

  if (!github.scanned || Date.now() - github.scanned > 20 * 60 * 1000) {
    const found = await gh.search("issue", "is:open tree/", 100);
    const previous = new Map((github.candidates || []).map((candidate) => [candidate.number, candidate]));
    github.candidates = found.items.filter((raw) => raw.user.login !== login).map((raw) => {
      const before = previous.get(raw.number);
      const branches = fixBranches(raw.body, upstreamOwner, project);
      return { ...item(raw), branches: branches.length ? branches : before?.branches || [], check: before?.check || null, scannedComments: before?.scannedComments && before.updatedAt === raw.updated_at, updatedAt: raw.updated_at };
    });
    github.scanned = Date.now();
  }
  let budget = 8;
  for (const candidate of github.candidates) {
    if (budget <= 0) break;
    if (!candidate.branches.length && !candidate.scannedComments) {
      budget--;
      try {
        const list = await gh.get(`repos/${config.repo}/issues/${candidate.number}/comments?per_page=100`);
        candidate.branches = fixBranches(list.filter((comment) => comment.user.login === candidate.author?.login).map((comment) => comment.body).join("\n"), upstreamOwner, project);
      } catch {}
      candidate.scannedComments = true;
    }
    const branch = candidate.branches[0];
    if (branch && (!candidate.check || Date.now() - Date.parse(candidate.check.at) > 6 * 3600 * 1000)) {
      budget -= 2;
      try {
        const compare = await gh.get(`repos/${config.repo}/compare/main...${branch.owner}:${project}:${encodeURIComponent(branch.branch)}`);
        const pulls = await gh.get(`repos/${config.repo}/pulls?state=all&head=${branch.owner}:${encodeURIComponent(branch.branch)}`);
        candidate.check = { at: new Date().toISOString(), ahead: compare.ahead_by, behind: compare.behind_by, files: (compare.files || []).map((file) => file.filename).slice(0, 60), pulls: pulls.map((pull) => ({ number: pull.number, state: pull.merged_at ? "merged" : pull.state })) };
      } catch (error) {
        candidate.check = { at: new Date().toISOString(), error: String(error.message || error) };
      }
    }
  }
  github.updated = new Date().toISOString();
  github.rate = { ...rate };
  cache.github = github;
}
