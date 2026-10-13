// Line generator — pure logic, no React. Takes the notes selected on the piano
// roll (a "line") and returns an alternative set of pitches for them. Rhythm
// (beats + lengths) is never touched; only pitches change.
//
// A line is an array of { beat, len, midi }. Pitches move in SCALE STEPS
// (global index = octave * scaleSize + degree), so "one step up" always means
// the next note of the scale in force, whatever the root or scale is.
//
// Scale zones: every note can sit in a different scale. `ctx` is either one
// context (the whole line is in one scale) or an array with one context per
// note. A note's interval is measured in, and applied through, the scale of the
// note it leads to, so every generated note lands inside its own zone's scale.
// When all notes share one context the behaviour is exactly the single-scale one.
//
// A context (built by PianoRoll from a scaleContext):
//   scaleSize          number of notes in the scale
//   low, high          playable MIDI range
//   toStep(midi)       midi -> global scale step, or null if off-scale
//   toMidi(step)       global scale step -> midi
//   snap(midi)         nearest in-scale midi
//   chordOf(pc)        'left' | 'right' | 'both' | null  (the scale's chord pair)
//
// opts: { option, amount }
//   option   the mode's own choice (see `options` below)
//   amount   0..1, how much of the line the generation may touch

// How many alternative lines one Generate press produces.
export const VARIATION_COUNT = 6

export const LINE_MODES = [
  {
    key: 'tabby',
    label: 'Tabby order',
    hint: 'New pitches, same left/right chord order as the selection.',
    amount: true,
  },
  {
    key: 'direction',
    label: 'Direction',
    hint: 'Changes the direction of the intervals: up becomes down and down becomes up. Step sizes stay the same.',
    amount: true,
  },
  {
    key: 'contour',
    label: 'Contour',
    hint: 'Maintain the contour (same ups and downs, wider or narrower) or change it into a new one.',
    amount: true,
    options: [
      { key: 'maintain', label: 'Maintain contour' },
      { key: 'change', label: 'Change contour' },
    ],
  },
  {
    key: 'sequence',
    label: 'Sequence',
    hint: 'Keeps the exact shape, moves it to start on another note.',
  },
  {
    key: 'anchor',
    label: 'Anchor',
    hint: 'Locks the selected notes so no other mode changes them. Press again to unlock.',
    lock: true,
  },
]

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)]

function shuffled(arr, rng) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Pick which of `candidates` (indices) the generation touches, from the amount
// slider: 0 -> none, otherwise at least one, otherwise round(amount * count).
function chooseAffected(candidates, amount, rng) {
  if (amount <= 0 || !candidates.length) return new Set()
  const k = Math.max(1, Math.round(candidates.length * amount))
  return new Set(shuffled(candidates, rng).slice(0, k))
}

// ---- Per-note scale contexts ----------------------------------------------

// One context per note: a single ctx is shared by every note.
const ctxList = (line, ctx) => (Array.isArray(ctx) ? ctx : line.map(() => ctx))

// A midi value as a scale step of context `c` (snapped in if it is off-scale).
const stepIn = (c, midi) => c.toStep(midi) ?? c.toStep(c.snap(midi))

// The line's intervals, each measured in the scale of the note it leads to.
const intervalsIn = (line, ctxs) =>
  line.slice(1).map((n, i) => {
    const c = ctxs[i + 1]
    return stepIn(c, n.midi) - stepIn(c, line[i].midi)
  })

// Lay a line out from its first pitch and a list of intervals: each new note is
// the previous pitch, as a step of the next note's scale, plus its interval.
function layOut(ctxs, start, diffs) {
  const out = [start]
  for (let i = 0; i < diffs.length; i++) {
    const c = ctxs[i + 1]
    out.push(c.toMidi(stepIn(c, out[i]) + diffs[i]))
  }
  return out
}

const inRange = (midis, c) => midis.every((m) => m >= c.low && m <= c.high)

// Slide the whole line by whole octaves until it fits the playable range.
function fitByOctaves(ctxs, start, diffs) {
  const first = layOut(ctxs, start, diffs)
  if (inRange(first, ctxs[0])) return first
  for (let k = 1; k <= 4; k++) {
    for (const sign of [1, -1]) {
      const moved = layOut(ctxs, start + sign * 12 * k, diffs)
      if (inRange(moved, ctxs[0])) return moved
    }
  }
  return null
}

