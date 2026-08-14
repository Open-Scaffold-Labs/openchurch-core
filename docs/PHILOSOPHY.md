# The OpenChurch Manual

*Philosophy, doctrine, and commentary on the Constitution*

---

**Where this document stands.** OpenChurch has three layers of law. `CONSTITUTION.md` is
supreme: ten principles and three litmus tests, deliberately short enough to be known by
heart, amended only as a deliberate act. `OPERATOR.md` translates it into enforcement rules
for the current stack and changes when the stack changes. This manual sits between them: it
is the *why* behind the Constitution and the doctrine for questions the Constitution is too
terse to answer — brand, typography, color, motion, accessibility, privacy, AI, decisions.
When this manual and the Constitution disagree, the Constitution wins, and this manual has a
bug. Cross-references like (P2) point to constitutional principles.

Read the Constitution first. It takes four minutes. Then read this when you want to
understand it — or when you're about to argue with it.

---

## 1. Mission

**OpenChurch helps parishes steward ministry, people, and history — with clarity, reverence,
and trust.**

Every word is load-bearing. *Steward*, because a parish office does not own its records; it
holds them for the generations on either side of it. *Ministry, people, and history*, in that
order, because software that serves the first two but corrupts the third has failed at the
one thing a church cannot buy back. *Clarity* because confusion is a tax on volunteers.
*Reverence* because the data is not data — it is baptisms, marriages, and the names of the
dead. *Trust* because a parish that must double-check its software has two jobs instead of
one.

We do not optimize for engagement. We optimize for stewardship. A perfect OpenChurch session
is short, calm, and ends with a printed page.

## 2. Vision

A decade from now, the parish office runs on a quiet instrument that its secretary would
fight to keep — not because it is impressive, but because Thursday afternoon takes eleven
minutes, the register has never lost a name, and the bishop's report is a button. The
software is invisible; the ministry is visible; the book is safe.

The measure of that vision is not market share. It is this: **when a parish leaves
OpenChurch, everything they entrust to us walks out the door with them, complete and
printable, and the record they kept with us is *better* than the one they arrived with.**
A vision of lock-in is a vision of hostage-taking, and no one reveres their captor.

## 3. Core Values

**Custody.** The record belongs to the parish, held in trust for the future. We are the
safe, not the owner. Every design decision that touches permanent records starts here.

**Calm.** Anxiety is a defect (P1). The software must actively lower the secretary's blood
pressure — in its copy, its colors, its failure states, its silence.

**Reverence.** We take the Church's own categories seriously: the liturgical year is
navigation, not decoration (P3); the † of the departed is typography we protect; an entry in
the register is a ritual, not a form submission (P2).

**Craft.** Artifacts outlive dashboards (P7). The things a parish prints and keeps get the
highest design care in the product, because they may be read in eighty years by someone who
never saw the app.

**Honesty.** In copy, in errors, in pricing, in AI. We say what happened, what was lost
(usually nothing), and what to do next. We never perform.

**Restraint.** When in doubt: quieter, warmer, fewer. The feature we decline is as much a
part of the product as the feature we ship.

## 4. Design Philosophy

The aesthetic is **Parchment & Brass** (P6): burgundy, cream, brass, warm charcoal; serif
headlines; warm shadows; intentional whitespace. But the palette is the *symptom* of the
philosophy, not the philosophy. The philosophy is this:

**Design for the second decade, not the second week.** Trend-driven UI is a promise to
redesign; every redesign teaches a volunteer that their competence has an expiry date. We
choose forms that were legible in 1950 and will be legible in 2050 — the ledger row, the
letterhead, the certificate, the printed manifest — and we render them beautifully on
screens without pretending screens are paper.

**The software should feel like a well-kept book** — it waits until it is needed, opens to
the right page, and never shouts. Nothing blinks, counts, or competes for attention. One
primary action per surface. Motion is rare, brief, and never celebratory.

