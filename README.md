# UniversalCollab Relay

The optional self-hosted relay for UniversalCollab: accounts, collab requests, shared scenes, fallback and multistream output. It runs on Node.js with MediaMTX and FFmpeg.

This repo is one of three:

| Repo | What it is |
|---|---|
| `universalcollab-app` | The desktop app (Electron). It controls OBS over OBS WebSocket. |
| `universalcollab-obs-plugin` | A plugin for regular OBS, for people who don't want a separate app |
| **`universalcollab-relay`** | This repo: the relay server both of them connect to |

Neither the app nor the plugin needs a relay to edit layouts. A relay is only needed for collaboration.

## Status

This is the relay part of the 1.0.0-rc.8 test source bundle, split out of the combined project. Installation and host notes are in the app repo under `docs/START-HERE-1.0.0-rc.8.md`. A standalone relay installer is planned and will be the last milestone.

## Layout

- `index.js`: entry point. It reads `config.json`, installs MediaMTX if it's missing, then starts `src/multi-controller.mjs`.
- `install.mjs`: downloads a pinned MediaMTX release and checks its hash.
- `src/`: the relay modules and the browser portal/studio UI the relay serves.
- `tests/`: relay and portal tests. The `*.py` live tests start temporary local relays.
- `build/`: release build tooling. `obfuscate.cjs` expects keys in a **private folder outside this repo**.

## Never commit

`config.json`, `data/`, `recordings/`, signing keys, relay passwords, platform tokens or stream keys. `.gitignore` blocks the usual paths.

## Known issues to fix

- `index.js` forces the control server to listen on all network interfaces (`0.0.0.0`) with remote HTTP allowed and TLS off by default, so relay passwords can travel unencrypted. Fix this before any public release.
- `index.js` prints "1.0.0-rc.5" while the release is rc.8.

## License

MIT (see `LICENSE`). FFmpeg, MediaMTX and Node.js have their own licenses (see `THIRD_PARTY.md`).
