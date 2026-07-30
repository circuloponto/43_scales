// User-defined scales of any size (pentatonics, 7-note modes, etc.), kept
// separate from the 43 hand-authored 8-note scales in scales.js. They share the
// same shape the rest of the app consumes — { id, notes } — plus:
//   - kind: 'custom'   marks them so id-keyed art/tables (glyphs, rootSteps,
//                       chordPairs) are never indexed for them
//   - name             user label (there is no bespoke glyph)
//   - rootStep         1-indexed position into `notes` of the intrinsic root,
//                       the direct analogue of rootSteps[id-1] for built-ins
//
// IDs are STRINGS (`custom-<n>`) so `rootSteps[id-1]` / `glyphs[id-1]` resolve
// to undefined/NaN (already guarded) and can never collide with ids 1..48.

const STORAGE_KEY = 'eightFold.customScales'

const isPitchClass = (n) => Number.isInteger(n) && n >= 0 && n <= 11

// Accept only well-formed entries so a corrupt localStorage blob can't crash
// the app; coerce/repair the fields we can.
function sanitize(entry) {
  if (!entry || typeof entry !== 'object') return null
  const notes = Array.isArray(entry.notes)
    ? [...new Set(entry.notes.filter(isPitchClass))].sort((a, b) => a - b)
    : []
  if (notes.length < 2) return null
  const id =
    typeof entry.id === 'string' && entry.id ? entry.id : `custom-${Date.now()}`
  const rootStep =
    Number.isInteger(entry.rootStep) &&
    entry.rootStep >= 1 &&
    entry.rootStep <= notes.length
      ? entry.rootStep
      : 1
  const name =
    typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : 'Custom scale'
  return { id, name, notes, rootStep, kind: 'custom' }
}

export function loadCustomScales() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.map(sanitize).filter(Boolean)
  } catch {
    return []
  }
}

export function saveCustomScales(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list || []))
  } catch {}
}

// Unique-enough string id for a new custom scale.
export function newCustomScaleId() {
  return `custom-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

export const isCustomScale = (s) => !!s && s.kind === 'custom'
