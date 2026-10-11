// Line generator — pure logic, no React. Takes the notes selected on the piano
// roll (a "line") and returns an alternative set of pitches for them. Rhythm
// (beats + lengths) is never touched; only pitches change.
//
// A line is an array of { beat, len, midi }. Every mode works on SCALE STEPS
// (global index = octave * scaleSize + degree) so "one step up" always means
// the next note of the active scale, whatever the root or scale is.
//
// ctx (supplied by PianoRoll, which owns the scale/root):
//   scaleSize          number of notes in the active scale
//   low, high          playable MIDI range
//   toStep(midi)       midi -> global scale step, or null if off-scale
//   toMidi(step)       global scale step -> midi
//   snap(midi)         nearest in-scale midi
//   chordOf(pc)        'left' | 'right' | 'both' | null  (the scale's chord pair)
//
// opts: { option, amount }
//   option   the mode's own choice (see `options` below)
//   amount   0..1, how much of the line the generation may touch

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

// Build a line of steps from a start step + a list of intervals (in steps).
function stepsFromIntervals(start, intervals) {
  const out = [start]
  for (const d of intervals) out.push(out[out.length - 1] + d)
  return out
}

const intervalsOf = (steps) => steps.slice(1).map((s, i) => s - steps[i])

function stepsToMidis(steps, ctx) {
  return steps.map((s) => ctx.toMidi(s))
}

const fits = (steps, ctx) =>
  steps.every((s) => {
    const m = ctx.toMidi(s)
    return m >= ctx.low && m <= ctx.high
  })

// Slide a whole step-line by whole octaves until it fits the playable range.
function fitByOctaves(steps, ctx) {
  if (fits(steps, ctx)) return steps
  for (let k = 1; k <= 4; k++) {
    for (const sign of [1, -1]) {
      const moved = steps.map((s) => s + sign * k * ctx.scaleSize)
      if (fits(moved, ctx)) return moved
    }
  }
  return null
}

// Rebuild the line from its original first note and a new interval list,
// retrying until it fits the playable range. `makeDiffs()` returns a fresh
// interval list each call (it is random).
function rebuild(steps, ctx, makeDiffs) {
  for (let t = 0; t < 12; t++) {
    const fitted = fitByOctaves(stepsFromIntervals(steps[0], makeDiffs()), ctx)
    if (fitted) return { midis: stepsToMidis(fitted, ctx) }
  }
  return { error: 'No room to reshape this line.' }
}

const NOTHING = { error: 'Amount is 0%, nothing to change.' }

// ---- Modes ---------------------------------------------------------------

// Tabby order: notes keep their left/right chord membership order.
function tabby(line, ctx, rng, amount) {
  const pool = (label) => {
    const out = []
    for (let m = ctx.low; m <= ctx.high; m++) {
      if (ctx.snap(m) !== m) continue // off-scale
      const c = ctx.chordOf(((m % 12) + 12) % 12)
      if (label === 'any' || c === label || c === 'both') out.push(m)
    }
    return out
  }
  const pools = { left: pool('left'), right: pool('right'), any: pool('any') }
  const affected = chooseAffected(
    line.map((_, i) => i),
    amount,
    rng
  )
  const out = []
  let prev = line[0].midi
  line.forEach((n, i) => {
    let next = n.midi
    if (affected.has(i)) {
      const c = ctx.chordOf(((n.midi % 12) + 12) % 12)
      const candidates = pools[c === 'left' || c === 'right' ? c : 'any']
      // Stay near the previous note, but never reuse the original pitch.
      const nearest = [...candidates]
        .filter((m) => m !== n.midi)
        .sort((a, b) => Math.abs(a - prev) - Math.abs(b - prev))
        .slice(0, 3)
      if (nearest.length) next = pick(nearest, rng)
    }
    out.push(next)
    prev = next
  })
  return { midis: out }
}

// Sequence: identical shape, different starting note.
function sequence(steps, ctx, rng) {
  const n = ctx.scaleSize
  const shifts = []
  for (let d = -n; d <= n; d++) {
    if (d !== 0 && fits(steps.map((s) => s + d), ctx)) shifts.push(d)
  }
  if (!shifts.length) return { error: 'No room to move this line.' }
  const d = pick(shifts, rng)
  return { midis: stepsToMidis(steps.map((s) => s + d), ctx) }
}

// Direction: flip the direction of the intervals (up <-> down), sizes kept.
// The amount slider sets how many of the intervals flip.
function direction(steps, ctx, rng, amount) {
  if (steps.length < 2) return { error: 'Select at least 2 notes.' }
  const diffs = intervalsOf(steps)
  const movable = diffs.map((d, i) => (d !== 0 ? i : -1)).filter((i) => i >= 0)
  if (!movable.length) return { error: 'These notes have no up or down moves.' }
  if (amount <= 0) return NOTHING
  return rebuild(steps, ctx, () => {
    const hit = chooseAffected(movable, amount, rng)
    return diffs.map((d, i) => {
      return hit.has(i) ? -d : d
    })
  })
}

// Contour: works on the overall shape of the line.
//   maintain -> every up and down stays; steps may widen or narrow (any size)
//   change   -> affected intervals become brand-new moves (new direction/size)
function contour(steps, ctx, rng, option, amount) {
  if (steps.length < 2) return { error: 'Select at least 2 notes.' }
  const diffs = intervalsOf(steps)
  if (amount <= 0) return NOTHING
  const maintain = option === 'maintain'
  const pickable = diffs
    .map((d, i) => (maintain && d === 0 ? -1 : i))
    .filter((i) => i >= 0)
  if (!pickable.length) return { error: 'These notes have no steps to reshape.' }
  return rebuild(steps, ctx, () => {
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

// Entry point. Returns { midis } (same order/length as `line`) or { error }.
export function generateLine(modeKey, line, ctx, opts = {}, rng = Math.random) {
  if (!line.length) return { error: 'Select some notes on the piano roll first.' }
  const amount = opts.amount ?? 1
  if (modeKey === 'tabby') {
    return amount > 0 ? tabby(line, ctx, rng, amount) : NOTHING
  }

  const steps = line.map((n) => ctx.toStep(n.midi) ?? ctx.toStep(ctx.snap(n.midi)))
  if (steps.some((s) => s == null)) return { error: 'Could not map a note to the scale.' }
  if (modeKey === 'sequence') return sequence(steps, ctx, rng)
  if (modeKey === 'direction') {
    return direction(steps, ctx, rng, amount)
  }
  if (modeKey === 'contour') {
    return contour(steps, ctx, rng, opts.option ?? 'maintain', amount)
  }
  return { error: 'This mode is not available yet.' }
}

// Order a selection into a playable line: by time, then low to high.
export function sortLine(items) {
  return [...items].sort((a, b) => a.beat - b.beat || a.midi - b.midi)
}
