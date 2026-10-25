#!/bin/bash
export LC_ALL=C
WORK=${WORK:-$HOME/.anyps5-orchestrator}
ENGINE=${ENGINE:-}
out() { printf '@@check %s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "${5:-}"; }
have() { command -v "$1" >/dev/null 2>&1; }

. /etc/os-release 2>/dev/null
FAMILY=other
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*) FAMILY=debian ;;
  *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*) FAMILY=fedora ;;
  *" arch "*) FAMILY=arch ;;
  *" suse "*|*" opensuse "*) FAMILY=suse ;;
esac
echo "@@family $FAMILY"
echo "@@user $(id -un)"
out os info "Operating system" "${PRETTY_NAME:-$(uname -s)} (kernel $(uname -r), $(uname -m))"
[ "$(uname -m)" = x86_64 ] || out arch fail "x86-64 CPU" "AnyPS5 builds need an x86-64 machine; this is $(uname -m)"

if [ "$(id -u)" = 0 ]; then out sudo ok "Administrator access" "signed in as root"
elif ! have sudo; then out sudo fail "Administrator access" "sudo is not installed, so fixes that need root can't run"
elif sudo -n true 2>/dev/null; then out sudo ok "Administrator access" "sudo works without a password"
else out sudo warn "Administrator access" "sudo asks for a password; you'll type it when you approve a fix" password; fi

NVIDIA_PCI=0; DRI_GPU=0
for d in /sys/class/drm/card[0-9]*/device; do
  [ -e "$d/vendor" ] || continue
  case "$(cat "$d/vendor")" in 0x10de) NVIDIA_PCI=1 ;; 0x1002|0x8086) DRI_GPU=1 ;; esac
done
if have lspci && lspci -nn 2>/dev/null | grep -Eqi '(vga|3d|display).*\[10de:'; then NVIDIA_PCI=1; fi

DOCKER=none; PODMAN=none
if have docker; then
  if docker info >/dev/null 2>&1; then DOCKER=ok
  elif [ -S /var/run/docker.sock ] && ! [ -w /var/run/docker.sock ]; then DOCKER=nogroup
  elif have systemctl && ! systemctl is-active --quiet docker 2>/dev/null; then DOCKER=stopped
  else DOCKER=broken; fi
