// Parse the Excalidraw SVG and extract cell positions for the 48-scales grid.
// Each "on" (white) cell is a <g> element with a translate(X Y) rotate(270 ...)
// transform and a 22.9x22.9 path. Off cells are not drawn.
//
// Grid: 12 columns (pitch classes 0..11) x 48 rows (scales 1..48)
// Column 0 origin x = 76.91437...; Row 0 origin y = 10.21825...
// Cell size = 22.9 (with 0 gap in the SVG layout).

import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync(process.argv[2], 'utf8');

const CELL = 22.9;
const X0 = 76.91437384;
const Y0 = 10.21825497;

// Match every `<g ... transform="translate(X Y) rotate(270 11.4513... 11.4513...)">`
// followed by the canonical 22.9x22.9 rectangle path. This pattern is unique to
// the grid cells (other annotations use rotate(0 ...) or different sizes).
const cellRe = /transform="translate\(([\-\d.]+)\s+([\-\d.]+)\)\s+rotate\(270\s+11\.4513[\d.]+\s+11\.4513[\d.]+\)"[^>]*>\s*<path\s+d="M0 0 L22\.9 0 L22\.9 22\.9 L0 22\.9"/g;

const cells = [];
let m;
while ((m = cellRe.exec(svg)) !== null) {
  const x = parseFloat(m[1]);
  const y = parseFloat(m[2]);
  cells.push({ x, y });
}

console.log(`Found ${cells.length} cells.`);

// Map each cell to (row, col)
const placed = cells.map(({ x, y }) => {
  const col = Math.round((x - X0) / CELL);
  const row = Math.round((y - Y0) / CELL);
  return { row, col, x, y };
});

// Bucket by row
const byRow = new Map();
for (const p of placed) {
  if (!byRow.has(p.row)) byRow.set(p.row, new Set());
  byRow.get(p.row).add(p.col);
}

// Validate
const rows = [...byRow.keys()].sort((a, b) => a - b);
console.log(`Rows present: ${rows.length} (min=${rows[0]}, max=${rows[rows.length - 1]})`);

const counts = {};
for (const r of rows) {
  const n = byRow.get(r).size;
  counts[n] = (counts[n] || 0) + 1;
}
console.log('Cells-per-row histogram:', counts);

// Column histogram
const colCounts = {};
for (const p of placed) colCounts[p.col] = (colCounts[p.col] || 0) + 1;
console.log('Column histogram:', colCounts);

// Build output: scales 1..48 with notes arrays
const scales = [];
for (let r = 0; r < 48; r++) {
  const notes = [...(byRow.get(r) || [])]
    .filter((c) => c >= 0 && c <= 11)
    .sort((a, b) => a - b);
  scales.push({ id: r + 1, notes });
}

// Print as JS
const lines = scales
  .map((s) => `  { id: ${String(s.id).padStart(2)}, notes: [${s.notes.join(',')}] },`)
  .join('\n');

writeFileSync(process.argv[3], `export const scales = [\n${lines}\n];\n`);
console.log(`Wrote ${process.argv[3]}`);
