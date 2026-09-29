import type { InputSource, Mode } from '../effects/EffectController';
import { SCRIPT_LABELS, SCRIPT_NAMES, type ScriptName } from '../input/ScriptedMotion';

interface Props {
  mode: Mode;
  input: InputSource;
  script: ScriptName;
  debug: boolean;
  panelOpen: boolean;
  recording: boolean;
  canRecord: boolean;
  fusionPurple: boolean;
  onMode: (m: Mode) => void;
  onInput: (i: InputSource) => void;
  onScript: (s: ScriptName) => void;
  onDebug: () => void;
  onPanel: () => void;
  onRecord: () => void;
  onShowcase: () => void;
  onReset: () => void;
  onSplit: () => void;
}

export function ModeBar(p: Props) {
  return (
    <nav className="modebar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="seg">
        <button className={p.mode === 'sandbox' ? 'on' : ''} onClick={() => p.onMode('sandbox')} title="1">
          Purple
        </button>
        <button className={p.mode === 'fusion' ? 'on' : ''} onClick={() => p.onMode('fusion')} title="2">
          Blue + Red
        </button>
      </div>
      <div className="seg">
        <button className={p.input === 'mouse' ? 'on' : ''} onClick={() => p.onInput('mouse')} title="Mouse simulation">
          Mouse
        </button>
        <button className={p.input === 'camera' ? 'on' : ''} onClick={() => p.onInput('camera')} title="C">
          Camera
        </button>
        <select
          className={p.input === 'script' ? 'on' : ''}
          value={p.input === 'script' ? p.script : ''}
          onChange={(e) => e.target.value && p.onScript(e.target.value as ScriptName)}
          aria-label="Scripted test motion"
        >
          <option value="">Test motion…</option>
          {SCRIPT_NAMES.map((n) => (
            <option key={n} value={n}>
              {SCRIPT_LABELS[n]}
            </option>
          ))}
        </select>
      </div>
      <div className="seg">
        {p.mode === 'fusion' && p.fusionPurple && (
          <button onClick={p.onSplit} title="Split purple back into blue + red">
            Split
          </button>
        )}
        <button onClick={p.onReset} title="R">
          Reset
        </button>
        <button className={p.debug ? 'on' : ''} onClick={p.onDebug} title="D">
          Debug
        </button>
        <button className={p.panelOpen ? 'on' : ''} onClick={p.onPanel} title="S">
          Tune
        </button>
        {p.canRecord && (
          <button className={p.recording ? 'rec on' : 'rec'} onClick={p.onRecord} title="V">
            {p.recording ? '■ Stop' : '● Rec'}
          </button>
        )}
        <button onClick={p.onShowcase} title="H">
          Showcase
        </button>
      </div>
    </nav>
  );
}
