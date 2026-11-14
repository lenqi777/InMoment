# Windows native helper

Build from the repository root with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1`. The script uses the Windows .NET Framework compiler and System.Speech assembly already installed on the machine. Output is `build/native/InMoment.Native.exe` (x64).

## Protocol

The executable reads UTF-8, newline-delimited JSON from stdin and writes only newline-delimited JSON to stdout. Responses can arrive out of order; match the original request `id`.

```json
{"id":1,"method":"configure","params":{"enabled":true,"previewDelayMs":0,"thresholdMs":550,"keyboardTrigger":"none","excludedApps":["InMoment","electron","devenv.exe"]}}
{"id":2,"method":"foreground","params":{}}
{"id":7,"method":"focusWindow","params":{"hwnd":"123456","pid":1234,"processName":"chrome"}}
{"id":3,"method":"captureWindow","params":{"hwnd":"123456","outputPath":"D:\\example\\draft\\source.png"}}
{"id":4,"method":"speechEngines","params":{}}
{"id":5,"method":"transcribe","params":{"audioPaths":["D:\\example\\segment-0.wav"],"language":"zh-CN"}}
{"id":6,"method":"shutdown","params":{}}
```

Successful responses have `{id, ok:true, result}`; failures have `{id, ok:false, error:{code,message}}`. Source objects have `hwnd` (decimal **string**), `pid`, `processName` (without `.exe`), and `title`.

Events:

```json
{"event":"holdPreviewStart","data":{"thresholdMs":550,"previewDelayMs":0,"trigger":"right-button","x":500,"y":300,"startedAt":"2026-10-16T01:00:00.0000000Z"}}
{"event":"holdPreviewCancel","data":{"reason":"released"}}
{"event":"holdStart","data":{"source":{"hwnd":"123456","pid":1234,"processName":"chrome","title":"Example","trigger":"right-button"},"trigger":"right-button","x":500,"y":300,"triggeredAt":"2026-10-16T01:00:00.0000000Z"}}
{"event":"holdEnd","data":{"trigger":"right-button","releasedAt":"2026-10-16T01:00:02.0000000Z"}}
{"event":"inputFault","data":{"message":"A description of an input integration failure."}}
```

Preview contains only timing, trigger kind, and pointer coordinates. It authorizes a progress display, not capture. `previewDelayMs` is the silent initial wait (0–5000 ms, default 0). After that wait, preview starts and runs for the entire `thresholdMs` interval (250–10000 ms, default 550). The window title and `holdStart` occur only after both intervals have elapsed. Timing values are snapshotted when the press begins; subsequent settings apply to the next press.

Cancellation reasons are `released`, `drag`, `disabled`, `excluded-app`, `elevated-or-unavailable`, `source-changed`, `modifier-combination`, and `shutdown`. An excluded/unavailable window can emit a cancellation without a preceding preview so the host can explain why the trigger was rejected. `holdStart` replaces the preview; the normal release afterward emits `holdEnd`, not preview cancellation. `configure` includes `triggerVersion:3`, `hookThreadAlive`, and `keyboardHookAvailable` for capability diagnostics and is applied in stdin order.

`keyboardTrigger` accepts `none` (default), `F8`, `F9`, or `F10`. Right-button hold remains available regardless of that option. An independent `WH_KEYBOARD_LL` hook shares the same press/timing lifecycle with the mouse: the original key/button release always ends its active hold even when the host has disabled new triggers. `trigger` is `right-button` or the configured function key. A short function-key press replays that key's normal down/up once; a completed long hold suppresses it. Auto-repeat never starts another hold. Modifier shortcuts pass through; adding a modifier during a pending function-key hold cancels capture and restores the pending key. The helper retains only pressed modifiers and the three candidate function keys in memory, never ordinary typing or key history. It uses hook events for hold timing; `GetKeyState` is used only to avoid intercepting modifiers that were already held when the helper started.

`speechEngines` returns `{engines:[{id,name,language,description}]}`. `transcribe` accepts **PCM WAV** only, returns `{text,segments,language,engine,durationMs,provider,status}`. Each segment includes `text`, `confidence`, `startMs` and `endMs` across all segments, plus `audioIndex`, `audioStartMs`, `audioEndMs` for replay within one recorded file. Exact language matching is required; no available engine is a `CAPABILITY_UNAVAILABLE` error. It never sends audio to a network service. Native helper access is intended only for the trusted Electron main process.

`captureWindow` returns `{outputPath,capturedAt,width,height,status:"captured",method,warning}`. It attempts `PrintWindow`, then only that window's DC if PrintWindow fails. It never captures the desktop or full display as a fallback. Minimized, hung, missing, blank/protected windows return explicit errors. A target capture that takes over three seconds is abandoned without writing a late image file. The calling application must still delete a completed image if its draft was cancelled while capture was running.

`focusWindow` requires both the original `hwnd` and `pid`; optional `processName` adds a process-name check. It verifies the current window owner before restoring a minimized window and asking Windows for foreground focus once. The result reports `{success,hwnd,pid,processName,foregroundRequested,error}`; `success` reflects the observed foreground window. Missing/changed windows return an error without starting another process. Windows focus policy can deny the request, and no focus-stealing retry or synthetic keyboard workaround is used.

## Trigger behavior and limitations

- Monitoring defaults to disabled. The host must explicitly enable it. Source process-identity sampling pauses when disabled and idle; titles are deferred until the hold threshold. No screenshots, microphone recording, or persistent draft are created by preview.
- First right-button down is suppressed in supported windows. A release before the threshold replays a standard right click. After the threshold, `holdStart` is emitted once; release emits `holdEnd` and suppresses the native context menu.
- Pointer movement beyond the system drag threshold before the long-press threshold restores a right-button drag instead of starting recording. Restoring the drag uses tagged synthetic pointer moves/down at the initial point and returns to the current point. This can cause a brief cursor movement and is incompatible with applications that reject synthetic input. This is a best-effort prototype, not transparent input virtualization.
- Elevated/protected processes are skipped when their integrity exceeds this helper, or cannot be read. If the foreground changes before its source snapshot is refreshed, that press is passed through. Applications listed in `excludedApps` are passed through.
- Some applications react on button-down, raw input, injected-input filtering, or unusual drag semantics. Verify each target application. Prefer exclusions or another trigger for incompatible software. Hook callbacks enqueue work and do not run image capture, model requests, process inspection, or file I/O.
- The host must disable new triggering during an active draft/manual continuation. Disabling does not cancel an existing hold's release event.
- A real release cannot be promised to stop the microphone at zero latency. This helper emits the event; the host must stop the actual audio stream.
- Hold timing uses observed hook DOWN/UP events and `Stopwatch`. It deliberately does not gate on `GetAsyncKeyState`: suppressing the original right-button DOWN can leave that state unpressed, which previously prevented every long hold from reaching `holdStart`.
- Windows System.Speech engines are separate from some modern Windows voice-typing installations. Voice typing working does not prove that a matching System.Speech recognizer is installed.
- PrintWindow and window-DC capture may fail or return incomplete surfaces in hardware-accelerated/protected applications. Window-DC fallback reports a warning; black samples are rejected. DPI awareness is enabled for multi-monitor coordinates.

## Local verification

`InMoment.Native.exe --self-test` probes Win32 availability and lists installed recognition engines. It **does not** install an input hook, capture a screen, record microphone audio, or call any model/API.

On the development machine, the helper compiles successfully, the Win32 probe succeeds, and the System.Speech engine list is empty. Transcription through this helper's **System.Speech path** is therefore unavailable until a compatible recognizer is installed. The application uses the separate SenseVoiceSmall path described below for offline transcription; it does not require a System.Speech recognizer. Manual text entry and preserved recording remain available when the offline component is missing.

For actual input integration, opt in with `INMOMENT_NATIVE_INPUT_TEST=1` and run `node --test tests/native-input.test.cjs` on an interactive Windows desktop. This compiles a separate executable using `INMOMENT_NATIVE_INPUT_TEST`; normal builds have no test entry or synthetic-input bypass. The harness opens its own test window, verifies the active input desktop and target-window ownership before each synthetic event, and uses the same production mouse/keyboard hooks and timer logic. Only explicitly tagged synthetic input drives its test state; unrelated human/automation motion passes through. It tests short-click replay, threshold crossing/release without context-menu replay, drag cancellation, repeated configuration, exclusion, and disabled passthrough. For each of F8/F9/F10 it also checks short-key replay, repeated DOWN without restarting the hold, disabled-after-threshold UP delivering `holdEnd`, and Ctrl combinations passing through. It does not screenshot, record, or call a model. Windows focus policy and concurrent desktop activity can cause an explicit integration failure; it is not silently skipped after opting in. Default `pnpm test` skips this visible window test. Its test-only entry throws/catches UI failures into a sanitized JSON response instead of displaying a WinForms/JIT exception dialog.

The same test file always runs a separate `--state-test` entry on Windows with no GUI, installed hooks, synthetic input, screen capture, audio, or model call. Its eight deterministic checks cover delay-plus-preview timing, zero delay, maximum stage values, late timer scheduling, function-key repeat, all modifier categories, excluding ordinary typing from shortcut state, and safe masking of high-bit/sign-extended 64-bit Win32 message values. This uses the production `HoldTiming` and `KeyboardInputState` classes. Keyboard input delivery and function-key menu compatibility remain desktop integration checks, not claims made by the pure state test.

The six-case focused input regression passed on the development desktop. It also observed `GetAsyncKeyState(VK_RBUTTON)==0` after the suppressed synthetic DOWN, reproducing the old timing guard's failure. This verifies isolated native input behavior; normal applications still require compatibility checks for their raw-input/menu/drag behavior.

The later F8/F9/F10 desktop regression has not been accepted yet: its final run was refused foreground focus (`GetForegroundWindow==0`) and exited with an explicit failure before sending keyboard test events. The deterministic timing/shortcut/message parsing checks pass. The test window previously exposed a test-only 64-bit `WParam.ToInt32()` overflow; it now reads only relevant keyboard messages and masks `ToInt64()` values safely, with a headless regression. No production capture path uses that test form.

## SenseVoiceSmall offline Chinese transcription

The app uses **SenseVoiceSmall INT8 2024-07-17** with the **sherpa-onnx 2.0.1** Windows x64 CPU CLI through `src/main/offline-asr.cjs`. No system Python is required. Development installation occurs only when a user explicitly runs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-offline-asr.ps1 -RootDir .local/asr
```

