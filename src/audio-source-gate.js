// audio-source-gate.js — Smart meeting detection and audio source prioritization.
//
// PROBLEM:
//   GhostWolf captures the full OS audio loopback via getDisplayMedia. When
//   the user is on Google Meet but switches to Telegram, notification pings
//   get transcribed and trigger irrelevant AI responses.
//
// SOLUTION:
//   AudioSourceGate tracks two heuristic signals on the 'them' (system audio)
//   channel to decide whether a meeting is active. When a meeting is active,
//   short notification-like audio bursts are blocked before reaching STT.
//
// Meeting Detection — 2-of-3 signals:
//   Signal 1 (Sustained Speech):  >= 2 speech events > 2000ms in last 60s
//   Signal 2 (Activity Ratio):    them channel active > 40% of last 30s
//   Signal 3 (Manual Override):   user explicitly set mode via UI
//
// Notification Gating (when meeting mode is active):
//   A buffer is classified as a notification spike and DROPPED when:
//     - bufferMs < 1500ms  AND
//     - peak RMS > 3x average RMS  (characteristic impulse/spike envelope)
//   Human speech has sustained energy; notification pings do not.
//
// The 'you' (microphone) channel is NEVER gated.

class AudioSourceGate {
  constructor() {
    // Manual mode override: 'auto' | 'meeting' | 'blocked'
    this.manualMode = 'auto';

    // Rolling window for sustained-speech signal (last 60s of events)
    this._speechEvents = []; // [{ ts, durationMs }]
    this.SPEECH_WINDOW_MS = 60000;
    this.SUSTAINED_THRESHOLD_MS = 2000; // speech > 2s counts as sustained
    this.SUSTAINED_MIN_COUNT = 2;       // need 2 sustained events to fire signal 1

    // Rolling activity tracker for activity-ratio signal (last 30s)
    this._activitySamples = []; // [{ ts, active: bool }]
    this.ACTIVITY_WINDOW_MS = 30000;
    this.ACTIVITY_RATIO_THRESHOLD = 0.40; // 40% of last 30s must be active

    // Cooldown: once meeting detected, hold for 90s after last evidence
    this._lastMeetingEvidenceTs = 0;
    this.MEETING_HOLD_MS = 90000;

    // Current auto-detection state
    this._autoDetected = false;
  }

  // Called by main.js VAD onSpeechEnd for the 'them' channel.
  recordSpeechEvent(channel, durationMs) {
    if (channel !== 'them') return;
    const now = Date.now();
    const cutoff = now - this.SPEECH_WINDOW_MS;
    this._speechEvents = this._speechEvents.filter(e => e.ts >= cutoff);
    this._speechEvents.push({ ts: now, durationMs });
    return this._recomputeAutoDetect();
  }

  // Called by main.js routeAudio for every 'them' buffer to track activity ratio.
  recordActivitySample(hasAudio) {
    const now = Date.now();
    const cutoff = now - this.ACTIVITY_WINDOW_MS;
    this._activitySamples = this._activitySamples.filter(s => s.ts >= cutoff);
    this._activitySamples.push({ ts: now, active: hasAudio });
  }

  // Recompute auto-detection based on current signals.
  _recomputeAutoDetect() {
    const now = Date.now();

    // Signal 1: Sustained speech events
    const cutoff60 = now - this.SPEECH_WINDOW_MS;
    const sustained = this._speechEvents.filter(
      e => e.ts >= cutoff60 && e.durationMs >= this.SUSTAINED_THRESHOLD_MS
    );
    const signal1 = sustained.length >= this.SUSTAINED_MIN_COUNT;

    // Signal 2: Activity ratio
    const cutoff30 = now - this.ACTIVITY_WINDOW_MS;
    const recentSamples = this._activitySamples.filter(s => s.ts >= cutoff30);
    let signal2 = false;
    if (recentSamples.length >= 10) {
      const activeCount = recentSamples.filter(s => s.active).length;
      signal2 = (activeCount / recentSamples.length) >= this.ACTIVITY_RATIO_THRESHOLD;
    }

    const wasDetected = this._autoDetected;
    if (signal1 || signal2) {
      this._autoDetected = true;
      this._lastMeetingEvidenceTs = now;
    } else if (now - this._lastMeetingEvidenceTs > this.MEETING_HOLD_MS) {
      this._autoDetected = false;
    }

    return wasDetected !== this._autoDetected; // true if state changed
  }

  // Returns true if a meeting is currently active.
  isMeetingActive() {
    if (this.manualMode === 'meeting') return true;
    if (this.manualMode === 'blocked') return false;
    return this._autoDetected;
  }

  // Returns the current status for the UI badge.
  getStatus() {
    if (this.manualMode === 'blocked') return { mode: 'blocked', label: 'Blocked', icon: 'blocked', active: false };
    if (this.manualMode === 'meeting') return { mode: 'meeting', label: 'Meeting', icon: 'meeting', active: true };
    if (this._autoDetected) return { mode: 'auto-meeting', label: 'Meeting (auto)', icon: 'meeting', active: true };
    return { mode: 'auto', label: 'Auto', icon: 'auto', active: false };
  }

  // Set manual override. mode: 'auto' | 'meeting' | 'blocked'
  setManualMode(mode) {
    if (!['auto', 'meeting', 'blocked'].includes(mode)) return;
    this.manualMode = mode;
  }

  // The core gate function. Returns true = allow through, false = drop.
  shouldPassThrough(channel, bufferMs, pcmBuffer) {
    // Microphone ('you') is NEVER gated.
    if (channel !== 'them') return true;

    // 'blocked' mode: always drop system audio.
    if (this.manualMode === 'blocked') return false;

    // Auto mode with no meeting detected: allow everything through.
    if (!this.isMeetingActive()) return true;

    // Meeting mode: gate notification-style spikes (short + impulsive energy).
    if (bufferMs < 1500) {
      const envelope = this._computeEnergyEnvelope(pcmBuffer);
      if (envelope && envelope.peakRms > envelope.avgRms * 3) {
        return false; // Notification spike — drop it
      }
    }

    return true;
  }

  // Compute peak vs average RMS for spike detection.
  _computeEnergyEnvelope(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length < 64) return null;
    const FRAME_BYTES = 320; // 10ms at 16kHz mono int16 = 160 samples * 2 bytes
    let sumRms = 0;
    let peakRms = 0;
    let frameCount = 0;

    for (let offset = 0; offset + FRAME_BYTES <= pcmBuffer.length; offset += FRAME_BYTES) {
      let sumSq = 0;
      for (let i = offset; i < offset + FRAME_BYTES; i += 2) {
        if (i + 1 >= pcmBuffer.length) break;
        const sample = pcmBuffer.readInt16LE(i);
        sumSq += sample * sample;
      }
      const rms = Math.sqrt(sumSq / (FRAME_BYTES / 2));
      sumRms += rms;
      if (rms > peakRms) peakRms = rms;
      frameCount++;
    }

    if (frameCount === 0) return null;
    return { avgRms: sumRms / frameCount, peakRms };
  }

  // Reset transient state (called on capture stop). manualMode intentionally preserved.
  reset() {
    this._speechEvents = [];
    this._activitySamples = [];
    this._autoDetected = false;
    this._lastMeetingEvidenceTs = 0;
  }
}

module.exports = { AudioSourceGate };
