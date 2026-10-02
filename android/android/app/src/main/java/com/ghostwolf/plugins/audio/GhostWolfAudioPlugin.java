package com.ghostwolf.plugins.audio;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * GhostWolfAudioPlugin — Captures system audio via Android MediaProjection API.
 *
 * Requires Android 10+ (API 29).
 * Triggers the system permission dialog once; permission is remembered per-session.
 *
 * JS usage:
 *   const stream = await window.GhostWolfAudio.startCapture()
 *   window.GhostWolfAudio.stopCapture()
 */
@CapacitorPlugin(name = "GhostWolfAudio")
public class GhostWolfAudioPlugin extends Plugin {

    private static final int SAMPLE_RATE   = 16000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT  = AudioFormat.ENCODING_PCM_16BIT;

    private MediaProjection mediaProjection;
    private AudioRecord     audioRecord;
    private Thread          captureThread;
    private PluginCall      pendingCall;
    private boolean         isCapturing = false;

    @PluginMethod
    public void startCapture(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("System audio capture requires Android 10 or later.");
            return;
        }
        if (isCapturing) {
            call.resolve(new JSObject().put("status", "already_capturing"));
            return;
        }
        this.pendingCall = call;
        // Trigger the MediaProjection permission dialog
        MediaProjectionManager mgr = (MediaProjectionManager)
            getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        Intent intent = mgr.createScreenCaptureIntent();
        startActivityForResult(call, intent, "handleProjectionResult");
    }

    @ActivityCallback
    private void handleProjectionResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("System audio permission denied by user.");
            return;
        }
        MediaProjectionManager mgr = (MediaProjectionManager)
            getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        mediaProjection = mgr.getMediaProjection(result.getResultCode(), result.getData());

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            AudioPlaybackCaptureConfiguration config =
                new AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();

            int bufSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
            audioRecord = new AudioRecord.Builder()
                .setAudioFormat(new AudioFormat.Builder()
                    .setEncoding(AUDIO_FORMAT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_CONFIG)
                    .build())
                .setBufferSizeInBytes(bufSize * 4)
                .setAudioPlaybackCaptureConfig(config)
                .build();

            isCapturing = true;
            audioRecord.startRecording();

            // Note: For real streaming to the JS layer, a more complex bridge using
            // WebRTC or a local audio server is needed. This plugin returns a
            // "started" status and the audio is processed server-side via the
            // AudioWorklet in stt-mobile.js listening to the MediaStream.
            // Full implementation requires Capacitor's JSObject streaming or a
            // local WebSocket audio bridge (Phase 2 scope).
            call.resolve(new JSObject().put("status", "capturing").put("sampleRate", SAMPLE_RATE));
        }
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        isCapturing = false;
        if (audioRecord != null) {
            audioRecord.stop();
            audioRecord.release();
            audioRecord = null;
        }
        if (mediaProjection != null) {
            mediaProjection.stop();
            mediaProjection = null;
        }
        if (call != null) call.resolve(new JSObject().put("status", "stopped"));
    }
}
