# Current three-platform delivery, 2026-09-25

The Linux runtime gates and installed Darwin relay check ran against the code-tested archives built from `f1f5a0ce7e28fa2c035e501fef7a0740eb481c21`. Their hashes and Linux gate logs are preserved below. The final archives were rebuilt from clean source commit `45f23b0071583df30780bf70d3bdbdbb41edeb6c` after the documentation correction. The tracked-source diff from `f1f5a0c` to `45f23b0` contains seven Markdown paths and no runtime, test, or build-code changes, so runtime gates were not repeated for this documentation-only repack.

| Runtime-tested archive from `f1f5a0c` | SHA-256 |
| --- | --- |
| `dist/f1f5a0ce7e28fa2c035e501fef7a0740eb481c21/final/darwin-arm64/lcu-0.3.0-darwin-arm64.tar.gz` | `e25691706ae3ffbe9b300ebe44287995b755418936b2dfc557cc7a637ed11da9` |
| `dist/f1f5a0ce7e28fa2c035e501fef7a0740eb481c21/final/linux-arm64/lcu-0.3.0-linux-arm64.tar.gz` | `44bebdb833f1958d0dc774d0307d78affeedfbb75a5824111b4f0290fd217484` |
| `dist/f1f5a0ce7e28fa2c035e501fef7a0740eb481c21/final/linux-x64/lcu-0.3.0-linux-x64.tar.gz` | `81a52adc6e6b59042c27b2c00fb81f288b1c09c48234601c2a7954df96dfe25a` |

| Final docs-repacked archive from `45f23b0` | SHA-256 |
| --- | --- |
| `dist/45f23b0071583df30780bf70d3bdbdbb41edeb6c/final/darwin-arm64/lcu-0.3.0-darwin-arm64.tar.gz` | `8a1409225bf52ce2f0ba98c7b9ec5580fd1e9d1e931cf50af6bc89136086acec` |
| `dist/45f23b0071583df30780bf70d3bdbdbb41edeb6c/final/linux-arm64/lcu-0.3.0-linux-arm64.tar.gz` | `9a94f036db9ec066132d70fa9a2b09bc92a037dbfb22314ac1c2d2c218d6d6b5` |
| `dist/45f23b0071583df30780bf70d3bdbdbb41edeb6c/final/linux-x64/lcu-0.3.0-linux-x64.tar.gz` | `622e71694ad71b72e71f2f82943b7d6726d69761fec0d5a8371c22f586ff8ac9` |

All three repacked archives passed source-member, installed-document-link, no-upstream-payload, sidecar/checksum, and extracted-seal audits. The Linux archives each retain the 144-test offline gate results from the runtime-identical `f1f5a0c` archives. Each gate also passed agent registration and scope checks for Codex CLI, Claude Code, and Pi, the exported MCP contract, and the GTK action suite with its independent save oracle. Logs and SHA-256 values are `/private/tmp/lcu-final-f1f5a0c-arm64-test-f1f5a0c.log` (`19fe33bc439cd3ab9181a2644cbf737ecb21183c70ce9fec7874bd472d39d099`) and `/private/tmp/lcu-final-f1f5a0c-x64-test-f1f5a0c.log` (`05f89c961aeb5be08c6c1936083a937e75d163d76c177a4c5dba4b189021d727`).

The `f1f5a0c` relay fix makes the entrypoint guard resolve the same canonical file path as Node's ESM loader. With an installed `current -> releases/...` symlink, Node retains the `current` path in `process.argv[1]` but sets `import.meta.url` to the resolved `releases` path; the previous comparison silently exited 0 without starting the MCP server. The Claude relay test file passes 5/5, including the symlink regression; the adapter suite passes 13 tests with 4 opt-in skips. An official-SDK client initialized the corrected installed relay with `--chrome`; `listTools` returned `js`, `js_reset`, `turn_ended`, and `set_turn_context` with empty child stderr. The guarded Claude relay lifecycle and direct-runtime active-call Escape comparison are recorded in [Claude relay lifecycle evidence](claude-relay-2026-09-25.md). Native-app approval and save behavior were not verified on the corrected installed archive.

The runtime-tested Darwin archive passed source and seal audits, then installed with `--runtime-only` into `/private/tmp/lcu-claude-final-f1f5a0c-install`. It reports ChatGPT `26.917.62051` and CUA `0.0.16/20260915001755-492f19756c31`, and its installation descriptor points to the pinned staged app `/private/tmp/lcu-mac-guest-staging-20260924/ChatGPT.app`, reused in place. The install itself did not run agent setup or install a browser connector; the later guarded probe used an isolated task-local project config and temporary home. No Windows archive or gate was produced, and nothing was published. See the [superseded 29a81a3 record](final-three-delivery-claude-relay-2026-09-25.md) for its former archive hashes and gates; those archives did not test startup through the installed `current` symlink.
