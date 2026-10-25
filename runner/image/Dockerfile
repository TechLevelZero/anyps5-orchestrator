FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc g++ binutils cmake ninja-build git python3 ccache curl ca-certificates pkg-config file \
    libx11-dev libxext-dev libxrandr-dev libxcursor-dev libxi-dev libxss-dev libxinerama-dev libxfixes-dev \
    libwayland-dev libxkbcommon-dev libegl-dev libdecor-0-dev \
    libpipewire-0.3-dev libpulse-dev libasound2-dev libudev-dev libdbus-1-dev \
    libvulkan1 vulkan-tools vulkan-validationlayers mesa-vulkan-drivers libglvnd0 libgl1 libegl1 libgles2 libglx0 \
    && rm -rf /var/lib/apt/lists/*
ENV NVIDIA_DRIVER_CAPABILITIES=all
LABEL org.opencontainers.image.title="anyps5-orchestrator build environment"
