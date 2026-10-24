param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $destination = [IO.Path]::GetFullPath($request.destination)
  if ([IO.Directory]::Exists($destination)) { throw 'Runtime extraction destination already exists' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($request.archive)
  try {
    if ($zip.Entries.Count -gt 30000) { throw 'Runtime archive entry limit' }
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace([char]92,[char]47)
      if ($name -match '(^/|^[A-Za-z]:|(^|/)[.][.](/|$))' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Runtime archive unsafe path or link' }
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destination,$entry.FullName))
      if (-not $target.StartsWith($destination + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime archive outside destination' }
      $total += $entry.Length
      if ($total -gt 1GB) { throw 'Runtime expanded size limit' }
    }
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip,$destination)
  } finally { $zip.Dispose() }
  @{ok=$true} | ConvertTo-Json -Compress
} catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }
