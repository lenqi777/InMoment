param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
$taskIconCode = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
public static class InMomentExecutableIcon {
  delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
  delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr param);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, NameCallback callback, IntPtr param);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr param);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort language, byte[] bytes, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResource(IntPtr handle, bool discard);
  class Entry { public int Type; public int Id; public string Name; public ushort Language; }
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Apply(string exe, string icon) {
    byte[] ico = File.ReadAllBytes(icon);
    if (ico.Length < 6 || BitConverter.ToUInt16(ico,0) != 0 || BitConverter.ToUInt16(ico,2) != 1) throw new InvalidDataException("Expected ICO.");
    int count = BitConverter.ToUInt16(ico,4);
    if (count < 1 || count > 100 || ico.Length < 6 + count * 16) throw new InvalidDataException("Invalid ICO directory.");
    var old = new List<Entry>();
    IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, 2);
    if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      foreach (int resourceType in new int[] { 3, 14 }) {
        EnumResourceNames(module, new IntPtr(resourceType), delegate(IntPtr m, IntPtr type, IntPtr name, IntPtr p) {
          long numericName = name.ToInt64();
          string resourceName = numericName > 65535 || numericName < 0 ? Marshal.PtrToStringUni(name) : null;
          EnumResourceLanguages(m, type, name, delegate(IntPtr mm, IntPtr tt, IntPtr nn, ushort language, IntPtr pp) {
            old.Add(new Entry { Type=resourceType, Id=resourceName == null ? (int)numericName : 0, Name=resourceName, Language=language }); return true;
          }, IntPtr.Zero); return true;
        }, IntPtr.Zero);
      }
    } finally { FreeLibrary(module); }
    IntPtr handle = BeginUpdateResource(exe, false);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    bool committed = false;
    try {
      foreach (Entry e in old) {
        IntPtr name = e.Name == null ? new IntPtr(e.Id) : Marshal.StringToHGlobalUni(e.Name);
        try { Check(UpdateResource(handle,new IntPtr(e.Type),name,e.Language,null,0)); }
        finally { if (e.Name != null) Marshal.FreeHGlobal(name); }
      }
      byte[] group = new byte[6 + count * 14]; Array.Copy(ico,0,group,0,6);
      for (int index=0; index<count; index++) {
        int offset=6+index*16, destination=6+index*14;
        uint size=BitConverter.ToUInt32(ico,offset+8), start=BitConverter.ToUInt32(ico,offset+12);
        if (size == 0 || start > ico.Length || size > ico.Length-start) throw new InvalidDataException("Invalid icon image bounds.");
        byte[] bytes=new byte[(int)size]; Array.Copy(ico,(int)start,bytes,0,(int)size);
        Check(UpdateResource(handle,new IntPtr(3),new IntPtr(index+1),0,bytes,size));
        Array.Copy(ico,offset,group,destination,12);
        Array.Copy(BitConverter.GetBytes((ushort)(index+1)),0,group,destination+12,2);
      }
      Check(UpdateResource(handle,new IntPtr(14),new IntPtr(1),0,group,(uint)group.Length));
      Check(EndUpdateResource(handle,false)); committed=true;
    } finally { if (!committed) EndUpdateResource(handle,true); }
  }
}
'@
Add-Type -TypeDefinition $taskIconCode
[InMomentExecutableIcon]::Apply((Resolve-Path -LiteralPath $Executable).Path, (Resolve-Path -LiteralPath $Icon).Path)
Write-Output 'Executable icon resources updated.'
