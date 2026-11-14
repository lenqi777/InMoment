// Compiled only into the explicit synthetic native test executable.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace InMoment.Native
{
    internal static class CloseRearmHarness
    {
        private sealed class SourceForm : Form
        {
            internal int LeftDowns;
            protected override void WndProc(ref Message message) { if(message.Msg==0x0201)Interlocked.Increment(ref LeftDowns);base.WndProc(ref message); }
        }
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Win32.POINT point);
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
        private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
        private static bool Wait(Func<bool> ready) { var watch=Stopwatch.StartNew(); while(watch.ElapsedMilliseconds<1500) { if(ready())return true;Thread.Sleep(5); } return ready(); }
        private static void Send(IntPtr owned, Win32.POINT point, uint flags)
        {
            Require(Win32.GetForegroundWindow()==owned,"Synthetic input target lost foreground ownership.");
            Require(Win32.GetAncestor(WindowFromPoint(point),2)==owned,"Synthetic pointer is outside its owned test window.");
            Rectangle screen=SystemInformation.VirtualScreen;
            var input=new Win32.INPUT { type=0,data=new Win32.INPUTUNION { mouse=new Win32.MOUSEINPUT {
                dx=(int)Math.Round((point.x-screen.Left)*65535.0/Math.Max(1,screen.Width-1)),dy=(int)Math.Round((point.y-screen.Top)*65535.0/Math.Max(1,screen.Height-1)),
                dwFlags=0x0001|0x4000|0x8000|flags,dwExtraInfo=MouseTrigger.TestInjectionTag } } };
            Require(Win32.SendInput(1,new Win32.INPUT[]{input},Marshal.SizeOf(typeof(Win32.INPUT)))==1,"Windows refused owned-window synthetic input.");
        }
        [STAThread]
        public static int Main()
        {
            try { Win32.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { Win32.SetProcessDPIAware(); }
            Exception failure=null;int starts=0,ends=0,cycles=0,leftClicks=0;
            using(var source=new SourceForm { Text="InMoment close/rearm test source",Width=460,Height=260,TopMost=true,StartPosition=FormStartPosition.CenterScreen })
            using(var chat=new Form { Text="Synthetic floating chat",Width=220,Height=140,TopMost=true,StartPosition=FormStartPosition.CenterScreen })
            using(var trigger=new MouseTrigger(delegate(string name,object value) { if(name=="holdStart")Interlocked.Increment(ref starts);if(name=="holdEnd")Interlocked.Increment(ref ends); }))
            {
                source.Shown+=delegate {
                    trigger.TestWindow=source.Handle;trigger.Start();uint ignoredPid;
                    uint foregroundThread=Win32.GetWindowThreadProcessId(Win32.GetForegroundWindow(),out ignoredPid),ownThread=Win32.GetCurrentThreadId();
                    bool attached=foregroundThread!=0&&foregroundThread!=ownThread&&AttachThreadInput(ownThread,foregroundThread,true);
                    try { source.Activate();Win32.SetForegroundWindow(source.Handle); } finally { if(attached)AttachThreadInput(ownThread,foregroundThread,false); }
                    IntPtr owned=source.Handle;Rectangle bounds=source.Bounds;var point=new Win32.POINT { x=bounds.Left+bounds.Width/2,y=bounds.Top+bounds.Height/2 };
                    var worker=new Thread(delegate() {
                        try {
                            Require(Wait(()=>Win32.GetForegroundWindow()==owned),"Owned source could not acquire foreground.");
                            Send(owned,point,0x0002);Send(owned,point,0x0004);Require(Wait(()=>source.LeftDowns==1),"Initial owned focus click was not delivered.");
                            var focus=typeof(Program).GetMethod("FocusWindow",BindingFlags.NonPublic|BindingFlags.Static);
                            for(int cycle=0;cycle<3;cycle++) {
                                trigger.Configure(new Dictionary<string,object>{{"enabled",false}});
                                source.Invoke(new Action(()=>{chat.Show();chat.Activate();Win32.SetForegroundWindow(chat.Handle);}));
                                Require(Wait(()=>Win32.GetForegroundWindow()==chat.Handle),"Synthetic chat did not own foreground.");
                                var result=focus.Invoke(null,new object[]{new Dictionary<string,object>{{"hwnd",owned.ToInt64().ToString()},{"pid",Process.GetCurrentProcess().Id},{"processName",Process.GetCurrentProcess().ProcessName}}});
                                var decoded=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new JavaScriptSerializer().Serialize(result));
                                Require(Convert.ToBoolean(decoded["success"])&&Win32.GetForegroundWindow()==owned,"Production focusWindow returned before restoring the verified source: "+new JavaScriptSerializer().Serialize(result));
                                source.Invoke(new Action(()=>chat.Hide()));
                                trigger.Configure(new Dictionary<string,object>{{"enabled",true},{"thresholdMs",250},{"excludedApps",new object[]{"InMoment","electron"}}});
                                int before=starts;Send(owned,point,0x0008);Require(Wait(()=>starts==before+1),"Close/rearm required an extra click before right hold.");
                                int ended=ends;Send(owned,point,0x0010);Require(Wait(()=>ends==ended+1),"Retriggered hold did not release.");
                                Require(source.LeftDowns==1,"Unexpected left clicks during the close/rearm proof: "+source.LeftDowns);cycles++;
                            }
                        } catch(Exception error) { failure=error; }
                        finally { leftClicks=source.LeftDowns;try { source.BeginInvoke(new Action(()=>source.Close())); } catch {} }
                    });worker.IsBackground=true;worker.Start();
                };
                Application.Run(source);
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=failure==null,error=failure==null?null:failure.Message,cycles,starts,ends,leftClicksAfterInitialFocus=leftClicks-1,scope="own-window-synthetic-input-only",microphoneTest="not-run",screenshotTest="not-run"}));
            return failure==null?0:1;
        }
    }
}
