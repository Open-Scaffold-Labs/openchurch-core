// The effective chart of accounts for a parish, in three layers (DIO.5).
//
//   0 · the standard template   (organization_id IS NULL)
//   1 · the affiliated diocese  (organization_id = the diocese's org)
//   2 · this parish's own rows  (organization_id = $1)
//
// Higher layer wins — but NOT uniformly, and the split is the whole point.
//
//   Structure is the diocese's: acct_type, rollup_group, assessable and
//   active come from layer 1 when a diocese is attached, ignoring layer 2.
//   Otherwise a parish could shrink its own assessment by unticking
//   `assessable`, or deactivating the account entirely, and the chancery
//   would never see it. The consolidated matrix depends on every parish
//   binning revenue the same way, so rollup_group cannot be local either.
//
//   Wording is the parish's: name and sort_order come from layer 2. A
//   parish calling 4220 "Offerings" instead of "Sacramental Fees" costs
//   the roll-up nothing.
//
// An unaffiliated parish sees exactly what it saw before: template
// overridden by its own rows, all columns.
//
// THIS LIVES IN ONE PLACE ON PURPOSE. It was briefly duplicated between
// routes/finance.js and finance/periodTotals.js, and the copies drifted:
// the display honoured the diocese while the MONEY did not, so a parish's
// chart of accounts said "not assessable" and its assessable base counted
// the revenue anyway. A resolver that decides what is assessable is not a
// thing to have two of.
export const EFFECTIVE_COA = `
  WITH aff AS (
    SELECT diocese_org_id
      FROM ochr_diocese_affiliations
     WHERE parish_org_id = $1 AND status = 'active'
     LIMIT 1
  ),
  layered AS (
    SELECT code, name, acct_type, rollup_group, assessable, sort_order, active,
           organization_id,
           CASE WHEN organization_id = $1        THEN 2
                WHEN organization_id IS NOT NULL THEN 1
                ELSE 0 END AS layer
      FROM ochr_coa_accounts
     WHERE organization_id IS NULL
        OR organization_id = $1
        OR organization_id = (SELECT diocese_org_id FROM aff)
  ),
  wording AS (
    SELECT DISTINCT ON (code) code, name, sort_order, organization_id, layer
      FROM layered ORDER BY code, layer DESC
  ),
  -- Structure normally ignores the parish (layer 2) — that is the whole
  -- point. But "ignore layer 2" is only right when something ABOVE it is
  -- actually speaking, and there are two cases where nothing is:
  --
  --   · No diocese is attached. Capping at layer 1 here would hand an
  --     UNAFFILIATED parish the bare template and silently discard its own
  --     assessable/active/acct_type — the opposite of this module's
  --     contract, and a money bug: assessable feeds the assessable base.
  --   · The code exists ONLY as a parish row. Nothing at layer 0 or 1
  --     defines it, so capping at 1 leaves structure with no row at all
  --     and the JOIN below drops the account out of the parish's chart of
  --     accounts, its ledger validation and its totals entirely.
  --
  -- In both cases the parish's own row is the only authority available, so
  -- it wins. Where a diocese HAS defined the code, layer 2 still loses.
  structure AS (
    SELECT DISTINCT ON (code) code, acct_type, rollup_group, assessable, active, layer
      FROM layered
     WHERE layer <= 1
        OR NOT EXISTS (SELECT 1 FROM aff)
        OR code NOT IN (SELECT code FROM layered WHERE layer <= 1)
     ORDER BY code, layer DESC
  )
  SELECT w.code, w.name, s.acct_type, s.rollup_group, s.assessable,
         w.sort_order, s.active,
         (w.organization_id IS NOT NULL) AS customized,
         (s.layer = 1) AS structure_from_diocese
    FROM wording w JOIN structure s USING (code)
`
