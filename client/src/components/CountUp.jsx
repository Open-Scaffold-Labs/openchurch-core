// Quiet craft 2: amounts render their final value immediately.
//
// The V1.4 count-up (study #14) animated a total after a change the user
// just made. Jarvis's quiet-craft review and the login promise ("Nothing
// here blinks, counts, or competes for your attention") ask that animated
// metrics go. This component remains as a thin formatter so call sites that
// still import it stay honest without counting.

export function useCountTo(target) {
  return Number(target)
}

export default function CountUp({ value, format = (n) => String(n) }) {
  const n = Number(value)
  return <>{format(Number.isFinite(n) ? n : value)}</>
}
