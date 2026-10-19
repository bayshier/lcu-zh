ARG BASE_IMAGE
ARG BROWSER_KIND=chromium
FROM ${BASE_IMAGE} AS prepared
ARG BROWSER_KIND
RUN useradd --create-home --shell /bin/bash browser-test
COPY --chown=browser-test:browser-test release.tar.gz /home/browser-test/release.tar.gz
COPY --chown=browser-test:browser-test chatgpt.deb /home/browser-test/chatgpt.deb
COPY --chown=browser-test:browser-test browser_extension.py /home/browser-test/browser_extension.py
USER browser-test
ENV HOME=/home/browser-test \
    XDG_DATA_HOME=/home/browser-test/.local/share \
    LCU_BROWSER_PREFIX=/home/browser-test/lcu \
    LCU_BROWSER_RELEASE=/home/browser-test/lcu/current \
    LCU_BROWSER_EXTENSION=/home/browser-test/extension
RUN mkdir /home/browser-test/thin-release \
    && mkdir -p /home/browser-test/.cache/ms-playwright \
    && tar -xzf /home/browser-test/release.tar.gz --strip-components=1 -C /home/browser-test/thin-release \
    && dpkg-deb --extract /home/browser-test/chatgpt.deb /home/browser-test/chatgpt-root \
    && python3 /home/browser-test/thin-release/scripts/install.py \
         --prefix "$LCU_BROWSER_PREFIX" --runtime-only --skip-system \
         --existing-app /home/browser-test/chatgpt-root/usr/lib/chatgpt --offline \
    && if [ "$BROWSER_KIND" = chromium ]; then \
         "$LCU_BROWSER_RELEASE/app/resources/cua_node/bin/node" \
           "$LCU_BROWSER_RELEASE/app/resources/cua_node/lib/node_modules/playwright/cli.js" install chromium; \
       elif [ "$BROWSER_KIND" != chrome ]; then echo "Unsupported browser kind: $BROWSER_KIND" >&2; exit 2; \
       fi \
    && python3 /home/browser-test/browser_extension.py \
         /home/browser-test/extension.crx "$LCU_BROWSER_EXTENSION"

FROM ${BASE_IMAGE}
ARG BROWSER_KIND
USER root
RUN if [ "$BROWSER_KIND" = chrome ]; then \
      case "$(dpkg --print-architecture)" in \
        arm64) chrome_deb_url=https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb ;; \
        amd64) chrome_deb_url=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb ;; \
        *) echo "Unsupported Chrome package architecture: $(dpkg --print-architecture)" >&2; exit 2 ;; \
      esac; \
      curl --fail --location --silent --show-error "$chrome_deb_url" -o /tmp/google-chrome.deb; \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/google-chrome.deb; \
      rm -f /tmp/google-chrome.deb; \
      rm -rf /var/lib/apt/lists/*; \
    elif [ "$BROWSER_KIND" != chromium ]; then \
      echo "Unsupported browser kind: $BROWSER_KIND" >&2; exit 2; \
    fi
RUN useradd --create-home --shell /bin/bash browser-test
COPY --from=prepared --chown=browser-test:browser-test /home/browser-test/lcu /home/browser-test/lcu
COPY --from=prepared --chown=browser-test:browser-test /home/browser-test/.cache/ms-playwright /home/browser-test/.cache/ms-playwright
COPY --from=prepared --chown=browser-test:browser-test /home/browser-test/extension /home/browser-test/extension
COPY --from=prepared /home/browser-test/extension.crx /tmp/official-chatgpt.crx
RUN if [ "$BROWSER_KIND" = chrome ]; then \
      mkdir -p /opt/google/chrome/extensions; \
      mv /tmp/official-chatgpt.crx /opt/google/chrome/extensions/official-chatgpt.crx; \
      printf '{"external_crx":"/opt/google/chrome/extensions/official-chatgpt.crx","external_version":"1.26.901.11451"}\n' \
        > /opt/google/chrome/extensions/hehggadaopoacecdllhhajmbjkdcmajg.json; \
    else rm -f /tmp/official-chatgpt.crx; \
    fi
ENV HOME=/home/browser-test \
    XDG_DATA_HOME=/home/browser-test/.local/share \
    LCU_BROWSER_PREFIX=/home/browser-test/lcu \
    LCU_BROWSER_RELEASE=/home/browser-test/lcu/current \
    LCU_BROWSER_EXTENSION=/home/browser-test/extension \
    LCU_BROWSER_KIND=${BROWSER_KIND}
USER browser-test
