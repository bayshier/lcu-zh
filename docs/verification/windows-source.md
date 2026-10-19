# Windows x64 source and live guest verification (2026-09-25)

The pinned official package, private app copy, thin LCU install, native
computer use, helper lifecycle, native agent registration, and an opt-in
Chrome extension action passed in a disposable Windows 11 guest. Windows
real-model use remains unverified. The first failed candidates below are retained as diagnostic
history; later installed candidates passed the specific gates stated at the
end of this record.

The [official OpenAI Windows update manifest](https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json)
identified `OpenAI.Codex` build `26.917.9434.0`. Its
`https://persistent.oaistatic.com/codex-app-prod/releases/26.917.9434.0/ChatGPT-x64.msix`
response was an 830,521,537-byte MSIX. The downloaded package's SHA-256 was
`9892383820c5505997456bde8385810afadd6076ae7fff9e3835a48ca0555c98`.
No MSIX payload was added to Git. The package contains `AppxSignature.p7x`;
this macOS inspection did not verify the signature as Windows does during
deployment. The pin source and component hashes are in `runtime.lock.json`.

`AppxManifest.xml` identifies `OpenAI.Codex`, `x64`, version `26.917.9434.0`,
publisher `CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B`, and
`Windows.Desktop` minimum `10.0.19041.0`. It registers the original
`extension-host.exe` as the `codex-chrome-native-host.exe` execution alias and
excludes the current-user Chrome native-messaging registry key from
virtualization. The package includes the original Node `24.21.0`,
`node_repl.exe`, CUA launcher, `codex.exe`, `codex-code-mode-host.exe`,
`@oai/sky` Windows helper and Swift backend, Chrome native host, plugins,
and original instructions. Its CUA manifest names platform `windows`,
architecture `x64`, runtime `0.0.16/20260915001755-492f19756c31`.

### Packaged launch contract

The inspected `AppxManifest.xml` declares two applications: `App`, whose
entrypoint is `app/ChatGPT.exe`, and `CodexCoreCommandRunner`, whose entrypoint
is `app/resources/codex-command-runner.exe`. Its only app execution aliases are
`codex-chrome-native-host.exe` for the original Chrome extension host and
`codex-core-command-runner.exe` for that Core runner. It declares no alias or
application entrypoint for bundled `codex.exe`, `node.exe`, `node_repl.exe`, or
the CUA helper. Microsoft's [app execution alias documentation](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/desktop-to-uwp-extensions)
describes aliases as manifest-registered process entrypoints; its [MSIX runtime
documentation](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)
describes the protected, read-only WindowsApps installation. The manifest does
not establish that all unaliased bundled executables are blocked; each launch
path needs its own native test.

The original Windows `@oai/sky` client, at
`app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/computer_use_client.js`,
resolves `bin/windows/codex-computer-use.exe` from its package. Its
`internal/helper_transport.js` directly spawns that helper with piped stdin,
stdout, and stderr and `windowsHide: true`. It does not invoke
`codex-core-command-runner.exe` in this path. The latter binary identifies
`--pipe-in`/`--pipe-out`, framed `SpawnRequest` fields, and registered package
image checks in its embedded strings. Those are evidence of an internal Codex
sandbox runner, not a documented general-purpose stdio entrypoint for LCU.
Reusing it as a CUA launcher would require an unproven private protocol and
would depart from the original Sky helper path. No such bridge was added.

In the disposable Windows 11 guest, the official MSIX deployed as
`OpenAI.Codex` `26.917.9434.0` x64 with Store signature. Direct invocation of
its installed `app/resources/codex.exe --version` returned `Access is denied`
from elevated PowerShell. Direct invocation of its installed `node.exe --version`
returned the same error for the ordinary account. A successful read/hash and
an ordinary-account copy test below narrow those observations; neither error
alone identifies the Windows enforcement mechanism.

The package's Chrome `installManifest.mjs` selects
`extension-host/windows/x64/extension-host.exe`, writes the host config under
the host's directory, writes a manifest under the current user's
`AppData/Local/OpenAI/extension` path constructed from `os.homedir()`, and registers that manifest under
`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts`. [Chromium's Windows
launcher](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_win.cc)
starts `.exe` hosts directly and passes other manifest paths through `cmd.exe`.
That source supports a `.cmd` relay wrapper in principle. LCU's opt-in
Windows setup now runs the original installer, selects the original Windows
`extension-host.exe`, and redirects the generated manifest through a quiet
`.cmd` relay using the Python interpreter selected at installation. Its
binary-safe stdio and upstream browser authorization still need native
integration tests. Authorization must be shown to
work with the relay. This remains a browser parity blocker, not a reason to
bypass the original extension's approval policy.

`lcu/windows.py` reads the registered current-user package location through
`Get-AppxPackage`, checks exact identity/version/architecture and Store
signature kind, and hashes pinned runtime components. Microsoft documents that
MSIX packages are [deployed per user into a protected, read-only package
location](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes).
Because direct execution from that location failed, the installer copies the
complete original app into a validated private generation without changing
the registered source or its policy. `lcu/runtime.py` selects that private app;
the original native host is derived under the thin release and serves the
original sandboxed CUA process. The installed guest results are below.

