$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RelayWin {
 public delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct Key {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] public struct Union {[FieldOffset(0)]public Mouse mouse;[FieldOffset(0)]public Key key;}
 [StructLayout(LayoutKind.Sequential)] public struct Input {public uint type;public Union value;}
 [DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc cb,IntPtr lp);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr hwnd,StringBuilder s,int n);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr hwnd,int n);
 [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
 [DllImport("user32.dll",SetLastError=true)]public static extern uint SendInput(uint n,Input[] inputs,int size);
 public static void Text(string text){foreach(char c in text){var d=new Input{type=1,value=new Union{key=new Key{scan=c,flags=4}}};var u=d;u.value.key.flags=6;if(SendInput(2,new[]{d,u},Marshal.SizeOf(typeof(Input)))!=2)throw new Exception("Input rejected; check target privilege level");}}
}
'@
[RelayWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$r = [Console]::In.ReadToEnd() | ConvertFrom-Json
$p = $r.params
$hwnd = [IntPtr]([long]$p.windowId)
function Bounds($handle) { $rect = New-Object RelayWin+Rect; if (-not [RelayWin]::GetWindowRect($handle,[ref]$rect)) {throw 'Window is no longer available'}; @{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top} }
function FocusTarget { [RelayWin]::ShowWindow($hwnd,9) | Out-Null; [RelayWin]::SetForegroundWindow($hwnd) | Out-Null; Start-Sleep -Milliseconds 80; if ([RelayWin]::GetForegroundWindow() -ne $hwnd) {throw 'Target could not receive foreground focus'} }
function MoveTo($x,$y) { $b=Bounds $hwnd; if ($x -lt 0 -or $y -lt 0 -or $x -ge $b.width -or $y -ge $b.height) {throw 'Coordinates outside target'}; [RelayWin]::SetCursorPos($b.x+[int]$x,$b.y+[int]$y) | Out-Null }
function MouseEvent($flag,$data=0) {[RelayWin]::mouse_event($flag,0,0,[uint32]([int64]$data -band 0xffffffff),[UIntPtr]::Zero)}
switch ($r.method) {
 'listWindows' { $script:windows=New-Object System.Collections.Generic.List[object]; $cb=[RelayWin+EnumProc]{param($h,$unused) if([RelayWin]::IsWindowVisible($h)){ $s=New-Object Text.StringBuilder 1024; [RelayWin]::GetWindowText($h,$s,1024)|Out-Null; if($s.Length -gt 0){$procId=[uint32]0;[RelayWin]::GetWindowThreadProcessId($h,[ref]$procId)|Out-Null; $app='';try{$app=(Get-Process -Id $procId -ErrorAction Stop).ProcessName}catch{}; $script:windows.Add(@{id=$h.ToInt64().ToString();title=$s.ToString();application=$app;pid=$procId;bounds=(Bounds $h)})}};return $true};[RelayWin]::EnumWindows($cb,[IntPtr]::Zero)|Out-Null; ConvertTo-Json -InputObject @($script:windows.ToArray()) -Depth 8 -Compress }
 'focus' {FocusTarget; 'true'}
 'close' {if(-not [RelayWin]::PostMessage($hwnd,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Close request failed'};'true'}
 'capture' { $b=Bounds $hwnd;$bitmap=New-Object Drawing.Bitmap $b.width,$b.height;$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc();try{$ok=[RelayWin]::PrintWindow($hwnd,$dc,2)}finally{$graphics.ReleaseHdc($dc)};if(-not $ok){$graphics.Dispose();$bitmap.Dispose();throw 'Window refused capture'};$memory=New-Object IO.MemoryStream;try{$bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png);@{width=$b.width;height=$b.height;bounds=$b;capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();dataUrl='data:image/png;base64,'+[Convert]::ToBase64String($memory.ToArray())}|ConvertTo-Json -Depth 5 -Compress}finally{$memory.Dispose();$graphics.Dispose();$bitmap.Dispose()} }
 'releaseAll' {foreach($k in @(16,17,18,91,92)){[RelayWin]::keybd_event($k,0,2,[UIntPtr]::Zero)};foreach($f in @(4,16,64)){MouseEvent $f};'true'}
 'input' {if(-not ($p.action -eq 'up' -and $hwnd -eq [IntPtr]::Zero)){FocusTarget};$down=2;$up=4;if($p.button -eq 'right'){$down=8;$up=16};if($p.button -eq 'middle'){$down=32;$up=64};switch($p.kind){
  'click' {MoveTo $p.x $p.y;MouseEvent $down;MouseEvent $up;if($p.clickCount -eq 2){Start-Sleep -Milliseconds 80;MouseEvent $down;MouseEvent $up}}
  'move' {MoveTo $p.x $p.y}
  'drag' {MoveTo $p.x $p.y;MouseEvent $down;try{for($i=1;$i -le 20;$i++){MoveTo ($p.x+($p.toX-$p.x)*$i/20) ($p.y+($p.toY-$p.y)*$i/20);Start-Sleep -Milliseconds 15}}finally{MouseEvent $up}}
  'scroll' {if($null -ne $p.x){MoveTo $p.x $p.y};if($p.deltaY){MouseEvent 2048 (-[int]$p.deltaY)};if($p.deltaX){MouseEvent 4096 ([int]$p.deltaX)}}
  'type' {[RelayWin]::Text([string]$p.text)}
  'key' {$names=@{Enter=13;Return=13;Tab=9;Escape=27;Backspace=8;Delete=46;Space=32;Left=37;Up=38;Right=39;Down=40;Home=36;End=35;PageUp=33;PageDown=34;Control=17;Control_L=17;Ctrl=17;Shift=16;Shift_L=16;Alt=18;Alt_L=18;Super=91;Super_L=91;Meta=91};$keys=New-Object System.Collections.Generic.List[byte];foreach($name in ([string]$p.key -split '\+')){if($names.ContainsKey($name)){$keys.Add($names[$name])}elseif($name.Length -eq 1){$keys.Add([byte][char]$name.ToUpper())}elseif($name -match '^F([1-9]|1[0-2])$'){$keys.Add([byte](111+[int]$Matches[1]))}else{throw "Unsupported key: $name"}};if($p.action -ne 'up'){foreach($key in $keys){[RelayWin]::keybd_event($key,0,0,[UIntPtr]::Zero)}};if($p.action -ne 'down'){if($p.action -ne 'up' -and $p.durationMs -gt 0){Start-Sleep -Milliseconds ([Math]::Min(120000,[Math]::Max(0,[int]$p.durationMs)))};for($i=$keys.Count-1;$i -ge 0;$i--){[RelayWin]::keybd_event($keys[$i],0,2,[UIntPtr]::Zero)}}}
  default {throw "Unsupported input: $($p.kind)"}
 };'true'}
 default {throw "Unknown method: $($r.method)"}
}
