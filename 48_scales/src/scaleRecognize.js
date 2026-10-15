// Name the scale behind a list of notes — pure, no React.
//
// A scale in the app is (scaleId, root, modeStep): `root` is the pitch class of
// the degree that acts as the scale's root, `modeStep` (1-based, or null for the
// scale's own default) says WHICH degree that is. scaleContext.js builds the
// pitch classes as  (note - notes[modeStep-1]) + root. Recognition inverts that:
// the first note typed is taken as the root, and every (scale, degree) whose
// pitch-class set equals the typed set is a match.

import { rootSteps } from './scales'

// The degree (1-based) that is the root of a scale by default.
export const defaultRootStep = (raw) => raw.rootStep ?? rootSteps[raw.id - 1] ?? 1

const idOrder = (id) => (typeof id === 'number' ? id : 1000)

// pcsInOrder: pitch classes in the order typed (first = the root the user means).
// scales: built-in + custom scale objects { id, notes, rootStep? }.
// Returns [{ scaleId, root, modeStep, degree }], default-mode matches first.
export function recognizeScale(pcsInOrder, scales) {
  if (!pcsInOrder.length) return []
  const firstPc = pcsInOrder[0]
  const set = new Set(pcsInOrder)
  const out = []
  for (const s of scales) {
    if (s.notes.length !== set.size) continue
    const def = defaultRootStep(s)
    for (let k = 1; k <= s.notes.length; k++) {
      const pivot = s.notes[k - 1]
      let ok = true
      for (const n of s.notes) {
        if (!set.has((((n - pivot + firstPc) % 12) + 12) % 12)) {
          ok = false
          break
        }
      }
      if (ok) out.push({ scaleId: s.id, root: firstPc, modeStep: k === def ? null : k, degree: k })
    }
  }
  return out.sort(
    (a, b) =>
      (a.modeStep === null ? 0 : 1) - (b.modeStep === null ? 0 : 1) ||
      idOrder(a.scaleId) - idOrder(b.scaleId) ||
      a.degree - b.degree
  )
}
