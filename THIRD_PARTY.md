# Third-party components

This ZIP contains original relay source and a generated geometric fallback
image, not Node.js, FFmpeg or MediaMTX binaries.

- MediaMTX v1.21.0: https://github.com/bluenviron/mediamtx — MIT.
  The installer downloads official Linux x64/arm64 release archives and saves
  their LICENSE to vendor/LICENSE alongside the binary. Pinned hashes are in
  install.mjs. Redistribute the upstream license with any bundled binary.
- FFmpeg: https://ffmpeg.org — licensing depends on build configuration.
  It is supplied separately by the runtime image. This app requires libx264;
  hosts distributing FFmpeg builds/images must review their applicable GPL,
  source availability and other license obligations. The relay's MIT license
  does not relicense FFmpeg or its dependencies.
- Node.js: https://nodejs.org — distributed separately by the runtime image,
  with its own third-party notices.
- Pterodactyl/Node.js container images are independently maintained. The
  included egg is original integration configuration, not an endorsement.

No streamer artwork, avatars, personal branding, customer account details or
real stream credentials are included. Test credentials are fictional and only
used with temporary local instances.

## rc.2 packaging
The customer relay update contains an obfuscated program rather than the original module tree. The existing MIT notice remains in BASE-MIT-LICENSE.txt. No Node.js, FFmpeg or MediaMTX binary is bundled in that update. esbuild and javascript-obfuscator are build tools only; pinning information is in the private owner-source build files. Electron desktop packages retain their existing Electron/Chromium license files and the desktop MIT notice. No registry or activation is required.

The desktop includes ws 8.18.3 (MIT) for optional OBS WebSocket setup. Its full notice is included in DesktopSource/vendor/ws/LICENSE.
