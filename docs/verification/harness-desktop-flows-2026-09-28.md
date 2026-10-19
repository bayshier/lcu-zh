# Reproducing OMP and Hermes desktop flows

These opt-in tests run the real harness CLI and a model against generated GTK windows in a disposable Linux container. The harness runs with a temporary host profile. The desktop has no network, host credentials, personal home directory, or personal display. A host-loopback model proxy reads an existing provider credential in place; only the proxy receives the real key. Model requests are bounded, and the proxy logs request counts, tool names, and HTTP status without prompts or credentials.

The original runtime controls `LCU Target`, enters a randomized marker, clicks `Save draft`, and reads the saved status. Each runner independently reads `Target.txt` from the container and requires an exact match. `Other.txt` must remain absent. Discovery or a model's success claim cannot satisfy these checks.

## Prepare verified local inputs

Build the test image and thin archive with `tests/run.sh linux/arm64 /absolute/path/to/verified-chatgpt.deb`. The supplied official package is a development fixture, verified against `runtime.lock.json` before extraction. LCU setup still selects a preinstalled app with acquisition disabled; it never downloads or installs the desktop app for a user. Keep the package and generated evidence outside Git.

Install the desired official harness releases in an isolated directory. Record their release tags and source or asset hashes; do not replace the user's installation. The dated [OMP](omp-compatibility-2026-09-28.md) and [Hermes](hermes-harness-2026-09-28.md) notes contain the exact versions tested.

Start one fixture per harness, using fresh container names and output directories. The image must already exist. `DOCKER_HOST` can select the disposable Docker daemon when needed.

```sh
bash tests/harness_fixture.sh \
  /absolute/path/to/lcu-0.4.1-linux-arm64.tar.gz \
  /absolute/path/to/verified-chatgpt.deb \
  lcu-omp-flow /tmp/lcu-omp-evidence

bash tests/harness_fixture.sh \
  /absolute/path/to/lcu-0.4.1-linux-arm64.tar.gz \
  /absolute/path/to/verified-chatgpt.deb \
  lcu-hermes-flow /tmp/lcu-hermes-evidence
```

The helper verifies input checksums, provisions LCU offline from the extracted app, exports the LCU configuration, starts only generated windows, and runs `lcu doctor`. It was exercised on Linux ARM64 on 2026-09-28 with ChatGPT `26.915.31945` and CUA `0.0.16/20260915001755-492f19756c31`; window listing and screenshot capture passed.

## Model connection and harness runs

For the verified Z.ai provider route, run this host-only proxy in a separate terminal. `--pi-auth` points at the existing Pi credential file; the file is never copied to a fixture or harness profile. The proxy reads only its `zai.key` entry. The ready file contains the loopback URL and model name, with no credential.

```sh
python3 tests/harness_model_proxy.py \
  --pi-auth "$HOME/.pi/agent/auth.json" \
  --model glm-5.3-flash --max-requests 32 \
  --ready /tmp/lcu-proxy-ready.json --log /tmp/lcu-proxy-requests.jsonl
```

Use that ready file's `base_url` below. Keep raw transcripts outside the repository: they can contain original runtime instructions and generated image bytes.

```sh
python3 tests/omp_real_gtk.py \
  --omp /absolute/path/to/omp \
  --container lcu-omp-flow --container-user lcutester \
  --model openai/glm-5.3-flash \
  --proxy-base-url http://127.0.0.1:PORT/v1 \
  --docker-host unix:///absolute/path/to/docker.sock \
  --evidence-file /tmp/lcu-omp-evidence/flow.json

HERMES_BIN=/absolute/path/to/hermes \
HERMES_TEST_NODE=/absolute/path/to/node \
LCU_TEST_RELEASE="$PWD" \
LCU_TEST_CONTAINER=lcu-hermes-flow \
LCU_TEST_MODEL=glm-5.3-flash \
LCU_TEST_BASE_URL=http://127.0.0.1:PORT/v1 \
LCU_TEST_API_KEY=local-fixture-proxy \
LCU_TEST_DOCKER_PREFIX='["--host","unix:///absolute/path/to/docker.sock"]' \
LCU_TEST_EVIDENCE=/tmp/lcu-hermes-evidence/flow.json \
python3 tests/hermes_real_desktop.py
```

Hermes' `LCU_TEST_RELEASE` can also point at an unpacked release containing the installed adapter dependencies. A source checkout needs `npm ci --prefix adapters` first. The model sees only the harness's LCU tools. The runners leave approval settings unchanged; these GTK actions do not exercise native permission prompts.

Stop the proxy and remove only the fixtures created for the run:

```sh
docker rm -f lcu-omp-flow lcu-hermes-flow
```

This flow proves Linux GTK interaction through the tested harness versions. It does not extend browser, audio, macOS, Windows, native approval, or cancellation evidence.

## Final task verification

The clean commit snapshot, including the Hermes identity fix and excluding unrelated working-tree edits, passed `tests/run.sh linux/arm64` with the local verified package: 199 Python tests, offline installation, registration, and the complete Linux GTK desktop suite. The snapshot's adapter suite passed 27 tests with 8 opt-in environment skips. Its archive is `/private/tmp/lcu-harness-latest-20260928/committed-source/.verification/arm64.8l6xS9/lcu-0.4.1-linux-arm64.tar.gz`. The working-tree adapter suite also passed (35 tests, 8 skips).

OMP 18.4.1 saved `omp-lcu-031538f03c23`. Hermes v2026.9.24 (0.21.5) saved `hermes-lcu-7515fa9cf4c4` with direct tool exposure, then saved `hermes-lcu-ed6be2c61580` from the clean snapshot through its default discovery tools. Every Target oracle matched exactly and every Other oracle stayed absent. Set `LCU_TEST_TOOL_SEARCH=on` to reproduce Hermes' default discovery route; the runner defaults to direct tool exposure for a smaller transcript.

The full working-tree Python gate separately exposed an unrelated, uncommitted macOS acceptance-fixture race: `test_wait_drains_pty_while_waiting_for_agent_end_observer` checked its captured buffer before draining the PTY's remaining bytes. That fixture and the other preexisting edits were left unchanged. The clean snapshot excludes that unrelated work; its passing gate is not a claim that the entire working tree passed.
