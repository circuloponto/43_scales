// Semitone offsets from the chord's root. Every chord here is a 4-note voicing.
//
// Edit by hand to add or refine voicings used in src/chordPairs.js.

export const CHORD_INTERVALS = {
  'Diminished':   [0, 3, 6, 9],   // fully diminished 7th
  'Dominant':     [0, 4, 7, 10],  // dom 7
  'Min 7':        [0, 3, 7, 10],
  'Min7b5':       [0, 3, 6, 10],  // half-diminished
  '7b5':          [0, 4, 6, 10],
  '7#5':          [0, 4, 8, 10],
  'Sus 2&4':      [0, 2, 5, 7],
  'Add 9':        [0, 2, 4, 7],
  'Major 7':      [0, 4, 7, 11],
  'Min add 11':   [0, 3, 5, 7],
  'Dom 9 no 5':   [0, 2, 4, 10],  // whole-tone cluster
  'Aug7sus2':     [0, 2, 4, 6],   // 0, 2, 3, #4 in scale-degree notation
  // Short-form aliases for the names used in your source list:
  'dim7':         [0, 3, 6, 9],
  'min7':         [0, 3, 7, 10],
  'min7b5':       [0, 3, 6, 10],
  'sus2&4':       [0, 2, 5, 7],
  'Add9':         [0, 2, 4, 7],
  'MinAdd11':     [0, 3, 5, 7],
  '7':            [0, 4, 7, 10],
  'dom7':         [0, 4, 7, 10],
}

// Distance column → semitones between left and right chord roots.
export const INTERVAL_SEMITONES = {
  'Half Step':    1,
  'Whole Step':   2,
  'Min 3rd':      3,
  'Maj 3rd':      4,
  'Perfect 4th':  5,
  'Tritone':      6,
  'Perfect 5th':  7,
  'Maj 6th':      9,
  'Min 7':        10,
  'minor 7th':    10,
  'Major7':       11,
}

const NOTE_NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const NOTE_NAMES_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

// Rotation-aware resolver. The scale is first rotated so that `rootStep`
// (1-indexed scale degree) becomes the new pc 0 — i.e., the scale is
// re-expressed relative to its intrinsic root. Then every note of the
// rotated scale is tried as the LEFT chord's root; the first one where
// both chord shapes' notes lie inside the rotated scale wins. Returned
// pitches are transposed by the user-picked `root`.
export function resolveChordPair(pair, scaleNotes, root, rootStep) {
  const leftShape = CHORD_INTERVALS[pair.left]
  const rightShape = CHORD_INTERVALS[pair.right]
  const distance = INTERVAL_SEMITONES[pair.distance]
  if (!leftShape || !rightShape || distance == null) return null

  const intrinsicPc =
    rootStep && rootStep >= 1 && rootStep <= scaleNotes.length
      ? scaleNotes[rootStep - 1]
      : 0
  const rotated = scaleNotes.map((n) => (n - intrinsicPc + 12) % 12)
  const scaleSet = new Set(rotated)

  for (const candidate of rotated) {
    const leftNotes = leftShape.map((o) => (candidate + o) % 12)
    const rightRel = (candidate + distance) % 12
    const rightNotes = rightShape.map((o) => (rightRel + o) % 12)
    if (![...leftNotes, ...rightNotes].every((pc) => scaleSet.has(pc))) continue
    return {
      leftRoot: (candidate + root) % 12,
      rightRoot: (rightRel + root) % 12,
      leftNotes: leftNotes.map((pc) => (pc + root) % 12),
      rightNotes: rightNotes.map((pc) => (pc + root) % 12),
    }
  }
  return null
}

export function pcName(pc, useFlats = false) {
  const idx = ((pc % 12) + 12) % 12
  return (useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[idx]
}
