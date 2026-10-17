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

On the development machine, the helper compiles successfully, the Win32 probe succeeds, and the System.Speech engine list is empty. Transcription through this helper's **System.Speech path** is therefore unavailable until a compatible recognizer is installed; this is not a statement that the app has no offline Chinese transcription. The application also implements a separate whisper.cpp path, described below, which does not require a System.Speech recognizer. Manual text entry and preserved recording remain available when the selected transcription component is missing.

For actual input integration, opt in with `INMOMENT_NATIVE_INPUT_TEST=1` and run `node --test tests/native-input.test.cjs` on an interactive Windows desktop. This compiles a separate executable using `INMOMENT_NATIVE_INPUT_TEST`; normal builds have no test entry or synthetic-input bypass. The harness opens its own test window, verifies the active input desktop and target-window ownership before each synthetic event, and uses the same production mouse/keyboard hooks and timer logic. Only explicitly tagged synthetic input drives its test state; unrelated human/automation motion passes through. It tests short-click replay, threshold crossing/release without context-menu replay, drag cancellation, repeated configuration, exclusion, and disabled passthrough. For each of F8/F9/F10 it also checks short-key replay, repeated DOWN without restarting the hold, disabled-after-threshold UP delivering `holdEnd`, and Ctrl combinations passing through. It does not screenshot, record, or call a model. Windows focus policy and concurrent desktop activity can cause an explicit integration failure; it is not silently skipped after opting in. Default `pnpm test` skips this visible window test. Its test-only entry throws/catches UI failures into a sanitized JSON response instead of displaying a WinForms/JIT exception dialog.

The same test file always runs a separate `--state-test` entry on Windows with no GUI, installed hooks, synthetic input, screen capture, audio, or model call. Its eight deterministic checks cover delay-plus-preview timing, zero delay, maximum stage values, late timer scheduling, function-key repeat, all modifier categories, excluding ordinary typing from shortcut state, and safe masking of high-bit/sign-extended 64-bit Win32 message values. This uses the production `HoldTiming` and `KeyboardInputState` classes. Keyboard input delivery and function-key menu compatibility remain desktop integration checks, not claims made by the pure state test.

The six-case focused input regression passed on the development desktop. It also observed `GetAsyncKeyState(VK_RBUTTON)==0` after the suppressed synthetic DOWN, reproducing the old timing guard's failure. This verifies isolated native input behavior; normal applications still require compatibility checks for their raw-input/menu/drag behavior.

The later F8/F9/F10 desktop regression has not been accepted yet: its final run was refused foreground focus (`GetForegroundWindow==0`) and exited with an explicit failure before sending keyboard test events. The deterministic timing/shortcut/message parsing checks pass. The test window previously exposed a test-only 64-bit `WParam.ToInt32()` overflow; it now reads only relevant keyboard messages and masks `ToInt64()` values safely, with a headless regression. No production capture path uses that test form.

## Optional whisper.cpp offline Chinese transcription

The app also supports a local multilingual Whisper **base** model through `src/main/offline-asr.cjs`. Installation only occurs when a user explicitly runs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-offline-asr.ps1 -RootDir .local/asr
```

Use `INMOMENT_ASR_DIR` in the host application to point to this development installation. Installed applications can instead use a directory under their own user-data folder. `asr.json` contains relative binary/model paths, so the entire installation can be moved together. Neither opening the app nor transcribing causes downloads or network model requests.

The script pins the official [v1.9.5 source release](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5) and its linked [b5454 Windows CPU x64 binary](https://github.com/ggml-org/whisper.cpp/releases/expanded_assets/b5454), verifies archive SHA256 `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb`, and downloads the 142 MiB model from the model location documented in [upstream models/README](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/models/README.md). Its official SHA1 is `465707469ff3a37a2b9b8d8f89f2f99de7299dac`. Models and runtime files belong in ignored local directories, never source control.

whisper.cpp is MIT licensed, copyright (c) 2023-2026 The ggml authors; original Whisper models are MIT licensed, copyright (c) 2022 OpenAI. The setup writes both full MIT notices alongside the runtime. Preserve both notices in any redistributed offline installation. This is CPU inference; speed and recognition quality depend on the machine, recording, and model. The adapter reports elapsed processing time, audio duration, and real-time factor, rather than promising a fixed speed.

Transcription spawns the CLI without a shell, uses `-l zh -ng -oj -of`, processes only local WAV files, and groups text under each original audio segment id. Transient JSON outputs live under the installation's `jobs/` directory and are removed when the worker closes. Cancellation kills the worker, waits for its close, and deletes its final output; the host must additionally check its record still exists before saving any result. Diagnostic streams are drained without logging their contents, since they may include recognized speech.
