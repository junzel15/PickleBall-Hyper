package com.pickleballhyper

import android.speech.tts.TextToSpeech
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale

/**
 * Referee voice: Android TextToSpeech exposed to JavaScript
 * (the browser game used the Web Speech API for this).
 */
class SpeechModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  private var tts: TextToSpeech? = null
  @Volatile private var ready = false
  private var nextId = 0

  init {
    tts = TextToSpeech(reactContext.applicationContext) { status ->
      if (status == TextToSpeech.SUCCESS) {
        val engine = tts
        if (engine != null) {
          val res = engine.setLanguage(Locale.US)
          ready = res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED
          if (!ready) ready = engine.setLanguage(Locale.ENGLISH) >= TextToSpeech.LANG_AVAILABLE
        }
      }
    }
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun isReady(promise: Promise) {
    promise.resolve(ready)
  }

  @ReactMethod
  fun speak(text: String, pitch: Double, rate: Double, flush: Boolean) {
    val engine = tts ?: return
    if (!ready || text.isBlank()) return
    engine.setPitch(pitch.toFloat())
    engine.setSpeechRate(rate.toFloat())
    val mode = if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
    engine.speak(text, mode, null, "pb-${nextId++}")
  }

  @ReactMethod
  fun stop() {
    tts?.stop()
  }

  override fun invalidate() {
    tts?.stop()
    tts?.shutdown()
    tts = null
    ready = false
    super.invalidate()
  }

  companion object {
    const val NAME = "PickleSpeech"
  }
}
