FROM node:24.11.1-bookworm-slim AS pi-verification
RUN npm install --global @mariozechner/pi-coding-agent@0.73.0 --ignore-scripts --no-audit --no-fund

FROM ubuntu:24.04
# Match scripts/install.mjs's Ubuntu 24.04 runtime dependencies, then add fixtures.
# LCU itself needs no Python: python3 (and its GTK/Qt bindings) is here only because the
# test drivers and fixtures under tests/ are Python.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    at-spi2-core bubblewrap ca-certificates dbus-x11 ffmpeg \
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
    libc6 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libexpat1 \
    libgbm1 libgcc-s1 libgdk-pixbuf-2.0-0 libgl1 libglib2.0-bin \
    libglib2.0-0t64 libgtk-3-0t64 libnotify4 libnspr4 libnss3 \
    libpango-1.0-0 libssl3t64 libstdc++6 libtss2-esys-3.0.2-0t64 \
    libtss2-mu-4.0.1-0t64 libtss2-tcti-device0t64 libudev1 libusb-1.0-0 \
    libx11-6 libx11-xcb1 libxcb-dri3-0 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 \
    libxtst6 mesa-vulkan-drivers pulseaudio pulseaudio-utils python3 \
    x11-utils xdg-utils xz-utils \
    python3-gi gir1.2-gtk-3.0 gir1.2-gtk-4.0 python3-pyqt5 xvfb openbox xdotool \
    xfce4-session xfwm4 xfdesktop4 xfce4-panel curl binutils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=pi-verification /usr/local/bin/node /usr/local/bin/node
COPY --from=pi-verification /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js "$@"\n' > /usr/local/bin/pi && \
    chmod +x /usr/local/bin/pi
