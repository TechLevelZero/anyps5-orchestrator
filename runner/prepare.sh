#!/bin/bash
set -uo pipefail
: "${ENGINE:?}" "${WORK:?}"
IMAGE=${IMAGE:-anyps5-orch-build:1}
mkdir -p "$WORK/cache"
LOG=$WORK/cache/prepare.log
: > "$LOG"
if ! $ENGINE image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building image" >> "$LOG"
  $ENGINE build -t "$IMAGE" "$WORK/runner/image" >> "$WORK/cache/image-build.log" 2>&1 || { echo "@@error image build failed, see $WORK/cache/image-build.log"; exit 1; }
fi
if [ "$ENGINE" = docker ]; then ID=(-u "$(id -u):$(id -g)"); DRI="--device /dev/dri"; for g in $(stat -c %g /dev/dri/* 2>/dev/null | sort -u); do DRI="$DRI --group-add $g"; done
else ID=(--security-opt label=disable --userns=keep-id); DRI="--device /dev/dri --group-add keep-groups"; fi
echo "@@dri"
[ -e /dev/dri ] && $ENGINE run --rm "${ID[@]}" $DRI "$IMAGE" vulkaninfo --summary 2>/dev/null | grep -E "deviceName|driverInfo|deviceType|deviceID|vendorID"
echo "@@nvidia"
if command -v nvidia-smi >/dev/null 2>&1; then
  if [ "$ENGINE" = docker ]; then NV="--gpus all"; else NV="--device nvidia.com/gpu=all"; fi
  $ENGINE run --rm "${ID[@]}" $NV "$IMAGE" vulkaninfo --summary 2>/dev/null | grep -E "deviceName|driverInfo|deviceType|deviceID|vendorID"
fi
echo "@@done"