// Rebuild the line from its first note and a new interval list, retrying until
// it fits the playable range. `makeDiffs()` returns a fresh interval list each
// call (it is random).
function rebuild(ctxs, start, makeDiffs) {
  for (let t = 0; t < 12; t++) {
    const fitted = fitByOctaves(ctxs, start, makeDiffs())
    if (fitted) return { midis: fitted }
  }
  return { error: 'No room to reshape this line.' }
}

const NOTHING = { error: 'Amount is 0%, nothing to change.' }

// ---- Modes ---------------------------------------------------------------

// Tabby order: notes keep their left/right chord membership order, each in the
// chord pair of its own zone's scale.
function tabby(line, ctxs, rng, amount) {
  const poolCache = new Map()
  const poolsOf = (ctx) => {
    if (!poolCache.has(ctx)) {
      const pool = (label) => {
        const out = []
        for (let m = ctx.low; m <= ctx.high; m++) {
          if (ctx.snap(m) !== m) continue // off-scale
          const c = ctx.chordOf(((m % 12) + 12) % 12)
          if (label === 'any' || c === label || c === 'both') out.push(m)
        }
        return out
      }
      poolCache.set(ctx, { left: pool('left'), right: pool('right'), any: pool('any') })
    }
    return poolCache.get(ctx)
  }
  const affected = chooseAffected(
    line.map((_, i) => i),
    amount,
    rng
  )
  // Pitches that stay as they are (amount < 100%) are already "taken".
  const kept = line.filter((_, i) => !affected.has(i)).map((n) => n.midi)
  // Last earlier note with the same original pitch, or -1. Only notes in the
  // same scale count: a pitch reused from another zone might not belong here.
  const echoOf = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      if (line[j].midi === line[i].midi && ctxs[j] === ctxs[i]) return j
    }
    return -1
  }
  const out = []
  let prev = line[0].midi
  line.forEach((n, i) => {
    let next = n.midi
    if (affected.has(i)) {
      const c = ctxs[i].chordOf(((n.midi % 12) + 12) % 12)
      const candidates = poolsOf(ctxs[i])[c === 'left' || c === 'right' ? c : 'any']
      const echo = echoOf(i)
      if (echo >= 0 && affected.has(echo)) {
        // The original repeats this pitch on purpose: repeat the new one too.
        next = out[echo]
      } else {
        // Otherwise every note gets a pitch not used yet in the line, near the
        // previous note, and never the original pitch.
        const used = new Set([...out, ...kept])
        const byDistance = (a, b) => Math.abs(a - prev) - Math.abs(b - prev)
        const free = (m) => m !== n.midi && (i === 0 || m !== out[i - 1])
        let nearest = candidates
          .filter((m) => free(m) && !used.has(m))
          .sort(byDistance)
          .slice(0, 5)
        // Nothing unused left in this chord: settle for just no immediate repeat.
        if (!nearest.length) {
          nearest = candidates.filter(free).sort(byDistance).slice(0, 5)
        }
        if (nearest.length) next = pick(nearest, rng)
      }
    }
    out.push(next)
    prev = next
  })
  return { midis: out }
}

// Sequence: identical shape, different starting note.
function sequence(line, ctxs, start, rng) {
  const diffs = intervalsIn(line, ctxs)
  const n = ctxs[0].scaleSize
  const base = stepIn(ctxs[0], line[0].midi)
  const shifts = []
  for (let d = -n; d <= n; d++) {
    if (d === 0) continue
    const moved = layOut(ctxs, ctxs[0].toMidi(base + d), diffs)
    if (inRange(moved, ctxs[0])) shifts.push(d)
  }
  if (!shifts.length) return { error: 'No room to move this line.' }
  const d = pick(shifts, rng)
  return { midis: layOut(ctxs, ctxs[0].toMidi(base + d), diffs) }
}

