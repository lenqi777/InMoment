// Windows-only local helper. stdout is reserved for newline-delimited JSON.
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace InMoment.Native
{
    internal sealed class NativeError : Exception
    {
        public readonly string Code;
        public NativeError(string code, string message) : base(message) { Code = code; }
    }

    internal static class Program
    {
        private static readonly BlockingCollection<object> Output = new BlockingCollection<object>();
        private static readonly CountdownEvent PendingRequests = new CountdownEvent(1);
        private static MouseTrigger Trigger;
        private static readonly object CaptureGate = new object();
        private static readonly object SpeechGate = new object();

        [STAThread]
        private static int Main(string[] args)
        {
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = new UTF8Encoding(false);
            try { Win32.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { Win32.SetProcessDPIAware(); }
#if INMOMENT_NATIVE_INPUT_TEST
            if (args.Contains("--input-test"))
            {
                try
                {
                    // Test failures must return JSON, never open a WinForms/JIT dialog.
                    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                    return NativeInputHarness.Run();
                }
                catch (Exception)
                {
                    WriteDirect(new { ok = false, error = "The isolated native input test failed internally.", scope = "own-window-synthetic-input-only", screenshotTest = "not-run", microphoneTest = "not-run" });
                    return 1;
                }
            }
            if (args.Contains("--state-test")) return NativeTriggerStateHarness.Run();
#endif
            if (args.Contains("--self-test"))
            {
                try
                {
                    WriteDirect(new { ok = true, platform = Environment.OSVersion.ToString(), pointerBits = IntPtr.Size * 8,
                        win32Available = Win32.GetDoubleClickTime() > 0, speechEngines = SpeechEngines(),
                        screenshotTest = "not-run", microphoneTest = "not-run", hookTest = "not-installed" });
                    return 0;
                }
                catch (Exception ex) { WriteDirect(new { ok = false, error = ex.Message }); return 1; }
            }
            var writer = new Thread(delegate()
            {
                foreach (object value in Output.GetConsumingEnumerable())
                {
                    try { WriteDirect(value); } catch (IOException) { Environment.Exit(0); }
                }
            });
            writer.IsBackground = true;
            writer.Name = "InMoment protocol output";
            writer.Start();
            Trigger = new MouseTrigger(Emit);
            Trigger.Start();
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (String.IsNullOrWhiteSpace(line)) continue;
                Dictionary<string, object> request;
                try { request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line); }
                catch (Exception) { Output.Add(new { id = (object)null, ok = false, error = new { code = "INVALID_JSON", message = "Expected one JSON request per line." } }); continue; }
                if (request == null) { Output.Add(new { id = (object)null, ok = false, error = new { code = "INVALID_REQUEST", message = "Expected a JSON object." } }); continue; }
                if (GetString(request, "method", "") == "shutdown")
                {
                    Trigger.Dispose();
                    Output.Add(new { id = Get(request, "id"), ok = true, result = new { stopped = true } });
                    Output.CompleteAdding();
                    writer.Join(1000);
                    return 0;
                }
                // Configuration is input state, not a long-running operation. Apply it in
                // stdin order; ThreadPool dispatch allowed later enables to overtake disables.
                if (GetString(request, "method", "") == "configure") { Dispatch(request); continue; }
                var copiedRequest = request;
                PendingRequests.AddCount();
                ThreadPool.QueueUserWorkItem(delegate { try { Dispatch(copiedRequest); } finally { PendingRequests.Signal(); } });
            }
            Trigger.Dispose();
            PendingRequests.Signal();
            PendingRequests.Wait(5000);
            Output.CompleteAdding();
            writer.Join(1000);
            return 0;
        }

        private static void WriteDirect(object value) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
        private static void Emit(string name, object data) { if (!Output.IsAddingCompleted) { try { Output.Add(new { @event = name, data = data }); } catch (InvalidOperationException) { } } }
        private static void Dispatch(Dictionary<string, object> request)
        {
            object id = Get(request, "id");
            try
            {
                var args = Get(request, "params") as Dictionary<string, object> ?? new Dictionary<string, object>();
                string method = GetString(request, "method", "");
                object result;
                switch (method)
                {
                    case "configure": result = Trigger.Configure(args); break;
                    case "foreground": result = SourceInfo.ReadForeground().Public(); break;
                    case "focusWindow": result = FocusWindow(args); break;
                    case "captureWindow": result = Capture(args); break;
                    case "speechEngines": result = new { engines = SpeechEngines() }; break;
                    case "transcribe": result = Transcribe(args); break;
                    default: throw new NativeError("UNKNOWN_METHOD", "Unsupported native helper method: " + method);
                }
                if (!Output.IsAddingCompleted) Output.Add(new { id = id, ok = true, result = result });
            }
            catch (Exception ex)
            {
                var nativeError = ex as NativeError;
                if (!Output.IsAddingCompleted) Output.Add(new { id = id, ok = false, error = new { code = nativeError == null ? "NATIVE_ERROR" : nativeError.Code, message = ex.Message } });
            }
        }

        internal static object Get(Dictionary<string, object> args, string name) { object value; return args.TryGetValue(name, out value) ? value : null; }
        internal static string GetString(Dictionary<string, object> args, string name, string fallback) { object value = Get(args, name); return value == null ? fallback : Convert.ToString(value, CultureInfo.InvariantCulture); }
        internal static string Now() { return DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture); }
        private static object[] SpeechEngines()
        {
            return SpeechRecognitionEngine.InstalledRecognizers().Select(r => (object)new { id = r.Id, name = r.Name, language = r.Culture.Name, description = r.Description }).ToArray();
        }

        private static object FocusWindow(Dictionary<string, object> args)
        {
            long windowValue;
            uint expectedPid;
            if (!Int64.TryParse(GetString(args, "hwnd", ""), out windowValue) || windowValue == 0)
                throw new NativeError("INVALID_WINDOW", "A valid original window handle is required.");
            if (!UInt32.TryParse(GetString(args, "pid", ""), out expectedPid) || expectedPid == 0)
                throw new NativeError("INVALID_PARAMS", "The original process id is required to verify this window.");
            IntPtr hwnd = new IntPtr(windowValue);
            if (!Win32.IsWindow(hwnd)) throw new NativeError("WINDOW_UNAVAILABLE", "The original window no longer exists.");
            uint actualPid;
            Win32.GetWindowThreadProcessId(hwnd, out actualPid);
            if (actualPid != expectedPid) throw new NativeError("WINDOW_IDENTITY_MISMATCH", "The window now belongs to a different process; it was not activated.");
            string actualProcessName;
            try
            {
                using (Process process = Process.GetProcessById((int)actualPid)) actualProcessName = process.ProcessName;
            }
            catch { throw new NativeError("WINDOW_UNAVAILABLE", "The original process is no longer available for verification."); }
            string expectedProcessName = GetString(args, "processName", "");
            if (expectedProcessName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) expectedProcessName = expectedProcessName.Substring(0, expectedProcessName.Length - 4);
            if (expectedProcessName.Length > 0 && !String.Equals(expectedProcessName, actualProcessName, StringComparison.OrdinalIgnoreCase))
                throw new NativeError("WINDOW_IDENTITY_MISMATCH", "The process name no longer matches the original source; it was not activated.");
            // Recheck immediately before touching the window. Do not open a replacement process,
            // attach other input queues, simulate keystrokes, or retry foreground acquisition.
            Win32.GetWindowThreadProcessId(hwnd, out actualPid);
            if (!Win32.IsWindow(hwnd) || actualPid != expectedPid) throw new NativeError("WINDOW_UNAVAILABLE", "The original window closed before it could be activated.");
            if (Win32.IsIconic(hwnd)) Win32.ShowWindow(hwnd, 9); // SW_RESTORE
            bool foregroundRequested = Win32.SetForegroundWindow(hwnd);
            bool actualSuccess = Win32.GetForegroundWindow() == hwnd;
            return new { success = actualSuccess, hwnd = hwnd.ToInt64().ToString(CultureInfo.InvariantCulture), pid = actualPid,
                processName = actualProcessName, foregroundRequested = foregroundRequested,
                error = actualSuccess ? null : new { code = "FOREGROUND_DENIED", message = "Windows did not grant foreground focus. Select the original application from the taskbar." } };
        }

        private static object Transcribe(Dictionary<string, object> args)
        {
            if (!Monitor.TryEnter(SpeechGate)) throw new NativeError("TRANSCRIPTION_BUSY", "Another local transcription is already running.");
            try
            {
                string language = GetString(args, "language", "zh-CN");
                var engine = SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(r => String.Equals(r.Culture.Name, language, StringComparison.OrdinalIgnoreCase));
                if (engine == null) throw new NativeError("CAPABILITY_UNAVAILABLE", "No installed System.Speech recognizer for " + language + ". Install an appropriate Windows desktop speech recognition engine, or keep the recording for manual transcription.");
                var inputPaths = Get(args, "audioPaths") as IEnumerable;
                if (inputPaths == null || inputPaths is string) throw new NativeError("INVALID_PARAMS", "audioPaths must be an array of local WAV file paths.");
                var paths = inputPaths.Cast<object>().Select(p => Path.GetFullPath(Convert.ToString(p, CultureInfo.InvariantCulture))).ToArray();
                if (paths.Length == 0) throw new NativeError("INVALID_PARAMS", "At least one WAV audio path is required.");
                var segments = new List<object>();
                var chunks = new List<string>();
                double cumulative = 0;
                for (int audioIndex = 0; audioIndex < paths.Length; audioIndex++)
                {
                    string path = paths[audioIndex];
                    if (!File.Exists(path)) throw new NativeError("AUDIO_NOT_FOUND", "A recorded WAV segment is unavailable.");
                    double wavDuration = WavDuration(path);
                    using (var recognizer = new SpeechRecognitionEngine(engine))
                    using (var complete = new ManualResetEvent(false))
                    {
                        Exception recognitionError = null;
                        int capturedIndex = audioIndex;
                        double capturedOffset = cumulative;
                        recognizer.LoadGrammar(new DictationGrammar());
                        recognizer.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs ev)
                        {
                            if (String.IsNullOrWhiteSpace(ev.Result.Text)) return;
                            lock (segments)
                            {
                                chunks.Add(ev.Result.Text);
                                segments.Add(new { text = ev.Result.Text, confidence = ev.Result.Confidence,
                                    startMs = Math.Round((capturedOffset + ev.Result.Audio.AudioPosition.TotalSeconds) * 1000),
                                    endMs = Math.Round((capturedOffset + ev.Result.Audio.AudioPosition.TotalSeconds + ev.Result.Audio.Duration.TotalSeconds) * 1000),
                                    audioIndex = capturedIndex,
                                    audioStartMs = Math.Round(ev.Result.Audio.AudioPosition.TotalMilliseconds),
                                    audioEndMs = Math.Round((ev.Result.Audio.AudioPosition + ev.Result.Audio.Duration).TotalMilliseconds) });
                            }
                        };
                        recognizer.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs ev) { recognitionError = ev.Error; complete.Set(); };
                        try { recognizer.SetInputToWaveFile(path); }
                        catch (Exception) { throw new NativeError("UNSUPPORTED_AUDIO", "Local transcription requires a valid PCM WAV file."); }
                        recognizer.RecognizeAsync(RecognizeMode.Multiple);
                        int timeoutMs = (int)Math.Min(1800000, Math.Max(60000, wavDuration * 2500 + 15000));
                        if (!complete.WaitOne(timeoutMs)) { recognizer.RecognizeAsyncCancel(); complete.WaitOne(2000); throw new NativeError("TRANSCRIPTION_TIMEOUT", "Local speech recognition timed out."); }
                        if (recognitionError != null) throw new NativeError("TRANSCRIPTION_FAILED", recognitionError.Message);
                    }
                    cumulative += wavDuration;
                }
                return new { text = String.Join("\n", chunks), segments = segments, language = engine.Culture.Name, engine = new { id = engine.Id, name = engine.Name }, durationMs = Math.Round(cumulative * 1000), provider = "windows-system-speech", status = chunks.Count == 0 ? "no-speech-recognized" : "recognized" };
            }
            finally { Monitor.Exit(SpeechGate); }
        }

        private static double WavDuration(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var reader = new BinaryReader(stream))
            {
                if (stream.Length < 12 || new string(reader.ReadChars(4)) != "RIFF") throw new NativeError("UNSUPPORTED_AUDIO", "Expected a PCM WAV file.");
                reader.ReadUInt32();
                if (new string(reader.ReadChars(4)) != "WAVE") throw new NativeError("UNSUPPORTED_AUDIO", "Expected a PCM WAV file.");
                uint bytesPerSecond = 0;
                uint dataBytes = 0;
                while (stream.Position + 8 <= stream.Length)
                {
                    string type = new string(reader.ReadChars(4));
                    uint length = reader.ReadUInt32();
                    long end = stream.Position + length;
                    if (end > stream.Length) throw new NativeError("UNSUPPORTED_AUDIO", "The WAV file is incomplete.");
                    if (type == "fmt " && length >= 16)
                    {
                        ushort format = reader.ReadUInt16();
                        reader.ReadUInt16(); reader.ReadUInt32(); bytesPerSecond = reader.ReadUInt32();
                        if (format != 1) throw new NativeError("UNSUPPORTED_AUDIO", "Local transcription requires PCM WAV audio.");
                    }
                    if (type == "data") dataBytes = length;
                    stream.Position = Math.Min(stream.Length, end + (length % 2));
                }
                if (bytesPerSecond == 0 || dataBytes == 0) throw new NativeError("UNSUPPORTED_AUDIO", "The WAV file has no PCM audio samples.");
                return (double)dataBytes / bytesPerSecond;
            }
        }

        private sealed class CaptureResult
        {
            public Bitmap Bitmap;
            public Exception Error;
            public bool Abandoned;
            public string Method;
            public string CapturedAt;
            public readonly object Gate = new object();
        }

        private static object Capture(Dictionary<string, object> args)
        {
            long windowValue;
            if (!Int64.TryParse(GetString(args, "hwnd", ""), out windowValue) || windowValue == 0) throw new NativeError("INVALID_WINDOW", "A valid target window handle is required.");
            string outputPath = Path.GetFullPath(GetString(args, "outputPath", ""));
            if (String.IsNullOrWhiteSpace(GetString(args, "outputPath", ""))) throw new NativeError("INVALID_PARAMS", "outputPath is required.");
            IntPtr hwnd = new IntPtr(windowValue);
            if (!Win32.IsWindow(hwnd)) throw new NativeError("WINDOW_UNAVAILABLE", "The original window no longer exists.");
            if (hwnd == Win32.GetDesktopWindow() || hwnd == Win32.GetShellWindow()) throw new NativeError("DESKTOP_CAPTURE_DISABLED", "Desktop capture is disabled; choose an application window.");
            if (Win32.IsIconic(hwnd)) throw new NativeError("WINDOW_MINIMIZED", "The target window is minimized; no screenshot was taken.");
            if (Win32.IsHungAppWindow(hwnd)) throw new NativeError("WINDOW_UNRESPONSIVE", "The target window is not responding; no screenshot was taken.");
            Win32.RECT bounds;
            if (!Win32.GetWindowRect(hwnd, out bounds)) throw new NativeError("WINDOW_BOUNDS_UNAVAILABLE", "The target window bounds are unavailable.");
            int width = bounds.right - bounds.left;
            int height = bounds.bottom - bounds.top;
            if (width < 1 || height < 1 || (long)width * height > 30000000) throw new NativeError("INVALID_WINDOW_SIZE", "The target window size cannot be captured safely.");
            var capture = new CaptureResult();
            var done = new ManualResetEvent(false);
            // The worker owns CaptureGate until PrintWindow returns, including after a timeout.
            // This prevents a blocked target from creating unbounded screenshot threads.
            if (!Monitor.TryEnter(CaptureGate)) { done.Dispose(); throw new NativeError("CAPTURE_BUSY", "Another window capture is still running."); }
            Monitor.Exit(CaptureGate);
            var worker = new Thread(delegate()
            {
                if (!Monitor.TryEnter(CaptureGate)) { lock (capture.Gate) capture.Error = new NativeError("CAPTURE_BUSY", "Another window capture is still running."); done.Set(); return; }
                try
                {
                    Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
                    try
                    {
                        using (Graphics graphics = Graphics.FromImage(bitmap))
                        {
                            IntPtr targetDc = graphics.GetHdc();
                            try
                            {
                                bool printed = Win32.PrintWindow(hwnd, targetDc, 2);
                                if (printed) capture.Method = "print-window";
                                else
                                {
                                    IntPtr windowDc = Win32.GetWindowDC(hwnd);
                                    if (windowDc == IntPtr.Zero) throw new NativeError("CAPTURE_UNAVAILABLE", "The target window does not expose a capture surface.");
                                    try
                                    {
                                        if (!Win32.BitBlt(targetDc, 0, 0, width, height, windowDc, 0, 0, 0x00CC0020)) throw new NativeError("CAPTURE_UNAVAILABLE", "The target window surface could not be copied.");
                                        capture.Method = "window-dc";
                                    }
                                    finally { Win32.ReleaseDC(hwnd, windowDc); }
                                }
                            }
                            finally { graphics.ReleaseHdc(targetDc); }
                        }
                        capture.CapturedAt = Now();
                        lock (capture.Gate)
                        {
                            if (capture.Abandoned) bitmap.Dispose();
                            else capture.Bitmap = bitmap;
                        }
                    }
                    catch { bitmap.Dispose(); throw; }
                }
                catch (Exception ex) { lock (capture.Gate) capture.Error = ex; }
                finally { Monitor.Exit(CaptureGate); done.Set(); }
            });
            worker.IsBackground = true;
            worker.Name = "InMoment target-window capture";
            worker.Start();
            if (!done.WaitOne(3000))
            {
                lock (capture.Gate)
                {
                    capture.Abandoned = true;
                    if (capture.Bitmap != null) { capture.Bitmap.Dispose(); capture.Bitmap = null; }
                }
                // Do not dispose done while an unresponsive native call may still use it.
                throw new NativeError("CAPTURE_TIMEOUT", "The target window did not provide a screenshot in time; no file was saved.");
            }
            done.Dispose();
            if (capture.Error != null) throw capture.Error;
            using (Bitmap bitmap = capture.Bitmap)
            {
                bool allBlack = true;
                for (int y = 0; y < 8 && allBlack; y++)
                    for (int x = 0; x < 8; x++)
                    {
                        Color c = bitmap.GetPixel(Math.Min(width - 1, (x + 1) * width / 9), Math.Min(height - 1, (y + 1) * height / 9));
                        if (c.R > 3 || c.G > 3 || c.B > 3) { allBlack = false; break; }
                    }
                if (allBlack) throw new NativeError("CAPTURE_BLANK", "The target returned a blank or protected surface; no screenshot was saved.");
                string directory = Path.GetDirectoryName(outputPath);
                Directory.CreateDirectory(directory);
                bitmap.Save(outputPath, ImageFormat.Png);
                return new { outputPath = outputPath, capturedAt = capture.CapturedAt, width = width, height = height, status = "captured", method = capture.Method,
                    warning = capture.Method == "window-dc" ? "Window-DC capture may be incomplete for occluded or hardware-accelerated windows." : (string)null };
            }
        }
    }

    internal sealed class SourceInfo
    {
        public IntPtr Hwnd;
        public uint Pid;
        public string ProcessName = "";
        public string Title = "";
        public bool Eligible;
        public string EligibilityReason = "elevated-or-unavailable";
        public object Public() { return new { hwnd = Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture), pid = Pid, processName = ProcessName, title = Title }; }
        public object PublicForTrigger(string trigger) { return new { hwnd = Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture), pid = Pid, processName = ProcessName, title = Title, trigger = trigger }; }
        public static SourceInfo ReadForeground() { return ReadWindow(Win32.GetForegroundWindow(), true); }
        public static SourceInfo ReadWindow(IntPtr hwnd, bool includeTitle)
        {
            var source = new SourceInfo();
            source.Hwnd = hwnd;
            if (source.Hwnd == IntPtr.Zero) return source;
            Win32.GetWindowThreadProcessId(source.Hwnd, out source.Pid);
            if (includeTitle) source.ReadTitle();
            try
            {
                using (Process process = Process.GetProcessById((int)source.Pid))
                {
                    source.ProcessName = process.ProcessName;
                    source.Eligible = source.Pid != (uint)Process.GetCurrentProcess().Id && IntegrityLevel(source.Pid) <= IntegrityLevel((uint)Process.GetCurrentProcess().Id);
                }
            }
            catch { source.Eligible = false; }
            return source;
        }
        public void ReadTitle()
        {
            var title = new StringBuilder(2048);
            Win32.GetWindowText(Hwnd, title, title.Capacity);
            Title = title.ToString();
        }

        private static int IntegrityLevel(uint pid)
        {
            IntPtr process = Win32.OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return Int32.MaxValue;
            IntPtr token = IntPtr.Zero;
            IntPtr buffer = IntPtr.Zero;
            try
            {
                if (!Win32.OpenProcessToken(process, 8, out token)) return Int32.MaxValue;
                int length;
                Win32.GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
                buffer = Marshal.AllocHGlobal(length);
                if (!Win32.GetTokenInformation(token, 25, buffer, length, out length)) return Int32.MaxValue;
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                byte count = Marshal.ReadByte(Win32.GetSidSubAuthorityCount(sid));
                return Marshal.ReadInt32(Win32.GetSidSubAuthority(sid, (uint)(count - 1)));
            }
            finally
            {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
                if (token != IntPtr.Zero) Win32.CloseHandle(token);
                Win32.CloseHandle(process);
            }
        }
    }

    internal sealed class HoldTiming
    {
        private long Started;
        private int Delay;
        private int Duration;
        private bool PreviewSent;
        private bool ThresholdSent;
        public void Begin(long ticks, int delayMs, int durationMs) { Started = ticks; Delay = delayMs; Duration = durationMs; PreviewSent = false; ThresholdSent = false; }
        // Flags: 1 preview becomes visible, 2 the recording threshold is reached.
        public int Advance(long ticks)
        {
            double elapsed = (ticks - Started) * 1000.0 / Stopwatch.Frequency;
            int result = 0;
            if (!PreviewSent && elapsed >= Delay) { PreviewSent = true; result |= 1; }
            if (!ThresholdSent && elapsed >= Delay + Duration) { ThresholdSent = true; result |= 2; }
            return result;
        }
    }

    internal sealed class KeyboardInputState
    {
        private readonly HashSet<uint> Down = new HashSet<uint>();
        public bool Observe(uint key, bool down)
        {
            // Track shortcut candidates and modifiers only, never ordinary typing.
            if (!IsModifier(key) && key != 0x77 && key != 0x78 && key != 0x79) return false;
            bool repeated = Down.Contains(key); if (down) Down.Add(key); else Down.Remove(key); return down && repeated;
        }
        public bool ModifiersHeld { get { return Down.Any(IsModifier); } }
        public static bool IsModifier(uint key) { return key == 0x10 || key == 0x11 || key == 0x12 || key == 0x5B || key == 0x5C || (key >= 0xA0 && key <= 0xA5); }
    }

    internal sealed class MouseTrigger : IDisposable
    {
        private readonly object Gate = new object();
        private readonly Action<string, object> Emit;
        private readonly BlockingCollection<Action> InputActions = new BlockingCollection<Action>();
        private readonly ManualResetEvent HookReady = new ManualResetEvent(false);
        private Win32.HookProc HookCallback;
        private Win32.HookProc KeyboardCallback;
        private IntPtr Hook;
        private IntPtr KeyboardHook;
        private uint HookThreadId;
        private Thread HookThread;
        private Thread InjectionThread;
        private System.Threading.Timer Timer;
        private System.Threading.Timer SourceTimer;
        private SourceInfo Source;
        private SourceInfo PressSource;
        private bool Enabled;
        private int ThresholdMs = 550;
        private int PreviewDelayMs;
        private string KeyboardTrigger = "none";
        private readonly KeyboardInputState KeyboardState = new KeyboardInputState();
        private readonly HoldTiming Timing = new HoldTiming();
        private HashSet<string> Excluded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private int PressState; // 0 idle, 1 pending, 2 holding, 3 restored right-drag
        private int PressThresholdMs;
        private int PressPreviewDelayMs;
        private string PressTrigger;
        private uint PressKey;
        private Win32.POINT PressPoint;
        private volatile bool Disposed;
        private int SourceRefreshBusy;
        private int DragX;
        private int DragY;
        private string HookError;
        private static readonly UIntPtr InjectionTag = new UIntPtr(0x494D4F4D);
#if INMOMENT_NATIVE_INPUT_TEST
        internal IntPtr TestWindow;
        internal static readonly UIntPtr TestInjectionTag = new UIntPtr(0x494D5445);
        internal int TestObservedInputs;
        internal int TestTaggedInputs;
        internal int TestForegroundMatches;
#endif

        public MouseTrigger(Action<string, object> emit) { Emit = emit; }
        public void Start()
        {
            DragX = Math.Max(4, SystemInformation.DragSize.Width);
            DragY = Math.Max(4, SystemInformation.DragSize.Height);
            InjectionThread = new Thread(delegate()
            {
                foreach (Action action in InputActions.GetConsumingEnumerable())
                { try { action(); } catch (Exception ex) { Emit("inputFault", new { message = ex.Message }); } }
            });
            InjectionThread.IsBackground = true;
            InjectionThread.Name = "InMoment replay input";
            InjectionThread.Start();
            HookThread = new Thread(delegate()
            {
                HookThreadId = Win32.GetCurrentThreadId();
                HookCallback = MouseHook;
                KeyboardCallback = KeyboardHookCallback;
                Hook = Win32.SetWindowsHookEx(14, HookCallback, Win32.GetModuleHandle(null), 0);
                KeyboardHook = Win32.SetWindowsHookEx(13, KeyboardCallback, Win32.GetModuleHandle(null), 0);
                if (Hook == IntPtr.Zero) HookError = "Could not install the Windows mouse hook (" + Marshal.GetLastWin32Error() + ").";
                HookReady.Set();
                if (Hook != IntPtr.Zero)
                {
                    Application.Run();
                    Win32.UnhookWindowsHookEx(Hook);
                    if (KeyboardHook != IntPtr.Zero) Win32.UnhookWindowsHookEx(KeyboardHook);
                    Hook = IntPtr.Zero;
                    KeyboardHook = IntPtr.Zero;
                }
            });
            HookThread.IsBackground = true;
            HookThread.Name = "InMoment Windows mouse hook";
            HookThread.SetApartmentState(ApartmentState.STA);
            HookThread.Start();
            HookReady.WaitOne(3000);
            Timer = new System.Threading.Timer(CheckHold, null, 10, 10);
            SourceTimer = new System.Threading.Timer(RefreshSource, null, 0, 150);
        }

        public object Configure(Dictionary<string, object> args)
        {
            SourceInfo updatedSource = null;
            object requestedEnabled = Program.Get(args, "enabled");
            if (requestedEnabled != null && Convert.ToBoolean(requestedEnabled)) updatedSource = ReadSourceIdentity();
            lock (Gate)
            {
                object threshold = Program.Get(args, "thresholdMs");
                int desiredThreshold = threshold == null ? ThresholdMs : Math.Max(250, Math.Min(10000, Convert.ToInt32(threshold)));
                object delay = Program.Get(args, "previewDelayMs");
                int desiredDelay = delay == null ? PreviewDelayMs : Math.Max(0, Math.Min(5000, Convert.ToInt32(delay)));
                string keyboard = Program.GetString(args, "keyboardTrigger", KeyboardTrigger).ToUpperInvariant();
                if (keyboard != "NONE" && keyboard != "F8" && keyboard != "F9" && keyboard != "F10") throw new NativeError("INVALID_PARAMS", "keyboardTrigger must be none, F8, F9, or F10.");
                string desiredKeyboard = keyboard == "NONE" ? "none" : keyboard;
                object enabled = Program.Get(args, "enabled");
                bool desiredEnabled = enabled == null ? Enabled : Convert.ToBoolean(enabled);
                if (desiredEnabled && Hook == IntPtr.Zero) throw new NativeError("HOOK_UNAVAILABLE", HookError ?? "The mouse hook is unavailable.");
                if (desiredEnabled && desiredKeyboard != "none" && KeyboardHook == IntPtr.Zero) throw new NativeError("KEYBOARD_HOOK_UNAVAILABLE", "The Windows keyboard hook is unavailable.");
                ThresholdMs = desiredThreshold;
                PreviewDelayMs = desiredDelay;
                KeyboardTrigger = desiredKeyboard;
                Enabled = desiredEnabled;
                if (updatedSource != null) Source = updatedSource;
                var excluded = Program.Get(args, "excludedApps") as IEnumerable;
                if (excluded != null && !(excluded is string)) Excluded = new HashSet<string>(excluded.Cast<object>().Select(o => NormalizeProcess(Convert.ToString(o))), StringComparer.OrdinalIgnoreCase);
                if (!Enabled && PressState == 1)
                {
                    Win32.POINT current;
                    Win32.GetCursorPos(out current);
                    PressState = 3;
                    Emit("holdPreviewCancel", new { reason = "disabled" });
                    if (PressTrigger == "right-button") QueueReplay(PressPoint, current, false);
                    else QueueKeyboardReplay(PressKey, false);
                }
                return new { enabled = Enabled, thresholdMs = ThresholdMs, previewDelayMs = PreviewDelayMs, keyboardTrigger = KeyboardTrigger, excludedApps = Excluded.ToArray(), hookAvailable = Hook != IntPtr.Zero, keyboardHookAvailable = KeyboardHook != IntPtr.Zero, hookThreadAlive = HookThread != null && HookThread.IsAlive, triggerVersion = 3 };
            }
        }
        private static string NormalizeProcess(string process) { return process.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? process.Substring(0, process.Length - 4) : process; }
        private SourceInfo ReadSourceIdentity()
        {
#if INMOMENT_NATIVE_INPUT_TEST
            if (TestWindow != IntPtr.Zero) return SourceInfo.ReadWindow(TestWindow, false);
#endif
            // Preview uses only pointer position and timing. Window title is read only
            // after the hold threshold; nothing is persisted by this helper.
            return SourceInfo.ReadWindow(Win32.GetForegroundWindow(), false);
        }
        private void RefreshSource(object ignored)
        {
            if (Disposed || Interlocked.Exchange(ref SourceRefreshBusy, 1) != 0) return;
            try
            {
                lock (Gate) { if (!Enabled && PressState == 0) { Source = null; return; } }
                SourceInfo source = ReadSourceIdentity();
                lock (Gate) Source = source;
            }
            catch { }
            finally { Interlocked.Exchange(ref SourceRefreshBusy, 0); }
        }
        private void CheckHold(object ignored)
        {
            if (Disposed) return;
            lock (Gate)
            {
                if (PressState != 1) return;
                int stage = Timing.Advance(Stopwatch.GetTimestamp());
                if ((stage & 1) != 0) EmitPreview();
                if ((stage & 2) == 0) return;
                // The suppressed DOWN never reliably enters the asynchronous key state.
                // DOWN/UP observed by the hook are the authoritative hold state.
                if (PressSource.Hwnd != Win32.GetForegroundWindow() || !Win32.IsWindow(PressSource.Hwnd))
                {
                    Win32.POINT current;
                    Win32.GetCursorPos(out current);
                    PressState = 3;
                    Emit("holdPreviewCancel", new { reason = "source-changed" });
                    if (PressTrigger == "right-button") QueueReplay(PressPoint, current, false);
                    else QueueKeyboardReplay(PressKey, false);
                    return;
                }
                PressSource.ReadTitle();
                PressState = 2;
                Emit("holdStart", new { source = PressSource.PublicForTrigger(PressTrigger), trigger = PressTrigger, x = PressPoint.x, y = PressPoint.y, triggeredAt = Program.Now() });
            }
        }
        private void EmitPreview() { Emit("holdPreviewStart", new { thresholdMs = PressThresholdMs, previewDelayMs = PressPreviewDelayMs, trigger = PressTrigger, x = PressPoint.x, y = PressPoint.y, startedAt = Program.Now() }); }
        private void BeginPress(SourceInfo source, Win32.POINT point, string trigger, uint key)
        {
            PressSource = source;
            PressPoint = point;
            PressTrigger = trigger;
            PressKey = key;
            PressThresholdMs = ThresholdMs;
            PressPreviewDelayMs = PreviewDelayMs;
            PressState = 1;
            long started = Stopwatch.GetTimestamp();
            Timing.Begin(started, PressPreviewDelayMs, PressThresholdMs);
            if ((Timing.Advance(started) & 1) != 0) EmitPreview();
        }

        private IntPtr MouseHook(int code, IntPtr message, IntPtr data)
        {
            if (code < 0 || Disposed) return Win32.CallNextHookEx(Hook, code, message, data);
            var mouse = (Win32.MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(Win32.MSLLHOOKSTRUCT));
            // Never interpret input injected by this helper or other automation as user capture intent.
            bool allowedTestInput = false;
#if INMOMENT_NATIVE_INPUT_TEST
            Interlocked.Increment(ref TestObservedInputs);
            if (mouse.dwExtraInfo == TestInjectionTag) Interlocked.Increment(ref TestTaggedInputs);
            if (Win32.GetForegroundWindow() == TestWindow) Interlocked.Increment(ref TestForegroundMatches);
            allowedTestInput = TestWindow != IntPtr.Zero && mouse.dwExtraInfo == TestInjectionTag && Win32.GetForegroundWindow() == TestWindow;
            // The isolated harness exercises only its explicitly tagged input. Pass
            // unrelated human/automation motion through without mutating test state.
            if (TestWindow != IntPtr.Zero && mouse.dwExtraInfo != TestInjectionTag && mouse.dwExtraInfo != InjectionTag)
                return Win32.CallNextHookEx(Hook, code, message, data);
#endif
            if (mouse.dwExtraInfo == InjectionTag || ((mouse.flags & 1) != 0 && !allowedTestInput)) return Win32.CallNextHookEx(Hook, code, message, data);
            int msg = message.ToInt32();
            lock (Gate)
            {
                if (msg == 0x0204) // WM_RBUTTONDOWN
                {
                    SourceInfo source = Source;
                    if (!Enabled || PressState != 0) return Win32.CallNextHookEx(Hook, code, message, data);
                    if (source == null || source.Hwnd != Win32.GetForegroundWindow())
                    {
                        Emit("holdPreviewCancel", new { reason = "source-changed" });
                        return Win32.CallNextHookEx(Hook, code, message, data);
                    }
                    if (!source.Eligible && !allowedTestInput)
                    {
                        Emit("holdPreviewCancel", new { reason = source.EligibilityReason });
                        return Win32.CallNextHookEx(Hook, code, message, data);
                    }
                    if (Excluded.Contains(NormalizeProcess(source.ProcessName)))
                    {
                        Emit("holdPreviewCancel", new { reason = "excluded-app" });
                        return Win32.CallNextHookEx(Hook, code, message, data);
                    }
                    BeginPress(source, mouse.pt, "right-button", 0);
                    return new IntPtr(1);
                }
                if (msg == 0x0200 && PressState == 1 && PressTrigger == "right-button" && (Math.Abs(mouse.pt.x - PressPoint.x) > DragX || Math.Abs(mouse.pt.y - PressPoint.y) > DragY))
                {
                    PressState = 3;
                    Emit("holdPreviewCancel", new { reason = "drag" });
                    QueueReplay(PressPoint, mouse.pt, false);
                }
                if (msg == 0x0205 && PressState != 0 && PressTrigger == "right-button") // WM_RBUTTONUP
                {
                    int previous = PressState;
                    PressState = 0;
                    if (previous == 1) { Emit("holdPreviewCancel", new { reason = "released" }); QueueReplay(PressPoint, mouse.pt, true); }
                    else if (previous == 3) QueueInput(new Win32.INPUT[] { MouseInput(0, 0, 0x0010) });
                    else if (previous == 2) Emit("holdEnd", new { trigger = "right-button", releasedAt = Program.Now() });
                    return new IntPtr(1);
                }
            }
            return Win32.CallNextHookEx(Hook, code, message, data);
        }

        private IntPtr KeyboardHookCallback(int code, IntPtr message, IntPtr data)
        {
            if (code < 0 || Disposed) return Win32.CallNextHookEx(KeyboardHook, code, message, data);
            var key = (Win32.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(Win32.KBDLLHOOKSTRUCT));
            bool allowedTestInput = false;
#if INMOMENT_NATIVE_INPUT_TEST
            allowedTestInput = TestWindow != IntPtr.Zero && key.dwExtraInfo == TestInjectionTag && Win32.GetForegroundWindow() == TestWindow;
            if (TestWindow != IntPtr.Zero && key.dwExtraInfo != TestInjectionTag && key.dwExtraInfo != InjectionTag)
                return Win32.CallNextHookEx(KeyboardHook, code, message, data);
#endif
            if (key.dwExtraInfo == InjectionTag || ((key.flags & 0x10) != 0 && !allowedTestInput)) return Win32.CallNextHookEx(KeyboardHook, code, message, data);
            int msg = message.ToInt32();
            bool down = msg == 0x0100 || msg == 0x0104;
            bool up = msg == 0x0101 || msg == 0x0105;
            if (!down && !up) return Win32.CallNextHookEx(KeyboardHook, code, message, data);
            lock (Gate)
            {
                bool repeated = KeyboardState.Observe(key.vkCode, down);
                if (PressState != 0 && PressTrigger != "right-button" && key.vkCode == PressKey)
                {
                    if (down) return new IntPtr(1); // Auto-repeat never restarts a stage.
                    int previous = PressState;
                    PressState = 0;
                    if (previous == 1) { Emit("holdPreviewCancel", new { reason = "released" }); QueueKeyboardReplay(PressKey, true); }
                    else if (previous == 3) QueueInput(new Win32.INPUT[] { KeyboardInput(PressKey, true) });
                    else if (previous == 2) Emit("holdEnd", new { trigger = PressTrigger, releasedAt = Program.Now() });
                    return new IntPtr(1);
                }
                if (down && KeyboardInputState.IsModifier(key.vkCode) && PressState == 1 && PressTrigger != "right-button")
                {
                    PressState = 3;
                    Emit("holdPreviewCancel", new { reason = "modifier-combination" });
                    QueueKeyboardReplay(PressKey, false);
                }
                uint configuredKey = KeyboardTrigger == "F8" ? 0x77u : KeyboardTrigger == "F9" ? 0x78u : KeyboardTrigger == "F10" ? 0x79u : 0u;
                if (!down || repeated || key.vkCode != configuredKey || !Enabled || PressState != 0)
                    return Win32.CallNextHookEx(KeyboardHook, code, message, data);
                bool modifierHeld = KeyboardState.ModifiersHeld || (key.flags & 0x20) != 0 || (Win32.GetKeyState(0x10) & 0x8000) != 0 || (Win32.GetKeyState(0x11) & 0x8000) != 0 || (Win32.GetKeyState(0x12) & 0x8000) != 0 || (Win32.GetKeyState(0x5B) & 0x8000) != 0 || (Win32.GetKeyState(0x5C) & 0x8000) != 0;
                if (modifierHeld) return Win32.CallNextHookEx(KeyboardHook, code, message, data);
                SourceInfo source = Source;
                if (source == null || source.Hwnd != Win32.GetForegroundWindow()) { Emit("holdPreviewCancel", new { reason = "source-changed" }); return Win32.CallNextHookEx(KeyboardHook, code, message, data); }
                if (!source.Eligible && !allowedTestInput) { Emit("holdPreviewCancel", new { reason = source.EligibilityReason }); return Win32.CallNextHookEx(KeyboardHook, code, message, data); }
                if (Excluded.Contains(NormalizeProcess(source.ProcessName))) { Emit("holdPreviewCancel", new { reason = "excluded-app" }); return Win32.CallNextHookEx(KeyboardHook, code, message, data); }
                Win32.POINT point;
                Win32.GetCursorPos(out point);
                BeginPress(source, point, KeyboardTrigger, configuredKey);
                return new IntPtr(1);
            }
        }
        private void QueueKeyboardReplay(uint key, bool release)
        {
            var input = new List<Win32.INPUT> { KeyboardInput(key, false) };
            if (release) input.Add(KeyboardInput(key, true));
            QueueInput(input.ToArray());
        }
        private static Win32.INPUT KeyboardInput(uint key, bool up) { return new Win32.INPUT { type = 1, data = new Win32.INPUTUNION { keyboard = new Win32.KEYBDINPUT { wVk = (ushort)key, dwFlags = up ? 2u : 0u, dwExtraInfo = InjectionTag } } }; }

        private void QueueReplay(Win32.POINT start, Win32.POINT current, bool release)
        {
            if (InputActions.IsAddingCompleted) return;
            try { InputActions.Add(delegate()
            {
                Rectangle screen = SystemInformation.VirtualScreen;
                var input = new List<Win32.INPUT>();
                input.Add(AbsoluteMove(start, screen));
                input.Add(MouseInput(0, 0, 0x0008));
                input.Add(AbsoluteMove(current, screen));
                if (release) input.Add(MouseInput(0, 0, 0x0010));
                Inject(input.ToArray());
            }); } catch (InvalidOperationException) { }
        }
        private void QueueInput(Win32.INPUT[] input)
        {
            if (!InputActions.IsAddingCompleted) { try { InputActions.Add(delegate { Inject(input); }); } catch (InvalidOperationException) { } }
        }
        private void Inject(Win32.INPUT[] input)
        {
            uint count = Win32.SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Win32.INPUT)));
            if (count != input.Length) Emit("inputFault", new { message = "Windows blocked replaying the original right click. Disable long-press capture for this application; elevated/protected applications may reject injected input." });
        }
        private static Win32.INPUT AbsoluteMove(Win32.POINT point, Rectangle screen)
        {
            int x = (int)Math.Round((point.x - screen.Left) * 65535.0 / Math.Max(1, screen.Width - 1));
            int y = (int)Math.Round((point.y - screen.Top) * 65535.0 / Math.Max(1, screen.Height - 1));
            return MouseInput(x, y, 0x0001 | 0x4000 | 0x8000);
        }
        private static Win32.INPUT MouseInput(int x, int y, uint flags)
        {
            return new Win32.INPUT { type = 0, data = new Win32.INPUTUNION { mouse = new Win32.MOUSEINPUT { dx = x, dy = y, dwFlags = flags, dwExtraInfo = InjectionTag } } };
        }
        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            if (Timer != null) Timer.Dispose();
            if (SourceTimer != null) SourceTimer.Dispose();
            lock (Gate)
            {
                if (PressState == 1) { Emit("holdPreviewCancel", new { reason = "shutdown" }); Win32.POINT current; Win32.GetCursorPos(out current); if (PressTrigger == "right-button") QueueReplay(PressPoint, current, true); else QueueKeyboardReplay(PressKey, true); }
                if (PressState == 3) QueueInput(new Win32.INPUT[] { PressTrigger == "right-button" ? MouseInput(0, 0, 0x0010) : KeyboardInput(PressKey, true) });
                PressState = 0;
            }
            InputActions.CompleteAdding();
            if (HookThreadId != 0) Win32.PostThreadMessage(HookThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
            if (HookThread != null) HookThread.Join(1000);
            if (InjectionThread != null) InjectionThread.Join(1000);
        }
    }

