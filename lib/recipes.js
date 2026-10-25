const validUser = /^[a-z_][a-z0-9_-]{0,31}$/;
const validGroup = /^[a-z_][a-z0-9_-]{0,31}$/;

const toolkitRepo = {
  debian: [
    "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
    "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list",
    "apt-get update",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit",
  ],
  fedora: [
    "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo -o /etc/yum.repos.d/nvidia-container-toolkit.repo",
    "dnf install -y nvidia-container-toolkit",
  ],
  arch: ["pacman -Sy --needed --noconfirm nvidia-container-toolkit"],
  suse: [
    "zypper --non-interactive addrepo --refresh https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo || true",
    "zypper --non-interactive --gpg-auto-import-keys install -y nvidia-container-toolkit",
  ],
};
const configureDocker = ["nvidia-ctk runtime configure --runtime=docker", "systemctl restart docker"];
const configurePodman = ["mkdir -p /etc/cdi", "nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml"];
const packages = {
  debian: (names) => ["apt-get update", `DEBIAN_FRONTEND=noninteractive apt-get install -y ${names.join(" ")}`],
  fedora: (names) => [`dnf install -y ${names.join(" ")}`],
  arch: (names) => [`pacman -Sy --needed --noconfirm ${names.map((name) => name === "python3" ? "python" : name).join(" ")}`],
  suse: (names) => [`zypper --non-interactive install -y ${names.join(" ")}`],
};
const toolPackage = { python3: "python3", flock: "util-linux", curl: "curl" };

