# AnyPS5 Orchestrator (beta)

A self-hosted dashboard for [AnyPS5](https://github.com/boykopovar/AnyPS5) contributors. It brings your GitHub work, the machines you test on and your AI into one place, and it can build and test other people's fix branches on your GPUs in sandboxes.

It has no AI of its own. You connect the one you already use (Claude Code, Codex, Cursor or any other MCP client), and that AI gets everything below as context.

- **Your work:** your PRs and issues, the threads you've commented in, new comments from others, and your open-PR limit (AnyPS5's CONTRIBUTING.md allows 1 open PR until one is merged, then 20).
- **Your machines:** live CPU, memory and GPU use for each machine you add, what it's doing, and a health check that finds and fixes what's missing for building AnyPS5.
- **Your AI:** what it's working on, its recent history and the plans it adds. Anything it wants to do on your machines comes to the dashboard as a request you approve.
- **Verification:** issues that link a fix branch get a **Verify** button. The branch is merged onto `main`, built, and tested against unchanged `main` on every GPU you enabled, following AnyPS5's rules for GPU changes:
  - It runs the tests `tools/select_tests.py` selects, plus any the branch adds.
  - It runs them with `ANYPS5_REQUIRE_VULKAN=1`, `ANYPS5_NO_SHADER_CACHE=1` and the Khronos validation layer, and reports new `VUID-` errors.
  - A test that fails only on the branch is rerun three times, one at a time, on both sides.

  You get a draft report to copy into the issue.

## Safety

- **Nothing runs by itself.**
  - You approve every build after seeing the files it changes. Build scripts, CMake and Python files are highlighted, because they run during the build.
  - Your AI's actions wait for your approval in the dashboard, and it can't approve its own requests. Actions are queuing a verification, cancelling, preparing a machine, changing GPUs, fixing a machine and running a command.
  - You can set "always allow" for an action per AI, except for running commands and anything that runs as root.
- **Branch code is sandboxed.**
  - It runs only in containers with `--network none`, in its own copies of the source and build trees, and as your user, never root.
  - `main` is built and tested outside the sandbox, because it is the project's own code.
- **It never posts to GitHub.** Reports are drafts, and a read-only token is enough.
- **The dashboard is private.**
  - A one-time setup code (printed in the server log) is needed to claim a new instance, after which it's protected by your password. Repeated wrong passwords are slowed down.
  - Secrets (your GitHub token, saved SSH passwords) are encrypted in the data folder, which only you can read.
  - The page updates live over a WebSocket at `/api/live`, which only accepts a signed-in session from the dashboard's own address. A reverse proxy in front of it must pass WebSocket upgrades through; if it doesn't, the page falls back to checking every 15 seconds.
  - Started with Node, it listens on `127.0.0.1` only. The Docker image listens on all interfaces, so keep it on a trusted network, or put it behind HTTPS if it must be reachable from elsewhere.
- **Root is explicit.** Machine fixes run as root through `sudo` and always show the exact commands first. A `sudo` password you type is used once and not saved. GPU kernel drivers are never installed automatically.

## Requirements

**On the machine that runs the dashboard:** Node.js 22 or newer, `ssh`, and `sshpass` (needed only for password sign-in). The Docker image includes all three.

**On every machine that builds:**
- Linux on x86-64.
- Docker or rootless Podman.
- `python3`, `flock` and `curl`.
- About 40 GB free, more without reflink copies.
- For NVIDIA GPUs: the driver and the NVIDIA Container Toolkit.
- For AMD and Intel GPUs: access to `/dev/dri`.

The health check finds what's missing and fixes most of it for you. The exception is GPU kernel drivers, which you install yourself.

## Install

No `npm install` is needed: the server has no runtime dependencies.

```sh
git clone https://github.com/TechLevelZero/anyps5-orchestrator.git
cd anyps5-orchestrator
node server.js            # http://127.0.0.1:8091
```

Or with Docker (the dashboard is then on port 8091 of this host):

```sh
git clone https://github.com/TechLevelZero/anyps5-orchestrator.git
cd anyps5-orchestrator
cp .env.example .env
mkdir -p data             # create it first, so it belongs to you and not to root
docker compose up -d
docker logs anyps5-orchestrator    # shows the setup code
```

The container runs as uid and gid 1000. If your user has other IDs, set `UID_GID` in `.env`, for example to the output of `echo $(id -u):$(id -g)`. Keep `DATA` on a local disk, not a network share, because SSH refuses keys with loose file permissions.

To keep the Node version running, use a systemd user service, for example `~/.config/systemd/user/anyps5-orchestrator.service`:

```ini
[Unit]
Description=AnyPS5 Orchestrator

[Service]
ExecStart=/usr/bin/node %h/anyps5-orchestrator/server.js
Restart=always

[Install]
WantedBy=default.target
```

Then run `systemctl --user enable --now anyps5-orchestrator`, and `loginctl enable-linger` to keep it running while you're logged out.

## Setup wizard

1. **Setup code and password.** The setup code proves the instance is yours. It's printed when the server starts, and kept as `setup-code` in the data folder until you set a password.
2. **GitHub.** Paste a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only access to public repositories; no extra permissions are needed. You can point it at a fork of AnyPS5 instead of `boykopovar/AnyPS5`.
3. **Setup type.**
   - **Simple:** builds run on the computer the dashboard runs on. This isn't available when the dashboard runs in a container.
   - **Advanced:** add machines over SSH. You choose how the orchestrator signs in:
     - **Password, then a key** (recommended): your password is used once to install the orchestrator's own key, then forgotten.
     - **Password every time:** the password is stored encrypted.
     - **Key only:** you add its public key to `~/.ssh/authorized_keys` yourself.

     The host key is pinned on first connection.