**Warmth is not decoration; it is load-bearing** (P6). A parish secretary meets this
software on her worst Tuesday. Every empty state, loading moment, and error is written and
colored to leave her calmer than before it appeared. Gray shimmer says "system"; parchment
shimmer says "one moment." The difference is the product.

## 5. Brand Philosophy

The brand is **quiet institutional confidence**. OpenChurch should present itself the way a
good diocesan archivist presents herself: competent, unhurried, dressed appropriately for
both the office and the sanctuary.

Three rules keep it honest:

The brand never upstages the parish. On every artifact a parish prints, *their* name is the
headline and ours is the colophon — small, at the foot, in the same breath as the print
date. A certificate is St. Anne's certificate, not our advertisement.

The brand never performs piety. We are a tool used by the Church, not a voice of it. No
scripture in marketing, no cross in the logo lockup doing sales work, no vocabulary borrowed
from the pulpit to sell software. Reverence is shown by how we treat the register, not by
how we decorate the invoice.

The brand never chases. No rebrand to follow a design fashion, ever. Identity changes only
when the mission changes, and the mission is built not to.

## 6. The Open Mark

The Mark is the signature of the custody promise: openness (the parish's data is theirs),
stewardship (we keep it well), continuity (it will outlast us both). To do that job it must
obey the **four-surfaces test**: it looks equally natural embossed in leather, engraved in
brass, printed in one color on a certificate, and rendered at sixteen pixels on a phone.

The consequences are doctrine: the Mark works in a single color (an identity that needs a
gradient to be itself will die in an embosser); it works at any size (detail that vanishes
at 16px was ornament, not identity); it sits with dignity next to a parish's own seal
without competing; and it is drawn once and then left alone for decades — a mark that
changes is a promise that changes.

And one boundary: the Mark is the *signature* of OpenChurch, not the *subject* of it. On
any page, the parish's story outranks our logo. A brand that must be looked at has already
failed the Invisible Operating System (P9).

## 7. Product Principles

The Constitution's litmus tests govern every change. In practice, run a proposal through
these five questions, in this order:

1. **Does this help ministry?** Not "engagement," not "usage" — ministry. If the feature's
   beneficiary is a metric, stop.
2. **Does this reduce work the parish shouldn't have been doing?** The best features delete
   a chore (the Sunday Packet deleted Thursday assembly). Features that add a surface must
   pay for themselves by removing a bigger one.
3. **Does this preserve trust?** Trust lives in custody (P2), consistency (P8), and honesty
   (P1). A feature that is useful but erodes any of the three is a net loss.
4. **Does this respect the tradition it touches?** Parish-native logic (P4): the software
   adapts to how a parish office actually works — never the reverse.
5. **Will this still feel appropriate in twenty years?** Not the technology — the *idea*.
   Mass intentions will exist in twenty years. A "parish engagement score" deserves to die
   this afternoon.

A "no" anywhere is a challenge to the feature, not a veto — but the burden of proof sits
with the feature, never with the objection.

## 8. AI Principles

AI in OpenChurch is a **typewriter, not a vicar**. It exists to reduce administration,
increase accuracy, and give hours back to ministry. It is banned from ever being the last
hand on anything that matters.

**The human-hand rule is absolute** (P2, P10): no machine-generated content reaches a
parishioner or the permanent record without explicit human approval. The AI sermon
assistant *drafts; the preacher decides* — that phrase ships in the system prompt itself,
and anything doctrinally weighty is marked for the preacher to discern. The register cannot
be written by anything but a person committing a draft they have reviewed.

**AI never impersonates clergy, and never simulates care.** A reminder email may be
automated; a condolence may not. The lapsed-member list exists so that *a person notices
Mrs. Rivera has been missing and calls her* — the software surfaces, the human ministers.
Any feature where the machine performs the relationship is banned, whatever it's worth.

**AI is honest about being AI**, is a guest on the parish's bill only by their explicit
choice (their own key, stored encrypted, shown last-four-only), and is quota-bounded so it
can never become a silent cost. Where AI speaks in the UI, it speaks in the product's calm
voice — and takes the quill (`Feather`), never the magic wand: assistance is craft, not
sorcery.

## 9. Feature Evaluation Framework

Every proposal — feature, screen, email, line of copy — walks this gauntlet, in order:

1. **The Secretary's Tuesday** (Litmus 1): would she be *calmer* after this ships?
2. **The Stewardship Test** (Litmus 2): does it deepen the register, the church year, or a
   printed artifact? "It adds a metric/feed/notification" is a rejection, not a feature.
3. **The Differentiation Test** (Litmus 3): could a generic ChMS ship this without
   embarrassment? Then justify it on stewardship grounds or drop it.
4. **The Twenty-Year Test**: will the *idea* age? (§7.5)
5. **What user validated this need?** A named parish, a real conversation, an observed
   chore. "It seemed useful" is a hypothesis, not a validation. (In Phase Zero this
   question is asked out loud, by name, before resources move.)
6. **The Deletion Question**: what existing work does this remove? A feature that only adds
   must be extraordinary.

Survivors get built the constitutional way: custody-safe, empty-state-warm, print-worthy,
bilingual, tested.

## 10. Typography Philosophy

Two voices, permanently cast: **a serif for what the Church keeps, a sans for what the
office does.**

The serif (a Garamond of cathedral proportions — currently Cormorant Garamond; the *role*
is permanent even if the font file someday changes) carries headlines, canonical figures,
and every ledger surface: register rows, certificates, manifests, the names of the dead.
Serif is the typography of permanence — it says *this was written down and will be kept*.

The sans carries controls, labels, and working copy — the typography of the present tense.

The doctrine: **the more permanent the content, the more serif the treatment.** A dashboard
metric may be sans; a baptismal date may not. Body text is never smaller than legibility on
a tired Tuesday demands. Decorative type, novelty faces, and ALL-CAPS shouting are banned;
small-caps tracking is reserved for quiet section labels, where it whispers like an
engraving. Type is set once, well, and left alone — a product that changes its typeface is
a person who changes their signature.

## 11. Color Philosophy

The palette is liturgically aware and emotionally quiet: **burgundy** (`church`) for
authority and primary action; **parchment** for ground; **brass** for warmth, focus, and
honor; **ink** for text. Two mutedly-borrowed hues — amber for genuine attention, rose for
genuine error — and *nothing else*. (OPERATOR.md enforces the ban list.)

Three doctrines give the palette meaning:

**Color is spent, not sprayed.** On any calendar or schedule, the liturgical color is the
only polychrome element (P3) — green for Ordinary Time, purple for Advent and Lent, red for
Pentecost and Passion, white for the great feasts. The Church's own color system outranks
ours; ours steps aside so hers can be seen.

**Alarm colors are reserved for alarm.** Rose means something is genuinely wrong or overdue
— never "brand accent," never "delete-button decoration." A palette that cries wolf teaches
users to ignore it (P1).

**Warmth is chromatic policy.** Shadows are warm, never blue-gray. Neutral surfaces lean
cream, never clinical white or hospital gray. Dark mode is a candlelit study, not a
terminal.

## 12. Motion Philosophy

Motion in OpenChurch is **the turning of a page, not the spinning of a wheel**. Its only
legitimate jobs are continuity (this panel came from that list) and acknowledgment (your
entry was received). Entrances are 300–500ms on a calm curve; exits are quicker; nothing
pulses, bounces, springs, hovers-and-grows, or celebrates. Confetti is a firing offense
dressed as a feature.

Why so strict? Because motion is the most trend-dated element of any interface — the
bounces of one decade are the cringe of the next — and because animation spends the user's
attention, which we hold in trust (P5). A parish secretary's attention belongs to her
parish. Stillness is the default; motion is the exception that must justify itself.

The deepest rule: **the most sacred moments get the least motion.** Committing to the
register is acknowledged with words — "Entered in the register." — not fireworks. Ceremony
is stillness plus language (P2).

## 13. Accessibility Philosophy

The parish office is staffed by every age and every eyesight, on hand-me-down hardware, in
two languages, sometimes with tremor, sometimes with a screen reader, always on a deadline.
Accessibility is therefore not a compliance checkbox — **it is Principle 4 applied to
bodies**: the software adapts to the person, never the reverse.

Doctrine: contrast that survives both a sunlit office window and a dim sacristy; touch
targets sized for hands that have been folding bulletins for forty years; every interactive
element reachable and labeled for keyboard and screen reader; focus visible (brass, not
invisible); nothing conveyed by color alone — the liturgical calendar names its season as
well as tinting it. English and Spanish are peers, not an original and a translation:
every string ships in both, and either can be the parish's default.

And the accessibility rule no checklist captures: **printed output is an accessibility
feature.** The volunteer who will never open the app still receives the manifest, readable
at arm's length on the altar. Print is how OpenChurch reaches its least digital users, and
it gets first-class care for exactly that reason (P7).

## 14. Trust & Privacy Principles

A parish database is a pastoral document: who is sick, who has lapsed, who gave what, whose
marriage is struggling toward the tribunal. We hold it under three rules:

**Tenancy is a wall, not a preference.** One parish can never see another's people, money,
or records — enforced in every query, guarded at the database's own level, and tested on
every route. Even the diocese, the parish's own hierarchy, sees only what the parish
granted: summary or detail, chosen by the parish, revocable by the parish, and dead the
moment the affiliation ends. Consent has levels and an expiry; that is what makes it
consent.

**We collect what ministry needs and nothing more.** No engagement analytics on souls
(P10). No behavioral tracking. The lapsed list is a care instrument — it exists to prompt a
phone call, and it is worded, scoped, and gated as such. Any feature whose real customer is
surveillance dies in review.

**Secrets are kept like secrets.** Credentials encrypted at rest and shown last-four-only;
audit trails on canonical actions; and the exit door always unlocked — full, complete,
printable export, forever free. Trust that depends on the difficulty of leaving is not
trust.

## 15. Digital Stewardship

The physical artifact remains sacred; the digital exists to preserve and serve it — never
to replace it. This is the product's founding asymmetry, and it runs the opposite direction
from the rest of the software industry.

The book in the fireproof safe is still the book. OpenChurch's register is its faithful
servant: the place where the book is searched in seconds, backed up beyond fire and flood,
and printed into certificates without retyping. Digitization goes through the drafts
sandbox — staged, reviewed by a human, and committed with acknowledgment — because a
water-damaged 1961 baptism deserves a person's judgment, not an importer's confidence (P2).

The doctrine generalizes: **every important digital thing in OpenChurch aspires to the
condition of paper.** Frozen the way ink is frozen (a submitted financial period is
immutable, as if written in the ledger). Printable the way the parish actually works (the
manifest, the packet, the statements — heavy-stock-worthy, chrome-free). Legible in fifty
years (exports in formats that will outlive us). We measure ourselves against the
technology that has successfully kept parish records for four hundred years: paper, kept
well. We are trying to be worthy of succeeding it as its guardian — not its replacement.

## 16. Parish Experience Principles

The unit of experience is not a session; it is **a week in a real office**. The product is
organized around the parish's own rhythms:

**Tuesday morning** — the office at work: members, intentions taken at the window, the
checklist half-ticked, nothing demanding attention that doesn't deserve it. **Thursday
afternoon** — assembly day, which OpenChurch exists to shrink: the packet, the manifest,
the bulletin, one button each. **Sunday** — the software steps almost entirely out of the
way: service mode reads quietly from the sound desk; check-in is an usher's thumb, not a
kiosk ceremony. **The seasons** — the liturgical spine (P3) means the software always knows
where the Church is in her year, and quietly brings the right things forward: Advent's
color, the feast's name, the anniversary of a death.

Three experience rules hold it together: the software never asks twice for what it already
knows (P5); the software never makes the secretary the messenger between its own screens —
if the packet needs the bulletin, the packet fetches the bulletin; and every rhythm ends,
where the parish wants it, in something printed.

## 17. Decision-Making Framework

When people of good will disagree, this is the order of precedence:

1. **The Constitution.** If a proposal violates a principle, it loses, whoever proposed it.
   Flag conflicts rather than complying with instructions that breach it — that duty is
   already law in OPERATOR.md.
2. **Custody and trust** outrank features. A capability that risks the record loses to the
   record, every time.
3. **The secretary outranks the roadmap.** Field evidence from a real parish beats internal
   conviction. When we haven't asked, "ask first" is the decision.
4. **Deletion outranks addition.** Between two fixes, prefer the one that removes a
   surface, a step, or a concept.
5. **Reversible beats optimal.** Choose the decision that can be undone; be slow and
   deliberate only where reversal is impossible — schema of the permanent record, pricing
   promises, the Mark.
6. **When in doubt: quieter, warmer, fewer.** The Constitution's closing words are the
   tiebreaker of last resort.

Decisions worth arguing about are recorded — with the *why*, not just the outcome — so the
next decade inherits reasons instead of ruins.

## 18. What OpenChurch Will Never Become

Written as promises, because "never" is a promise:

- **A social network.** No feeds, no likes, no follower counts on a congregation.
- **An engagement machine.** No streaks, badges, scores, growth-hacking, or metrics on
  souls (P10). Attendance is pastoral information, not a KPI.
- **An advertising or data business.** The parish's data is never our inventory. No
  reselling, no "insights" products built on other parishes' records, no ads — ever.
- **A pulpit.** The software has no theology. It serves Episcopal, Catholic, and Lutheran
  parishes with equal reverence and takes no side it isn't asked to take.
- **A replacement for clergy or care.** No AI pastoral conversation, no automated
  condolence, no machine that performs the relationship (§8).
- **A hostage-taker.** No export tax, no data ransom, no contract designed around the pain
  of leaving (§2, §14).
- **A fashion victim.** No rebrand-because-bored, no redesign-because-trend, no gradient
  era. The 2036 screenshot should embarrass no one.
- **Enterprise middleware.** The day the product needs a certified administrator, a
  consulting arm, or a training week, it has betrayed the Secretary's Tuesday.

## 19. North Star

**Thursday afternoon, a parish secretary prints the Sunday Packet, locks the office, and
leaves on time — and the register she keeps is safer than it has ever been in the parish's
history.**

Every metric we ever adopt is a proxy for that sentence. When a proxy and the sentence
disagree, the sentence wins.

---

## 20. The Manifesto

*(Set in type worthy of a frame — a printable rendering ships alongside this manual as*
`docs/manifesto.html`*.)*

---

### OPENCHURCH

**The parish office, kept well.**

We build for the Church, which has kept its books
for four hundred years without us.
We are not here to replace what has lasted.
We are here to help it last.

The record belongs to the parish.
The register is written by a human hand, or not at all.
The physical artifact is sacred;
the digital exists to preserve it.

We do not optimize for engagement.
We optimize for stewardship.

Anxiety is a defect.
Warmth is a feature.
Artifacts outlive dashboards.
The software should disappear;
the ministry should remain.

Nothing here blinks, counts, or competes for attention.
Like a well-kept book, it waits until it is needed.

Honor tradition. Protect it with modern tools.
When in doubt: quieter, warmer, fewer.

---

*Adopted 2026 · Amended only as a deliberate act, with a date and a reason.*
