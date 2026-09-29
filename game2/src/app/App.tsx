import { useCallback, useEffect, useRef, useState } from 'react';
import { presetSettings } from '../config/presets';
import { DEFAULT_SETTINGS, type Settings } from '../config/schema';
import { loadStoredSettings, parseSettingsJson, settingsToJson, storeSettings } from '../config/storage';
import { EffectController, type EngineStats, type InputSource, type Mode } from '../effects/EffectController';
import { SCRIPT_NAMES, type ScriptName } from '../input/ScriptedMotion';
import { CanvasRecorder } from '../record/Recorder';
import { ControlPanel } from '../ui/ControlPanel';
import { ModeBar } from '../ui/ModeBar';

const params = new URLSearchParams(location.search);
const initialMode: Mode = params.get('mode') === 'fusion' ? 'fusion' : 'sandbox';
const scriptParam = params.get('script') as ScriptName | null;
const initialScript: ScriptName = scriptParam && SCRIPT_NAMES.includes(scriptParam) ? scriptParam : 'circle';
const initialInput: InputSource =
  params.get('input') === 'camera' ? 'camera' : params.get('input') === 'script' || scriptParam ? 'script' : 'mouse';

export function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EffectController | null>(null);
  const recorderRef = useRef(new CanvasRecorder());
  const [settings, setSettings] = useState<Settings>(() => loadStoredSettings());
  const [mode, setMode] = useState<Mode>(initialMode);
  const [input, setInput] = useState<InputSource>(initialInput);
  const [script, setScript] = useState<ScriptName>(initialScript);
  const [debug, setDebug] = useState(params.get('debug') === '1');
  const [panelOpen, setPanelOpen] = useState(params.get('panel') === '1');
  const [showcase, setShowcase] = useState(false);
  const [intro, setIntro] = useState(params.get('intro') !== '0' && !params.has('input') && !scriptParam);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [recording, setRecording] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [loadText, setLoadText] = useState('');
  const [notice, setNotice] = useState('');
  const [slowmo, setSlowmo] = useState(params.has('slowmo'));

  // Engine lifecycle.
  useEffect(() => {
    const engine = new EffectController();
    engineRef.current = engine;
    engine.setSettings(settings);
    engine.mode = initialMode;
    engine.debug = debug;
    engine.script = initialScript;
    void engine.setInput(initialInput);
    engine.mount(stageRef.current!);
    (window as unknown as { __zerog: EffectController }).__zerog = engine; // for automation/debugging
    const id = setInterval(() => setStats(engine.getStats()), 250);
    return () => {
      clearInterval(id);
      engine.unmount();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setSettings(settings);
    const t = setTimeout(() => storeSettings(settings), 200);
    return () => clearTimeout(t);
  }, [settings]);

  useEffect(() => {
    if (engineRef.current) engineRef.current.debug = debug;
  }, [debug]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.showHandles = !showcase;
  }, [showcase]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.timeScale = slowmo ? Number(params.get('slowmo')) || 0.25 : 1;
  }, [slowmo]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((m) => (m === msg ? '' : m)), 2600);
  }, []);

  const changeMode = useCallback((m: Mode) => {
    setMode(m);
    engineRef.current?.setMode(m);
  }, []);
  const changeInput = useCallback((i: InputSource) => {
    setInput(i);
    setIntro(false);
    const e = engineRef.current;
    if (e) void e.setInput(i).then(() => setInput(e.input));
  }, []);
  const changeScript = useCallback((s: ScriptName) => {
    setScript(s);
    setInput('script');
    setIntro(false);
    const e = engineRef.current;
    if (!e) return;
    void e.setInput('script');
    e.setScript(s);
    if (s === 'fusion') {
      setMode('fusion');
      e.setMode('fusion');
    }
  }, []);
  const resetEffect = useCallback(() => engineRef.current?.resetEffect(), []);

  const setParam = useCallback((key: string, value: number | boolean | string) => {
    setSettings((s) => ({ ...s, [key]: value }) as Settings);
  }, []);

  const copyJson = useCallback(async () => {
    const json = settingsToJson(settings);
    try {
      await navigator.clipboard.writeText(json);
      flash('Settings JSON copied to clipboard.');
    } catch {
      setLoadText(json);
      setLoadOpen(true);
      flash('Clipboard blocked — JSON shown in the dialog, copy it manually.');
    }
  }, [settings, flash]);

  const applyLoad = useCallback(() => {
    try {
      const { settings: next, applied } = parseSettingsJson(loadText, settings);
      setSettings(next);
      setLoadOpen(false);
      flash(`Loaded ${applied} values.`);
    } catch (e) {
      flash(`Invalid JSON: ${(e as Error).message}`);
    }
  }, [loadText, settings, flash]);

  const toggleRecord = useCallback(() => {
    const r = recorderRef.current;
    const e = engineRef.current;
    if (!e) return;
    if (r.recording) {
      r.stop();
      setRecording(false);
    } else {
      r.start(e.canvas);
      setRecording(true);
    }
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      switch (ev.key.toLowerCase()) {
        case 'd':
          setDebug((d) => !d);
          break;
        case 's':
          setPanelOpen((o) => !o);
          break;
        case 'm':
          setSettings((s) => ({ ...s, mirror: !s.mirror }));
          break;
        case 'r':
          resetEffect();
          break;
        case 'h':
          setShowcase((v) => !v);
          break;
        case 'escape':
          setShowcase(false);
          setLoadOpen(false);
          break;
        case '1':
          changeMode('sandbox');
          break;
        case '2':
          changeMode('fusion');
          break;
        case 'c':
          changeInput(input === 'camera' ? 'mouse' : 'camera');
          break;
        case 'v':
          if (CanvasRecorder.supported()) toggleRecord();
          break;
        case 'x':
          engineRef.current?.requestSplit();
          break;
        case 't':
          setSlowmo((v) => !v);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changeMode, changeInput, resetEffect, toggleRecord, input]);

  const fusionPurple = stats?.fusionState === 'PURPLE';

  return (
    <div className="app">
      <div className="stage" ref={stageRef} onDoubleClick={() => showcase && setShowcase(false)} />

      {!showcase && (
        <>
          <div className="status-pill">
            <span className={`dot ${stats?.effectState === 'LOST' || stats?.effectState === 'IDLE' ? 'off' : ''}`} />
            {mode === 'sandbox' ? 'Purple' : 'Blue + Red'} · {input}
            {stats && ` · ${stats.effectState}`}
            {slowmo && <span className="rec-dot">SLOW-MO</span>}
            {recording && <span className="rec-dot">REC</span>}
          </div>

          {debug && stats && (
            <pre className="stats">
              {`FPS           ${stats.fps.toFixed(0)}
tracker FPS   ${input === 'camera' ? stats.trackerFps.toFixed(0) : '-'}
state         ${stats.effectState}
anchor A      ${stats.anchorA}
anchor B      ${stats.anchorB}
confidence    ${input === 'camera' ? stats.confidence.toFixed(2) : '-'}
hands         ${stats.handsMode}
distance A-B  ${mode === 'fusion' ? stats.distance.toFixed(3) : '-'}
droplets      ${stats.droplets}
speed (u/s)   ${stats.speed.toFixed(2)}
deformation   ${stats.deformation.toFixed(2)} r
camera        ${stats.cameraStatus} / tracker ${stats.trackerStatus}
mirror        ${settings.mirror ? 'on' : 'off'}`}
              <span className="legend">
                {'\n'}× raw  ○ smoothed target  ● fluid center{'\n'}— velocity  — accel  · surface/tail points
              </span>
            </pre>
          )}

          {stats?.message && <div className="toast">{stats.message}</div>}
          {notice && !panelOpen && <div className="toast">{notice}</div>}

          {intro && (
            <div className="intro">
              <h1>Zero-G Energy</h1>
              <p>
                A liquid energy mass tethered to your fingertip. Hold up a hand and point your index finger — the mass
                follows with its own inertia.
              </p>
              <div className="intro-actions">
                <button className="primary" onClick={() => changeInput('camera')}>
                  Enable camera
                </button>
                <button onClick={() => changeInput('mouse')}>Play with mouse</button>
              </div>
              <p className="small">Camera processing runs locally in your browser. Nothing is uploaded.</p>
              <p className="small keys">
                D debug · S tuning · M mirror · R reset · 1/2 mode · C camera · H showcase · V record · T slow-mo
              </p>
            </div>
          )}

          <ModeBar
            mode={mode}
            input={input}
            script={script}
            debug={debug}
            panelOpen={panelOpen}
            recording={recording}
            canRecord={CanvasRecorder.supported()}
            fusionPurple={fusionPurple}
            onMode={changeMode}
            onInput={changeInput}
            onScript={changeScript}
            onDebug={() => setDebug((d) => !d)}
            onPanel={() => setPanelOpen((o) => !o)}
            onRecord={toggleRecord}
            onShowcase={() => setShowcase(true)}
            onReset={resetEffect}
            onSplit={() => engineRef.current?.requestSplit()}
          />

          {panelOpen && (
            <ControlPanel
              settings={settings}
              onChange={setParam}
              onCopy={copyJson}
              onLoad={() => {
                setLoadText('');
                setLoadOpen(true);
              }}
              onReset={() => {
                setSettings({ ...DEFAULT_SETTINGS });
                flash('Defaults restored.');
              }}
              onPreset={(n) => {
                setSettings(presetSettings(n));
                flash(`Preset “${n}” applied.`);
              }}
              onClose={() => setPanelOpen(false)}
              notice={notice}
            />
          )}

          {loadOpen && (
            <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
              <div className="modal-card">
                <strong>Settings JSON</strong>
                <textarea
                  value={loadText}
                  onChange={(e) => setLoadText(e.target.value)}
                  placeholder='Paste settings JSON, e.g. {"stiffness": 120, "damping": 12.5}'
                  spellCheck={false}
                  autoFocus
                />
                <div className="modal-actions">
                  <button onClick={() => setLoadOpen(false)}>Cancel</button>
                  <button className="primary" onClick={applyLoad}>
                    Apply
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {showcase && <div className="showcase-hint">H / Esc / double-click to show UI</div>}
    </div>
  );
}
