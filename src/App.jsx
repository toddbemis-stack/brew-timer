import React, { useEffect, useMemo, useRef, useState } from 'react'

// Phone‑friendly brewing timer (updated)
// New:
// - Continuous beeping until ACK for main stage alerts
// - 60‑second "Next Up" pre‑alert (single chirp)
// - Big on‑screen ACK banner
// - Everything persists and remains PWA‑friendly

export default function BrewTimerApp() {
  // ---------- Helpers
  const now = () => Date.now()
  const pad = (n) => String(n).padStart(2, '0')
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

  // ---------- Persistence keys
  const LS_KEY = 'brewTimer.settings.v2' // bumped for new defaults

  // ---------- Defaults
  const defaultSettings = {
    totalMinutes: 60,
    stages: [
      { id: cryptoId(), label: 'Hop Add #1', minute: 30, sound: 'beep' },
      { id: cryptoId(), label: 'Hop Add #2', minute: 45, sound: 'bell' },
      { id: cryptoId(), label: 'Hop Add #3', minute: 55, sound: 'airhorn' },
      { id: cryptoId(), label: 'Flame Out',  minute: 60, sound: 'beep' },
    ],
    flashScreen: true,
    vibrate: true,
    volume: 0.8,
    preAlertSeconds: 60,  // NEW: heads‑up lead time
    continuousBeepMs: 1200, // NEW: repeat sound cadence when un‑ACKed
  }

  // ---------- State
  const [settings, setSettings] = useState(() => {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return defaultSettings
    try {
      const parsed = JSON.parse(raw)
      const stages = (parsed.stages || []).map((s) => ({ id: s.id || cryptoId(), ...s }))
      return { ...defaultSettings, ...parsed, stages }
    } catch { return defaultSettings }
  })

  const [running, setRunning] = useState(false)
  const [startTs, setStartTs] = useState(null)
  const [pausedAccum, setPausedAccum] = useState(0)
  const [pauseTs, setPauseTs] = useState(null)
  const [lastFiredStageIds, setLastFiredStageIds] = useState(new Set())
  const [preAlertFiredIds, setPreAlertFiredIds] = useState(new Set()) // NEW
  const [permission, setPermission] = useState(Notification?.permission || 'default')
  const [wakeLockActive, setWakeLockActive] = useState(false)

  // Active alert banner state
  const [activeAlert, setActiveAlert] = useState(null) // {type:'stage'|'pre', stage, startedAt}
  const beeperRef = useRef(null)

  const appRef = useRef(null)
  const audioCtxRef = useRef(null)
  const wakeLockRef = useRef(null)
  const rafRef = useRef(null)

  // ---------- Effects: persist settings
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(settings))
  }, [settings])

  // ---------- Ticker
  const [, setTick] = useState(0)
  useEffect(() => {
    const loop = () => {
      setTick((t) => (t + 1) % 1e9)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // ---------- Derived time
  const elapsedMs = useMemo(() => {
    if (!running || !startTs) return 0
    const base = now() - startTs
    return clamp(base - pausedAccum, 0, settings.totalMinutes * 60_000)
  }, [running, startTs, pausedAccum, settings.totalMinutes])

  const elapsedSec = Math.floor(elapsedMs / 1000)
  const totalSec = settings.totalMinutes * 60
  const remainingSec = clamp(totalSec - elapsedSec, 0, totalSec)

  // ---------- Stage calculations
  const sortedStages = useMemo(() => {
    const maxMin = settings.totalMinutes
    const canonical = settings.stages
      .map((s) => ({ ...s, minute: clamp(Math.round(Number(s.minute) || 0), 0, maxMin) }))
      .sort((a, b) => a.minute - b.minute)
    return canonical
  }, [settings.stages, settings.totalMinutes])

  const nextStage = useMemo(() => {
    const elMin = elapsedSec / 60
    return sortedStages.find((s) => s.minute > elMin) || null
  }, [sortedStages, elapsedSec])

  const progressPct = 100 * (elapsedSec / totalSec)

  // ---------- Audio (Web Audio API)
  function ensureAudio() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    return audioCtxRef.current
  }

  function playSound(kind = 'beep', duration = 1000) {
    const ctx = ensureAudio()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    const nowT = ctx.currentTime
    g.gain.setValueAtTime(0, nowT)
    g.gain.linearRampToValueAtTime(clamp(settings.volume, 0, 1), nowT + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, nowT + duration / 1000)

    if (kind === 'beep') {
      o.type = 'sine'; o.frequency.setValueAtTime(880, nowT)
    } else if (kind === 'bell') {
      o.type = 'triangle'; o.frequency.setValueAtTime(660, nowT)
    } else if (kind === 'airhorn') {
      o.type = 'square'; o.frequency.setValueAtTime(220, nowT)
    } else if (kind === 'chirp') {
      o.type = 'sawtooth'; o.frequency.setValueAtTime(400, nowT); o.frequency.exponentialRampToValueAtTime(1200, nowT + 0.4)
    } else {
      o.type = 'sine'; o.frequency.setValueAtTime(880, nowT)
    }

    o.connect(g); g.connect(ctx.destination)
    o.start(); o.stop(nowT + duration / 1000)
  }

  // Continuous beeping until ACK (for main stage alerts)
  function startContinuousBeep(kind) {
    stopContinuousBeep()
    playSound(kind, 900)
    beeperRef.current = setInterval(() => playSound(kind, 900), settings.continuousBeepMs)
  }
  function stopContinuousBeep() {
    if (beeperRef.current) {
      clearInterval(beeperRef.current)
      beeperRef.current = null
    }
  }

  // ---------- Notifications, Vibration, Flash
  function visualFlash() {
    if (settings.flashScreen && appRef.current) {
      appRef.current.classList.add('animate-[flash_800ms_ease-in-out_2]')
      setTimeout(() => appRef.current?.classList.remove('animate-[flash_800ms_ease-in-out_2]'), 1600)
    }
  }

  function triggerPreAlert(stage) {
    // single chirp + small vibration + notification (no continuous loop)
    try { playSound('chirp', 900) } catch {}
    if (settings.vibrate && 'vibrate' in navigator) navigator.vibrate([120])
    visualFlash()
    if (permission === 'granted' && 'Notification' in window) {
      new Notification(`Next up: ${stage.label}`, { body: `In ${settings.preAlertSeconds}s (min ${stage.minute})`, tag: 'brew-timer-pre' })
    }
    setActiveAlert({ type: 'pre', stage, startedAt: now() })
  }

  function triggerStageAlert(stage) {
    visualFlash()
    // Start continuous beeping until ACK
    startContinuousBeep(stage.sound || 'beep')
    if (settings.vibrate && 'vibrate' in navigator) navigator.vibrate([200, 100, 200, 100, 200])
    if (permission === 'granted' && 'Notification' in window) {
      new Notification(`Stage: ${stage.label}`, { body: `Reached ${stage.minute} of ${settings.totalMinutes}`, tag: 'brew-timer' })
    }
    setActiveAlert({ type: 'stage', stage, startedAt: now() })
  }

  function acknowledgeAlert() {
    stopContinuousBeep()
    setActiveAlert(null)
  }

  async function requestNotifications() {
    if (!('Notification' in window)) return
    const p = await Notification.requestPermission()
    setPermission(p)
  }

  // ---------- Wake Lock
  const [wakeSupported] = useState(() => 'wakeLock' in navigator)
  async function toggleWakeLock() {
    try {
      if (!wakeSupported) return
      if (!wakeLockRef.current) {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
        setWakeLockActive(true)
        wakeLockRef.current.addEventListener('release', () => setWakeLockActive(false))
      } else {
        await wakeLockRef.current.release()
        wakeLockRef.current = null
        setWakeLockActive(false)
      }
    } catch (e) {
      console.warn('WakeLock error', e)
    }
  }

  // ---------- Controls
  function start() {
    if (!running) {
      setStartTs(now())
      setPausedAccum(0)
      setPauseTs(null)
      setRunning(true)
      setLastFiredStageIds(new Set())
      setPreAlertFiredIds(new Set())
      setActiveAlert(null)
      stopContinuousBeep()
    }
  }

  function pause() {
    if (running) {
      setRunning(false)
      setPauseTs(now())
    }
  }

  function resume() {
    if (!running && pauseTs) {
      const additional = now() - pauseTs
      setPausedAccum((x) => x + additional)
      setPauseTs(null)
      setRunning(true)
    }
  }

  function reset() {
    setRunning(false)
    setStartTs(null)
    setPausedAccum(0)
    setPauseTs(null)
    setLastFiredStageIds(new Set())
    setPreAlertFiredIds(new Set())
    setActiveAlert(null)
    stopContinuousBeep()
  }

  function addStage() {
    const nextMinute = clamp((sortedStages.at(-1)?.minute ?? 0) + 5, 0, settings.totalMinutes)
    setSettings((s) => ({ ...s, stages: [...s.stages, { id: cryptoId(), label: `Stage ${s.stages.length + 1}`, minute: nextMinute, sound: 'beep' }] }))
  }

  function updateStage(id, patch) {
    setSettings((s) => ({ ...s, stages: s.stages.map((st) => (st.id === id ? { ...st, ...patch } : st)) }))
  }

  function removeStage(id) {
    setSettings((s) => ({ ...s, stages: s.stages.filter((st) => st.id !== id) }))
  }

  // ---------- Stage firing logic (pre + main)
  useEffect(() => {
    if (!running) return
    const el = elapsedSec

    sortedStages.forEach((s) => {
      const sSec = s.minute * 60

      // Pre‑alert window: exactly once when we cross (sSec - preAlertSeconds)
      if (
        settings.preAlertSeconds > 0 &&
        el >= sSec - settings.preAlertSeconds &&
        el < sSec &&
        !preAlertFiredIds.has(s.id)
      ) {
        triggerPreAlert(s)
        setPreAlertFiredIds((prev) => new Set(prev).add(s.id))
      }

      // Main alert at or after the stage minute (only once)
      if (el >= sSec && !lastFiredStageIds.has(s.id)) {
        triggerStageAlert(s)
        setLastFiredStageIds((prev) => new Set(prev).add(s.id))
      }
    })
  }, [elapsedSec, running, sortedStages, lastFiredStageIds, preAlertFiredIds, settings.preAlertSeconds])

  // ---------- Formatting helpers
  function formatHMS(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    return (h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`)
  }

  // ---------- Fullscreen
  function toggleFullscreen() {
    const el = appRef.current
    if (!el) return
    if (!document.fullscreenElement) el.requestFullscreen().catch(() => {})
    else document.exitFullscreen()
  }

  // ---------- UI
  return (
    <div ref={appRef} className="min-h-screen w-full bg-neutral-950 text-neutral-50 flex flex-col items-center p-4 select-none">
      {/* Flash animation keyframes */}
      <style>{`@keyframes flash { 0%,100%{background-color:transparent} 50%{background-color:#ef4444} }`}</style>

      <div className="w-full max-w-3xl">
        <header className="flex items-center justify-between gap-2 py-2">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Brew Timer</h1>
          <div className="flex items-center gap-2">
            <button onClick={toggleFullscreen} className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 active:scale-95">Fullscreen</button>
            <button onClick={toggleWakeLock} className={`px-3 py-2 rounded-xl ${wakeLockActive ? 'bg-emerald-700' : 'bg-neutral-800 hover:bg-neutral-700'} active:scale-95`}>
              {wakeLockActive ? 'Keep Awake: ON' : (wakeSupported ? 'Keep Awake' : 'Keep Awake N/A')}
            </button>
            <button onClick={requestNotifications} className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 active:scale-95">Notify: {permission}</button>
          </div>
        </header>

        {/* Active alert banner */}
        {activeAlert && (
          <div className={`mt-2 rounded-3xl ${activeAlert.type === 'stage' ? 'bg-red-700' : 'bg-amber-600'} p-4 md:p-5 flex items-center justify-between gap-3 shadow-lg`}>
            <div className="text-sm md:text-base">
              <div className="font-bold uppercase tracking-wide">{activeAlert.type === 'stage' ? 'ALERT' : 'HEADS‑UP'}</div>
              <div className="text-xl md:text-2xl font-extrabold">{activeAlert.stage.label}</div>
              <div className="opacity-90">{activeAlert.type === 'stage' ? 'It\'s time!' : `Happens in ~${settings.preAlertSeconds}s`}</div>
            </div>
            <button onClick={acknowledgeAlert} className="px-4 py-3 rounded-2xl bg-neutral-900 hover:bg-neutral-800 font-semibold">Acknowledge</button>
          </div>
        )}

        {/* Big timer */}
        <div className="mt-2 rounded-3xl bg-neutral-900 p-4 md:p-6 shadow-inner">
          <div className="text-center">
            <div className="text-neutral-400 text-sm">Elapsed</div>
            <div className="text-5xl md:text-7xl font-black tabular-nums">{formatHMS(elapsedSec)}</div>
            <div className="text-neutral-400 text-sm mt-1">Remaining</div>
            <div className="text-3xl md:text-5xl font-extrabold tabular-nums">{formatHMS(remainingSec)}</div>

            {/* Progress */}
            <div className="mt-4 h-3 rounded-full bg-neutral-800 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progressPct}%` }} />
            </div>

            {/* Controls */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {!running && !startTs && (
                <button onClick={start} className="px-5 py-3 rounded-2xl text-lg font-semibold bg-emerald-600 hover:bg-emerald-500 active:scale-95">Start</button>
              )}
              {running && (
                <button onClick={pause} className="px-5 py-3 rounded-2xl text-lg font-semibold bg-amber-600 hover:bg-amber-500 active:scale-95">Pause</button>
              )}
              {!running && startTs && (
                <button onClick={resume} className="px-5 py-3 rounded-2xl text-lg font-semibold bg-emerald-600 hover:bg-emerald-500 active:scale-95">Resume</button>
              )}
              <button onClick={reset} className="px-5 py-3 rounded-2xl text-lg font-semibold bg-neutral-700 hover:bg-neutral-600 active:scale-95">Reset</button>
            </div>

            {/* Next stage */}
            <div className="mt-4 text-neutral-300 text-sm">
              {nextStage ? (
                <div>Next: <span className="font-semibold">{nextStage.label}</span> at <span className="font-mono">{nextStage.minute}:00</span></div>
              ) : (
                <div>All stages complete.</div>
              )}
            </div>
          </div>
        </div>

        {/* Settings */}
        <section className="mt-4 rounded-3xl bg-neutral-900 p-4 md:p-6">
          <h2 className="text-xl font-bold mb-3">Boil & Stages</h2>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm text-neutral-400">Total Boil (minutes)</label>
              <input type="number" min={1} max={600} value={settings.totalMinutes}
                     onChange={(e) => setSettings((s) => ({ ...s, totalMinutes: clamp(Number(e.target.value || 0), 1, 600) }))}
                     className="mt-1 w-40 px-3 py-2 rounded-xl bg-neutral-800 outline-none focus:ring-2 ring-emerald-500" />
            </div>
            <div>
              <label className="block text-sm text-neutral-400">Pre‑Alert Lead (seconds)</label>
              <input type="number" min={0} max={300} value={settings.preAlertSeconds}
                     onChange={(e) => setSettings((s) => ({ ...s, preAlertSeconds: clamp(Number(e.target.value || 0), 0, 300) }))}
                     className="mt-1 w-40 px-3 py-2 rounded-xl bg-neutral-800 outline-none focus:ring-2 ring-emerald-500" />
            </div>
            <div>
              <label className="block text-sm text-neutral-400">Continuous Beep Every (ms)</label>
              <input type="number" min={500} max={5000} step={100} value={settings.continuousBeepMs}
                     onChange={(e) => setSettings((s) => ({ ...s, continuousBeepMs: clamp(Number(e.target.value || 0), 500, 5000) }))}
                     className="mt-1 w-48 px-3 py-2 rounded-xl bg-neutral-800 outline-none focus:ring-2 ring-emerald-500" />
            </div>
            <div className="ml-auto flex gap-3">
              <div>
                <label className="block text-sm text-neutral-400">Volume</label>
                <input type="range" min={0} max={1} step={0.01} value={settings.volume}
                       onChange={(e) => setSettings((s) => ({ ...s, volume: Number(e.target.value) }))}
                       className="mt-3 w-40" />
              </div>
              <div className="flex items-center gap-3 mt-6">
                <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.flashScreen} onChange={(e) => setSettings((s) => ({ ...s, flashScreen: e.target.checked }))} /> Flash</label>
                <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.vibrate} onChange={(e) => setSettings((s) => ({ ...s, vibrate: e.target.checked }))} /> Vibrate</label>
              </div>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-neutral-400">
                <tr>
                  <th className="text-left p-2">Label</th>
                  <th className="text-left p-2">Minute</th>
                  <th className="text-left p-2">Sound</th>
                  <th className="p-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedStages.map((s) => (
                  <tr key={s.id} className="border-b border-neutral-800">
                    <td className="p-2">
                      <input value={s.label}
                             onChange={(e) => updateStage(s.id, { label: e.target.value })}
                             className="w-full px-3 py-2 rounded-xl bg-neutral-800 outline-none focus:ring-2 ring-emerald-500" />
                    </td>
                    <td className="p-2 w-32">
                      <input type="number" min={0} max={settings.totalMinutes}
                             value={s.minute}
                             onChange={(e) => updateStage(s.id, { minute: clamp(Number(e.target.value || 0), 0, settings.totalMinutes) })}
                             className="w-full px-3 py-2 rounded-xl bg-neutral-800 outline-none focus:ring-2 ring-emerald-500" />
                    </td>
                    <td className="p-2 w-40">
                      <select value={s.sound}
                              onChange={(e) => updateStage(s.id, { sound: e.target.value })}
                              className="w-full px-3 py-2 rounded-xl bg-neutral-800 outline-none focus:ring-2 ring-emerald-500">
                        <option value="beep">Beep</option>
                        <option value="bell">Bell</option>
                        <option value="airhorn">Airhorn</option>
                        <option value="chirp">Chirp</option>
                      </select>
                    </td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => playSound(s.sound, 700)} className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">Test</button>
                        <button onClick={() => removeStage(s.id)} className="px-3 py-2 rounded-xl bg-red-700 hover:bg-red-600">Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <button onClick={addStage} className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">Add Stage</button>
            <div className="text-xs text-neutral-400">Tip: Stages fire at the exact minute; pre‑alerts fire {settings.preAlertSeconds}s before each stage.</div>
          </div>
        </section>

        {/* How to use */}
        <section className="mt-4 mb-10 rounded-3xl bg-neutral-900 p-4 md:p-6">
          <h2 className="text-xl font-bold mb-2">Tips</h2>
          <ul className="list-disc ml-5 space-y-1 text-neutral-300 text-sm">
            <li>Tap <span className="font-semibold">Notify</span> to allow system notifications.</li>
            <li>Tap <span className="font-semibold">Keep Awake</span> to stop your screen from sleeping (where supported).</li>
            <li>Add this page to your phone’s home screen for a native‑like feel.</li>
            <li>Volume, vibration, flashing, pre‑alert lead, and continuous cadence can be tuned above. Settings persist.</li>
            <li>During a main alert, the sound repeats until you tap <span className="font-semibold">Acknowledge</span>.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}

function cryptoId() {
  if ('randomUUID' in crypto) return crypto.randomUUID()
  return 'id-' + Math.random().toString(36).slice(2)
}
