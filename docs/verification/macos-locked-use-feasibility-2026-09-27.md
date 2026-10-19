# macOS locked-use feasibility for LCU, 2026-09-27

## Decision

**The installed runtime has a narrow, code-enforced route for lock-screen
unlock, but this audit cannot establish that any current LCU launch mode
qualifies. LCU must not claim locked use.** The helper requires an authorized
*responsible application identity* before it will prepare an unlock-eligible
request. The service's request preparer tracks thread IDs after dispatch has
passed its sender and request-classification checks; this audit found no
evidence that LCU must obtain a separate pre-registered active-turn token from
the desktop. Whether the remaining coordinator conditions succeed for an LCU
call still needs runtime evidence.

The identity gate is exact: the operating system must attribute the IPC sender's
`responsibleIdentity` to a bundle in the original Codex host allow-set and to
team `2DC432GLL2`. The signed bundled Node has that team, but its signature alone
does not satisfy the bundle check. The actual responsible identity assigned to
each LCU process topology remains unobserved. An independent terminal or
another non-Codex host cannot satisfy this identity predicate unless macOS
attributes it to an allowed Codex host. A topology attributed to an allowed
Codex host passes the identity gate, but that fact alone is not a runtime
demonstration of successful locked use.

## Inspected installation and official boundary

The inspected app is `/Applications/ChatGPT.app`, version `26.924.22138`,
build `11645`, bundle `com.openai.codex`. Its intact signed helper is
`Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app`,
with executable `Contents/MacOS/SkyComputerUseService`. The bundled
`Codex Computer Use Installer.app` was present. This locked-use investigation
launched neither component and changed no setting. The separate
[native-host investigation](native-host-integration-plan-2026-09-27.md)
records its aborted helper `--help` launch.

The official [Computer Use locked-use documentation](https://learn.chatgpt.com/docs/computer-use#locked-use)
says temporary automatic unlock is scoped to an active trusted Computer Use
turn, that local keyboard or pointer activity relocks the Mac, and that other
local processes cannot unlock it. That describes the product boundary; the
decision here is grounded separately in the installed helper's gate below.

## Exact sender identity predicate

Read-only ARM64 disassembly and Swift reflection identify
`ComputerUse.ComputerUseIPCSenderContext` and its fields. The reflected field
layout is:

| Offset | Field |
| --- | --- |
| `0x00` | `senderPID` |
| `0x08` | `parentIdentity` |
| `0x48` | `responsibleIdentity` |
| `0x88` | `ancestorIdentities` |
| `0x90` | `clientType` |
| `0xa0` | `mcpRuntime` |

`ComputerUseIPCSenderContext.allowsLockScreenAutoUnlock.getter` is at
`0x100170f18`. It reads `responsibleIdentity` (the value beginning at offset
`0x48`), not `parentIdentity` or `ancestorIdentities`, and requires:

1. the responsible identity's team identifier to equal `2DC432GLL2`; and
2. its bundle identifier to be in the set initialized from
   `SystemSoftware.BundleIdentifiers.computerUseHostBundleIdentifiers`.

The host-bundle set initializer is at `0x1001717c8`; the property accessor is
at `0x1002489ac`. Decoding the static array used by this installed build gives
these five allowed bundle IDs: `com.openai.codex`,
`com.openai.codex.alpha`, `com.openai.codex.beta`, `com.openai.codex.dev`, and
`com.openai.codex.nightly`. The allowed-team set's static entry is the single
team ID `2DC432GLL2` (file offset `0x13d3e30`).

The alternate executable-path set is empty. Its initializer at `0x100171830`
starts from Swift's empty-set singleton and passes it through
`0x1001703d8`; the resulting global at `0x101555c00` contains no path entries.
There is no path-only exception that admits an independently launched LCU
binary.

The bundled Node's code signature reports TeamIdentifier `2DC432GLL2` and
Identifier `node`. That meets the team comparison but not, by itself, the
bundle-ID comparison. The code checks the OS-resolved `responsibleIdentity`,
not the signer's team in isolation. A process may therefore qualify only if
macOS attributes that sender to one of the listed Codex host identities; this
audit did not observe that attribution for LCU.

## Request and active-turn path

The getter is used by authenticated IPC dispatch. Representative dispatch
sites at `0x10017d928`, `0x10017e5a4`, and `0x10017ed94` combine its result with
request classification before invoking the authenticated-request preparation
callback. The service's
`ComputerUse.LockScreenAutoUnlockCoordinator.prepareForRequest(threadID:)`
is at `0x10019b1fc`. Its continuation checks the optional thread ID and inserts
it into the coordinator's `activeThreadIDs` set (`self + 0x58`) at
`0x10019b31c`–`0x10019b35c`; this is request preparation updating service
state, not evidence of a prior turn-registration handshake. The eventual
`ComputerUse.SystemLockScreenController.unlock()` call is at `0x100215cc0` and
uses `LockScreenLoginAuthorizationApprover`. The helper's authorization
socket is `/tmp/com.openai.sky.CUAService/LockScreenLoginAuthorization.sock`.
The authorization installer participates in that flow; its presence or
installation does not make an otherwise rejected sender or request qualify.

LCU's metadata is not uniformly synthetic. Maintained adapters carry real
host-provided session and turn identifiers in `x-codex-turn-metadata`; for
example, [the shared adapter](../../adapters/client.mjs) requires both IDs,
and the [Claude adapter](../../adapters/claude.mjs) relays the host context.
The [Pi adapter](../../adapters/pi/index.ts) creates its turn ID within that
adapter. Separately, [runtime.py](../../lcu/runtime.py) creates fallback IDs
only when `NODE_REPL_REQUEST_META` is absent. These values support request
context and turn-ended cleanup. The service's preparation callback uses the
supplied thread identifier after sender and request checks; a caller-supplied
ID cannot bypass those checks. This static trace does not establish whether all
remaining coordinator predicates accept LCU requests.

## Falsifiable conclusion and missing evidence

The falsifiable identity result is: an independent non-Codex responsible host
fails `allowsLockScreenAutoUnlock`; a sender whose OS-resolved responsible
identity is an allowed Codex host passes that getter. For an LCU mode to claim
end-to-end locked use, an isolated run must additionally show its qualifying
request proceed through the original coordinator and authorization path. The
experiment must record:

1. its IPC sender context's `responsibleIdentity` fields and getter result; and
2. whether its request reaches `prepareForRequest(threadID:)` and proceeds
   through the original unlock authorization path.

The smallest decisive experiment is an isolated macOS comparison across the
intended LCU launch modes, capturing the helper's resolved sender context,
getter result, and request-preparation outcome on a disposable desktop. This
audit did not perform that experiment. The evidence-based answer is: **a
standalone caller attributed to a non-Codex responsible host cannot pass the
identity gate; a Codex-responsible topology is conditionally eligible at that
gate; end-to-end locked use remains unverified and unsupported by LCU.** The
official documentation alone is not used to claim that every Codex-host
integration is impossible, and the Node signature or caller-supplied turn IDs
are not treated as proof of eligibility.

This locked-use investigation performed no desktop action, lock-state change,
credential access, or helper/installer launch. No OpenAI binaries, extracted
source, or generated fragments were added to Git.