// Direction: flip the direction of the intervals (up <-> down), sizes kept.
// The amount slider sets how many of the intervals flip.
function direction(line, ctxs, start, rng, amount) {
  if (line.length < 2) return { error: 'Select at least 2 notes.' }
  const diffs = intervalsIn(line, ctxs)
  const movable = diffs.map((d, i) => (d !== 0 ? i : -1)).filter((i) => i >= 0)
  if (!movable.length) return { error: 'These notes have no up or down moves.' }
  if (amount <= 0) return NOTHING
  return rebuild(ctxs, start, () => {
    const hit = chooseAffected(movable, amount, rng)
    return diffs.map((d, i) => (hit.has(i) ? -d : d))
  })
}

// Contour: works on the overall shape of the line.
//   maintain -> every up and down stays; steps may widen or narrow (any size)
//   change   -> affected intervals become brand-new moves (new direction/size)
function contour(line, ctxs, start, rng, option, amount) {
  if (line.length < 2) return { error: 'Select at least 2 notes.' }
  const diffs = intervalsIn(line, ctxs)
  if (amount <= 0) return NOTHING
  const maintain = option === 'maintain'
  const pickable = diffs
    .map((d, i) => (maintain && d === 0 ? -1 : i))
    .filter((i) => i >= 0)
  if (!pickable.length) return { error: 'These notes have no steps to reshape.' }
  return rebuild(ctxs, start, () => {
    const hit = chooseAffected(pickable, amount, rng)
    return diffs.map((d, i) => {
      if (!hit.has(i)) return d
      if (maintain) {
        const sizes = [1, 2, 3].filter((m) => m !== Math.abs(d))
        return Math.sign(d) * pick(sizes, rng)
      }
      // change: a new move that differs from the original one
      const next = pick([-1, 1], rng) * pick([1, 2, 3], rng)
      return next === d ? -d : next
    })
  })
}

// Entry point. `ctx` is one context or one per note. Returns { midis } (same
// order/length as `line`) or { error }.
export function generateLine(modeKey, line, ctx, opts = {}, rng = Math.random) {
  if (!line.length) return { error: 'Select some notes on the piano roll first.' }
  const ctxs = ctxList(line, ctx)
  const amount = opts.amount ?? 1
  if (modeKey === 'tabby') {
    return amount > 0 ? tabby(line, ctxs, rng, amount) : NOTHING
  }

  const steps = line.map((n, i) => stepIn(ctxs[i], n.midi))
  if (steps.some((s) => s == null)) return { error: 'Could not map a note to the scale.' }
  // The line's first pitch (snapped into its scale) anchors every rebuild.
  const start = ctxs[0].toMidi(steps[0])
  if (modeKey === 'sequence') return sequence(line, ctxs, start, rng)
  if (modeKey === 'direction') return direction(line, ctxs, start, rng, amount)
  if (modeKey === 'contour') {
    return contour(line, ctxs, start, rng, opts.option ?? 'maintain', amount)
  }
  return { error: 'This mode is not available yet.' }
}

// ---- Quality: profile, hard rules, scoring -------------------------------
// One random draw above can come out stuck (repeated notes), oscillating
// (a-b-a-b) or squashed into a narrow range. generateVariations draws many
// candidates, throws out the bad ones and keeps the best few.

// Shape numbers for a line. `steps` measure size (span, leaps, first note);
// `keys` identify pitches (repeats, a-b-a-b, distinct). With one scale both are
// the scale steps. Across zones step numbers of different scales are not
// comparable, so `keys` are the MIDI pitches and `steps` are scaled semitones.
function profileOf(steps, keys = steps) {
  const d = steps.slice(1).map((s, i) => s - steps[i])
  let repeats = 0
  let leaps = 0
  for (let i = 1; i < keys.length; i++) if (keys[i] === keys[i - 1]) repeats++
  for (const v of d) if (Math.abs(v) >= 3) leaps++
  let osc = 0 // a-b-a-b
  for (let i = 0; i + 3 < keys.length; i++) {
    if (keys[i] === keys[i + 2] && keys[i + 1] === keys[i + 3]) osc++
  }
  return {
    span: Math.max(...steps) - Math.min(...steps),
    repeats,
    leaps,
    osc,
    distinct: new Set(keys).size,
    first: steps[0],
    intervals: d.length,
  }
}

