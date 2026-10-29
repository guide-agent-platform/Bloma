param([ValidateSet('inspect','recognize')][string]$Mode='inspect',[string]$RequestPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
function AwaitResult($Operation,[Type]$ResultType) {
  $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  $task.GetAwaiter().GetResult()
}
function FileSha([string]$Path) {
  $algorithm=[System.Security.Cryptography.SHA256]::Create()
  $inputStream=[System.IO.File]::OpenRead($Path)
  try { ([System.BitConverter]::ToString($algorithm.ComputeHash($inputStream))).Replace('-','').ToLowerInvariant() }
  finally {$inputStream.Dispose();$algorithm.Dispose()}
}
try {
  $languages=@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {$_.LanguageTag})
  if($Mode -eq 'inspect') { @{languages=$languages;max_dimension=[Windows.Media.Ocr.OcrEngine]::MaxImageDimension;provider='windows-ocr-v1'} | ConvertTo-Json -Compress; exit 0 }
  $request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if((FileSha $request.file) -ne $request.sha256) {throw 'OCR_INPUT_CHANGED'}
  $language=New-Object Windows.Globalization.Language($request.language)
  $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if($null -eq $engine) {throw 'OCR_LANGUAGE_UNAVAILABLE'}
  $null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
  $file=AwaitResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.file)) ([Windows.Storage.StorageFile])
  $null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $stream=AwaitResult ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $decoder=AwaitResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $max=[Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if($decoder.PixelWidth -gt $max -or $decoder.PixelHeight -gt $max) {throw 'OCR_IMAGE_DIMENSION_LIMIT'}
    $bitmap=AwaitResult ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $result=AwaitResult ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines=@($result.Lines | ForEach-Object {
        $line=$_
        @{text=$line.Text;words=@($line.Words | ForEach-Object {@{text=$_.Text;x=$_.BoundingRect.X;y=$_.BoundingRect.Y;width=$_.BoundingRect.Width;height=$_.BoundingRect.Height}})}
      })
      if((FileSha $request.file) -ne $request.sha256) {throw 'OCR_INPUT_CHANGED'}
      @{text=$result.Text;lines=$lines;width=$decoder.PixelWidth;height=$decoder.PixelHeight;language=$engine.RecognizerLanguage.LanguageTag;source_sha256=$request.sha256;provider='windows-ocr-v1'} | ConvertTo-Json -Depth 8 -Compress
    } finally {$bitmap.Dispose()}
  } finally {$stream.Dispose()}
} catch { [Console]::Error.WriteLine('OCR_FAILED: '+$_.Exception.Message); exit 1 }
