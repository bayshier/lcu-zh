# Browser renderer locale adaptation

> Historical evidence for the unpublished embedded-browser candidate. The current release scope uses the original external Chrome provider; see [installation](INSTALLATION.md) and [status](PARITY-STATUS.md).

The original renderer mounts React Intl with a runtime config. React Intl's inspected `IntlProvider` passes its props to the formatter config; the formatter accepts message strings and compiled AST arrays, and its config includes fields such as `locale`, `defaultLocale`, `messages`, `formats`, `defaultFormats`, `timeZone`, `fallbackOnEmptyString`, and `onError`. The browser-host adapter therefore preserves the caller's trusted `runtimeIntlConfig` object unchanged. It supplies `{ defaultLocale: 'en-US', locale: systemLocale, messages: {} }` only when the caller provides no config. This fallback is not locale canonicalization or catalog validation.

The pinned original `app.asar` contains localized JSON catalogs under `native-menu-locales/` (including `fr-FR.json` and `de-DE.json`), which the native host loader consumes. It contains no renderer `shared` React Intl catalog JSON. The `locales/*.pak` files belong to Chromium and are not React Intl catalogs. The original browser UI obtains its `shared` web app resources from the remote shared-app origin, so that remote catalog selection and its translations remain the exact external dependency. No translations are synthesized here. The old checked-in architecture inventory was removed; the selected complete app retains these files locally.

Source evidence hashes:

- `bootstrap-DF0QwAxC.js`: `5787d416ccbd7be549251d2c691f9c2579d6960f3ccd470037d97486c93fdf0f` (native locale file selection and fallback behavior).
- `main-DUHZj4_w.js`: `9e8a3bd79c817064f28693ca26aa1378895e07ab2108c78c42d0ea20dac9d66e` (app locale, preferred system languages, and shared-app resource locale override).
- `app-shared-81f4259020b8.js`: `cb6a5717c309015ac2f803879ae2e0ec9917555b45c0d66d36e64efe4bab264d` (React Intl formatter accepts string or AST messages; `IntlProvider` config).
- `tab-content-b70d652be669.js`: `b316ade805850138537db825b79122407cc15331146894c12c935d1643a19076` (original computer-use renderer imports and localized UI messages).
