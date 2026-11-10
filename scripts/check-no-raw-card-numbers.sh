#!/usr/bin/env bash
# Vendored from Open-Scaffold-Labs/openscaffold-core at
# a7939e565bacbeee48e6f404ca0a3fc7f394c842 (openscaffold-core #28).
# Script body is otherwise unchanged.
# STD-49 CI guard (ADOPTED 2026-11-10): fail if tracked files contain a full card number
# or a server-side "create a card" call with card details.
# Usage: check-no-raw-card-numbers.sh [path ...]
# Exit 0 if clean, 1 if hits, 2 if the checker itself failed.
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "check-no-raw-card-numbers.sh: python3 is required" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OSL_CARD_GUARD_ROOT="${HERE}"
exec python3 - "$@" << 'PY'
import os, re, sys
from pathlib import Path

ALLOW_MARK = "osl-allow-test-pan"
# Unix-ms timestamps are 13 digits (Sept 2001–May 2033 for this window).
# Skip bare 13-digit numbers in that range unless they use card-like grouping.
TS_MIN = 1_000_000_000_000
TS_MAX = 2_000_000_000_000

# Pattern checks (card[number], *.create with card details) run on source/test
# files only. Markdown and this script may name the forbidden patterns. Full
# card numbers are still flagged in every scanned text file.
DOC_EXT = {".md", ".markdown", ".txt", ".rst", ".adoc"}
SELF_NAMES = {"check-no-raw-card-numbers.sh", "std-49-no-raw-card-numbers.yml"}

SKIP_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".woff", ".woff2", ".eot", ".ttf", ".otf",
    ".mp3", ".mp4", ".mov", ".webm", ".wav", ".m4a",
    ".wasm", ".bin", ".exe", ".dll", ".so", ".dylib", ".class", ".jar",
    ".pyc", ".pyo", ".o", ".a",
}

MAX_BYTES = 2_000_000

# Maximal runs of digits with optional spaces or dashes between them.
# A slice of a longer run (for example a 32-digit dashed UUID) is not a card.
PAN_RUN = re.compile(r"\d(?:[ \t-]*\d)*")

# Typical written card groupings. Arbitrary space-separated numbers (SVG paths,
# coordinates) are not treated as cards even if a Luhn check would pass.
CARD_GROUPS = {
    (4, 4, 4, 4),       # 16-digit, the usual printed form
    (4, 4, 4, 4, 3),    # 19-digit
    (4, 6, 5),          # 15-digit (Amex)
    (4, 6, 4),          # 14-digit (Diners)
    (4, 4, 5),          # 13-digit
    (4, 3, 3, 3),       # 13-digit
}

# Server-side card-create entry points.
CREATE_CALL = re.compile(
    r"\b(?:paymentMethods|payment_methods|tokens|sources)\s*\.\s*create\b",
    re.I,
)
CARD_NUMBER_FIELD = re.compile(
    r"card\s*\[\s*['\"]?number['\"]?\s*\]"
    r"|card\s*\[\s*['\"]number['\"]\s*\]"
    r"|\bcard\b[^.\n]{0,80}\bnumber\b"
    r"|\bnumber\b[^.\n]{0,80}\bcard\b",
    re.I,
)
CARD_BRACKET_NUMBER = re.compile(r"card\s*\[\s*['\"]?number['\"]?\s*\]", re.I)


def luhn_ok(digits: str) -> bool:
    if not digits.isdigit() or not (13 <= len(digits) <= 19):
        return False
    total = 0
    alt = False
    for ch in reversed(digits):
        n = ord(ch) - 48
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def looks_like_unix_ms(digits: str, raw: str) -> bool:
    if len(digits) != 13:
        return False
    if any(c in raw for c in " -"):
        return False
    try:
        n = int(digits)
    except ValueError:
        return False
    return TS_MIN <= n <= TS_MAX


