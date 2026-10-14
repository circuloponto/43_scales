// Scale zones: stretches of the timeline that carry their own scale + root, so a
// song can be a progression of scales. Pure helpers, no React.
//
// A zone is { id, start, end, scaleId, root, modeStep }:
//   start / end   16th-cells on the timeline (end exclusive), snapped to measures
//   scaleId       built-in scale id (number) or custom scale id ('custom-...')
//   root          0-11
//   modeStep      optional 1-based intrinsic-root override, or null
// Zones never overlap and are kept sorted by start. Cells outside every zone
// use the song's home scale (the one picked in the matrix).

// Zone edges sit on the rhythm subdivision grid, which can be fractional
// (a triplet is 4/3 cells), so comparisons tolerate float noise.
export const EPS = 1e-6

export const makeZoneId = () =>
  `zn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// Accept only well-formed zones (corrupt persisted data must not crash the roll).
export function sanitizeZones(raw) {
  if (!Array.isArray(raw)) return []
  let out = []
  for (const z of raw) {
    if (!z || typeof z !== 'object') continue
    const start = Number(z.start)
    const end = Number(z.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
      continue
    }
    if (z.scaleId == null) continue
    const root = Number.isInteger(z.root) && z.root >= 0 && z.root <= 11 ? z.root : 0
    // Zones never overlap: if saved data has two on the same cells (an old bug
    // stacked duplicates), the later one wins, as it is the one last edited.
    out = out.filter((o) => o.end <= start || o.start >= end)
    out.push({
      id: typeof z.id === 'string' && z.id ? z.id : makeZoneId(),
      start,
      end,
      scaleId: z.scaleId,
      root,
      modeStep: Number.isInteger(z.modeStep) && z.modeStep >= 1 ? z.modeStep : null,
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

// The zone covering `cell`, or null.
export function zoneAt(zones, cell) {
  for (const z of zones) if (cell >= z.start - EPS && cell < z.end - EPS) return z
  return null
}

// How far a zone sitting at [start, end) may grow without touching a neighbour:
// { left, right } = the nearest neighbour edge on each side (0 / Infinity when
// there is none). `ignoreId` excludes the zone being resized itself.
export function freeLimits(zones, start, end, ignoreId = null) {
  let left = 0
  let right = Infinity
  for (const z of zones) {
    if (z.id === ignoreId) continue
    if (z.end <= start + EPS) left = Math.max(left, z.end)
    else if (z.start >= end - EPS) right = Math.min(right, z.start)
  }
  return { left, right }
}

// Float noise from fractional subdivisions (triplets) must not leak into zones.
export const cleanCell = (v) => Math.round(v * 1e6) / 1e6

const byStart = (a, b) => a.start - b.start

// Moving the selected zones as one group: how far they may shift (in cells)
// before one of them would hit a zone that is NOT selected, or cell 0.
// Returns { minDelta, maxDelta } (<= 0 and >= 0 respectively when valid).
export function moveLimits(zones, ids) {
  const sel = new Set(ids)
  let minDelta = -Infinity
  let maxDelta = Infinity
  for (const z of zones) {
    if (!sel.has(z.id)) continue
    let left = 0
    let right = Infinity
    for (const o of zones) {
      if (sel.has(o.id)) continue
      if (o.end <= z.start + EPS) left = Math.max(left, o.end)
      else if (o.start >= z.end - EPS) right = Math.min(right, o.start)
    }
    minDelta = Math.max(minDelta, left - z.start)
    maxDelta = Math.min(maxDelta, right - z.end)
  }
  if (minDelta === -Infinity && maxDelta === Infinity) return { minDelta: 0, maxDelta: 0 }
  return { minDelta, maxDelta }
}

// The same zones with the selected ones shifted by `delta` cells.
export function shiftZones(zones, ids, delta) {
  const sel = new Set(ids)
  return zones
    .map((z) =>
      sel.has(z.id)
        ? { ...z, start: cleanCell(z.start + delta), end: cleanCell(z.end + delta) }
        : z
    )
    .sort(byStart)
}

// What a copy puts on the shared clipboard: the selected zones, positions
// relative to the first one, so they can be dropped anywhere.
export function zonesToClip(zones, ids) {
  const sel = zones.filter((z) => ids.has(z.id)).sort(byStart)
  if (!sel.length) return null
  const first = sel[0].start
  return {
    kind: 'zones',
    sourceMin: first,
    items: sel.map((z) => ({
      relStart: cleanCell(z.start - first),
      len: cleanCell(z.end - z.start),
      scaleId: z.scaleId,
      root: z.root,
      modeStep: z.modeStep ?? null,
    })),
  }
}

// Paste: lay the clip's zones down starting at cell `at`, OVERWRITING what is
// underneath. Existing zones are trimmed, split or removed where a pasted zone
// covers them (a split gives the right-hand piece a fresh id). Returns
// { zones, placedIds } with fresh ids for the pasted zones.
export function placeZones(existing, clip, at, makeId = makeZoneId) {
  const pasted = clip.items
    .map((it) => ({
      start: cleanCell(at + it.relStart),
      end: cleanCell(at + it.relStart + it.len),
      scaleId: it.scaleId,
      root: it.root,
      modeStep: it.modeStep ?? null,
    }))
    .filter((p) => p.start >= -EPS && p.end > p.start + EPS)
  const out = []
  for (const z of existing) {
    let pieces = [[z.start, z.end]]
    for (const p of pasted) {
      pieces = pieces.flatMap(([s, e]) => {
        if (p.end <= s + EPS || p.start >= e - EPS) return [[s, e]] // untouched
        const kept = []
        if (p.start > s + EPS) kept.push([s, p.start])
        if (p.end < e - EPS) kept.push([p.end, e])
        return kept
      })
    }
    pieces.forEach(([s, e], i) =>
      out.push({ ...z, id: i === 0 ? z.id : makeId(), start: cleanCell(s), end: cleanCell(e) })
    )
  }
  const placed = pasted.map((p) => ({ id: makeId(), ...p }))
  return { zones: [...out, ...placed].sort(byStart), placedIds: placed.map((p) => p.id) }
}

// Look up a scale by id in the built-in list + custom scales.
export function findScaleById(builtIn, custom, id) {
  return (
    builtIn.find((s) => s.id === id) ||
    (custom || []).find((s) => s.id === id) ||
    null
  )
}