Use `INMOMENT_ASR_DIR` in the host application to point to this development installation. Installed applications can instead use a directory under their own user-data folder. `asr.json` contains relative CLI, model and tokens paths, so the entire installation can be moved together. Neither opening the app nor transcribing causes downloads or network model requests. Older Whisper manifests require this explicit upgrade; they are not silently used as a fallback.

The fixed archives, per-file sizes and SHA-256 values are in `scripts/asr-assets.json`. Setup checks the runtime archive and converted model archive, extracts only allowlisted files and verifies every installed component. Before upgrading an older installation it backs up the prior manifest, binaries and models under the installation's `backups/`; original legacy files remain in place. New portable builds copy only SenseVoice files and notices, excluding backups, downloads, test audio and legacy Whisper files. Models and native binaries stay in ignored local directories, outside tracked source.

sherpa-onnx is Apache-2.0; its ONNX Runtime 1.28.2 DLLs are MIT licensed and retain the upstream third-party notices. The SenseVoice model has separate FunASR Model Open Source License Agreement terms, with both its original license pointer and the complete fixed model terms retained. Preserve these files and model attribution in redistributed installations. See `THIRD_PARTY_NOTICES.md` for sources.

Transcription spawns `sherpa-onnx-offline.exe` without a shell, with explicit SenseVoice model/tokens, Chinese language, inverse text normalization and CPU provider arguments. Source recordings are split into bounded chunks and processed in batches of at most four, with one worker/model load per batch; stdout emits one JSON result per input in order. Results are grouped back under each original audio segment id. Writable temporary WAV jobs live outside the model directory and are removed when the worker closes. Cancellation kills the worker and waits for close before cleanup; the host additionally checks the record before applying results. Diagnostic streams are inspected for bounded failure markers, then drained without logging their contents. An internal decoder failure remains visible even if the CLI exits with code zero. The adapter reports elapsed processing time, audio duration and real-time factor.