# Date-stamped migration / wizard identifiers: 20YYMMDDHHMM, optional
# seconds, and any trailing digits. Also matches the number inside
# names like 20YYMMDDHHMMSS_*.sql.
MIGRATION_TS = re.compile(
    r"^20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d(?:[0-5]\d)?\d*$"
)

def looks_like_migration_timestamp(digits: str) -> bool:
    if len(digits) < 12:
        return False
    return MIGRATION_TS.fullmatch(digits) is not None


def looks_like_decimal_fraction(line: str, start: int) -> bool:
    # Fractional part of a decimal (map coordinates, sRGB components).
    return start > 0 and line[start - 1] == "."


HEX_CHARS = set("0123456789abcdefABCDEF")
MIN_HEX_BLOB = 24


def looks_like_hex_blob(line: str, start: int, end: int) -> bool:
    # Digit run inside a long hex token (PNG bytes, CRC / sha256 fingerprints).
    i, j = start, end
    while i > 0 and line[i - 1] in HEX_CHARS:
        i -= 1
    while j < len(line) and line[j] in HEX_CHARS:
        j += 1
    blob = line[i:j]
    if len(blob) < MIN_HEX_BLOB:
        return False
    return any(c in "abcdefABCDEF" for c in blob)


def is_redaction_placeholder(text: str) -> bool:
    # Sentry-style "card [number]" (space, unquoted). Not card[number] / card['number'].
    return re.fullmatch(r"card\s+\[\s*number\s*\]", text.strip(), re.I) is not None


def git_tracked(root: Path):
    import subprocess
    try:
        out = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-z"],
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    files = [root / p for p in out.decode("utf-8", "replace").split("\0") if p]
    return files


def iter_files(roots):
    seen = set()
    for raw in roots:
        root = Path(raw).resolve()
        if not root.exists():
            print(f"check-no-raw-card-numbers: path not found: {root}", file=sys.stderr)
            sys.exit(2)
        if root.is_file():
            key = str(root)
            if key not in seen:
                seen.add(key)
                yield root, root.parent
            continue
        tracked = git_tracked(root) if (root / ".git").exists() or _in_git(root) else None
        if tracked is not None:
            candidates = tracked
        else:
            candidates = []
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d != ".git" and d != "node_modules"]
                for fn in filenames:
                    candidates.append(Path(dirpath) / fn)
        for fp in candidates:
            if not fp.is_file():
                continue
            key = str(fp.resolve()) if fp.exists() else str(fp)
            if key in seen:
                continue
            seen.add(key)
            yield fp, root


