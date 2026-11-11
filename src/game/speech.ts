// Referee voice through the app's native TextToSpeech module (android/.../SpeechModule.kt).
import { NativeModules } from 'react-native';

interface SpeechNative {
  isReady(): Promise<boolean>;
  speak(text: string, pitch: number, rate: number, flush: boolean): void;
  stop(): void;
}

const native: SpeechNative | undefined = NativeModules.PickleSpeech;

export const speech = {
  /** The device has a text-to-speech engine. */
  ok: !!native,
  /** Referee voice switch on the main menu. */
  on: true,
};

export function speak(text: string, pitch: number, interrupt: boolean): void {
  if (!native) return;
  try {
    native.speak(text, pitch, 1.08, interrupt);
  } catch {
    /* ignore */
  }
}

export function hushSpeech(): void {
  if (!native) return;
  try {
    native.stop();
  } catch {
    /* ignore */
  }
}

/** Resolves when the speech engine is ready (or after maxMs). */
export function waitForVoices(maxMs: number): Promise<void> {
  if (!native) return Promise.resolve();
  const start = Date.now();
  return new Promise(resolve => {
    const poll = () => {
      native
        .isReady()
        .then(ok => {
          if (ok || Date.now() - start > maxMs) resolve();
          else setTimeout(poll, 100);
        })
        .catch(() => resolve());
    };
    poll();
  });
}
