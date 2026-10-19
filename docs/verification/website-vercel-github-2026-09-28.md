# Website deployment after connecting GitHub

## Observed failure

On 2026-09-28, `https://lcu.polarzero.xyz/` returned Vercel's `404 NOT_FOUND` page. The production deployment was `4nJjF2shpRZhxjw2pTiub1WMkr39`, built from `main` commit `3dbc3720371923418c8aa61f636f1fe2ec3dd1b6` and marked Ready.

The [project build settings](https://vercel.com/polar0s-projects/lcu/settings/build-and-deployment) had an empty Root Directory, the Other framework preset, and no build or output override. GitHub therefore deployed the repository root, while the homepage is `site/index.html`. Commit `5d69ee1` documents that the previous CLI workflow staged media locally and uploaded `site/`.

`site/media/` is ignored by Git. A GitHub build also needs to run `site/build.sh` to copy the tracked showreel and poster from `docs/assets/`.

## Configuration

The Vercel project settings were updated to:

| Setting | Value |
| --- | --- |
| Root Directory | `site` |
| Framework Preset | Other |
| Build Command | `sh build.sh` |
| Output Directory | `.` explicitly in `site/vercel.json` |
| Include files outside the root directory in the Build Step | Enabled, as it already was |

[Vercel's build documentation](https://vercel.com/docs/builds/configure-a-build) describes the Root Directory setting, static output for Other, build-command overrides, and that directory changes apply on the next deployment. The outside-root build option is necessary for `docs/assets/` and was verified enabled in the project dashboard. With a build command configured, the live build required an explicit output directory; relying on the default produced a missing `public` error.

The Root Directory setting also affects CLI deployment. Future CLI deployments must use the repository as the upload root rather than uploading `site/` alone, so Vercel receives both the configured subdirectory and its source media.

## Build failures and repository fixes

After the user authorized redeployment, deployment `2r2Nn7asbPHzfaXx6SNqt1u2V9cc` failed because `site/.vercelignore` excluded `build.sh`. The Vercel build log explicitly listed `/site/build.sh` among the removed files. [Vercel's exclusion documentation](https://vercel.com/docs/deployments/vercel-ignore) explains that these patterns exclude files from the deployment process and that project-root rules take precedence in monorepos.

Commit `e4f0c5f` removed the build-script exclusion, recorded `buildCommand: "sh build.sh"` in `site/vercel.json`, and corrected the build-script comment to describe the GitHub workflow. The resulting deployment `FYCbLnYVueHpw5TRohRtiQt1phef` got past the build script but failed because Vercel expected a `public` output directory. Commit `f8bc214` recorded `outputDirectory: "."` explicitly. Both commits were pushed to `main`; the primary checkout was fast-forwarded while preserving unrelated local edits.

## Verification

A temporary archive of tracked `site/` and `docs/assets/` files from HEAD initially contained no generated media. Running `sh build.sh` from its `site/` directory succeeded. All eight local assets referenced by HTML existed afterward; copied video and poster bytes matched the tracked originals. The temporary directory was removed afterward. No runtime tests or personal-desktop runtime integration tests were run.

A second temporary-checkout check applied the project's literal `.vercelignore` exclusions before building: the original rule reproduced the missing-script failure; the corrected rule preserved the script and produced all eight referenced assets with byte-identical media.

The GitHub-triggered [production deployment `tKTcAkKaDKVnYxYxo8MiRUGGiWxb`](https://vercel.com/polar0s-projects/lcu/tKTcAkKaDKVnYxYxo8MiRUGGiWxb) is Ready and serves `lcu.polarzero.xyz` from commit `f8bc214318d64f5721ea14078e143a65cbfc433e`.

Live verification on 2026-09-28:

- The homepage rendered with its expected heading and styling in the browser.
- HTTP HEAD returned 200 with the expected content types for `/`, `/css/site.css`, `/js/site.js`, `/media/lcu-showreel-poster.jpg`, `/media/lcu-showreel.mp4`, and `/fonts/instrument-sans-latin.woff2`.
- The video element loaded the production MP4 with `readyState: 4`, duration 30 seconds, dimensions 1920 by 1080, and no media error. It was paused at inspection; this check establishes media loading rather than continuous playback.
- A screenshot was saved locally at `/tmp/lcu-restored-2026-09-28.png`.
