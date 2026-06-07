# Reads Windows 11 Live Captions text via UI Automation and prints each updated
# caption string to stdout as a compact JSON line: {"text":"..."}.
# Requires Live Captions to be enabled (Win + Ctrl + L). Windows-only.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$ErrorActionPreference = 'SilentlyContinue'

$AutomationIdProperty = [System.Windows.Automation.AutomationElement]::AutomationIdProperty
$Descendants = [System.Windows.Automation.TreeScope]::Descendants
# The caption text lives in an element with AutomationId "CaptionsTextBlock".
$cond = New-Object System.Windows.Automation.PropertyCondition($AutomationIdProperty, 'CaptionsTextBlock')

function Find-CaptionElement {
  $proc = Get-Process -Name 'LiveCaptions' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if (-not $proc) { return $null }
  try {
    $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    if (-not $win) { return $null }
    return $win.FindFirst($Descendants, $cond)
  } catch {
    return $null
  }
}

$element = $null
$last = ''

while ($true) {
  if (-not $element) { $element = Find-CaptionElement }

  if ($element) {
    try {
      $text = $element.Current.Name
      if ($text -and $text -ne $last) {
        $last = $text
        $line = [pscustomobject]@{ text = $text } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
      }
    } catch {
      # Element went stale (window closed/recreated) - re-acquire next loop.
      $element = $null
    }
  }

  Start-Sleep -Milliseconds 150
}
