# Browser actions without account initialization

LCU now defaults the original `BROWSER_USE_DISABLE_AMBIENT_NETWORK` option to
`1`. Explicit caller settings remain authoritative. Source inspected in the
pinned original Chrome `scripts/browser-service.mjs` shows this option skips
the account identity and telemetry initialization paths. It does not grant
access to a site. The existing LCU native-host relay still supplies the local
agent-header decision, which avoids the separate account feature-gate read.

Before changing the default, a freshly built Linux ARM64 archive was installed
offline into `/home/browser-test/fresh` in a disposable browser-test container.
The full `tests/browser_session.sh` ran with
`BROWSER_USE_DISABLE_AMBIENT_NETWORK=1` and Docker `--network none`. No account
credentials were present; only the container's localhost fixture was reachable.
The suite exited 0: original extension discovery, navigation, Unicode input,
Save click, screenshot, local fixture login/cookie, closed-tab rejection,
denied-origin blocking, stale tab rejection, reset/reconnection, service restart
and no replay after timeout passed. The page observed the original
`x-browser-agent` label. The archive was
`/private/tmp/lcu-finish-build-arm64/lcu-0.3.0-linux-arm64.tar.gz` and the local
log is `/private/tmp/lcu-finish-no-account-verified.log`.

Chrome's own sandbox remained enabled. Docker's default seccomp initially
blocked its namespace creation, so the disposable container used
`--security-opt seccomp=unconfined`. This is a bounded container check, not a
fresh Ubuntu AppArmor host check. An outdated mocked installer fixture also
failed before browser actions; its shared-path mock was corrected before the
passing run. Earlier failed logs were retained.

The passing run exercised the upstream option explicitly; final-package checks
must exercise the new LCU default without that environment override. Unit
coverage verifies both the default and preservation of an explicit caller
override. macOS Chrome and native Windows behavior are not established here.
