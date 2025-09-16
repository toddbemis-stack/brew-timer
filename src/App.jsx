import React, { useEffect, useMemo, useRef, useState } from 'react'

// Brew Timer App (Safari‑safe)
// All browser‑sensitive APIs are now guarded so iOS Safari/Chrome won’t white‑screen

export default function BrewTimerApp() {
  const now = () => Date.now()
  const pad = (n) => String(n).padStart(2, '0')
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

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
    preAlertSeconds: 60,
    continuousBeepMs: 1200,
  }

  const [settings, setSettings] = useState(defaultSettings)
  const [running, setRunning] = useState(false)
  const [startTs, setStartTs] = useState(null)
  const [pausedAccum, setPausedAccum] = useState(0)
  const [pauseTs, setPauseTs] = useState(null)
  const [lastFiredStageIds, setLastFiredStageIds] = useState(new Set())
  const [preAlertFiredIds, setPreAlertFiredIds] = useState(new Set())
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [activeAlert, setActiveAlert] = useState(null)

  const beeperRef = useRef(null)
  const appRef = useRef(null)
  const audioCtxRef = useRef(null)
  const wakeLockRef = useRef(null)
  const rafRef = useRef(null)

  useEffect(() => {
    const loop = () => {
      setTick((t) => (t + 1) % 1e9)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])
  const [, setTick] = useState(0)

  const elapsedMs = useMemo(() => {
    if (!running || !startTs) return 0
    const base = now() - startTs
    return clamp(base - pausedAccum, 0, settings.totalMinutes * 60_000)
  }, [running, startTs, pausedAccum, settings.totalMinutes])

  const elapsedSec = Math.floor(elapsedMs / 1000)
  const totalSec = settings.totalMinutes * 60
  const remainingSec = clamp(totalSec - elapsedSec, 0, totalSec)

  const sortedStages = useMemo(() => {
    const maxMin = settings.totalMinutes
    return settings.stages
      .map((s) => ({ ...s, minute: clamp(Math.round(Number(s.minute) || 0), 0, maxMin) }))
      .sort((a, b) => a.minute - b.minute)
  }, [settings.stages, settings.totalMinutes])

  const nextStage = useMemo(() => {
    const elMin = elapsedSec / 60
    return sortedStages.find((s) => s.minute > elMin) || null
  }, [sortedStages, elapsedSec])

  const progressPct = 100 * (elapsedSec / totalSec)

  function ensureAudio() {
    if (!audioCtxRef.current && typeof window !== 'undefined') {
      const AC = window.AudioContext || window.webkitAudioContext
      if (AC) audioCtxRef.current = new AC()
    }
    return audioCtxRef.current
  }

  function playSound(kind = 'beep', duration = 1000) {
    const ctx = ensureAudio()
    if (!ctx) return
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    const nowT = ctx.currentTime
    g.gain.setValueAtTime(0, nowT)
    g.gain.linearRampToValueAtTime(clamp(settings.volume, 0, 1), nowT + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, nowT + duration / 1000)

    if (kind === 'beep') o.type = 'sine', o.frequency.setValueAtTime(880, nowT)
    else if (kind === 'bell') o.type = 'triangle', o.frequency.setValueAtTime(660, nowT)
    else if (kind === 'airhorn') o.type = 'square', o.frequency.setValueAtTime(220, nowT)
    else if (kind === 'chirp') {
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(400, nowT)
      o.frequency.exponentialRampToValueAtTime(1200, nowT + 0.4)
    }
    else o.type = 'sine', o.frequency.setValueAtTime(880, nowT)

    o.connect(g); g.connect(ctx.destination)
    o.start(); o.stop(nowT + duration / 1000)
  }

  function startContinuousBeep(kind) {
    stopContinuousBeep()
    playSound(kind, 900)
    beeperRef.current = setInterval(() => playSound(kind, 900), settings.continuousBeepMs)
  }
  function stopContinuousBeep() {
    if (beeperRef.current) clearInterval(beeperRef.current), beeperRef.current = null
  }

  function visualFlash() {
    if (settings.flashScreen && appRef.current) {
      appRef.current.classList.add('animate-[flash_800ms_ease-in-out_2]')
      setTimeout(() => appRef.current?.classList.remove('animate-[flash_800ms_ease-in-out_2]'), 1600)
    }
  }

  function triggerPreAlert(stage) {
    playSound('chirp', 900)
    if (settings.vibrate && typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate([120])
    visualFlash()
    if (typeof Notification !== 'undefined' && permission === 'granted') {
      new Notification(`Next up: ${stage.label}`, { body: `In ${settings.preAlertSeconds}s`, tag: 'brew-timer-pre' })
    }
    setActiveAlert({ type: 'pre', stage, startedAt: now() })
  }

  function triggerStageAlert(stage) {
    visualFlash()
    startContinuousBeep(stage.sound || 'beep')
    if (settings.vibrate && typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate([200, 100, 200])
    if (typeof Notification !== 'undefined' && permission === 'granted') {
      new Notification(`Stage: ${stage.label}`, { body: `Reached ${stage.minute}`, tag: 'brew-timer' })
    }
    setActiveAlert({ type: 'stage', stage, startedAt: now() })
  }

  function acknowledgeAlert() {
    stopContinuousBeep()
    setActiveAlert(null)
  }

  async function requestNotifications() {
    if (typeof Notification === 'undefined') return
    const p = await Notification.requestPermission()
    setPermission(p)
  }

  async function toggleWakeLock() {
    try {
      if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
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

  function start() {
    setStartTs(now())
    setPausedAccum(0)
    setPauseTs(null)
    setRunning(true)
    setLastFiredStageIds(new Set())
    setPreAlertFiredIds(new Set())
    setActiveAlert(null)
    stopContinuousBeep()
  }

  function pause() { setRunning(false); setPauseTs(now()) }
  function resume() {
    if (!running && pauseTs) {
      setPausedAccum((x) => x + (now() - pauseTs))
      setPauseTs(null); setRunning(true)
    }
  }
  function reset() {
    setRunning(false); setStartTs(null); setPausedAccum(0); setPauseTs(null)
    setLastFiredStageIds(new Set()); setPreAlertFiredIds(new Set())
    setActiveAlert(null); stopContinuousBeep()
  }

  useEffect(() => {
    if (!running) return
    const el = elapsedSec
    sortedStages.forEach((s) => {
      const sSec = s.minute * 60
      if (settings.preAlertSeconds > 0 && el >= sSec - settings.preAlertSeconds && el < sSec && !preAlertFiredIds.has(s.id)) {
        triggerPreAlert(s)
        setPreAlertFiredIds((prev) => new Set(prev).add(s.id))
      }
      if (el >= sSec && !lastFiredStageIds.has(s.id)) {
        triggerStageAlert(s)
        setLastFiredStageIds((prev) => new Set(prev).add(s.id))
      }
    })
  }, [elapsedSec, running, sortedStages, lastFiredStageIds, preAlertFiredIds, settings.preAlertSeconds])

  function formatHMS(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    return (h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`)
  }

  function toggleFullscreen() {
    const el = appRef.current
    if (!el) return
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.()
  }

  return (
    <div ref={appRef} className="min-h-screen w-full bg-neutral-950 text-neutral-50 flex flex-col items-center p-4 select-none">
      <style>{`@keyframes flash { 0%,100%{background-color:transparent} 50%{background-color:#ef4444} }`}</style>
      <div className="w-full max-w-3xl">
        <header className="flex items-center justify-between gap-2 py-2">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Brew Timer</h1>
          <div className="flex items-center gap-2">
            <button onClick={toggleFullscreen} className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">Fullscreen</button>
            <button onClick={toggleWakeLock} className={`px-3 py-2 rounded-xl ${wakeLockActive ? 'bg-emerald-700' : 'bg-neutral-800'}`}>{wakeLockActive ? 'Keep Awake: ON' : 'Keep Awake'}</button>
            <button onClick={requestNotifications} className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">Notify: {permission}</button>
          </div>
        </header>
        {activeAlert && (
          <div className={`mt-2 rounded-3xl ${activeAlert.type === 'stage' ? 'bg-red-700' : 'bg-amber-600'} p-4 flex items-center justify-between`}>
            <div>
              <div className="font-bold">{activeAlert.type === 'stage' ? 'ALERT' : 'HEADS-UP'}</div>
              <div className="text-xl font-extrabold">{activeAlert.stage.label}</div>
            </div>
            <button onClick={acknowledgeAlert} className="px-4 py-3 rounded-2xl bg-neutral-900 hover:bg-neutral-800 font-semibold">Acknowledge</button>
          </div>
        )}
        <div className="mt-2 rounded-3xl bg-neutral-900 p-4">
          <div className="text-center">
            <div className="text-neutral-400 text-sm">Elapsed</div>
            <div className="text-5xl md:text-7xl font-black">{formatHMS(elapsedSec)}</div>
            <div className="text-neutral-400 text-sm mt-1">Remaining</div>
            <div className="text-3xl md:text-5xl font-extrabold">{formatHMS(remainingSec)}</div>
            <div className="mt-4 h-3 rounded-full bg-neutral-800 overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="mt-4 flex gap-2 justify-center">
              {!running && !startTs && (<button onClick={start} className="px-5 py-3 rounded-2xl bg-emerald-600">Start</button>)}
              {running && (<button onClick={pause} className="px-5 py-3 rounded-2xl bg-amber-600">Pause</button>)}
              {!running && startTs && (<button onClick={resume} className="px-5 py-3 rounded-2xl bg-emerald-600">Resume</button>)}
              <button onClick={reset} className="px-5 py-3 rounded-2xl bg-neutral-700">Reset</button>
            </div>
            <div className="mt-4 text-neutral-300 text-sm">
              {nextStage ? <div>Next: <b>{nextStage.label}</b> at {nextStage.minute}:00</div> : <div>All stages complete.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function cryptoId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'id-' + Math.random().toString(36).slice(2)
}