### Live guest: initial installation and selected executable

The task-owned KVM guest ran [Microsoft's Windows 11 Enterprise Evaluation
ISO](https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise),
7,092,807,680 bytes, SHA-256
`a61adeab895ef5a4db436e0a7011c92a2ff17bb0357f58b13bbc4062e535e7b9`.
It used 6 GiB RAM, four virtual CPUs, TPM, UEFI, AHCI/e1000 and an 80 GB sparse
disk. Standard OOBE completed with a generated guest-only local account and
unique synthetic VM identifiers. No Microsoft account, product key, ChatGPT
UI, or Codex login was used. The official [Python 3.13.15 installer](https://www.python.org/downloads/release/python-31315/)
had SHA-256 `edec09c4853aeae9ac36efb8c9f95b68e2fee65eee56d9767a8b7c69c574403`.

The first non-elevated `Add-AppxPackage` of the exact pinned MSIX failed with
`0x80073D28`: its packaged service required elevation. After ordinary guest
UAC approval, Windows registered `OpenAI.Codex` `26.917.9434.0` x64, publisher
`CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B`, `SignatureKind: Store`. The
installed path was `C:\Program Files\WindowsApps\OpenAI.Codex_26.917.9434.0_x64__2p2nqsd0c76g0`.
Package installation did not launch the ChatGPT UI.

The initial experimental thin ZIP built from source `5a6aaf5` had SHA-256
`74015e33f7b42068fcce3cd7c25324ecf76d5eef37282302cd9d888a9899ec8a`.
The ordinary account extracted it and ran
`python -B scripts\install_windows.py --prefix %LOCALAPPDATA%\LCU --runtime-only`.
Archive seal verification, registered-app identity, all pinned component hashes,
and original CUA manifest validation passed. `%LOCALAPPDATA%\LCU\lcu.cmd
--version` printed `lcu 0.3.0 (ChatGPT windows 26.917.9434.0; CUA
0.0.16/20260915001755-492f19756c31)`. The actual installed `%LOCALAPPDATA%\LCU\lcu.cmd
doctor` then failed `LCU: [WinError 5] Access is denied` before native control.
That archive/installer pass was not a usable-runtime result; later candidates
changed the private app and original-host launch paths.

As the ordinary account, `Get-FileHash` read the installed Node and Node REPL;
their hashes matched the lock. `Get-Acl` listed `BUILTIN\Users` with
`ReadAndExecute` on those files. A scoped query covering the denied launches
found no matching `node.exe`, `codex.exe`, or `OpenAI.Codex` event in
CodeIntegrity/Operational, AppLocker/EXE and DLL, or Windows Defender/Operational
over the preceding 30 minutes. These observations do not identify the denial
mechanism. A single ordinary-account copy of the installed `node.exe` to a
task-owned `LOCALAPPDATA` directory matched source SHA-256
`a604969e8eb5154a3d5617ff377c13b439e2436ff2ef98e546a05bd234724d78`
and printed `v24.21.0`, exit 0. This proves location-dependent launch behavior
for that one binary only.

### Live guest: intact original-runtime diagnostic before host extraction

To test whether private reuse suffices without changing policy, an ordinary
account used `robocopy /E /COPY:DAT /DCOPY:DAT /R:1 /W:1` to copy the complete
registered `app` tree into a task-owned private directory. It did not copy
WindowsApps ACLs or modify the installed app. All 13 required original
component files matched the source SHA-256 pins after copying. LCU's existing
environment builder selected the private original `node.exe`, `node_repl.exe`,
`codex.exe`, module directory and original CUA launcher. It preserved the
original Node REPL sandbox and enabled only the native computer surface.

The original MCP process initialized at protocol `2024-11-05`, exposed `js`,
and executed pure JavaScript. Its first native `cua.listWindows({emit:false})`
failed `spawn EPERM` before listing a window. In the same original REPL kernel,
`child_process.spawnSync` of the same private Node executable with `--version`
also returned `EPERM`. Outside that kernel, the same private Node printed
`v24.21.0`, and the exact private Sky `codex-computer-use.exe` started and
rejected `--help` as an unknown argument (exit 1). This differential shows a
child-process restriction in the original Windows REPL context, including the
Sky helper spawn. It does not prove how Windows implements that restriction.

Source inspection showed the original ChatGPT app hosts a named-pipe transport
for its helper. At this diagnostic stage, no pipe host had been extracted from
the original package; no synthetic server, undocumented runner, sandbox
disabling, or package-permission change was used. This `EPERM` result is
historical: later candidates used the exact-source original host and passed
the native gates below. Guest screenshots and logs remain outside
Git and release archives. Local screenshots of the installed `--version`,
shipped `doctor` denial, one-file Node copy, scoped zero-match event query,
and full-copy `EPERM` comparison are `/private/tmp/lcu-win-sealfix-installed.png`,
`/private/tmp/lcu-win-installed-doctor-denied.png`,
`/private/tmp/lcu-win-node-copy-version.png`,
`/private/tmp/lcu-win-policy-events-zero.png`, and
`/private/tmp/lcu-win-full-copy-spawn-eperm.png` respectively. The source
scripts and complete raw logs remain in task-owned temporary storage and the
disposable guest; no host credential was copied into that evidence.

### Live guest: private original runtime and installed candidates

The ordinary-account copy of the complete registered app preserved the pinned
original bytes and ran its original Node and CUA MCP. The extracted original
Windows host supplied the named-pipe helper transport outside the CUA sandbox;
the sandbox stayed enabled. The first candidate installer failed on a long
original npm path with `WinError 206`. The corrected installer used short
generation names and Windows extended-length paths for internal copying and
validation. It left public descriptors as ordinary paths, did not change
WindowsApps ACLs or system policy, and selected a release only after validating
the complete private app generation and thin release.

Installed candidate c, source `473de85`, thin ZIP SHA-256
`c495776126c3f7ec2b9fda7e52efe1bc23dc75c430114ae64b439ecdc45d77f6`,
passed default-prefix installation, `--version`, and `doctor` under the
ordinary guest account. The original MCP exposed `cua.getApp` while
`cua.createBrowserTab` was undefined in default native mode. It enumerated
Notepad and Explorer, captured a Notepad screenshot, replaced text using the
original `ctrl+a` and Unicode `typeText`, and saved an existing task-owned file
using `ctrl+s`. An independent file read matched
`Installed LCU Windows proof: café λ 東京 2026-09-25`, SHA-256
`2a788e7b40f8560fe94baeededa7ebf94ec9907b090ee358c1f45d2ae5693b82d`.
The guest log is `Desktop\lcu-installed-native-probe.log`. A separate attempt
to save a new file through a window-targeted Save As sequence did not complete;
that sequence alone does not establish an upstream defect or rule out another
supported way to operate the modal.

The candidate c client sent `tools/call` for `js` without per-call
`x-codex-turn-metadata` and did not set `NODE_REPL_REQUEST_META`. LCU supplied
its documented per-connection fallback identity, and those native actions
still passed. This shows that absent host turn metadata did not block this
direct native call path; it does not verify Claude Code's Windows model path or
provide the real turn IDs needed for matched per-turn cleanup.

Installed candidate d, source `a3abd9c`, thin ZIP SHA-256
`935d95a331fb03f6e497c376ce3c193b5ce2cf9121cf9e286a2089c1b15f46ee`,
passed the actual original MCP lifecycle sequence: a matching Stop ended the
first native helper; a stale prior-turn Stop left the new helper running;
matching Interrupt ended it; and MCP shutdown ended a third helper. The guest
log is `Desktop\lcu-installed-lifecycle-probe.log`. Unlike the candidate c
action probe, this fixture attached explicit `x-codex-turn-metadata` with real
test session/turn IDs so Stop and Interrupt could target the matching helper.
This tests process cleanup for the named turns, not agent-model behavior.

Installed candidate f, source `36c84b769250651e5af5e6563d1dd28b98c345f4`,
thin ZIP SHA-256
`e28a0e176fc8d049eee3f8b77004d7f6c759bfc4c20fff9cf01ee5fcc484765b`,
completed all six project-scoped native registration phases for Codex CLI,
Claude Code, and Pi 0.73 without the prior Unicode reader exception. The
generated Windows skill, Pi extension wrapper and Pi commands were present;
the guest log is `Desktop\lcu-candidate-f-native-setup.log`. No real model
session was run in those Windows agents. The official Chrome MSI was installed
after a valid guest Authenticode check. Candidate f's opt-in Chrome action
passed through the official extension in the default guest Chrome profile,
without sign-in. LCU elicited approval for `http://127.0.0.1:8080`, created a
tab, typed a Unicode marker, clicked Save, received the extension's saved
accessibility state and screenshot, and closed the test tab through the original API. An independent
local server confirmed the exact saved marker and `x-browser-agent` on all
three requests; MCP exited 0. This was a scripted original-MCP run, not a model
session, and does not verify automatic Windows browser per-turn cleanup. The
original URL-confidence policy blocked native `getApp` on the Chrome Web Store;
the setup click used ordinary guest UI and did not change policy. The guest log
is `Desktop\lcu-chrome-live.log`. Candidate f is a verification artifact, not
a published release.

Candidate f also passed a local scripted-provider Pi 0.73 fixture using normal
project auto-discovery, without explicit extension or skill flags. The fixture
discovered the generated `.pi` assets, received the original guide, skill and
tool descriptions, then made four original CUA calls, including persistent
JavaScript values `42` and `43` and native Notepad targeting by exact observed
ID and title. The guest log is `Desktop\lcu-pi-autodiscovery.log`. This was
not an external model run and does not independently verify Windows per-turn
cleanup.
