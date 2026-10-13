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

export const makeZoneId = () =>
  `zn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// Accept only well-formed zones (corrupt persisted data must not crash the roll).
export function sanitizeZones(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const z of raw) {
    if (!z || typeof z !== 'object') continue
    const start = Number(z.start)
    const end = Number(z.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
      continue
    }
    if (z.scaleId == null) continue
    const root = Number.isInteger(z.root) && z.root >= 0 && z.root <= 11 ? z.root : 0
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
  for (const z of zones) if (cell >= z.start && cell < z.end) return z
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
    if (z.end <= start) left = Math.max(left, z.end)
    else if (z.start >= end) right = Math.min(right, z.start)
  }
  return { left, right }
}

// Look up a scale by id in the built-in list + custom scales.
export function findScaleById(builtIn, custom, id) {
  return (
    builtIn.find((s) => s.id === id) ||
    (custom || []).find((s) => s.id === id) ||
    null
  )
}
