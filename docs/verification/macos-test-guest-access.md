# Task-owned macOS test guest access

The disposable UTM guest `LCU macOS cold helper test` (UUID `34461462-A64A-4740-9A68-458E1748EB15`) uses the local account `lcuverify` (`LCU Verification Admin`). Before asking the user for a password, consult the private local notes at `.verification/private/README.md`; the credential stays outside tracked files.

## Validated login procedure

1. Select the exact UTM window for the named guest and press `Escape` to wake it. Confirm the login screen shows `LCU Verification Admin` and the guest's U.S. keyboard input source.
2. Click the password field after observing it in the current screen. Start with an empty field. If text is present, clear it with `BackSpace` and confirm the empty placeholder; modifier chords can be dropped by UTM.
3. Read the password locally from `.verification/private/utm-lcuverify-password.txt` without displaying or logging it. Send each character using UTM `pressKey(character)`, then press `Return`.
4. Confirm unlock by checking the guest accessibility tree or screenshot for the normal desktop.

Successful unlock with the saved credential was observed on 2026-09-28. A subsequent guest terminal check showed that modifier chords can be dropped, so do not rely on Command-A to clear the field. Use the currently observed field and keyboard source. UTM `typeText` may fail to inject text; that failure alone does not mean the password is invalid. Do not reset the account, enable automatic login, or create another credential as a workaround.
