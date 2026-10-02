package com.ghostwolf.android;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;
import com.ghostwolf.plugins.privacy.GhostWolfPrivacyPlugin;
import com.ghostwolf.plugins.audio.GhostWolfAudioPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom native plugins before super.onCreate
        registerPlugin(GhostWolfPrivacyPlugin.class);
        registerPlugin(GhostWolfAudioPlugin.class);
        super.onCreate(savedInstanceState);

        // Apply FLAG_SECURE immediately so no window frame leaks before JS loads.
        // The JS layer can toggle it off via GhostWolfPrivacy.setSecure({ secure: false }).
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }
}

