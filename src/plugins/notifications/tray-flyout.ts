import { spawn, type ChildProcess } from 'node:child_process';

export type FlyoutRect = {
  left: number;
  // Top edge of the flyout window. The square the user sees starts a little
  // below it; see the comment on the probe.
  top: number;
};

// The shell keeps its tray overflow flyout (the "^" chevron) in a window it
// sizes to however many icons are hidden in there, so that window's rectangle
// is the only honest answer to "how far above the taskbar does the flyout
// reach?" — hardcoding the height of the band breaks the moment the flyout
// holds a different number of icon rows. The window is taller than the square
// it draws, and that margin is invisible to every probe here (the window
// answers hit-tests across its whole rectangle, DWM reports the same
// rectangle as the frame), so the popup adds the margin back itself.
const PROBE_SCRIPT = `
Add-Type -Namespace Pear -Name TrayFlyout -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr FindWindowW(string className, string windowName);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
public static extern int DwmGetWindowAttribute(System.IntPtr hWnd, int attribute, out RECT rect, int size);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
try { [Pear.TrayFlyout]::SetProcessDpiAwarenessContext([System.IntPtr](-4)) | Out-Null } catch {}

# How far the flyout window reaches, for however many icon rows it holds. Two
# sources: the window rectangle, and the frame bounds DWM draws it in.
# Whichever sits lower wins, so a shadow frame cannot be read as reach.
function Get-FlyoutTop($h, $r) {
  try {
    $f = New-Object Pear.TrayFlyout+RECT
    if ([Pear.TrayFlyout]::DwmGetWindowAttribute($h, 9, [ref]$f, 16) -eq 0) { return [Math]::Max($r.Top, $f.Top) }
  } catch {}
  return $r.Top
}

$last = ''
while ($true) {
  $h = [Pear.TrayFlyout]::FindWindowW('NotifyIconOverflowWindow', $null)
  $r = New-Object Pear.TrayFlyout+RECT
  $line = 'none'
  if ($h -ne [System.IntPtr]::Zero -and [Pear.TrayFlyout]::IsWindowVisible($h) -and [Pear.TrayFlyout]::GetWindowRect($h, [ref]$r)) {
    $top = Get-FlyoutTop $h $r
    $line = "$($r.Left),$top,$($r.Right),$($r.Bottom)"
  }
  if ($line -ne $last) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    $last = $line
  }
  Start-Sleep -Milliseconds 150
}
`;

// "left,top,right,bottom" in physical screen pixels ("top" being where the
// square starts), or null for "hidden" / anything else the probe may print.
export const parseFlyoutLine = (line: string): FlyoutRect | null => {
  const parts = line.split(',');
  if (parts.length !== 4) return null;

  const numbers = parts.map(Number);
  if (numbers.some(Number.isNaN)) return null;

  const [left, top] = numbers;
  return { left, top };
};

// Streams the flyout rectangle for as long as the returned stop function is
// not called. Only the last known rectangle matters: it does not move while
// the flyout is hidden, and the icons it holds stay where the flyout put them.
// The helper is spawned once (it is a 150ms poll, not a process per hover) and
// restarted if it ever dies, so the popup never quietly falls back to the
// position this was written to fix.
export const watchTrayFlyout = (
  onRect: (rect: FlyoutRect) => void,
): (() => void) => {
  if (process.platform !== 'win32') return () => {};

  let child: ChildProcess | null = null;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const start = () => {
    const spawned = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    child = spawned;

    // A missing PowerShell is not fatal: without a rectangle the popup just
    // anchors on the tray icon like it always did.
    spawned.on('error', () => {});
    spawned.on('close', () => {
      child = null;
      if (!stopped) restartTimer = setTimeout(start, 1000);
    });

    let buffered = '';
    spawned.stdout.setEncoding('utf8');
    spawned.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        const rect = parseFlyoutLine(line.trim());
        if (rect) onRect(rect);
      }
    });
  };

  start();

  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    child?.kill();
  };
};
