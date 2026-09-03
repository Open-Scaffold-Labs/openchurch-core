# failure-probe

Drives the real client against the real server, forces chosen `/api` routes to
fail, and reports what the screen SAYS.

Protocol §13: `UNKNOWN ≠ EMPTY`, `FAILED ≠ ZERO`, `NOT MEASURED ≠ NONE`. A
page that renders "No records" on a 500 is not correct, and no static gate can
tell you that — only looking can.

    node tools/failure-probe/observe.mjs \
      '{"name":"tasks","path":"/tasks","fail":["/api/tasks"]}'

Reports `claimsEmptiness` (phrases asserting there is nothing), `admitsFailure`,
and `pageErrors`; writes a screenshot and the page text beside itself.

## The instrument needs auditing too

It has been wrong three times and each correction is in the code:

- it flagged the REMEDY text as a lie, because the honest sentence contains the
  phrase it exists to deny ("not a sign that your parish has no members");
- its honest-phrase match was case-sensitive, so it scored a page saying
  "Couldn't load this page" as silent;
- it listed "No groups yet" as a lie, which is simply true for a parish with no
  groups — an emptiness phrase is only evidence when that surface's own request
  was the one forced to fail.

Requires a running server and client, and a bearer token at /tmp/tok.

## modes.mjs — the other ways a request fails

The first pass only ever forced a 500. `modes.mjs` forces the rest, and each
can produce a different lie:

    node tools/failure-probe/modes.mjs \
      '{"name":"x","path":"/tasks","target":["/api/tasks/stats"],"mode":"emptyok"}'

`malformed` (200 + HTML), `truncated` (200 + half a JSON object), `forbidden`
(403), `timeout`, `emptyok` (a genuine, successful, empty answer), `nullok`.

`emptyok` is the control that matters: a genuinely empty result MUST still say
"No tasks yet". UNKNOWN ≠ EMPTY has to hold in both directions, or the fix has
just traded one lie for another.

This is how the NaN was found: `/api/tasks/stats` answering 200 with the wrong
SHAPE made `stats` a truthy empty array, and the page rendered "NaN" progress.
`loadOne` now validates shape, not just status.

## hittest.mjs — touch targets you cannot measure by reading

`getBoundingClientRect()` cannot see a `::after` pseudo-element, so it cannot
measure `.tap-reach`. This dispatches real hit tests outward from each
control's centre.

It found that tap-reach's effective area is POSITION-DEPENDENT: in a dense
row, adjacent reaches overlap and the later painter wins. Row 1's controls
measured 79x79 and 77x71; the delete button and row 2's toggle collapsed to
their 26x26 and 32x32 visual boxes. Inspecting the CSS would never show that.

## tap.mjs — touch targets, measured by dispatched hit test

`getBoundingClientRect()` cannot see a `::after` pseudo-element, so it cannot
measure `.tap-reach`. This probes outward from each control's centre across
desktop / iPad (both orientations) / iPhone.

    node tools/failure-probe/tap.mjs '{"device":"iphone","path":"/tasks","rows":9}'

It found that `.tap-reach` is POSITION-DEPENDENT: on a 390px viewport row 1
reached 79×79 and every row after it collapsed to the 32×32 visual box,
because tap-reach centres a 48px pseudo-element and at iPhone row pitch that
is taller than the row — so vertically adjacent rows overlap and the later
painter wins. The primitive is not broken; it is documented for isolated
inline links, and a dense action row is not that.

## diocese.mjs — the same discipline for client-diocese

Always compare against an UNFORCED CONTROL. On 27 Aug the Finance and Payroll
pages appeared to turn a failure into `$0.00` — until the control showed
`$0.00` there anyway, because that tenant genuinely has no expense and no
shifts. Two of three "confirmed defects" evaporated at the control step. An
emptiness phrase is only evidence when the control does not show it.

## sac.mjs — the sacramental register and certificate

Same shape as `observe.mjs`/`modes.mjs`, pointed at `/register` and
`/register/:id/certificate`, with one addition: it watches for phrases that
ASSERT rather than only phrases that deny.

### Correction 4 — the instrument could not see the worst defect on the surface

Every earlier rule looked for an emptiness claim ("No records", "No sacraments
recorded yet"). That is the right rule for a list. It is the wrong rule for a
certificate, where the danger runs the other way: a failed read rendering a
complete, printable, letterheaded document that ASSERTS a sacrament took
place. On 27 Aug a 200 carrying `{}` produced exactly that, and the probe
reported a clean run — no emptiness phrase was present, because the page was
busy certifying nothing.

`This is to certify that`, `according to the rites of the Church`,
`Por la presente se certifica que` and `Print / Save as PDF` are now in the
assert list. On a certificate page the control is EXPECTED to trip them; any
failure mode that trips them is a defect.

### A fixture is not automatically representative

The first certificate control run came back red against the fixed page. The
fix was not wrong — the fixture was. Record 1 had `client_id NULL`, and
`member_name` is derived only from the linked member, so that record names
nobody and can never be certified. The control had to be a record linked to a
real member (record 2) before it could prove anything. A control that fails
is a question about the fixture before it is a question about the code.
