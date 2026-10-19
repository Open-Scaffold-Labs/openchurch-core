import { useId } from 'react'

// TextField — single-line input primitive with label, optional leading
// icon, optional trailing element, hint, and error state. Hand-rolled
// rather than reaching for a form library because every form in
// OpenChurch is small and the primitive only has to cover the shapes
// we actually use:
//
//   <TextField label="Email" type="email" leadingIcon={Mail} value={…} onChange={…} />
//   <TextField label="Password" leadingIcon={Lock} trailing={<button …>eye</button>} … />
//   <TextField label="Email" error="That email isn't recognized" … />
//   <TextField label="Org name" hint="Public — shown to your team" … />
//
// Everything not destructured below is passed through to the <input>,
// so type / required / autoComplete / placeholder / pattern / etc just
// work.
//
// Color discipline: bg-parchment-50 / dark:bg-ink-800, parchment-300/70
// border, brass-400 focus ring. Error state swaps border + ring to
// rose-400 so it's visible without changing the input layout.
export default function TextField({
  label,
  leadingIcon: LeadingIcon,
  trailing,
  hint,
  error,
  className = '',
  inputClassName = '',
  id: providedId,
  ...inputProps
}) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  const hintId  = hint  ? `${id}-hint`  : undefined
  const errorId = error ? `${id}-error` : undefined

  const ringCls = error
    ? 'focus:ring-2 focus:ring-rose-400 border-rose-300 dark:border-rose-700/60'
    : 'focus:ring-2 focus:ring-brass-400 border-parchment-300/70 dark:border-brass-900/40'

  // pl-9 only when leading icon is present; pr-10 only when trailing
  // element is present. Default padding is pl-3 pr-3.
  const padCls = [
    LeadingIcon ? 'pl-9' : 'pl-3',
    trailing    ? 'pr-10' : 'pr-3',
  ].join(' ')

  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        {LeadingIcon && (
          <LeadingIcon
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-400/60 pointer-events-none"
          />
        )}
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
          className={`w-full ${padCls} py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none transition-shadow ${ringCls} ${inputClassName}`}
          {...inputProps}
        />
        {trailing && (
          <div className="textfield-trailing absolute right-3 top-1/2 -translate-y-1/2 flex items-center">
            {trailing}
          </div>
        )}
      </div>
      {error ? (
        <p id={errorId} className="mt-1.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
