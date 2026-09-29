import { useState } from 'react';
import { PARAM_GROUPS, PARAMS, type ParamDef, type ParamGroup, type Settings } from '../config/schema';
import { PRESET_NAMES } from '../config/presets';

interface Props {
  settings: Settings;
  onChange: (key: string, value: number | boolean | string) => void;
  onCopy: () => void;
  onLoad: () => void;
  onReset: () => void;
  onPreset: (name: string) => void;
  onClose: () => void;
  notice: string;
}

const DEFAULT_OPEN: ParamGroup[] = ['Physics', 'Shape'];

function decimals(step: number): number {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

function Row({ def, value, onChange }: { def: ParamDef; value: unknown; onChange: Props['onChange'] }) {
  if (def.type === 'bool') {
    return (
      <label className="row row-bool" title={def.help}>
        <span className="row-label">{def.label}</span>
        <input type="checkbox" checked={value as boolean} onChange={(e) => onChange(def.key, e.target.checked)} />
      </label>
    );
  }
  if (def.type === 'select') {
    return (
      <label className="row row-bool" title={def.help}>
        <span className="row-label">{def.label}</span>
        <select value={value as string} onChange={(e) => onChange(def.key, e.target.value)}>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const v = value as number;
  const changed = v !== def.default;
  return (
    <div className={`row${changed ? ' changed' : ''}`} title={def.help}>
      <div className="row-head">
        <span className="row-label">{def.label}</span>
        <input
          className="num"
          type="number"
          value={Number(v.toFixed(decimals(def.step)))}
          min={def.min}
          max={def.max}
          step={def.step}
          onChange={(e) => {
            const x = parseFloat(e.target.value);
            if (Number.isFinite(x)) onChange(def.key, x);
          }}
        />
      </div>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={v}
        onChange={(e) => onChange(def.key, parseFloat(e.target.value))}
        onDoubleClick={() => onChange(def.key, def.default)}
      />
    </div>
  );
}

export function ControlPanel(p: Props) {
  const [open, setOpen] = useState<Set<ParamGroup>>(() => new Set(DEFAULT_OPEN));
  const toggle = (g: ParamGroup) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  return (
    <aside className="panel" onPointerDown={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <strong>Tuning</strong>
        <button className="icon-btn" onClick={p.onClose} aria-label="Close tuning panel">
          ✕
        </button>
      </header>
      <div className="panel-actions">
        <button onClick={p.onCopy}>Copy Settings JSON</button>
        <button onClick={p.onLoad}>Load Settings JSON</button>
        <button onClick={p.onReset}>Reset Defaults</button>
        <select value="" onChange={(e) => e.target.value && p.onPreset(e.target.value)} aria-label="Apply preset">
          <option value="">Preset…</option>
          {PRESET_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {p.notice && <div className="panel-notice">{p.notice}</div>}
      <div className="panel-body">
        {PARAM_GROUPS.map((g) => (
          <section key={g} className="group">
            <button className="group-head" onClick={() => toggle(g)} aria-expanded={open.has(g)}>
              <span>{open.has(g) ? '▾' : '▸'}</span> {g}
            </button>
            {open.has(g) && (
              <div className="group-body">
                {(PARAMS as readonly ParamDef[])
                  .filter((d) => d.group === g)
                  .map((d) => (
                    <Row key={d.key} def={d} value={(p.settings as Record<string, unknown>)[d.key]} onChange={p.onChange} />
                  ))}
              </div>
            )}
          </section>
        ))}
        <p className="panel-foot">
          Double-click a slider to reset it. Highlighted rows differ from defaults. Settings persist in this browser.
          <br />
          Camera processing runs locally in your browser.
        </p>
      </div>
    </aside>
  );
}
