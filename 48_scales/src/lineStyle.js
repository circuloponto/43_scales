// Style model learned from the user's own templates — pure logic, no React.
//
// Idea: instead of a hand-curated library of lines, treat the melodic
// templates the user already saved as examples of how they like lines to move,
// and prefer generated variations that "sound like" them.
//
// What it learns: how often each interval (in scale steps) follows each other
// interval (a bigram), smoothed with the overall interval frequencies. A
// candidate line's cost is its average surprise (negative log-probability) under
// that model; lower cost = more like the user's lines.
//
// The model fades in with the amount of data: `weight` goes from 0 (no usable
// templates) to 1 (~150 intervals), so a small template set only nudges the
// generator and a large one steers it.

const CLIP = 7 // intervals beyond +-7 scale steps share one bucket each side
const SMOOTH = 2 // how strongly bigram rows lean on the overall frequencies
const FULL_WEIGHT_AT = 150 // intervals needed for the model to count fully

const clip = (d) => Math.max(-CLIP, Math.min(CLIP, d))
const BUCKETS = 2 * CLIP + 1

// A template counts as a melodic line if it has >= 4 notes and no two notes
// share a beat (chords and drop voicings are not lines).
function lineOf(template, scaleSize) {
  const notes = template && template.notes
  if (!Array.isArray(notes) || notes.length < 4) return null
  if (new Set(notes.map((n) => n.beat)).size !== notes.length) return null
  return [...notes]
    .sort((a, b) => a.beat - b.beat)
    .map((n) => (n.octave || 0) * scaleSize + n.degree)
}

// templateLists: arrays of templates (e.g. [liveTemplates, shippedDefaults]);
// duplicates are skipped by id. Returns { weight, cost(steps) } or null when
// there is nothing to learn from.
export function buildStyleModel(templateLists, scaleSize) {
  const seen = new Set()
  const lines = []
  for (const list of templateLists) {
    for (const t of list || []) {
      if (!t || t.type === 'folder' || seen.has(t.id)) continue
      seen.add(t.id)
      const steps = lineOf(t, scaleSize)
      if (steps) lines.push(steps)
    }
  }

  const uni = new Array(BUCKETS).fill(0)
  const bi = Array.from({ length: BUCKETS }, () => new Array(BUCKETS).fill(0))
  const rowTotal = new Array(BUCKETS).fill(0)
  let total = 0
  const idx = (d) => clip(d) + CLIP
  for (const steps of lines) {
    let prev = null
    for (let i = 1; i < steps.length; i++) {
      const d = idx(steps[i] - steps[i - 1])
      uni[d]++
      total++
      if (prev !== null) {
        bi[prev][d]++
        rowTotal[prev]++
      }
      prev = d
    }
  }
  if (total === 0) return null

  const pUni = (d) => (uni[d] + 1) / (total + BUCKETS) // add-one smoothing
  const pBi = (p, d) => (bi[p][d] + SMOOTH * pUni(d)) / (rowTotal[p] + SMOOTH)

  return {
    weight: Math.min(1, total / FULL_WEIGHT_AT),
    intervals: total,
    // Average negative log-probability of the line's intervals (nats).
    cost(steps) {
      if (steps.length < 2) return 0
      let sum = 0
      let prev = null
      for (let i = 1; i < steps.length; i++) {
        const d = idx(steps[i] - steps[i - 1])
        sum += -Math.log(prev === null ? pUni(d) : pBi(prev, d))
        prev = d
      }
      return sum / (steps.length - 1)
    },
  }
}
