/**
 * @openscaffold/scheduling — Firehouse Kelly Shift Rotations (24/48 and 48/96)
 * and Landscape Crew Rain-Delay Bulk Cascade Rescheduler.
 */

/**
 * Generates A/B/C platoon shift schedule for 24/48 or 48/96 firehouse cycles.
 *  - 24/48 cycle: 3-day repeating pattern (A, B, C)
 *  - 48/96 cycle: 6-day repeating pattern (A, A, B, B, C, C)
 */
function generateKellyShiftRotation({
  orgId,
  startDateStr,
  days = 14,
  pattern = '48_96', // '24_48' or '48_96'
  shiftStartHourUtc = 14, // 07:00 AM PT
}) {
  const platoons = pattern === '24_48' ? ['A', 'B', 'C'] : ['A', 'A', 'B', 'B', 'C', 'C'];
  const baseMs = new Date(`${startDateStr}T${String(shiftStartHourUtc).padStart(2, '0')}:00:00Z`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const schedule = [];

  for (let d = 0; d < days; d++) {
    const startIso = new Date(baseMs + d * dayMs).toISOString();
    const endIso = new Date(baseMs + (d + 1) * dayMs).toISOString();
    const platoon = platoons[d % platoons.length];
    schedule.push({
      org_id: orgId,
      day_index: d,
      platoon_or_team: platoon,
      shift_kind: pattern === '24_48' ? 'kelly_24_48' : 'kelly_48_96',
      starts_at: startIso,
      ends_at: endIso,
      shift_range: `[${startIso},${endIso})`,
    });
  }
  return schedule;
}

/**
 * Rain-delay bulk cascade rescheduler for field crews (e.g., Open Landscape Business).
 * Shifts all non-completed crew bookings on or after `fromDateIso` forward by `shiftDays`,
 * automatically skipping Sundays if `skipSundays` is true.
 */
function rescheduleCascade(bookings = [], { fromDateIso, shiftDays = 1, skipSundays = true }) {
  const thresholdMs = new Date(fromDateIso).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  return bookings.map(b => {
    const startMs = new Date(b.starts_at).getTime();
    const endMs = new Date(b.ends_at).getTime();
    if (startMs < thresholdMs || b.status === 'completed' || b.status === 'canceled') {
      return { ...b, cascaded: false };
    }
    let newStartMs = startMs + shiftDays * dayMs;
    let newEndMs = endMs + shiftDays * dayMs;
    if (skipSundays && new Date(newStartMs).getUTCDay() === 0) {
      newStartMs += dayMs;
      newEndMs += dayMs;
    }
    return {
      ...b,
      starts_at: new Date(newStartMs).toISOString(),
      ends_at: new Date(newEndMs).toISOString(),
      cascaded: true,
    };
  });
}

module.exports = {
  generateKellyShiftRotation,
  rescheduleCascade,
};
