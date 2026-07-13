// Guitar chord-voicing engine for the 8-note-scale chord pairs.
//
// Each scale resolves (via resolveChordPair) to two 4-note tetrads given as
// pitch classes in root-3rd-5th-7th order. This module turns one tetrad into a
// list of concrete, playable guitar voicings — close position plus the three
// "drop" families — laid across the standard string sets, in every inversion,
// ready to draw on a fretboard and to sound.

// Standard tuning, LOW string → HIGH string (6th..1st) as MIDI open pitches.
// (Fretboard.jsx keeps a high→low copy; low→high is cleaner for the math here.)
export const TUNING = [40, 45, 50, 55, 59, 64] // E A D G B e
export const STRING_LABELS = ['E', 'A', 'D', 'G', 'B', 'e']
export const FRETS = 24

// A span (max fret − min fret) of 4 means the notes sit inside a 5-fret window
// — the comfortable "one finger per fret" reach. Anything wider is a stretch;
// past a family's cap it's dropped as unplayable. Drop 2 & 4 voicings are
// inherently wide (their minimum span is 5), so that family gets a looser cap.
const COMFORT_SPAN = 4

// Which string sets each family lives on. Indices are into TUNING (low→high).
// Drop 2 / Drop 2&4 / Close use 4 ADJACENT strings; Drop 3 skips the string
// just above the bass (classic 6-4-3-2 and 5-3-2-1 shapes).
const ADJACENT_SETS = [
  [0, 1, 2, 3],
  [1, 2, 3, 4],
  [2, 3, 4, 5],
]
const DROP3_SETS = [
  [0, 2, 3, 4],
  [1, 3, 4, 5],
]
export const FAMILIES = [
  { type: 'close', label: 'Close', sets: ADJACENT_SETS, maxSpan: 4 },
  { type: 'drop2', label: 'Drop 2', sets: ADJACENT_SETS, maxSpan: 4 },
  { type: 'drop3', label: 'Drop 3', sets: DROP3_SETS, maxSpan: 4 },
  { type: 'drop24', label: 'Drop 2 & 4', sets: ADJACENT_SETS, maxSpan: 5 },
]

const INV_LABELS = ['root', '1st inv', '2nd inv', '3rd inv']

// Label a string set the guitarist's way: index 0 = 6th string … 5 = 1st.
const setLabel = (set) => set.map((i) => 6 - i).join('-')

// Close voicing for a given inversion: rotate the tetrad so the inversion's
// bass is first, then stack ascending into MIDI near C3 (MIDI 48).
function buildClose(tones, inv) {
  const rotated = [...tones.slice(inv), ...tones.slice(0, inv)]
  const midis = []
  const base = 48
  for (let i = 0; i < 4; i++) {
    let m = base + rotated[i] // rotated[i] is 0..11 → m in 48..59
    while (i > 0 && m <= midis[i - 1]) m += 12
    midis.push(m)
  }
  return midis
}

// Apply a drop transform to a close voicing (ascending [c0,c1,c2,c3]). Dropping
// a voice = lowering it an octave; top-to-bottom is [c3,c2,c1,c0]. Returns the
// four ACTUAL pitches (MIDI) re-sorted ascending — low→high across the set.
function applyDrop(close, type) {
  const [c0, c1, c2, c3] = close
  let notes
  switch (type) {
    case 'drop2':
      notes = [c0, c1, c2 - 12, c3]
      break
    case 'drop3':
      notes = [c0, c1 - 12, c2, c3]
      break
    case 'drop24':
      notes = [c0 - 12, c1, c2 - 12, c3]
      break
    default: // close
      notes = [c0, c1, c2, c3]
  }
  return notes.slice().sort((a, b) => a - b)
}

// Lay the four ascending voicing pitches onto a string set (low→high), one per
// string, keeping their true intervals. The whole shape is shifted by octaves
// so its lowest fret sits in [0,11] (lowest neck position) — this preserves the
// pitch classes AND the fret span, so the shape is the real, playable voicing.
function placeOnStringSet(set, vMidis) {
  const raw = set.map((s, i) => vMidis[i] - TUNING[s])
  const minRaw = Math.min(...raw)
  const k = Math.floor(minRaw / 12) // octaves to bring min fret into [0,11]
  return raw.map((f) => f - 12 * k)
}

// Build every PLAYABLE voicing of one tetrad. `tones` = [root,3rd,5th,7th]
// pitch classes (absolute, already transposed by root). `rootPc` marks the
// chord root for highlighting. Returns a flat list ordered family → set →
// inversion, with unplayable (over-stretched) shapes filtered out.
export function buildVoicings(tones, rootPc) {
  if (!tones || tones.length !== 4) return []
  const out = []
  for (const fam of FAMILIES) {
    for (const set of fam.sets) {
      const group = []
      for (let rot = 0; rot < 4; rot++) {
        const close = buildClose(tones, rot)
        const vMidis = applyDrop(close, fam.type)
        const frets = placeOnStringSet(set, vMidis)
        const maxFret = Math.max(...frets)
        const minFret = Math.min(...frets)
        const span = maxFret - minFret
        if (span > fam.maxSpan || maxFret > FRETS) continue // not realistically playable
        const placements = set.map((si, i) => {
          const pc = (((TUNING[si] + frets[i]) % 12) + 12) % 12
          return {
            stringIndex: si,
            fret: frets[i],
            pc,
            midi: TUNING[si] + frets[i],
            isRoot: pc === rootPc,
          }
        })
        const mutedStrings = [0, 1, 2, 3, 4, 5].filter((s) => !set.includes(s))
        // Inversion is named by the ACTUAL bass note's chord degree (0=root,
        // 1=3rd, 2=5th, 3=7th) — for drop voicings the dropped voice becomes the
        // bass, so this differs from the close-stack rotation index `rot`.
        const bassPc = placements[0].pc
        const inversion = tones.indexOf(bassPc)
        group.push({
          id: `${fam.type}-${setLabel(set)}-${inversion}`,
          type: fam.type,
          typeLabel: fam.label,
          inversion,
          invLabel: INV_LABELS[inversion] ?? `inv ${inversion}`,
          stringSet: set,
          stringSetLabel: setLabel(set),
          placements,
          mutedStrings,
          minFret,
          maxFret,
          span,
          stretch: span > COMFORT_SPAN,
          midis: placements.map((p) => p.midi),
        })
      }
      // Present each string set root → 1st → 2nd → 3rd inversion.
      group.sort((a, b) => a.inversion - b.inversion)
      out.push(...group)
    }
  }
  return out
}
