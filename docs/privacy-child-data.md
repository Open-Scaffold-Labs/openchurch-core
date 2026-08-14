# Child & Check-in Data — Handling Note (DRAFT)

**Status: DRAFT for internal review — not legal advice.** This documents how OpenChurch currently handles children's and other check-in data after the CHK.3 hardening pass (2026-07-03). Before relying on it externally, review with counsel against COPPA (US), applicable US state privacy laws (e.g. CCPA/CPRA), and — for any church operating internationally — GDPR/UK-GDPR. Church child-safeguarding policies (e.g. diocesan requirements) may impose stricter rules than the law.

## What we collect

The check-in system (`ochr_checkins`) records, per check-in:

- `person_name` — the person checking in. For a child, this is a minor's name.
- `kind` — `member` | `guest` | `child`.
- `guardian_name` — for a child, who dropped them off / is authorized to pick them up.
- `client_id` — link to a member record when the person is a known member (null for walk-ins/children captured by name only).
- `calendar_event_id`, `room_id`, `checked_in_at`, `checked_out_at` — where/when.
- `security_code_hash` — a keyed HMAC-SHA256 of the one-time child pickup code (see below). The plaintext code is **never stored**.

We do **not** collect birthdates, health data, photos, or contact details on the check-in record itself.

## Why we collect it

To run child check-in/check-out safely (release a child only to someone holding the pickup code), to render the room roster during a service, and to produce attendance counts. Data is scoped to the single church (`organization_id`) that entered it.

## How the pickup code is protected

When a child checks in, the server mints a short one-time code and shows it **once** to the guardian on the check-in/kiosk screen. Only a **keyed HMAC-SHA256** of the code is stored (`security_code_hash`). The code is short (4 characters, ~20 bits) — an *unsalted* hash of it would be reversible from a dump in under a second, so the HMAC is keyed with a server-side pepper (`CHECKIN_CODE_PEPPER`) held **outside the database**. A database dump alone therefore can't reverse the codes. At checkout, staff enter the code and the server compares HMACs in constant time; on a successful checkout the hash is cleared.

## Retention & anonymization

The daily retention job (`server/src/services/retention.js`) applies two child-data policies:

- **Pickup-code hashes** are cleared immediately on checkout, and as a backstop any already-checked-out row's hash is cleared 2 days after check-in. A child still checked in keeps their code hash (the pickup gate stays active); a straggler in-flight hash is only removed by the PII window below — never while the child could still be waiting.
- **Check-in PII** (`person_name`, `guardian_name`) is anonymized 400 days after check-in — the name becomes `Redacted` and the guardian name is nulled — while the row itself survives so historical **attendance counts** stay intact. 400 days keeps just over a year of named history for operational needs, then removes the personal identifiers.

These windows are constants at the top of `retention.js` and can be tightened if policy requires.

## Access & tenancy

All check-in reads/writes are filtered by `organization_id`; one church cannot see another's check-ins. Staff/admin access is gated by the app's role system. The self-serve kiosk runs on a capability token that an admin can rotate to revoke a lost tablet, and the kiosk no longer exposes the member roster (it requires a typed search of ≥2 characters).

## Open items to review with counsel / safeguarding lead

1. **Parental notice & consent** — COPPA turns on collecting personal information from children under 13. Check-in data is entered by church staff/guardians rather than by the child, which affects (but does not automatically resolve) applicability. Confirm what notice churches must give parents, and whether a posted privacy notice at the check-in station is warranted.
2. **Retention windows** — confirm 400 days (PII) and 2 days (codes) meet both safeguarding recordkeeping needs and data-minimization expectations.
3. **Erasure / access requests** — there is currently no self-service parental erasure or data-access workflow; deletions are manual. Decide whether that's required for your jurisdictions.
4. **Guardian identity** — the pickup gate is a shared code, not verified guardian identity. Confirm that matches each church's safeguarding policy.
5. **Sub-processors** — if/when email, SMS, or error-monitoring providers are wired in, confirm none receive child PII, or that a DPA covers it.
6. **Hard deletes** — deleting an event cascade-deletes its check-ins (including the historical attendance rows); deleting an org cascade-deletes everything. Confirm this matches records-retention obligations.

*Last updated: 2026-07-03. Owner: engineering. Re-review before any public privacy-policy commitment.*
