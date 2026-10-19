# Installed application inventory

LCU's source and thin archives carry the [pin and selected component hashes](../runtime.lock.json), not a copy of the official application. Development tests verify the exact architecture-specific official `.deb` SHA-256 before extraction; the installer never downloads or extracts a package. The package supplies the complete application, including its original CUA runtime, CLI, Chrome plugin, instructions, notices and optional code that LCU does not expose.

## Local verification

[The installer](../scripts/install.mjs) checks the runtime manifest, architecture, required files and executables, and reads the app version from `app.asar` or its dpkg ownership. It uses the installed app in place and keeps no Linux app copy or tree inventory; LCU 0.7.0 and earlier copied the app into a managed generation under `<prefix>/apps`, which `lcu prune` now removes.

[Setup](../lcu/setup.mjs) registers no skill and copies no original documents: the original runtime delivers its instructions through the tool, as in official Codex. It removes the `lcu` skill that earlier versions registered. The [setup tests](../tests/node/setup.test.mjs) (removal of the old skill), the [installer tests](../tests/node/install.test.mjs) and the [source-distribution test](../tests/node/distribution.test.mjs) cover the corresponding boundaries.

## Historical source audit

The earlier full-copy candidate catalogued the entire pinned package, including inactive platforms and embedded-browser UI. That design is retired. Its large architecture inventories were removed from the active source because the current Linux installer validates the installed app's structure in place and records only its observed version and runtime; it neither authenticates the package nor inventories the tree. The compact [host source index](../scripts/host-source-inventory.json) retains source coordinates and hashes for the host-environment and authentication analysis; [historical instruction hashes](../scripts/instructions.lock.json) remain provenance only. Neither record is loaded by the current installer or included in the thin release.

The fixed official package is version 26.915.31945 with CUA 0.0.16/20260915001755-492f19756c31. ARM64 and amd64 package hashes are in `runtime.lock.json`. A SHA-256 pin proves that the acquired bytes match the reviewed package; it does not verify an independent publisher signature.
