# Bundled Android tools

Mirrune redistributes the following Windows x64 tools:

- Android SDK Platform-Tools 37.0.3 (`adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll`), downloaded from Google's official `platform-tools-latest-windows.zip` archive. The archive SHA-256 used for this bundle is `89d108360a3bf2924d3bea837239edaccc22fd6ff5befd3787c4348a9fe4f09d`. Google's bundled notices are included as `tools/adb/NOTICE.txt`.
- scrcpy-server 5.0.1, from the official [Genymobile scrcpy v5.0.1 Windows x64 release](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1). The source archive SHA-256 is `b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5`. Its Apache License 2.0 text is included as `tools/scrcpy/LICENSE.txt`.

The scrcpy server is distributed under Apache License 2.0. The Android Platform-Tools package's required attributions and notices accompany the bundled ADB files. These third-party components are unmodified.
