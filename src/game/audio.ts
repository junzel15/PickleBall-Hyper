// Tiny synth sound effects — the same Web Audio recipes as the browser game,
// played natively through react-native-audio-api (no sound files needed).
import { AudioContext } from 'react-native-audio-api';

type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

let actx: AudioContext | null = null;
let muted = false;

export function ensureAudio(): void {
  if (!actx) {
    try {
      actx = new AudioContext();
    } catch {
      actx = null;
    }
  }
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
}

export function setMuted(m: boolean): void { muted = m; }
export function isMuted(): boolean { return muted; }

/** Pause / resume all sound when the app goes to the background. */
export function suspendAudio(on: boolean): void {
  if (!actx) return;
  (on ? actx.suspend() : actx.resume()).catch(() => {});
}

function tone(freq: number, dur: number, type: Wave = 'sine', vol = 0.2, slide = 0, delay = 0): void {
  if (!actx || muted) return;
  try {
    const t = actx.currentTime + delay;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {
    /* audio engine unavailable */
  }
}

export const sfx = {
  hit() { tone(1150, 0.05, 'square', 0.06, 0.5); tone(540, 0.09, 'triangle', 0.2, 0.6); },
  smash() { tone(1500, 0.06, 'square', 0.09, 0.4); tone(420, 0.14, 'sawtooth', 0.12, 0.35); tone(90, 0.2, 'sine', 0.25, 0.6); },
  soft() { tone(700, 0.06, 'triangle', 0.14, 0.7); },
  bounce(v: number) { tone(320, 0.07, 'triangle', 0.13 * v, 0.7); },
  net() { tone(150, 0.18, 'sawtooth', 0.07, 0.6); },
  good() { [523, 659, 784].forEach((f, i) => tone(f, 0.16, 'triangle', 0.12, 0, i * 0.08)); },
  bad() { [392, 330].forEach((f, i) => tone(f, 0.2, 'triangle', 0.1, 0, i * 0.1)); },
  win() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.25, 'triangle', 0.13, 0, i * 0.11)); },
  power() { // deep boom + crack + rising zing
    tone(70, 0.45, 'sine', 0.4, 0.5);
    tone(1800, 0.08, 'square', 0.1, 0.3);
    tone(500, 0.25, 'sawtooth', 0.12, 2.2, 0.02);
  },
  charge() { tone(300, 0.25, 'sawtooth', 0.07, 3); tone(600, 0.3, 'triangle', 0.1, 2, 0.08); },
  full() { [784, 1046, 1318].forEach((f, i) => tone(f, 0.14, 'triangle', 0.1, 0, i * 0.06)); },
  deny() { tone(140, 0.16, 'square', 0.06, 0.8); },
  whistle() {
    if (!actx || muted) return;
    try {
      const t = actx.currentTime;
      const o = actx.createOscillator(), lfo = actx.createOscillator();
      const lg = actx.createGain(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = 2900;
      lfo.frequency.value = 38; lg.gain.value = 140; // pea-whistle trill
      lfo.connect(lg);
      lg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
      g.gain.setValueAtTime(0.09, t + 0.28);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t); lfo.start(t); o.stop(t + 0.4); lfo.stop(t + 0.4);
    } catch {
      /* audio engine unavailable */
    }
  },
};
