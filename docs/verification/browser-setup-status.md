# Browser setup diagnostics, 2026-09-24

`lcu browser status` runs the selected official application's original
`check-extension-installed.js` and `check-native-host-manifest.js` with the
selected browser family. It does not write browser settings or read page data.
It additionally checks that the manifest points to the current LCU relay,
its selected-app marker matches, and the original native host is executable.

Missing extension, disabled extension and missing/outdated connector each show
a concrete next action. The official extension URL comes from the original
plugin's `extension-ids.json`. The command explicitly distinguishes file-based
setup checks from a live browser connection and exits nonzero for incomplete
setup.

Eight focused Python tests passed, including existing installation checks,
missing/disabled extension guidance, an original non-LCU host manifest, an
outdated relay and a no-writes assertion. A read-only run against the installed
macOS app and real Chrome configuration reported the absent extension and
connector as expected. No extension or host registration was installed by that
check. This does not establish a successful macOS browser action.
