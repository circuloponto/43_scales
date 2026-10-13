// Everything the piano roll needs to know about ONE scale at ONE root, bundled
// so the roll can hold several (one per scale zone) and look them up by beat.
//
// This is the logic that used to sit inline in PianoRoll.jsx, moved here
// unchanged: rotate the scale so its intrinsic-root degree sits at pc 0, test
// membership, colour by the scale's chord pair, and convert between MIDI notes
// and "scale steps" (global index = octave * scaleSize + degree).

import { rootSteps } from './scales'
import { chordPairs } from './chordPairs'
import { resolveChordPair } from './chordVocab'

export const MIDI_LOW = 21 // A0
export const MIDI_HIGH = 108 // C8

// rawScale: { id, notes, rootStep? }; root: 0-11; modeStep: optional 1-based
// intrinsic-root override (an explicit mode pick wins over the scale's own).
// Returns null when there is no scale.
export function makeScaleContext(rawScale, root, modeStep = null) {
  if (!rawScale) return null

  // Intrinsic root degree: an explicit mode pick wins; else the scale's own
  // rootStep (custom scales carry it) or the built-in rootSteps table.
  const rootStep = modeStep ?? rawScale.rootStep ?? rootSteps[rawScale.id - 1]
  const intrinsicPc = rootStep ? rawScale.notes[rootStep - 1] : 0
  // Rotated + sorted ascending so scale.notes[i] is the i-th degree in pitch
  // order; the step helpers rely on that for monotone step indices.
  const scale = {
    ...rawScale,
    notes: rawScale.notes
      .map((n) => (n - intrinsicPc + 12) % 12)
      .sort((a, b) => a - b),
  }

  const inScale = (pc) => scale.notes.some((n) => (n + root) % 12 === pc)

  // Chord-pair membership for colouring. resolveChordPair wants the UNROTATED
  // notes (it rotates by rootStep itself), so feed it rawScale.notes.
  const pair = chordPairs.find((p) => p.scaleId === rawScale.id) || null
  const resolved = pair ? resolveChordPair(pair, rawScale.notes, root, rootStep) : null
  const leftChordPcs = new Set(resolved ? resolved.leftNotes : [])
  const rightChordPcs = new Set(resolved ? resolved.rightNotes : [])
  const chordClassFor = (pc) => {
    const inL = leftChordPcs.has(pc)
    const inR = rightChordPcs.has(pc)
    if (inL && inR) return 'chord-both'
    if (inL) return 'chord-left'
    if (inR) return 'chord-right'
    if (!inScale(pc)) return 'chord-electron'
    return ''
  }

  // MIDI value (assumed on-scale) -> global scale step = octave * n + degree.
  // Monotone in MIDI, so subtracting two steps gives the number of scale steps
  // between the pitches. null when the pitch is not in the scale.
  const midiToScaleStep = (midi) => {
    const pc = ((midi % 12) + 12) % 12
    const n = scale.notes.length
    for (let s = 0; s < n; s++) {
      if ((((scale.notes[s] + root) % 12) + 12) % 12 === pc) {
        const total = scale.notes[s] + root
        const wrap = Math.floor(total / 12)
        const baseMidi = ((total % 12) + 12) % 12
        const oct = (midi - baseMidi) / 12 - wrap
        return oct * n + s
      }
    }
    return null
  }

  // Inverse of midiToScaleStep. Accepts any integer (negative or overflowing).
  const scaleStepToMidi = (idx) => {
    const n = scale.notes.length
    const s = ((idx % n) + n) % n
    const oct = Math.floor((idx - s) / n)
    const total = scale.notes[s] + root
    const wrap = Math.floor(total / 12)
    const baseMidi = ((total % 12) + 12) % 12
    return baseMidi + (oct + wrap) * 12
  }

  // Snap a MIDI value to the nearest pitch that belongs to the scale.
  const nearestScaleMidi = (midi) => {
    const clamped = Math.max(MIDI_LOW, Math.min(MIDI_HIGH, midi))
    if (inScale(clamped % 12)) return clamped
    for (let d = 1; d < 12; d++) {
      if (clamped + d <= MIDI_HIGH && inScale((clamped + d) % 12)) return clamped + d
      if (clamped - d >= MIDI_LOW && inScale((((clamped - d) % 12) + 12) % 12)) {
        return clamped - d
      }
    }
    return clamped
  }

  return {
    rawScale,
    scale,
    root,
    rootStep,
    pair,
    resolved,
    leftChordPcs,
    rightChordPcs,
    inScale,
    chordClassFor,
    midiToScaleStep,
    scaleStepToMidi,
    nearestScaleMidi,
  }
}
