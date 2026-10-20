$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$rendererBuild = Join-Path $root 'dist\index.html'
$tempRoot = [IO.Path]::GetFullPath($env:TEMP) + [IO.Path]::DirectorySeparatorChar
$promaTemp = Join-Path $env:TEMP ('bloma-acceptance-electron-' + [guid]::NewGuid().ToString('N'))
$resolvedPromaTemp = [IO.Path]::GetFullPath($promaTemp)

if (-not (Test-Path -LiteralPath $electron)) {
  throw 'Electron binary is missing. Run npm ci first.'
}
if (-not (Test-Path -LiteralPath $rendererBuild)) {
  throw 'Renderer build is missing. Run npm run build first.'
}
if (-not $resolvedPromaTemp.StartsWith($tempRoot)) {
  throw "Unsafe PROMA_HOME: $resolvedPromaTemp"
}

New-Item -ItemType Directory -Path $resolvedPromaTemp | Out-Null
$isolatedUserData = Join-Path $resolvedPromaTemp 'electron-user-data'
$debugPortFile = Join-Path $isolatedUserData 'DevToolsActivePort'
$oldPromaHome = $env:PROMA_HOME
$env:PROMA_HOME = $resolvedPromaTemp
$process = $null

try {
  $process = Start-Process `
    -FilePath $electron `
    -ArgumentList @('.', "--user-data-dir=`"$isolatedUserData`"", '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0') `
    -WorkingDirectory $root `
    -PassThru `
    -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(20)
  $renderer = $null
  while ((Get-Date) -lt $deadline -and -not $process.HasExited) {
    try {
      if (-not (Test-Path -LiteralPath $debugPortFile)) {
        Start-Sleep -Milliseconds 200
        continue
      }
      $port = [int](Get-Content -LiteralPath $debugPortFile -TotalCount 1)
      $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 1
      $renderer = $pages |
        Where-Object { $_.url -match 'dist/index\.html' } |
        Select-Object -First 1
      if ($renderer) { break }
    } catch {
      # The debug endpoint is not ready yet.
    }
    Start-Sleep -Milliseconds 200
  }

  if ($process.HasExited) {
    throw "Electron exited with code $($process.ExitCode)"
  }
  if (-not $renderer) {
    throw 'Renderer URL was not exposed by the Electron debugging endpoint.'
  }

  [PSCustomObject]@{
    TestId = 'S0-UI-007'
    Status = 'PASS'
    ProcessId = $process.Id
    RendererUrl = $renderer.url
  } | Format-List
} finally {
  if ($process) {
    # Chromium owns child processes and cache handles. Stop only this test's
    # captured process tree, including children left after the parent exits.
    $ownedProcessIds = [Collections.Generic.HashSet[int]]::new()
    [void]$ownedProcessIds.Add($process.Id)
    $processSnapshot = @(Get-CimInstance Win32_Process)
    do {
      $foundChild = $false
      foreach ($processRow in $processSnapshot) {
        if ($ownedProcessIds.Contains([int]$processRow.ParentProcessId) -and $ownedProcessIds.Add([int]$processRow.ProcessId)) {
          $foundChild = $true
        }
      }
    } while ($foundChild)
    foreach ($ownedProcessId in $ownedProcessIds) {
      if ($ownedProcessId -eq $process.Id -and $process.HasExited) { continue }
      Stop-Process -Id $ownedProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($ownedProcessId in $ownedProcessIds) {
      Wait-Process -Id $ownedProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
  }
  if ($null -eq $oldPromaHome) {
    Remove-Item Env:PROMA_HOME -ErrorAction SilentlyContinue
  } else {
    $env:PROMA_HOME = $oldPromaHome
  }
  if (Test-Path -LiteralPath $resolvedPromaTemp) {
    for ($cleanupAttempt = 0; $cleanupAttempt -lt 10; $cleanupAttempt++) {
      try {
        Remove-Item -LiteralPath $resolvedPromaTemp -Recurse -Force -ErrorAction Stop
        break
      } catch {
        if ($cleanupAttempt -eq 9) { throw }
        Start-Sleep -Milliseconds 250
      }
    }
  }
}
