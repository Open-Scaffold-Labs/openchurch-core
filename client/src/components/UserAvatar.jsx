import { initials } from '../utils/format'

// Renders a person's avatar — the uploaded image when one exists,
// otherwise the brand-burgundy initials circle the app has always
// used. Shared by the header profile menu, the avatar uploader's
// own preview, and member rows, so the image/initials fallback logic
// lives in exactly one place.
//
// Props:
//   avatar        — base64 data URL (or null/undefined → initials)
//   name          — used for the initials fallback + alt text
//   className     — Tailwind sizing, e.g. "w-8 h-8" (default w-8 h-8)
//   textClassName — initials font size, e.g. "text-xs" (default)

export default function UserAvatar({
  avatar,
  name,
  className = 'w-8 h-8',
  textClassName = 'text-xs',
}) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name ? `${name}'s profile picture` : 'Profile picture'}
        className={`${className} rounded-full object-cover shadow-warm shrink-0`}
      />
    )
  }
  return (
    <div
      className={`${className} ${textClassName} rounded-full bg-church-900 dark:bg-brass-200 flex items-center justify-center text-brass-200 dark:text-church-900 font-bold shadow-warm shrink-0`}
      aria-hidden="true"
    >
      {initials(name) || 'OC'}
    </div>
  )
}
