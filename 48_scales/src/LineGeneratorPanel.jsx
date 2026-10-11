import { useState } from 'react'
import { LINE_MODES } from './lineGenerator'

// Sidebar panel: pick a transformation mode (and its option), set how much of
// the line may change, press Generate. `onGenerate(modeKey, { option, amount })`
// returns an error string, or '' on success. The Anchor mode doesn't transform:
// it locks / unlocks the selection so the other modes leave those notes alone.
export default function LineGeneratorPanel({ selectedCount, onGenerate }) {
  const [mode, setMode] = useState('tabby')
  // Each mode remembers its own option (first option is the default).
  const [options, setOptions] = useState(() =>
    Object.fromEntries(
      LINE_MODES.filter((m) => m.options).map((m) => [m.key, m.options[0].key])
    )
  )
  const [amount, setAmount] = useState(100) // percent
  const [message, setMessage] = useState('')
  const current = LINE_MODES.find((m) => m.key === mode)

  return (
    <div className="line-gen">
      <div className="line-gen-status">
        {selectedCount > 0
          ? `${selectedCount} note${selectedCount === 1 ? '' : 's'} selected`
          : 'Select notes on the piano roll'}
      </div>
      <ul className="line-gen-modes" role="radiogroup" aria-label="Variation mode">
        {LINE_MODES.map((m) => (
          <li key={m.key}>
            <button
              type="button"
              role="radio"
              aria-checked={mode === m.key}
              className={`line-gen-mode ${mode === m.key ? 'on' : ''}`}
              onClick={() => {
                setMode(m.key)
                setMessage('')
              }}
              title={m.hint}
            >
              <span className="line-gen-mode-label">{m.label}</span>
              <span className="line-gen-mode-hint">{m.hint}</span>
            </button>
            {m.options && mode === m.key && (
              <div className="line-gen-options" role="radiogroup" aria-label={`${m.label} option`}>
                {m.options.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    role="radio"
                    aria-checked={options[m.key] === o.key}
                    className={options[m.key] === o.key ? 'on' : ''}
                    onClick={() => setOptions((prev) => ({ ...prev, [m.key]: o.key }))}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {current?.amount && (
        <label className="line-gen-amount">
          <span className="line-gen-amount-row">
            <span>Amount</span>
            <span className="line-gen-amount-value">{amount}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </label>
      )}
      <button
        type="button"
        className="line-gen-generate"
        onClick={() =>
          setMessage(
            onGenerate(mode, { option: options[mode], amount: amount / 100 }) || ''
          )
        }
        disabled={selectedCount === 0}
      >
        {current?.lock ? 'Lock / unlock' : 'Generate'}
      </button>
      {message && <div className="line-gen-message">{message}</div>}
    </div>
  )
}