// Hard rules: a candidate may not be worse than the original on these.
function passesRules(c, o, strictDistinct) {
  if (c.repeats > o.repeats) return false
  if (c.osc > o.osc) return false
  // Same pitch coming back later in the line (not just back to back).
  if (strictDistinct && c.distinct < o.distinct) return false
  if (c.span < Math.ceil(o.span * 0.7)) return false // don't condense the range
  if (c.span > Math.ceil(o.span * 1.6) + 2) return false // nor explode it
  return true
}

// Lower is better. `style` (from lineStyle.js) adds "does it sound like the
// user's own lines", faded in by its weight as more templates exist.
function scoreCandidate(c, o, steps, style) {
  const n = Math.max(1, o.intervals)
  let s =
    Math.abs(c.span - o.span) / Math.max(1, o.span) +
    (0.8 * Math.max(0, o.distinct - c.distinct)) / Math.max(1, o.distinct) +
    (0.5 * Math.abs(c.leaps - o.leaps)) / n +
    (c.first !== o.first ? 0.15 : 0)
  if (style) s += style.weight * STYLE_WEIGHT * style.cost(steps)
  return s
}
const STYLE_WEIGHT = 0.4

// Candidates differ in at least this share of their notes, so the six
// variations feel like six options and not one idea with a tweak.
const MIN_DIFF = 0.3

const noteDiff = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0)

// Many draws -> filter by the rules -> rank by score -> pick `count` that are
// different enough from each other. `ctx` is one context or one per note.
// Returns { variants: midis[][] } or { error }.
export function generateVariations(
  modeKey,
  line,
  ctx,
  opts = {},
  { count = VARIATION_COUNT, pool = 80, rng = Math.random, style = null } = {}
) {
  if (!line.length) return { error: 'Select some notes on the piano roll first.' }
  const ctxs = ctxList(line, ctx)
  const oneScale = ctxs.every((c) => c === ctxs[0])
  // How a line of midi pitches is measured (see profileOf).
  const avgSize = ctxs.reduce((n, c) => n + c.scaleSize, 0) / ctxs.length
  const measure = (midis) =>
    oneScale
      ? (() => {
          const steps = midis.map((m) => stepIn(ctxs[0], m))
          return { steps, keys: steps }
        })()
      : { steps: midis.map((m) => (m * avgSize) / 12), keys: midis }
  // The style model counts whole steps of one scale: it only applies there.
  const styleModel = oneScale ? style : null

  const first = measure(line.map((n) => n.midi))
  const orig = profileOf(first.steps, first.keys)

  const seen = new Set([line.map((n) => n.midi).join(',')])
  const cands = []
  let stale = 0
  for (let t = 0; t < pool && stale < 25; t++) {
    const r = generateLine(modeKey, line, ctxs, opts, rng)
    if (r.error) {
      if (cands.length === 0 && t === 0) return { error: r.error }
      break
    }
    const id = r.midis.join(',')
    if (seen.has(id)) {
      stale++
      continue
    }
    seen.add(id)
    stale = 0
    const m = measure(r.midis)
    const prof = profileOf(m.steps, m.keys)
    cands.push({
      midis: r.midis,
      ok: passesRules(prof, orig, modeKey === 'tabby'),
      score: scoreCandidate(prof, orig, m.steps, styleModel) + rng() * 0.01,
    })
  }
  if (!cands.length) return { error: 'No different variation found.' }

  // Only candidates that pass the rules; if none do, fall back to the best of
  // what exists so Generate never comes back empty-handed.
  const good = cands.filter((c) => c.ok)
  const ranked = (good.length ? good : cands).sort((a, b) => a.score - b.score)

  const need = Math.max(1, Math.ceil(line.length * MIN_DIFF))
  const picked = []
  const skipped = []
  for (const c of ranked) {
    if (picked.length >= count) break
    if (picked.every((p) => noteDiff(p.midis, c.midis) >= need)) picked.push(c)
    else skipped.push(c)
  }
  // Too few distinct enough? Top up with the best of the near-duplicates.
  for (const c of skipped) {
    if (picked.length >= count) break
    picked.push(c)
  }
  return { variants: picked.map((c) => c.midis) }
}

// Order a selection into a playable line: by time, then low to high.
export function sortLine(items) {
  return [...items].sort((a, b) => a.beat - b.beat || a.midi - b.midi)
}
