param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not [IO.File]::Exists($request.file) -or [int]$request.process_id -lt 1) { throw 'Invalid owned file-dialog request' }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BlomaDialogOwner {
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr word, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  private static IntPtr FindEdit(IntPtr parent, int depth) {
    if (parent == IntPtr.Zero || depth == 0) return IntPtr.Zero;
    var edit = FindWindowEx(parent, IntPtr.Zero, "Edit", null);
    if (edit != IntPtr.Zero) return edit;
    for (var child = FindWindowEx(parent,IntPtr.Zero,null,null); child != IntPtr.Zero; child = FindWindowEx(parent,child,null,null)) {
      edit = FindEdit(child,depth-1); if (edit != IntPtr.Zero) return edit;
    }
    return IntPtr.Zero;
  }
  public static bool SetFileName(IntPtr dialog, string file) {
    var edit = FindEdit(GetDlgItem(dialog,1148),4);
    if (edit == IntPtr.Zero) return false;
    UIntPtr result;
    return SendMessageTimeout(edit,12,UIntPtr.Zero,file,2,3000,out result) != IntPtr.Zero && result != UIntPtr.Zero;
  }
  public static bool ClickOpen(IntPtr dialog) {
    var button = GetDlgItem(dialog,1); if (button == IntPtr.Zero) return false;
    UIntPtr result; return SendMessageTimeout(button,245,UIntPtr.Zero,null,2,3000,out result) != IntPtr.Zero;
  }
}
'@
  $rootProcess = Get-Process -Id ([int]$request.process_id) -ErrorAction Stop
  $startedAt = $rootProcess.StartTime.ToUniversalTime()
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $diagnostics = @{root_process_id=[int]$request.process_id;owned_windows=@();common_dialogs_seen=0;controls=@();last_error=''}
  while ([DateTime]::UtcNow -lt $deadline) {
    $current = Get-Process -Id ([int]$request.process_id) -ErrorAction Stop
    if ($current.StartTime.ToUniversalTime() -ne $startedAt) { throw 'Owned process identity changed' }
    $ownedIds = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$ownedIds.Add([int]$request.process_id)
    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
    do {
      $changed = $false
      foreach ($row in $processes) { if ($ownedIds.Contains([int]$row.ParentProcessId) -and $ownedIds.Add([int]$row.ProcessId)) { $changed = $true } }
    } while ($changed)
    $topWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
    $windows = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
    foreach ($top in $topWindows) {
      $windows.Add($top)
      if ($ownedIds.Contains($top.Current.ProcessId)) {
        # UIA may expose an owned modal as a child of the application window,
        # although its HWND is a top-level owned popup. Never scan foreign trees.
        $nested = $top.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'#32770')))
        foreach ($dialog in $nested) { $windows.Add($dialog) }
      }
    }
    foreach ($window in $windows) {
      if ($ownedIds.Contains($window.Current.ProcessId) -and $diagnostics.owned_windows.Count -lt 8) {
        $description = $window.Current.ClassName + ':' + $window.Current.Name
        if ($description -notin $diagnostics.owned_windows) { $diagnostics.owned_windows += $description }
      }
      if ($window.Current.ClassName -ne '#32770') { continue }
      $diagnostics.common_dialogs_seen++
      $scoped = $ownedIds.Contains($window.Current.ProcessId)
      $ownerHandle = [IntPtr]$window.Current.NativeWindowHandle
      for ($depth=0; -not $scoped -and $depth -lt 8; $depth++) {
        $ownerHandle = [BlomaDialogOwner]::GetWindow($ownerHandle,4)
        if ($ownerHandle -eq [IntPtr]::Zero) { break }
        [uint32]$ownerProcessId = 0
        [void][BlomaDialogOwner]::GetWindowThreadProcessId($ownerHandle,[ref]$ownerProcessId)
        $scoped = $ownedIds.Contains([int]$ownerProcessId)
      }
      if (-not $scoped) { continue }
      try {
        $edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)))
        foreach ($edit in $edits) {
          $description = 'Edit:' + $edit.Current.AutomationId + ':' + $edit.Current.Name
          if ($description -notin $diagnostics.controls -and $diagnostics.controls.Count -lt 20) { $diagnostics.controls += $description }
        }
        $fileEdit = $null
        foreach ($edit in $edits) { if ($edit.Current.AutomationId -in @('1148','1001','FileNameControlHost')) { $fileEdit = $edit; break } }
        if (-not $fileEdit) {
          foreach ($identity in @('FileNameControlHost','1148')) {
            $candidate = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$identity)))
            if ($candidate) { $fileEdit = $candidate; break }
          }
        }
        $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1')))
        if (-not $button) {
          $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)))
          foreach ($candidate in $buttons) { $description = 'Button:' + $candidate.Current.AutomationId + ':' + $candidate.Current.Name; if ($description -notin $diagnostics.controls -and $diagnostics.controls.Count -lt 20) { $diagnostics.controls += $description } }
        }
        if (-not $fileEdit -or -not $button) { continue }
        $diagnostics.stage = 'set_file_name'
        $value = $null
        if ($fileEdit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value)) {
          $value.SetValue([string]$request.file)
        } else {
          # The .NET UIA wrapper lacks LegacyIAccessiblePattern on some Windows
          # builds. Target only the common dialog's filename control, not focus
          # or global keyboard input, and bound the cross-process message wait.
          if (-not [BlomaDialogOwner]::SetFileName([IntPtr]$window.Current.NativeWindowHandle,[string]$request.file)) { throw 'Owned dialog filename edit is not writable' }
        }
        $diagnostics.stage = 'open_button'
        $dialogHandle = [IntPtr]$window.Current.NativeWindowHandle
        if (-not [BlomaDialogOwner]::ClickOpen($dialogHandle)) { throw 'Owned dialog Open button is not available' }
        $closeDeadline = [DateTime]::UtcNow.AddSeconds(3)
        while ([BlomaDialogOwner]::IsWindow($dialogHandle) -and [DateTime]::UtcNow -lt $closeDeadline) { Start-Sleep -Milliseconds 100 }
        if ([BlomaDialogOwner]::IsWindow($dialogHandle)) { throw 'Owned Open dialog did not accept the selected file' }
        @{ok=$true;dialog_process_id=$window.Current.ProcessId} | ConvertTo-Json -Compress
        exit 0
      } catch { $diagnostics.last_error=$_.Exception.Message; Start-Sleep -Milliseconds 100 }
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'No accessible common Open dialog owned by this live process tree'
} catch {
  @{ok=$false;error=$_.Exception.Message;diagnostics=$diagnostics} | ConvertTo-Json -Compress -Depth 5
  exit 1
}
