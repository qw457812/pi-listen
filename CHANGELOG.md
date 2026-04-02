# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.0.7] - 2026-04-03

### Added
- **Configurable voice toggle shortcut** — the toggle shortcut (default
  `Ctrl+Shift+V`) can now be customized via `toggleShortcut` in global
  `~/.pi/agent/settings.json` under the `"voice"` key. Project-scoped overrides
  are intentionally ignored since Pi registers shortcuts statically at load time.
- **Shortcut validation** — invalid shortcut values are rejected with a warning
  and fall back to the default `ctrl+shift+v`. Validation requires modifier+key
  format (e.g. `ctrl+shift+v`, `alt+r`, `meta+shift+m`).
- **Debug output** — `/voice debug` now shows the configured toggle shortcut.

### Fixed
- **Pi API compatibility: session events** — `session_start` now uses per-event
  `event.reason` detection for new Pi API. Non-startup transitions trigger
  `voiceCleanup()` and sherpa recognizer cache clear before re-initialization.
  Legacy `session_switch` handler preserved for backward compatibility with older
  Pi versions.
- No auth API changes needed — pi-voice does not make direct LLM calls via
  `ModelRegistry`.
## [5.0.5] - 2026-03-26

### Fixed
- **Env-derived Deepgram keys stay runtime-only** — `DEEPGRAM_API_KEY` from the
  shell is no longer copied into `~/.pi/agent/settings.json` during startup or
  first-run auto-activation.
- **Explicit secret saves remain intentional** — keys entered during onboarding
  still go to `~/.env.secrets` or `~/.zshrc`, while runtime env resolution
  continues to take priority over stored config.