4. **Machines.**
   - **Health check:** each machine is checked for the container engine and your access to it, the NVIDIA driver, its Vulkan libraries and container support, GPU device access, `python3`, `flock` and `curl`, disk space, reflink copies, GitHub access and `sudo`.
   - **Fixes:** failing items get a **Fix** button with the exact commands for your Linux family (Debian/Ubuntu, Fedora/RHEL, Arch, openSUSE). The exception is GPU kernel drivers, which get the steps to do by hand.
   - **Prepare:** once a machine passes, press **Prepare**. It builds the build image there (5–15 minutes the first time) and finds each GPU's Vulkan name. Untick a GPU to leave it out of tests.
5. **Connect your AI.** Create a connection, then either:
   - paste the ready-made message to your AI and let it add the server itself, or
   - copy the setup line for your client. For Claude Code:

     ```sh
     claude mcp add --transport http anyps5 http://<orchestrator>:8091/mcp --header "Authorization: Bearer <token>"
     ```

   The token is shown once. Revoke a connection in Settings if it leaks. Ask your AI to "get my machines ready" or "what needs my attention?".

Environment variables (for Docker, set them in `.env`):

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `8091` | Port to listen on |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Interface to listen on |
| `DATA_DIR` | `~/.anyps5-orchestrator/server` (`/data` in Docker) | Settings, encrypted secrets, the SSH key, jobs and plans |
| `DATA`, `NAME`, `UID_GID` | `./data`, `anyps5-orchestrator`, `1000:1000` | Docker only: data folder on the host, container name, user to run as |

## Tools your AI gets (MCP)

| Tool | What it does |
| --- | --- |
| `get_overview` | Your open PRs and issues, the open-PR limit, new comments, machines and GPUs, jobs and plans |
| `get_machine`, `check_machine` | A machine's details, and its health check with the fix for each failing item |
| `list_jobs`, `get_job`, `get_job_log` | Verification results per GPU, and log tails |
| `list_fix_branches`, `get_issue` | Issues that link a fix branch and the files it changes; any issue or PR with its comments |
| `list_plans`, `add_plan`, `update_plan` | The plan board (now, next, later) |
| `report_status`, `note` | Show what the AI is doing; add to the activity feed |
| `queue_verification`, `cancel_job`, `prepare_machine`, `set_gpu_enabled`, `fix_machine`, `run_command` | Actions. Each becomes a request you approve in the dashboard. `fix_machine`, and `run_command` with `sudo`, run as root, are never "always allowed", and take the `sudo` password in the approval card. |
| `list_requests`, `get_request` | The state and result of those requests |

The endpoint is `/mcp`: MCP streamable HTTP with JSON responses, authenticated with `Authorization: Bearer <token>`. Requests that carry a browser `Origin` from another site are refused. Read-only tools are annotated as such, for clients that skip asking before reading. There are two more ways in:
- `mcp/server.js` is a stdio bridge for clients that only support local servers.
- A small REST API (`/api/agent/status`, `/api/agent/overview`, `/api/agent/verify`) serves scripts and hooks.

## On each build machine

Everything lives in `~/.anyps5-orchestrator`:

| Path | Contents |
| --- | --- |
| `runner/` | Scripts copied there by the orchestrator |
| `src/` | A clone of the project |
| `main/` and `build-main/` | `main` and its cached build, rebuilt when `main` moves |
| `cache/` | ccache and build logs |
| `jobs/<id>/` | Each job's logs |

A job's sandbox copies are deleted when it ends, and deleting a job in the dashboard removes its folder.

## Troubleshooting

- **Lost the setup code:** it's in the data folder as `setup-code` (`data/setup-code` with Docker).
- **"Host key verification failed":** the machine's SSH host key changed since it was added. If that's expected (a reinstall), remove the machine's line from `ssh/known_hosts` in the data folder and add the machine again.
- **An NVIDIA GPU isn't used in containers:** run **Check again**. *NVIDIA container support* should pass; its fix installs NVIDIA's toolkit and configures Docker, or generates CDI for Podman.
- **An NVIDIA GPU is left out after Prepare:** Vulkan can't see it inside containers, usually because only the driver's compute libraries are installed. *NVIDIA Vulkan driver* in the health check installs the graphics libraries for your driver version; run **Prepare** again afterwards.
- **AMD or Intel GPU missing after Prepare:** the health check's *GPU device access* item adds you to the `render` and `video` groups. Run **Prepare** again afterwards.
- **A job fails right away:** the reason is shown on the job. `get_job_log` (or the machine's `jobs/<id>/run.log`) has the details.

## Updating

Stop it, update the files (`git pull`, plus `docker compose up -d --build` for Docker), and start it again. Settings, jobs and plans stay in the data folder. A server that can't read its `state.json` keeps a copy and refuses to start, rather than starting empty.

## Development

`npm test` runs the unit and server tests, using Node's built-in test runner. The page's stylesheet is Tailwind: after changing classes, run `npm install` and `npm run build`. `public/app.css` is committed, so the server runs without a build step.

## Status

This is a beta. Build machines must be Linux with a GPU, and Windows and macOS build machines aren't supported yet. Posting reports to GitHub is deliberately left out.

`runner/seccomp-uffd.json` is Docker's default seccomp profile (Apache-2.0, moby) with `userfaultfd` allowed, which AnyPS5 needs for guest memory.

MIT licence, see [LICENSE](LICENSE).
