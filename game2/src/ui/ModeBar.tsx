import type { InputSource, Mode, MouseGesture } from '../effects/EffectController';
import { SCRIPT_LABELS, SCRIPT_NAMES, type ScriptName } from '../input/ScriptedMotion';

interface Props {
  mode: Mode;
  input: InputSource;
  script: ScriptName;
  gesture: MouseGesture;
  debug: boolean;
  panelOpen: boolean;
  recording: boolean;
  canRecord: boolean;
  fusionPurple: boolean;
  onMode: (m: Mode) => void;
  onInput: (i: InputSource) => void;
  onScript: (s: ScriptName) => void;
  onGesture: (g: MouseGesture) => void;
  onFire: () => void;
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
      {p.input === 'mouse' && (
        <div className="seg" title="Simulated hand gesture (camera mode uses your real hand)">
          <button className={p.gesture === 'TRACK' ? 'on' : ''} onClick={() => p.onGesture('TRACK')} title="F — point: the liquid follows the fingertip">
            Point
          </button>
          <button className={p.gesture === 'PALM' ? 'on' : ''} onClick={() => p.onGesture('PALM')} title="P — open palm: release and push (drag B for a second palm)">
            Palm
          </button>
          <button className={p.gesture === 'GUN' ? 'on' : ''} onClick={() => p.onGesture('GUN')} title="G — handgun: aims at B / the center">
            Gun
          </button>
          {p.gesture === 'GUN' && (
            <button onClick={p.onFire} title="Space or click — thumb trigger">
              Fire
            </button>
          )}
        </div>
      )}
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