- **Report credit** — thanks to [@dvic](https://github.com/dvic) for reporting
  the remaining global config leak.

## [5.0.4] - 2026-03-18

### Fixed
- **Deepgram shutdown waits for server finals** — stream stop now sends
  `CloseStream`, waits for Deepgram to return the last finalized transcript, and
  only falls back to local finalization after a short timeout.
- **Single-fire Deepgram error handling** — streaming failures now close the
  session once, preventing duplicate error notifications and conflicting state
  transitions from `error` plus `close`.
- **Misaligned PCM buffers in sherpa path** — odd-offset `Buffer` inputs now
  fall back to `readInt16LE()` instead of throwing `RangeError` when converting
  audio samples.

### Added
- **Regression test for odd-offset PCM input** — `transcribeBuffer()` is now
  covered for pooled `Buffer` slices with non-2-byte-aligned offsets.

## [5.0.1] - 2026-03-16

### Security
- **API key no longer leaks into project config** — `deepgramApiKey` is stripped at serialization time when saving to project scope. Previously, env-derived API keys could be auto-persisted into `.pi/settings.json` inside repos, risking accidental credential commits.
- **Mic audio exfiltration blocked** — `localEndpoint` in project config is now restricted to loopback addresses only (localhost/127.0.0.1/::1). A malicious repo can no longer redirect microphone audio to a remote server.
- **Shell injection prevented in API key onboarding** — API keys are now escaped using single-quote shell escaping before writing to `~/.env.secrets` or `~/.zshrc`. Keys with embedded newlines are rejected. New secrets files are created with `0600` permissions.

### Fixed
- **Atomic config writes** — settings are now written to a temp file and renamed, preventing corruption from partial writes or concurrent saves.
- **Deleting active model no longer leaves broken config** — when the active local model is deleted from the settings panel, config switches to another downloaded model (or clears the selection) instead of leaving a dangling reference.
- **Timeout timer cleanup** — the 120s transcription timeout in local mode is now properly cleared when transcription finishes early, preventing resource leaks.
- **Config parse errors logged** — `readJsonFile()` now logs warnings to stderr instead of silently swallowing parse/read errors.
- **Inconsistent default model** — settings panel now uses `parakeet-v3` as fallback instead of `whisper-small`, matching `DEFAULT_LOCAL_MODEL`.

### Added
- 19 new regression tests covering secret stripping, endpoint validation, atomic writes, shell escaping, and loopback detection.

## [4.0.0] - 2026-03-14

### Removed
- **All voice commands and text processing** — removed "undo", "clear", "new line", and all other voice commands. Removed all punctuation shortcuts ("period", "comma", etc.). Deleted `text-processing.ts` module entirely. Live streaming transcription writes text to the editor before voice commands can be detected, making them fundamentally unreliable. pi-listen now does one thing well: hold space to record, release to transcribe.

## [3.4.0] - 2026-03-14

### Removed
- **Non-functional voice commands** — Pi's extension API doesn't support triggering keybindings, slash commands, or message submission. Removed all voice commands: session management, model switching, thinking control, display toggles, dev commands, control commands, "hey pi" prefix, and submit/send/stop. Kept editor text manipulation (undo, clear, new line) and dictation shortcuts (punctuation, brackets, symbols).

## [3.3.3] - 2026-03-14

### Added
- **Banner and preview images** — terminal banner in `assets/banner.png`, refreshed docs hero in `docs/images/hero.png`, and social preview card in `docs/images/social-preview.png`

## [3.3.2] - 2026-03-14

### Added
- **Documentation images** — photorealistic terminal hero and voice command screenshots in `docs/images/hero.png` and `docs/images/voice-commands.png`

## [3.3.1] - 2026-03-14

### Added
- **External editor voice command** — say "open editor", "external editor", or "vim" to launch `/editor`

## [3.3.0] - 2026-03-14

### Added
- **Session management commands** — "new session", "compact", "fork", "resume", "tree", "reload", "settings" trigger their `/slash` equivalents
- **Model switching commands** — "switch model", "next model", "previous model", "change to X" for model picker and direct selection
- **Thinking commands** — "cycle thinking", "more thinking", "thinking level" to cycle levels; "show/hide/toggle thinking" for visibility
- **Display commands** — "expand/collapse/show/hide tools" for tool call display
- **Editor commands** — "select all", "clear all" variants
- **Control commands** — "stop", "cancel", "abort" to interrupt the agent
- **Dev commands** — "build", "install", "format", "push", "pull", "show log", "git status", "git diff"
- **7 new punctuation shortcuts** — "hash" (`#`), "at sign" (`@`), "dollar sign" (`$`), "ampersand" (`&`), "percent" (`%`), "asterisk" (`*`), "tab"

## [3.2.0] - 2026-03-14

### Changed
- **Audio capture fallback chain** — no longer requires SoX. Tries `rec` (SoX) → `ffmpeg` → `arecord` (Linux ALSA) in order, uses the first available tool
- ffmpeg uses avfoundation on macOS, pulse on Linux, dshow on Windows
- arecord available as zero-install option on Linux (built into ALSA)
- Audio tool detection result is cached for the process lifetime

## [3.1.3] - 2026-03-14

### Added
- **Pre-recording** — audio capture starts during warmup countdown, never miss the first word
- **Tail recording** — keeps recording 1.5s after release so your last word isn't clipped
- **Reactive waveform** — audio-level-driven 12-bar animation with fast attack / slow decay and center emphasis
- **Typing cooldown** — space holds within 400ms of other keypresses are ignored, preventing false activation mid-sentence
- **Sound feedback** — macOS system sounds (Tink, Pop, Basso) for recording start, stop, and error
- **Session corruption guard** — overlapping recording requests abort the stale session first
- **Recording history** — `/voice history` shows recent transcriptions with timestamps and durations
- **Stale session watchdog** — aborts if Deepgram sends no response after 15s of audio
- **Connection timeout** — aborts if Deepgram WebSocket doesn't open within 10s

### Changed
- Hold threshold increased to 1200ms (from 800ms) for more deliberate activation
- Repeat confirm count increased to 6 (from 3) for more reliable non-Kitty hold detection
- Recording grace period increased to 800ms (from 600ms) to reduce false stops

## [3.0.2] - 2026-03-14

### Added
- **First-run welcome hint** — shows keybinding guide on first session when API key is set, or setup instructions when it's not
- **Zero-config auto-activation** — if `DEEPGRAM_API_KEY` is already in environment, voice activates immediately without running `/voice setup`
- **Deepgram API key validation** — `/voice test` now hits the Deepgram API to verify the key is valid (not just checking if it's set)
- **Full diagnostics output** — `/voice test` shows pass/fail for each prerequisite with actionable setup instructions

## [3.0.0] - 2026-03-14

### Changed
- **Complete rewrite** — Deepgram streaming-only architecture (removed local daemon, 5-backend system, BTW side conversations)
- **Separated Pompom companion** — creature animation now ships as its own extension (`@codexstar/pi-pompom`)
- **Renamed package** — `@codexstar/pi-voice` → `@codexstar/pi-listen`

### Added
- **Double-escape editor clear** — press Escape twice within 500ms to clear the editor text
- **Cross-platform escape handling** — filters Kitty key-release/repeat events to prevent false triggers
- **Voice commands** — "hey pi, run tests", "undo", "submit", "new line", punctuation shortcuts
- **Continuous dictation** — `/voice dictate` for long-form input without holding keys
- **Recording history** — `/voice history` shows recent transcriptions
- **Audio-reactive UI** — braille waveform + face widget that reacts to voice levels
- **Enterprise hold detection** — Kitty protocol + non-Kitty gap-based fallback with typing cooldown

### Removed
- Local STT daemon (`daemon.py`, `transcribe.py`)
- 5-backend system (faster-whisper, moonshine, whisper-cpp, parakeet)
- BTW side conversations
- VAD pre-filtering
- Pompom/Lumo creature companion (now separate package)

[5.0.1]: https://github.com/codexstar69/pi-listen/releases/tag/v5.0.1
[5.0.4]: https://github.com/codexstar69/pi-listen/releases/tag/v5.0.4
[4.0.0]: https://github.com/codexstar69/pi-listen/releases/tag/v4.0.0
[3.4.0]: https://github.com/codexstar69/pi-listen/releases/tag/v3.4.0
[3.3.1]: https://github.com/codexstar69/pi-listen/releases/tag/v3.3.1
[3.3.3]: https://github.com/codexstar69/pi-listen/releases/tag/v3.3.3
[3.3.2]: https://github.com/codexstar69/pi-listen/releases/tag/v3.3.2
[3.3.0]: https://github.com/codexstar69/pi-listen/releases/tag/v3.3.0
[3.2.0]: https://github.com/codexstar69/pi-listen/releases/tag/v3.2.0
[3.1.3]: https://github.com/codexstar69/pi-listen/releases/tag/v3.1.3
[3.0.2]: https://github.com/codexstar69/pi-listen/releases/tag/v3.0.2
[3.0.0]: https://github.com/codexstar69/pi-listen/releases/tag/v3.0.0
