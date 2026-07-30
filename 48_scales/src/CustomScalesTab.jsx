// The matrix's "Custom" tab: custom scales as thin matrix rows in the SAME
// footprint as the 48 built-ins — the left name block is sized to match the
// built-in glyph-zone + row-number, and the 12-cell pattern strip is identical,
// so the matrix column (and therefore the right info panel) is exactly the same
// width in both tabs. Clicking a row selects it (the info panel then shows);
// New / Edit / Delete live off the row (New = the "+" row here; Edit / Delete in
// the panel), so nothing adds trailing width. Returns a fragment so the rows sit
// directly inside the matrix column.
export default function CustomScalesTab({ scales, selectedId, onSelect, onNew }) {
  return (
    <>
      <button type="button" className="custom-add-row" onClick={onNew}>
        + new custom scale
      </button>

      {scales.length === 0 && (
        <div className="custom-empty">
          No custom scales yet — click “+ new custom scale”.
        </div>
      )}

      {scales.map((s) => (
        <div
          key={s.id}
          className={`row custom-scale-row ${
            s.id === selectedId ? 'selected' : ''
          }`}
          data-scale-id={s.id}
          onClick={() => onSelect(s.id === selectedId ? null : s.id)}
          title="Select scale"
        >
          <div className="custom-scale-name">{s.name}</div>
          <div
            className="row-cells"
            style={{ gridTemplateColumns: `repeat(12, var(--cell))` }}
          >
            {Array.from({ length: 12 }, (_, pc) => {
              const on = s.notes.includes(pc)
              const isRoot = s.notes[s.rootStep - 1] === pc
              return (
                <div
                  key={pc}
                  className={`cell ${on ? 'on' : 'off'} ${
                    on && isRoot ? 'is-scale-root' : ''
                  }`}
                />
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}
