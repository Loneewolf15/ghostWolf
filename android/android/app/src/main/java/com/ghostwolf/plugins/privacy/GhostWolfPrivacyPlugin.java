package com.ghostwolf.plugins.privacy;

import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * GhostWolfPrivacyPlugin — Native Android plugin that controls FLAG_SECURE.
 *
 * When FLAG_SECURE is set, the OS blacks out this window in:
 *   - Screenshots (Power + Vol Down)
 *   - Screen recordings
 *   - MediaProjection captures (what Zoom/Meet use for screen sharing)
 *
 * JS usage:
 *   window.GhostWolfPrivacy.setSecure({ secure: true })
 *   window.GhostWolfPrivacy.setSecure({ secure: false })
 */
@CapacitorPlugin(name = "GhostWolfPrivacy")
public class GhostWolfPrivacyPlugin extends Plugin {

    @PluginMethod
    public void setSecure(PluginCall call) {
        boolean secure = call.getBoolean("secure", true);
        getActivity().runOnUiThread(() -> {
            if (secure) {
                getActivity().getWindow().setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE
                );
            } else {
                getActivity().getWindow().clearFlags(
                    WindowManager.LayoutParams.FLAG_SECURE
                );
            }
        });
        call.resolve(new JSObject().put("secure", secure));
    }
}
