# Pinned runtime inputs restored, 2026-09-26

The existing pins in `runtime.lock.json` were restored for verification. No pin changed, no official application file was added to Git, and no downloader was added.

## macOS ARM64

The exact-version package came from the versioned [official OpenAI CDN URL](https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.917.62051.zip). The response was HTTP 200, `application/zip`, 599,953,541 bytes. Its SHA-256 was `ca4a4443f41e9fc5762eeda60254ff57cc8b9ef7b990c31ae58bddfbb9d0b6b3`.

The extracted app reports ChatGPT `26.917.62051` and bundle ID `com.openai.codex`. All seven files listed under `platforms.darwin.architectures.arm64.components` in `runtime.lock.json` matched their pinned SHA-256 values. Outside the sandbox, `codesign --verify --deep --strict` reported a valid bundle and satisfied designated requirement. Its signature chains to Developer ID Application: OpenAI OpCo, LLC, Team ID `2DC432GLL2`; the notarization ticket is stapled. The bundled Codex CLI reports `0.155.0-alpha.16.3`.

The downloaded ZIP was removed after successful extraction and verification; a single extracted app remains in task-local staging. The installed `/Applications/ChatGPT.app` was left untouched.

## Linux ARM64 and x86-64

The two official DEBs were fetched from the exact URLs in `runtime.lock.json`. The ARM64 package matched `b94c494b5f0fd7c720fa6fccd5ef609879affc62332ca930ed29b907d537bc6d`; the x86-64 package matched `d27a9c02919cfe484dcc5f34584b9ea9fd0d7a65c69dcc872b5bdcfa0efb5983`. One task-local package copy remains for each architecture.

The existing disposable verification images were present and matched the expected IDs: `lcu-verification:arm64` (`sha256:8b34c164568c155cfb9d01ff308ee4bc2e7d4c855ce00951c2f506349f3c34c1`) and `lcu-verification:amd64` (`sha256:191d68bdb9f99d33a3bc6d08772a78bb06f6339f5cf2a974692f3fb152c399a6`).
