# headed-evidence

Fingerprint PNG screenshots: IHDR dimensions and sha256 of the file bytes.

Folder names and Playwright viewport settings are labels. This tool reads
the file. Two paths with the same sha256 are one capture.

```
node tools/headed-evidence/fingerprint.mjs shots/*.png
node tools/headed-evidence/fingerprint.mjs --compare online.png offline.png
node tools/headed-evidence/fingerprint.mjs --json shot.png
node tools/headed-evidence/fingerprint.mjs --self-test
```

Exit codes: `0` clean, `1` usage, `2` not a PNG / unreadable, `3` duplicate
sha256, `4` self-test failed.

No extra dependencies. Does not talk to a browser, a database, or the
network. Does not grade a packet — it only reports what the bytes are.