export function recipeFor(item, health) {
  const family = health.family;
  const user = validUser.test(health.user || "") ? health.user : null;
  if (item.status === "ok" || item.status === "info") return null;
  switch (item.id) {
    case "engine": {
      if (!user) return null;
      if (item.code === "nogroup") return { title: `Let ${user} use Docker`, risk: "low", root: true, commands: [`usermod -aG docker ${user}`], note: "Adds the user to the docker group, which is equivalent to root access on that machine." };
      if (item.code === "stopped") return { title: "Start Docker", risk: "low", root: true, commands: ["systemctl enable --now docker"] };
      if (family === "fedora") return { title: "Install Podman", risk: "low", root: true, commands: packages.fedora(["podman"]), note: "Podman runs containers without a daemon and without root." };
      if (!packages[family]) return null;
      const name = family === "debian" ? "docker.io" : "docker";
      return { title: "Install Docker", risk: "medium", root: true, commands: [...packages[family]([name]), "systemctl enable --now docker", `usermod -aG docker ${user}`], note: "Installs your distribution's Docker package, starts it and lets the user run containers." };
    }
    case "nvidia-toolkit": {
      const [action, engine] = String(item.code || "").split("-");
      const configure = engine === "podman" ? configurePodman : configureDocker;
      const restart = engine === "docker" ? " It restarts Docker, which stops any containers running on that machine." : "";
      if (action === "configure") return { title: "Connect the NVIDIA toolkit to the container engine", risk: engine === "docker" ? "medium" : "low", root: true, commands: configure, note: `Makes the GPUs available inside containers.${restart}` };
      if (!toolkitRepo[family]) return null;
      return { title: "Install the NVIDIA Container Toolkit", risk: engine === "docker" ? "medium" : "low", root: true, commands: [...toolkitRepo[family], ...configure], note: `From NVIDIA's own package repository (nvidia.github.io/libnvidia-container).${restart}` };
    }
    case "nvidia-vulkan": {
      const major = "$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)";
      const commands = {
        "cuda-repo": [`dnf install -y "nvidia-driver-libs-$(rpm -q --qf '%{EPOCH}:%{VERSION}-%{RELEASE}.%{ARCH}' nvidia-driver-cuda)"`],
        "cuda-repo-release": [
          ". /etc/os-release",
          "curl -fsSL \"https://developer.download.nvidia.com/compute/cuda/repos/rhel${VERSION_ID%%.*}/x86_64/cuda-rhel${VERSION_ID%%.*}.repo\" -o \"/etc/yum.repos.d/cuda-rhel${VERSION_ID%%.*}-x86_64.repo\"",
          `dnf install -y "nvidia-driver-libs-$(rpm -q --qf '%{EPOCH}:%{VERSION}' nvidia-driver-cuda)"`,
        ],
        rpmfusion: ["dnf install -y xorg-x11-drv-nvidia-libs"],
        apt: ["apt-get update", `DEBIAN_FRONTEND=noninteractive apt-get install -y "libnvidia-gl-${major}"`],
        "apt-server": ["apt-get update", `DEBIAN_FRONTEND=noninteractive apt-get install -y "libnvidia-gl-${major}-server"`],
        pacman: ["pacman -Sy --needed --noconfirm nvidia-utils"],
      }[item.code];
      if (!commands) return { title: "Install the NVIDIA Vulkan driver", risk: "medium", manual: true, steps: ["Install the graphics (GL and Vulkan) libraries that match your installed NVIDIA driver version, from the same place the driver came from.", "Press Check again, then Prepare."] };
      const release = item.code === "cuda-repo-release" ? " The NVIDIA CUDA repository set up here is for a different RHEL release, whose signing key this release rejects, so this first adds NVIDIA's repository for this release; the driver's other user-space packages may move to that release's build of the same version." : "";
      return { title: "Install the NVIDIA Vulkan driver", risk: "medium", root: true, commands, note: `Adds the graphics libraries for the driver version already installed; the kernel driver is not touched and no reboot is needed.${release} Press Prepare again afterwards.` };
    }
    case "gpu-access": {
      if (!user) return null;
      const group = validGroup.test(item.code || "") ? item.code : "render";
      const groups = [...new Set([group, "render", "video"])];
      return { title: `Let ${user} use the GPU`, risk: "low", root: true, commands: groups.map((name) => `getent group ${name} >/dev/null && usermod -aG ${name} ${user} || true`), note: "Adds the user to the groups that own /dev/dri. New sign-ins get it straight away." };
    }
    case "tool-python3":
    case "tool-flock":
    case "tool-curl": {
      if (!packages[family]) return null;
      const tool = item.id.slice(5);
      return { title: `Install ${tool}`, risk: "low", root: true, commands: packages[family]([toolPackage[tool]]) };
    }
    case "nvidia-driver": {
      const steps = item.code === "ubuntu"
        ? ["Run `sudo ubuntu-drivers install` (or pick a driver in Software & Updates → Additional Drivers).", "Reboot.", "Press Check again."]
        : ["Install the NVIDIA driver the way your distribution recommends (Fedora: RPM Fusion's akmod-nvidia; RHEL: NVIDIA's CUDA repository; Arch: the nvidia package).", "If Secure Boot is on, enrol the module signing key when asked.", "Reboot, then press Check again."];
      return { title: "Install the NVIDIA driver", risk: "high", manual: true, steps, note: "Kernel drivers can need a reboot and can stop a machine from booting its desktop if they go wrong, so the orchestrator leaves this to you." };
    }
    case "disk": return { title: "Free up disk space", risk: "low", manual: true, steps: ["Delete old jobs in the dashboard (their folders go with them).", "Or move the work folder to a bigger disk."] };
    case "network": return { title: "Allow access to GitHub", risk: "low", manual: true, steps: ["Builds clone the project and its submodules from github.com; check the machine's firewall or proxy."] };
    case "sudo": return item.status === "fail" ? { title: "Install sudo", risk: "low", manual: true, steps: ["Sign in as root, install sudo, and add this user to the sudo (or wheel) group."] } : null;
    default: return null;
  }
}

export function shellQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

export function rootCommand(script, health) {
  const body = `set -e\n${script}`;
  if (health.user === "root") return { command: `bash -c ${shellQuote(body)}`, needsPassword: false };
  const passwordless = health.items?.find((item) => item.id === "sudo")?.status === "ok";
  return { command: passwordless ? `sudo -n bash -c ${shellQuote(body)}` : `sudo -S -p '' bash -c ${shellQuote(body)}`, needsPassword: !passwordless };
}
