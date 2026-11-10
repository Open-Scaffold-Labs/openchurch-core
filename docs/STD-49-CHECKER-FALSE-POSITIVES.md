# STD-49 checker false positives

STD-49 forbids storing or sending a full card number. The portable checker
(`check-no-raw-card-numbers.sh`) flags a 13-to-19-digit number that passes
the usual card checksum, and also flags a `card[number]` form-field pattern.

The following paths are checker false positives. Do **not** change them to
silence the checker:

- `ios/**/LaunchScreen.storyboard` — sRGB color components in the launch
  screen, not card data.
- `tools/headed-evidence/fingerprint.mjs` — a hexadecimal evidence
  fingerprint, not card data.

Negative-test fixtures in `server/tests/sentryMessageRedaction.test.js` that
plant a published Stripe test number, or that expect the redaction
placeholder `[number]` / `card [number]`, carry the `osl-allow-test-pan`
marker on the same line. Those lines still must not be used to send a
number to the payment provider.
