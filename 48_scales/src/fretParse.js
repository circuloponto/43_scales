// Reading and writing a hand-drawn chord shape as text — no dependencies, so
// both the note parser and the diagram code can use it without importing each
// other. A shape is 6 values, LOW string to HIGH string (E A D G B e):
//   null = muted (x),  0 = open,  n >= 1 = fretted at fret n.

export const STRING_COUNT = 6
export const MAX_FRET = 24

// "x 3 2 0 1 0" or "x,3,2,0,1,0" -> [null,3,2,0,1,0]; null if it is not a
// well-formed shape. Frets can be two digits, so values must be separated.
export function parseFrets(text) {
  const toks = String(text ?? '').trim().split(/[\s,]+/).filter(Boolean)
  if (toks.length !== STRING_COUNT) return null
  const out = []
  for (const t of toks) {
    if (/^[xX]$/.test(t)) out.push(null)
    else if (/^\d{1,2}$/.test(t) && Number(t) <= MAX_FRET) out.push(Number(t))
    else return null
  }
  return out
}

export const formatFrets = (frets) => frets.map((f) => (f == null ? 'x' : String(f))).join(' ')