#if INMOMENT_NATIVE_INPUT_TEST
    internal static class NativeMessageBits
    {
        public static uint LowUInt32(IntPtr value) { return unchecked((uint)value.ToInt64()); }
    }

    internal static class NativeTriggerStateHarness
    {
        private static long Ticks(int ms) { return (long)Math.Ceiling(ms * (double)Stopwatch.Frequency / 1000); }
        private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
        public static int Run()
        {
            var cases = new List<string>();
            Exception failure = null;
            try
            {
                var timing = new HoldTiming();
                timing.Begin(0, 120, 550);
                Require(timing.Advance(Ticks(0)) == 0 && timing.Advance(Ticks(119)) == 0, "Preview was emitted during the initial delay.");
                Require(timing.Advance(Ticks(120)) == 1, "Preview did not start at the delay boundary.");
                Require(timing.Advance(Ticks(669)) == 0 && timing.Advance(Ticks(670)) == 2 && timing.Advance(Ticks(900)) == 0, "The threshold did not include the full preview duration exactly once.");
                cases.Add("delay-then-full-preview-duration");
                timing.Begin(0, 0, 550);
                Require(timing.Advance(0) == 1 && timing.Advance(Ticks(549)) == 0 && timing.Advance(Ticks(550)) == 2, "Zero delay or threshold boundary is incorrect.");
                cases.Add("zero-delay-preview-is-immediate");
                timing.Begin(0, 5000, 10000);
                Require(timing.Advance(Ticks(4999)) == 0 && timing.Advance(Ticks(5000)) == 1 && timing.Advance(Ticks(14999)) == 0 && timing.Advance(Ticks(15000)) == 2, "Maximum staged timing is incorrect.");
                cases.Add("maximum-configured-stage-durations");
                timing.Begin(0, 100, 300);
                Require(timing.Advance(Ticks(500)) == 3 && timing.Advance(Ticks(900)) == 0, "Delayed scheduling dropped or duplicated a stage.");
                cases.Add("late-timer-emits-each-stage-once");
                var keyboard = new KeyboardInputState();
                Require(!keyboard.Observe(0x77, true) && keyboard.Observe(0x77, true) && keyboard.Observe(0x77, true), "Function-key auto-repeat was not detected.");
                keyboard.Observe(0x77, false);
                Require(!keyboard.Observe(0x77, true), "A new key press was mistaken for auto-repeat.");
                keyboard.Observe(0x77, false);
                cases.Add("function-key-repeat-does-not-create-new-press");
                foreach (uint modifier in new uint[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 })
                {
                    keyboard.Observe(modifier, true);
                    Require(keyboard.ModifiersHeld, "Modifier combinations were not recognized.");
                    keyboard.Observe(modifier, false);
                    Require(!keyboard.ModifiersHeld, "Modifier state remained pressed after release.");
                }
                cases.Add("modifier-combinations-remain-distinct-from-trigger");
                Require(!keyboard.Observe(0x41, true) && !keyboard.Observe(0x41, true) && !keyboard.ModifiersHeld, "Ordinary typing was retained by shortcut state.");
                cases.Add("ordinary-typing-is-not-retained");
                Require(NativeMessageBits.LowUInt32(new IntPtr(0x80000000L)) == 0x80000000u, "Unsigned high-bit message value overflowed.");
                Require(NativeMessageBits.LowUInt32(new IntPtr(0xC0000001L)) == 0xC0000001u, "Keyup/repeat message bits overflowed.");
                Require(NativeMessageBits.LowUInt32(new IntPtr(unchecked((long)0xFFFFFFFFC0000001UL))) == 0xC0000001u, "Sign-extended high-bit message value overflowed.");
                Require(NativeMessageBits.LowUInt32(new IntPtr(0x1234567887654321L)) == 0x87654321u, "64-bit message pointer was not masked safely.");
                cases.Add("64-bit-message-values-are-masked-without-overflow");
            }
            catch (Exception ex) { failure = ex; }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = failure == null, cases = cases, error = failure == null ? null : failure.Message,
                scope = "pure-production-timing-and-shortcut-state", hooksInstalled = false, syntheticInputSent = false, screenshotTest = "not-run", microphoneTest = "not-run" }));
            return failure == null ? 0 : 1;
        }
    }

    // Compiled only by the focused regression test, never by build-native.ps1.
    // It cannot ask for screenshots/audio and accepts synthetic input only over
    // its own foreground window. Production builds have no --input-test entry.
    internal static class NativeInputHarness
    {
        private static IntPtr OwnedWindow;
        private sealed class TestForm : Form
        {
            public int Downs;
            public int Ups;
            public readonly int[] KeyDowns = new int[3];
            public readonly int[] KeyUps = new int[3];
            protected override void WndProc(ref Message message)
            {
                if (message.Msg == 0x0204) Interlocked.Increment(ref Downs);
                if (message.Msg == 0x0205) Interlocked.Increment(ref Ups);
                bool keyDown = message.Msg == 0x0100 || message.Msg == 0x0104;
                bool keyUp = message.Msg == 0x0101 || message.Msg == 0x0105;
                if (keyDown || keyUp)
                {
                    uint key = NativeMessageBits.LowUInt32(message.WParam);
                    if (key >= 0x77 && key <= 0x79)
                    {
                        if (keyDown) Interlocked.Increment(ref KeyDowns[key - 0x77]);
                        if (keyUp) Interlocked.Increment(ref KeyUps[key - 0x77]);
                    }
                }
                // Observe F10's normal key messages without opening this test window's
                // system menu, which would take focus away from later isolated cases.
                if (message.Msg == 0x0112 && (message.WParam.ToInt64() & 0xFFF0) == 0xF100) return;
                base.WndProc(ref message);
            }
        }
        private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
        private static bool WaitFor(Func<bool> condition, int timeoutMs)
        {
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < timeoutMs) { if (condition()) return true; Thread.Sleep(10); }
            return condition();
        }
        public static int Run()
        {
            var events = new List<Dictionary<string, object>>();
            var cases = new List<string>();
            Exception failure = null;
            bool asyncStateAfterSuppressedDown = false;
            object diagnostics = null;
            Win32.POINT originalCursor;
            Win32.GetCursorPos(out originalCursor);
            using (var form = new TestForm { Text = "InMoment native input test (synthetic only)", Width = 360, Height = 180, ShowInTaskbar = true, TopMost = true, StartPosition = FormStartPosition.CenterScreen })
            using (var trigger = new MouseTrigger(delegate(string name, object data)
            {
                var item = new Dictionary<string, object>();
                item["event"] = name;
                item["data"] = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(new JavaScriptSerializer().Serialize(data));
                lock (events) events.Add(item);
            }))
            {
                form.Shown += delegate
                {
                    trigger.TestWindow = form.Handle;
                    OwnedWindow = form.Handle;
                    trigger.Start();
                    // Test-only focus setup. The production focusWindow command never
                    // attaches queues or retries. No data from the other queue is read.
                    uint ignoredPid;
                    uint foregroundThread = Win32.GetWindowThreadProcessId(Win32.GetForegroundWindow(), out ignoredPid);
                    uint ownThread = Win32.GetCurrentThreadId();
                    bool attached = foregroundThread != 0 && foregroundThread != ownThread && AttachThreadInput(ownThread, foregroundThread, true);
                    try { form.Activate(); Win32.SetForegroundWindow(form.Handle); }
                    finally { if (attached) AttachThreadInput(ownThread, foregroundThread, false); }
                    Rectangle bounds = form.Bounds;
                    var point = new Win32.POINT { x = bounds.Left + bounds.Width / 2, y = bounds.Top + bounds.Height / 2 };
                    var worker = new Thread(delegate()
                    {
                        try
                        {
                            // An actual click inside this test-owned topmost window grants it
                            // normal input focus when Windows rejects programmatic activation.
                            Require(Win32.GetAncestor(WindowFromPoint(point), 2) == trigger.TestWindow, "The isolated test point is not owned by the test window; no input was sent.");
                            Send(point, 0x0002);
                            Send(point, 0x0004);
                            Require(WaitFor(delegate { return Win32.GetForegroundWindow() == trigger.TestWindow; }, 1500), "The isolated input test window could not acquire foreground focus (foreground=" + Win32.GetForegroundWindow().ToInt64().ToString(CultureInfo.InvariantCulture) + ", test=" + trigger.TestWindow.ToInt64().ToString(CultureInfo.InvariantCulture) + ").");
                            Func<string, int> count = delegate(string name) { lock (events) return events.Count(e => Convert.ToString(e["event"]) == name); };
                            Func<string, bool> cancelled = delegate(string reason)
                            {
                                lock (events) return events.Any(e => Convert.ToString(e["event"]) == "holdPreviewCancel" && Convert.ToString(((Dictionary<string, object>)e["data"])["reason"]) == reason);
                            };
                            Action reset = delegate { Thread.Sleep(120); lock (events) events.Clear(); form.Downs = 0; form.Ups = 0; for (int i = 0; i < 3; i++) { form.KeyDowns[i] = 0; form.KeyUps[i] = 0; } };
                            trigger.Configure(new Dictionary<string, object> { { "enabled", true }, { "thresholdMs", 300 } });
                            reset();
                            Send(point, 0x0008);
                            Thread.Sleep(70);
                            asyncStateAfterSuppressedDown = (Win32.GetAsyncKeyState(2) & 0x8000) != 0;
                            Send(point, 0x0010);
                            Require(WaitFor(delegate { return cancelled("released") && form.Ups >= 1; }, 1500), "Short click did not cancel preview and replay its right button release.");
                            Require(count("holdPreviewStart") == 1 && count("holdStart") == 0 && form.Downs == 1, "Short click emitted capture or lost native menu input.");
                            cases.Add("short-click-preview-cancel-and-replay");

                            reset();
                            Send(point, 0x0008);
                            Require(WaitFor(delegate { return count("holdStart") == 1; }, 1200), "Holding the suppressed right button did not reach the threshold.");
                            // Repeated configuration used to race asynchronous dispatch. It must
                            // not clear a hold already emitted or lose its release event.
                            trigger.Configure(new Dictionary<string, object> { { "enabled", false } });
                            Send(point, 0x0010);
                            Require(WaitFor(delegate { return count("holdEnd") == 1; }, 1000), "Release after disabling did not end the active hold.");
                            Require(count("holdPreviewStart") == 1 && form.Downs == 0 && form.Ups == 0, "Long hold incorrectly replayed the context-menu click.");
                            lock (events)
                            {
                                var start = (Dictionary<string, object>)events.First(e => Convert.ToString(e["event"]) == "holdStart")["data"];
                                Require(Convert.ToInt32(start["x"]) == point.x && Convert.ToInt32(start["y"]) == point.y, "Long hold omitted its origin coordinates.");
                                Require(Convert.ToString(((Dictionary<string, object>)start["source"])["hwnd"]) == trigger.TestWindow.ToInt64().ToString(CultureInfo.InvariantCulture), "Capture source escaped the isolated test window.");
                            }
                            cases.Add("held-button-triggers-without-async-key-state-and-ends-on-release");

                            reset();
                            trigger.Configure(new Dictionary<string, object> { { "enabled", true } });
                            Send(point, 0x0008);
                            Thread.Sleep(50);
                            var moved = new Win32.POINT { x = point.x + 35, y = point.y };
                            Send(moved, 0);
                            Send(moved, 0x0010);
                            Require(WaitFor(delegate { return cancelled("drag") && form.Ups >= 1; }, 1200), "Right drag did not cancel preview and restore right input.");
                            Require(count("holdStart") == 0 && form.Downs == 1, "Right drag incorrectly started a capture.");
                            cases.Add("drag-cancels-preview-and-restores-input");

                            reset();
                            trigger.Configure(new Dictionary<string, object> { { "enabled", true } });
                            Send(point, 0x0008);
                            Thread.Sleep(50);
                            trigger.Configure(new Dictionary<string, object> { { "enabled", true }, { "thresholdMs", 300 } });
                            Require(WaitFor(delegate { return count("holdStart") == 1; }, 1000), "Idempotent configure reset the pending hold.");
                            Send(point, 0x0010);
                            Require(WaitFor(delegate { return count("holdEnd") == 1; }, 1000), "Repeated configure lost hold release.");
                            cases.Add("repeated-configure-preserves-pending-hold");

                            reset();
                            string ownProcess = Process.GetCurrentProcess().ProcessName;
                            trigger.Configure(new Dictionary<string, object> { { "enabled", true }, { "excludedApps", new object[] { ownProcess } } });
                            Send(point, 0x0008);
                            Thread.Sleep(350);
                            Send(point, 0x0010);
                            Require(WaitFor(delegate { return cancelled("excluded-app") && form.Ups >= 1; }, 1000), "Excluded application was not passed through with a cancellation reason.");
                            Require(count("holdPreviewStart") == 0 && count("holdStart") == 0, "Excluded application began capture preview.");
                            cases.Add("excluded-process-cancels-and-passes-through");

                            reset();
                            trigger.Configure(new Dictionary<string, object> { { "enabled", false } });
                            Send(point, 0x0008);
                            Send(point, 0x0010);
                            Require(WaitFor(delegate { return form.Ups >= 1; }, 1000), "Disabled hook did not pass native right input through.");
                            Require(count("holdPreviewStart") == 0 && count("holdStart") == 0, "Disabled hook emitted a preview.");
                            cases.Add("disabled-trigger-passes-through");

                            foreach (uint key in new uint[] { 0x77, 0x78, 0x79 })
                            {
                                int keyIndex = (int)key - 0x77;
                                string triggerName = "F" + (keyIndex + 8).ToString(CultureInfo.InvariantCulture);
                                reset();
                                trigger.Configure(new Dictionary<string, object> { { "enabled", true }, { "keyboardTrigger", triggerName }, { "previewDelayMs", 0 }, { "thresholdMs", 350 }, { "excludedApps", new object[0] } });
                                SendKey(key, false);
                                Thread.Sleep(60);
                                SendKey(key, true);
                                Require(WaitFor(delegate { return cancelled("released") && form.KeyUps[keyIndex] >= 1; }, 1200), triggerName + " short press did not cancel and replay its native key.");
                                Require(count("holdPreviewStart") == 1 && count("holdStart") == 0 && form.KeyDowns[keyIndex] == 1, triggerName + " short press was lost or duplicated.");
                                cases.Add(triggerName.ToLowerInvariant() + "-short-press-replays-once");

                                reset();
                                var holdWatch = Stopwatch.StartNew();
                                SendKey(key, false);
                                Thread.Sleep(120);
                                SendKey(key, false); // Real low-level auto-repeat shape.
                                Thread.Sleep(120);
                                SendKey(key, false);
                                Require(WaitFor(delegate { return count("holdStart") == 1; }, 180), triggerName + " repeat keydown reset the original 350ms hold.");
                                Require(holdWatch.ElapsedMilliseconds < 550 && count("holdPreviewStart") == 1, triggerName + " repeated keydown duplicated or restarted preview.");
                                trigger.Configure(new Dictionary<string, object> { { "enabled", false } });
                                SendKey(key, true);
                                Require(WaitFor(delegate { return count("holdEnd") == 1; }, 1000), triggerName + " keyup after disabling did not end its active hold.");
                                Require(form.KeyDowns[keyIndex] == 0 && form.KeyUps[keyIndex] == 0, triggerName + " long hold replayed the native function key.");
                                lock (events)
                                {
                                    var start = (Dictionary<string, object>)events.First(e => Convert.ToString(e["event"]) == "holdStart")["data"];
                                    var end = (Dictionary<string, object>)events.First(e => Convert.ToString(e["event"]) == "holdEnd")["data"];
                                    Require(Convert.ToString(start["trigger"]) == triggerName && Convert.ToString(end["trigger"]) == triggerName && Convert.ToString(((Dictionary<string, object>)start["source"])["trigger"]) == triggerName, "The function key was not preserved in hold/source metadata.");
                                }
                                cases.Add(triggerName.ToLowerInvariant() + "-repeat-hold-and-disabled-keyup");

                                reset();
                                trigger.Configure(new Dictionary<string, object> { { "enabled", true } });
                                SendKey(0xA2, false); // Ctrl+function key must remain an app shortcut.
                                try
                                {
                                    SendKey(key, false);
                                    Thread.Sleep(420);
                                    SendKey(key, true);
                                }
                                finally { SendKey(0xA2, true); }
                                Require(WaitFor(delegate { return form.KeyUps[keyIndex] >= 1; }, 1000), triggerName + " modifier shortcut was swallowed.");
                                Require(count("holdPreviewStart") == 0 && count("holdStart") == 0 && form.KeyDowns[keyIndex] == 1, triggerName + " modifier shortcut incorrectly armed capture.");
                                cases.Add(triggerName.ToLowerInvariant() + "-modifier-combination-passes-through");
                            }
                        }
                        catch (Exception ex) { failure = ex; }
                        finally
                        {
                            lock (events) diagnostics = new { observedInputs = trigger.TestObservedInputs, taggedInputs = trigger.TestTaggedInputs, foregroundMatches = trigger.TestForegroundMatches, events = events.Select(e => new { name = e["event"], reason = Program.Get((Dictionary<string, object>)e["data"], "reason") }).ToArray(), downs = form.Downs, ups = form.Ups };
                            trigger.Dispose();
                            Win32.SetCursorPos(originalCursor.x, originalCursor.y);
                            form.BeginInvoke((Action)delegate { form.Close(); });
                        }
                    });
                    worker.IsBackground = true;
                    worker.Start();
                };
                Application.Run(form);
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = failure == null, cases = cases, error = failure == null ? null : failure.Message,
                asyncStateAfterSuppressedDown = asyncStateAfterSuppressedDown, diagnostics = diagnostics, scope = "own-window-synthetic-input-only", screenshotTest = "not-run", microphoneTest = "not-run" }));
            return failure == null ? 0 : 1;
        }
        private static void Send(Win32.POINT point, uint buttonFlags)
        {
            RequireActiveDesktop();
            Require(Win32.GetAncestor(WindowFromPoint(point), 2) == OwnedWindow, "The synthetic pointer target is outside the isolated test window; no input was sent.");
            Rectangle screen = SystemInformation.VirtualScreen;
            int x = (int)Math.Round((point.x - screen.Left) * 65535.0 / Math.Max(1, screen.Width - 1));
            int y = (int)Math.Round((point.y - screen.Top) * 65535.0 / Math.Max(1, screen.Height - 1));
            var input = new Win32.INPUT { type = 0, data = new Win32.INPUTUNION { mouse = new Win32.MOUSEINPUT {
                dx = x, dy = y, dwFlags = 0x0001 | 0x4000 | 0x8000 | buttonFlags, dwExtraInfo = MouseTrigger.TestInjectionTag } } };
            Require(Win32.SendInput(1, new Win32.INPUT[] { input }, Marshal.SizeOf(typeof(Win32.INPUT))) == 1, "Windows refused synthetic input for the isolated test window.");
        }
        private static void SendKey(uint key, bool up)
        {
            RequireActiveDesktop();
            Require(Win32.GetForegroundWindow() == OwnedWindow, "The synthetic keyboard target is not the isolated foreground window; no input was sent.");
            var input = new Win32.INPUT { type = 1, data = new Win32.INPUTUNION { keyboard = new Win32.KEYBDINPUT {
                wVk = (ushort)key, dwFlags = up ? 2u : 0u, dwExtraInfo = MouseTrigger.TestInjectionTag } } };
            Require(Win32.SendInput(1, new Win32.INPUT[] { input }, Marshal.SizeOf(typeof(Win32.INPUT))) == 1, "Windows refused a synthetic key for the isolated test window.");
        }
        private static void RequireActiveDesktop()
        {
            IntPtr inputDesktop = OpenInputDesktop(0, false, 1);
            try
            {
                Require(inputDesktop != IntPtr.Zero && DesktopName(inputDesktop) == DesktopName(GetThreadDesktop(Win32.GetCurrentThreadId())), "The test is not on the active input desktop; no input was sent.");
            }
            finally { if (inputDesktop != IntPtr.Zero) CloseDesktop(inputDesktop); }
        }
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Win32.POINT point);
        [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder data, int length, out int needed);
        private static string DesktopName(IntPtr handle)
        {
            int needed;
            var name = new StringBuilder(256);
            return GetUserObjectInformation(handle, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "unavailable";
        }
    }
#endif

    internal static class Win32
    {
        public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr instance, uint threadId);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxLength);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] public static extern short GetKeyState(int key);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] input, int size);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int returnLength);
        [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    }
}
