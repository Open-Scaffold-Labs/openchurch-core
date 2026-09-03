// Who a gift is FROM — in one place, with a name.
//
// WHY THIS FILE EXISTS
//
// A donor's year-end statement groups gifts by donor_email, and the
// comparison was exact-string. So one household giving all year could
// arrive as three donors and receive three statements, each understating
// what they gave:
//
//   Jose@example.com      typed into the parish office's manual entry form
//   jose@example.com      typed by the donor on the public giving page
//   JOSE@EXAMPLE.COM      exported from an old system and imported as CSV
//
// Three rows, three donor_keys, three statements, and a pledge that reads
// as a third fulfilled. Nobody did anything wrong; the addresses are the
// same address. Email is case-insensitive in its domain by RFC and in its
// local part by every mail provider a parish will ever meet, and surrounding
// whitespace is a transcription artefact rather than data.
//
// WHAT THIS IS NOT
//
// This is normalisation of ONE identifier, not person resolution. It will
// not merge on name similarity, address similarity, household inference or
// fuzzy matching, and it must not grow to. Two people at one address with
// one shared mailbox are one donor_email and this file cannot tell they are
// two people; two addresses for one person are two donor_emails and it
// cannot tell they are one. Those are policy questions with a wrong answer
// that costs somebody their giving record, and they belong to the founder,
// not to a normaliser.
//
// Nor is email assumed to be the permanent donor identity forever. It is
// the identity the schema has today. When that changes, this file is the
// one place that has to know.
//
// EMAIL NORMALIZATION IS NOT PERSON RESOLUTION.

// Trim, then lowercase. Nothing else — no dot-stripping, no plus-address
// folding. Gmail treats j.ose+parish@gmail.com as jose@gmail.com and almost
// nobody else does, so folding those here would merge two donors at any
// provider that doesn't, which is the one outcome worse than not merging.
//
// Empty and whitespace-only become null: the column is nullable and a blank
// string is not an address. That also keeps the "no email" grouping path
// (donor_name + donor_email IS NULL) reachable rather than accumulating a
// separate '' bucket beside it.
export function normalizeDonorEmail(raw) {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  return s === '' ? null : s
}

// SQL for the same rule, for comparing against rows written before
// normalisation existed. Reads that must match historic data use this;
// reads that only ever see normalised writes can compare the column
// directly. Both are correct once the backfill has run — this one is also
// correct before it.
// COMPARING AGAINST STORED ROWS — deliberately NOT exported as a helper.
//
// The read sites compare lower(donor_email), inline, because migration 097
// builds a functional index on exactly that expression and a helper that
// wrapped btrim() around it would make the index unusable. A read that
// cannot use the index the same release added is a worse trade than the
// case it would cover, and a shared constant is how the two drift apart.
//
// THE SEAM, stated rather than papered over: trimming is closed on the WRITE
// side by normalizeDonorEmail() above, so no new row can carry surrounding
// whitespace. A row written before that could, and lower() alone would not
// match it. Measured against production on 2026-09-02: 5 rows carry an
// email and 0 would change under trim+lower, so there are no such rows to
// miss today. If that stops being true the fix is to rebuild the index as
// lower(btrim(donor_email)) and change the read sites with it — both
// together, or neither.
