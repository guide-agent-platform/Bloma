param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repoRoot = Split-Path -Parent $PSScriptRoot
$brandDir = Join-Path $repoRoot 'resources\branding'
$trayDir = Join-Path $repoRoot 'resources\tray'
New-Item -ItemType Directory -Force -Path $brandDir, $trayDir | Out-Null
Copy-Item -LiteralPath $Source -Destination (Join-Path $brandDir 'icon.png')
$original = [System.Drawing.Image]::FromFile((Join-Path $brandDir 'icon.png'))
$frames = @()
try {
  foreach ($size in @(16,24,32,48,64,128,256)) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = [System.IO.MemoryStream]::new()
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $ratio = [Math]::Min($size / $original.Width, $size / $original.Height)
      $width = [int][Math]::Round($original.Width * $ratio)
      $height = [int][Math]::Round($original.Height * $ratio)
      $graphics.DrawImage($original, [int](($size-$width)/2), [int](($size-$height)/2), $width, $height)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $bytes = $stream.ToArray()
      $frames += @{ Size=$size; Bytes=$bytes }
      if ($size -eq 16 -or $size -eq 32) {
        [System.IO.File]::WriteAllBytes((Join-Path $trayDir "icon$size.png"), $bytes)
      }
    } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  }
} finally { $original.Dispose() }
$iconStream = [System.IO.File]::Create((Join-Path $brandDir 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($iconStream)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
  $offset = 6 + 16 * $frames.Count
  foreach ($frame in $frames) {
    $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $frame.Bytes.Length
  }
  foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
} finally { $writer.Dispose(); $iconStream.Dispose() }
