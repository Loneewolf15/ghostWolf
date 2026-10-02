#!/usr/bin/env bash
# install-android-studio.sh
# Installs Android Studio to /usr/local/android-studio
# and sets up the CAPACITOR_ANDROID_STUDIO_PATH environment variable.
set -e

ARCHIVE="/tmp/android-studio.tar.gz"
INSTALL_DIR="/usr/local/android-studio"

echo "==> Checking archive..."
ls -lh "$ARCHIVE"

echo "==> Extracting to /usr/local/..."
sudo tar -xzf "$ARCHIVE" -C /usr/local/

echo "==> Installed at: $INSTALL_DIR"
ls "$INSTALL_DIR/bin/studio.sh"

# Create a launcher symlink
sudo ln -sf "$INSTALL_DIR/bin/studio.sh" /usr/local/bin/android-studio
echo "==> Symlink created: /usr/local/bin/android-studio"

# Add env vars to ~/.bashrc (idempotent)
if ! grep -q "CAPACITOR_ANDROID_STUDIO_PATH" ~/.bashrc; then
  echo "" >> ~/.bashrc
  echo "# Android Studio" >> ~/.bashrc
  echo "export CAPACITOR_ANDROID_STUDIO_PATH=\"$INSTALL_DIR/bin/studio.sh\"" >> ~/.bashrc
  echo "export ANDROID_HOME=\"\$HOME/Android/Sdk\"" >> ~/.bashrc
  echo "export PATH=\"\$PATH:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools\"" >> ~/.bashrc
  echo "==> Added env vars to ~/.bashrc"
fi

echo ""
echo "✅ Android Studio installed!"
echo ""
echo "Run this to launch it:"
echo "  android-studio &"
echo ""
echo "On first launch, let it install the Android SDK (~5GB)."
echo "Then come back and run: cd ~/Pictures/cue-main/android && npx cap open android"
