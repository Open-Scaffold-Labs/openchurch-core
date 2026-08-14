// Calm button (P8). This USED to apply hover-scale — a direct
// OPERATOR violation ("hover motion of any kind") that put startup
// jitter on every primary button in the app. Hover is now what the
// Constitution asks for everywhere else: a color/border shift only,
// supplied by each call site's classes. The component stays (dozens of
// call sites) but is a plain button; the name is historical.
export default function AnimatedButton({ children, className = '', onClick, type = 'button', disabled = false }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`transition-colors duration-200 ${className}`}
    >
      {children}
    </button>
  )
}