def _in_git(path: Path) -> bool:
    import subprocess
    try:
        subprocess.check_output(
            ["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"],
            stderr=subprocess.DEVNULL,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def pattern_scan(fp: Path) -> bool:
    if fp.name in SELF_NAMES:
        return False
    if fp.suffix.lower() in DOC_EXT:
        return False
    return True


def should_skip(fp: Path) -> str | None:
    if fp.suffix.lower() in SKIP_EXT:
        return "binary-extension"
    try:
        st = fp.stat()
    except OSError:
        return "unreadable"
    if st.st_size > MAX_BYTES:
        return "too-large"
    return None


def read_text(fp: Path):
    try:
        data = fp.read_bytes()
    except OSError:
        return None, "unreadable"
    if b"\x00" in data[:8192]:
        return None, "binary"
    return data.decode("utf-8", "replace"), None


def redact_pan(raw: str) -> str:
    digits = re.sub(r"\D", "", raw)
    if len(digits) <= 8:
        return "[redacted-number]"
    return digits[:4] + ("*" * (len(digits) - 8)) + digits[-4:]


def snippet(line: str, raw: str | None = None) -> str:
    s = line.strip()
    # Redact only card-like numbers, never every digit run (SVG paths, counts).
    pans = ([raw] if raw else []) + find_pan_hits(line)
    # Deduplicate while replacing longer first.
    for pan in sorted(set(pans), key=len, reverse=True):
        s = s.replace(pan, redact_pan(pan))
    if len(s) > 160:
        s = s[:157] + "..."
    return s


def card_like_grouping(raw: str, digits: str) -> bool:
    if not (13 <= len(digits) <= 19):
        return False
    groups = [g for g in re.split(r"[ \t-]+", raw.strip()) if g]
    if len(groups) == 1:
        return groups[0].isdigit()
    if not all(g.isdigit() for g in groups):
        return False
    return tuple(len(g) for g in groups) in CARD_GROUPS


def find_pan_hits(line: str):
    hits = []
    for m in PAN_RUN.finditer(line):
        raw = m.group(0)
        digits = re.sub(r"[ \t-]", "", raw)
        # Whole run only: do not test 13–19 digit slices of a longer identifier.
        if not (13 <= len(digits) <= 19):
            continue
        if looks_like_unix_ms(digits, raw):
            continue
        if looks_like_migration_timestamp(digits):
            continue
        if looks_like_decimal_fraction(line, m.start()):
            continue
        if looks_like_hex_blob(line, m.start(), m.end()):
            continue
        if not card_like_grouping(raw, digits):
            continue
        if luhn_ok(digits):
            hits.append(raw)
    return hits


def window_has_card_details(lines, start_idx, max_ahead=12):
    chunk = []
    for j in range(start_idx, min(len(lines), start_idx + max_ahead + 1)):
        chunk.append(lines[j])
        # Stop a window early at a blank line after we've started, if a closer looks done.
    text = "\n".join(chunk)
    return bool(CARD_NUMBER_FIELD.search(text) or CARD_BRACKET_NUMBER.search(text)), text


def scan_file(fp: Path, root: Path):
    reason = should_skip(fp)
    if reason:
        return []
    text, err = read_text(fp)
    if err or text is None:
        return []
    try:
        rel = fp.resolve().relative_to(root.resolve())
    except ValueError:
        rel = fp
    findings = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        allowed = ALLOW_MARK in line
        if not allowed:
            for raw in find_pan_hits(line):
                findings.append({
                    "file": str(rel),
                    "line": i + 1,
                    "kind": "full-card-number",
                    "snippet": snippet(line, raw),
                })
        if pattern_scan(fp) and not allowed:
            field_hits = [
                m for m in CARD_BRACKET_NUMBER.finditer(line)
                if not is_redaction_placeholder(m.group(0))
            ]
            if field_hits:
                findings.append({
                    "file": str(rel),
                    "line": i + 1,
                    "kind": "card[number]-field",
                    "snippet": snippet(line),
                })
        if pattern_scan(fp) and CREATE_CALL.search(line) and not allowed:
            has_details, _ = window_has_card_details(lines, i)
            # Allow if any line in the window has the marker and no other unallowed details? Marker is per-line.
            # If the create line is marked, skip. If details are on later unmarked lines, still flag those via PAN
            # or via this create-window check. Require the create line itself unmarked.
            if has_details:
                findings.append({
                    "file": str(rel),
                    "line": i + 1,
                    "kind": "server-side-card-create",
                    "snippet": snippet(line),
                })
    return findings


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print("Usage: check-no-raw-card-numbers.sh [path ...]")
        print("Scans git-tracked files (or all files if not a git work tree).")
        print("Allow a line with the comment marker: " + ALLOW_MARK)
        return 0
    roots = args or ["."]
    all_findings = []
    files_n = 0
    for fp, root in iter_files(roots):
        files_n += 1
        all_findings.extend(scan_file(fp, root))
    if all_findings:
        print(f"STD-49 card-data guard: {len(all_findings)} hit(s) in {files_n} file(s)")
        for f in all_findings:
            print(f"{f['file']}:{f['line']}: {f['kind']}: {f['snippet']}")
        print("Use Stripe test stand-ins (pm_card_visa, tok_visa) or collect cards only in the provider's form.")
        print(f"To allow a deliberate negative-test assertion, put {ALLOW_MARK} on that line.")
        return 1
    print(f"STD-49 card-data guard: clean ({files_n} file(s) scanned)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