fi
if have podman; then podman info >/dev/null 2>&1 && PODMAN=ok || PODMAN=broken; fi
[ -z "$ENGINE" ] && { [ "$DOCKER" = ok ] && ENGINE=docker || { [ "$PODMAN" = ok ] && ENGINE=podman; }; }
case "$DOCKER/$PODMAN" in
  ok/*|*/ok) out engine ok "Container engine" "$( [ "$DOCKER" = ok ] && echo -n "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) " )$( [ "$PODMAN" = ok ] && echo -n "Podman $(podman version --format '{{.Client.Version}}' 2>/dev/null)" )" ;;
  nogroup/*) out engine fail "Container engine" "Docker is installed but $(id -un) may not use it (not in the docker group)" nogroup ;;
  stopped/*) out engine fail "Container engine" "Docker is installed but the service isn't running" stopped ;;
  *) out engine fail "Container engine" "neither Docker nor Podman is installed and working" missing ;;
esac

if [ "$NVIDIA_PCI" = 1 ]; then
  if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then out nvidia-driver ok "NVIDIA driver" "$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1), $(nvidia-smi -L | wc -l) GPU(s)"
  else out nvidia-driver fail "NVIDIA driver" "an NVIDIA GPU is present but the NVIDIA driver isn't working (nvidia-smi fails)" "${ID:-}"; fi
  if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
    if { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libGLX_nvidia\.so\.0'; then out nvidia-vulkan ok "NVIDIA Vulkan driver" "the driver's graphics libraries are installed, so containers get Vulkan on the GPU"
    else
      SOURCE=manual
      if have rpm && rpm -q nvidia-driver-cuda >/dev/null 2>&1; then SOURCE=cuda-repo
      elif have rpm && rpm -q xorg-x11-drv-nvidia >/dev/null 2>&1; then SOURCE=rpmfusion
      elif have dpkg-query && dpkg-query -W -f='${Package} ${Status}\n' 'nvidia-*' 2>/dev/null | grep 'install ok installed' | grep -q -- '-server '; then SOURCE=apt-server
      elif have dpkg-query && dpkg-query -W -f='${Package} ${Status}\n' 'nvidia-*' 2>/dev/null | grep -q 'install ok installed'; then SOURCE=apt
      elif [ "$FAMILY" = arch ]; then SOURCE=pacman; fi
      out nvidia-vulkan fail "NVIDIA Vulkan driver" "only the driver's compute libraries are installed, so Vulkan can't use the NVIDIA GPU and tests would fall back to the CPU" "$SOURCE"
    fi
  fi
  if [ "$ENGINE" = docker ]; then
    if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia || docker info 2>/dev/null | grep -qi 'cdi.*nvidia.com/gpu'; then out nvidia-toolkit ok "NVIDIA container support" "Docker has the NVIDIA runtime"
    elif have nvidia-ctk; then out nvidia-toolkit fail "NVIDIA container support" "the NVIDIA Container Toolkit is installed but Docker isn't configured to use it" configure-docker
    else out nvidia-toolkit fail "NVIDIA container support" "the NVIDIA Container Toolkit isn't installed, so containers can't use the GPU" install-docker; fi
  elif [ "$ENGINE" = podman ]; then
    if [ -s /etc/cdi/nvidia.yaml ] || [ -s /var/run/cdi/nvidia.yaml ] || ls /etc/cdi/*nvidia* >/dev/null 2>&1; then out nvidia-toolkit ok "NVIDIA container support" "CDI specification found"
    elif have nvidia-ctk; then out nvidia-toolkit fail "NVIDIA container support" "the toolkit is installed but no CDI specification was generated" configure-podman
    else out nvidia-toolkit fail "NVIDIA container support" "the NVIDIA Container Toolkit isn't installed, so containers can't use the GPU" install-podman; fi
  fi
fi

if [ "$DRI_GPU" = 1 ]; then
  node=$(ls /dev/dri/renderD* 2>/dev/null | head -1)
  if [ -z "$node" ]; then out gpu-access fail "GPU device access" "an AMD or Intel GPU is present but there is no /dev/dri render node (is the kernel driver loaded?)"
  elif [ -r "$node" ] && [ -w "$node" ]; then out gpu-access ok "GPU device access" "$(id -un) can use $node"
  else out gpu-access fail "GPU device access" "$(id -un) may not use $node (needs the $(stat -c %G "$node") group)" "$(stat -c %G "$node")"; fi
fi
[ "$NVIDIA_PCI" = 0 ] && [ "$DRI_GPU" = 0 ] && out gpu warn "GPU" "no GPU found: Vulkan tests need one"

for tool in python3 flock curl; do
  if have "$tool"; then out "tool-$tool" ok "$tool" "$(command -v $tool)"; else out "tool-$tool" fail "$tool" "$tool is not installed" missing; fi
done

mkdir -p "$WORK" 2>/dev/null
FREE=$(( $(df -Pk "$WORK" 2>/dev/null | awk 'NR==2 {print $4}') / 1024 / 1024 ))
if [ "$FREE" -ge 80 ]; then out disk ok "Disk space" "$FREE GB free in $WORK"
elif [ "$FREE" -ge 40 ]; then out disk warn "Disk space" "$FREE GB free in $WORK; a build plus a job's sandbox can use 40 GB or more"
else out disk fail "Disk space" "only $FREE GB free in $WORK; builds need about 40 GB"; fi
probe="$WORK/.reflink-probe"; echo x > "$probe.a" 2>/dev/null
if cp --reflink=always "$probe.a" "$probe.b" 2>/dev/null; then out reflink ok "Fast copies (reflink)" "job sandboxes are copied instantly"
else out reflink info "Fast copies (reflink)" "this filesystem copies job sandboxes in full, which takes longer and needs more space"; fi
rm -f "$probe.a" "$probe.b"

if have curl && curl -fsS -o /dev/null --max-time 10 https://github.com; then out network ok "Internet access" "github.com is reachable"
elif have curl; then out network fail "Internet access" "github.com is not reachable; builds fetch the project and its submodules from it"; fi
echo "@@done"
