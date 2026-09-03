import { Loader2 } from 'lucide-react'
import LoadFailure from './LoadFailure'

// The four states, rendered in one place, so a page cannot reach the wrong
// one. (Pass 9 §7–§8)
//
// THE FOOT-GUN THIS REMOVES. `useLoad().data` is null until the first
// successful read. A caller that renders its list branch while the load is
// still in flight writes `data.map(...)` against null — which is exactly what
// happened on the register record page, where the record resolved before its
// history and the page died with "Cannot read properties of null".
//
// WHY NOT JUST DEFAULT data TO []. Because the crash is the honest half of
// the problem. With null, a caller who branches on `data.length` instead of
// `state` gets a loud failure. With [], the same caller silently renders
// "nothing here" WHILE STILL LOADING — a lie, and the exact collapse of
// LOADING into EMPTY this project spent three passes removing. Trading a
// crash for a quiet falsehood is not a safety improvement.
//
// So `data` keeps its semantics and the RENDER gets the guard instead: the
// `ready` branch is unreachable unless a successful read has happened, and
// `empty` is unreachable unless that read came back with nothing. Neither is
// a discipline a caller has to remember.
//
//   <LoadState load={bulletins} empty={<EmptyState … />}>
//     {rows => rows.map(...)}
//   </LoadState>
//
// `children` is a function on purpose. A plain node would be evaluated by the
// caller before this component could decide anything, which puts `data.map`
// back in the caller's hands during loading and returns the whole problem.
export default function LoadState({
  load,
  empty = null,
  failure,          // override the default failure block
  variant = 'strip',
  idle = null,
  loading,          // override the default spinner
  children,
}) {
  if (load.state === 'idle')    return idle
  if (load.state === 'loading') {
    return loading ?? (
      <div className="flex justify-center py-8">
        <Loader2 size={18} className="animate-spin text-brass-600" aria-hidden="true" />
      </div>
    )
  }
  if (load.state === 'failed') {
    return failure ?? (
      <LoadFailure variant={variant} cause={load.error}
        onRetry={load.reload} retrying={load.retrying} />
    )
  }

  // From here the read succeeded, so `data` is real. A stale strip sits ABOVE
  // the data rather than replacing it: what is on screen is older than the
  // truth, which is a fact worth showing, not a reason to hide it.
  const body = load.state === 'empty' ? empty : children(load.data)
  if (!load.isStale) return body
  return (
    <>
      <LoadFailure variant="strip" cause={load.error}
        onRetry={load.reload} retrying={load.retrying} className="mb-3" />
      {body}
    </>
  )
}
