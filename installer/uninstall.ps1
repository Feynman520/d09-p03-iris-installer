# installer/uninstall.ps1 -- IRIS uninstaller (2.0.39). ASCII only: Windows PowerShell 5.1
# reads a BOM-less .ps1 as ANSI, so every Korean string lives in uninstall-ko.json (UTF-8).
# Design = the uninstaller design doc under docs\ (Korean file name, so not spelled here).
#
# Started by the uninstall .cmd at the zip root, which first copies this file, its strings and
# lib\file-holders.ps1 to %TEMP% and cds there, so the uninstaller never runs from inside the
# folder it deletes (the installed copy under <root>\_agent\setup\installer works too).
#
# Safety rules (each one measured or argued in the design doc, section 2):
#   1. Receipt gate: only a folder with <root>\_agent\setup\package-receipt.json that parses
#      as JSON is ever touched. No receipt -> not one byte changes.
#   2. Refuse drive roots, Windows / Program Files / ProgramData / Users / the profile itself
#      (and their ancestors), and a root that is itself a junction or symlink.
#   3. Paths are compared with a trailing backslash (C:\IRIS-old is never taken for a folder
#      inside C:\IRIS).
#   4. Trees are removed with `rd /s /q "\\?\<path>"`: read-only, hidden, system and >260-char
#      paths all go, and junctions inside are NOT followed (Remove-Item -Recurse in 5.1 is).
#   5. rd exits 0 even when a locked file stays, so success is judged by what is left.
#   6. A user item that could not be moved to the archive is never deleted.
#   7. The receipt goes last and stays if anything else stayed, so a rerun passes the gate.
#   8. Processes are stopped by PID only, never this process or any of its ancestors, and
#      never ordinary GUI apps (they are named from Restart Manager instead).
#
# Headless use (tests, automation):
#   -NoUi -Root <dir> [-Mode keep|all] [-Yes] [-DryRun] [-Json <file>] [-LogFile <file>]
#   -EnvSubKey/-RunSubKey  HKCU subkeys used instead of Environment / ...\Run (tests)
#   -DesktopDir <dir>      desktop folder to look for shortcuts in (tests)
#   -WorkDir <dir>         instead of %LOCALAPPDATA%\IRIS-Installer (tests)
#   -ScanRoots "a;b"       parent folders to look for installs in instead of every fixed drive
#   -Scan                  print what was found as JSON and exit
#   -Screenshot <dir>      draw every screen into PNG files and exit (layout check)
# Exit codes: 0 done (or dry run), 1 partial, 2 refused / nothing found, 3 cancelled, 4 error.

param(
  [switch]$NoUi,
  [ValidateSet('keep', 'all')][string]$Mode = 'keep',
  [switch]$Yes,
  [string]$Root,
  [string]$EnvSubKey = 'Environment',
  [string]$RunSubKey = 'Software\Microsoft\Windows\CurrentVersion\Run',
  [string]$DesktopDir,
  [string]$WorkDir,
  [string]$ScanRoots,
  [switch]$DryRun,
  [string]$Json,
  [string]$LogFile,
  [switch]$Scan,
  [string]$Screenshot,
  [string]$StringsFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:IgnoreCase = [StringComparison]::OrdinalIgnoreCase
$script:DefaultEnvKey = ($EnvSubKey -eq 'Environment')
$script:RunValueName = 'IRIS relay'
$script:RelayUrlRe = '^https?://(127\.0\.0\.1|localhost):3456/?$'
$script:EnvNames = @('CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_BASE_URL', 'TEAMCLAUDE_CONFIG')
$script:SystemDirs = @('_agent', '_ontology', '_cleanup', '_document-templates', '_setup-guides')
$script:SystemFiles = @('soul-state.json', 'AGENTS.md', 'CLAUDE.md', '_cosmos.ico', 'desktop.ini')
$script:EmptyOnlyDirs = @('_trash', '_backup')
$script:HostNames = @('node.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe', 'cscript.exe',
  'bash.exe', 'sh.exe', 'uv.exe', 'uvx.exe', 'git.exe')
$script:BrowserNames = @('chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe')

# ---------------------------------------------------------------- log + strings

if (-not $LogFile) {
  $LogFile = Join-Path ([IO.Path]::GetTempPath()) ('IRIS-uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
}
$script:LogPath = $LogFile

function Write-Log([string]$msg) {
  $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $msg
  try { [IO.File]::AppendAllText($script:LogPath, $line + "`r`n", $script:Utf8) } catch { }
  if ($NoUi) { try { [Console]::Out.WriteLine($line) } catch { } }
}

function Read-JsonFile([string]$path) {
  $raw = [IO.File]::ReadAllText($path, $script:Utf8)
  return ($raw | ConvertFrom-Json)
}

$script:S = $null
function Load-Strings {
  $f = if ($StringsFile) { $StringsFile } else { Join-Path $script:Here 'uninstall-ko.json' }
  $script:S = Read-JsonFile $f
  foreach ($n in @($script:S.systemFilesKo)) { if ($n) { $script:SystemFiles += [string]$n } }
}

# T 'key' arg0 arg1 -> string from uninstall-ko.json with {0},{1} filled.
function T([string]$key) {
  $v = $null
  if ($script:S) { $p = $script:S.PSObject.Properties[$key]; if ($p) { $v = [string]$p.Value } }
  if ($null -eq $v) { $v = $key }
  if ($args.Count -gt 0) { $v = [string]::Format($v, [object[]]$args) }
  return $v
}

# ---------------------------------------------------------------- paths

function Normalize-Dir([string]$p) {
  if (-not $p) { return $null }
  $full = [IO.Path]::GetFullPath($p)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
  return $full
}

function Test-SamePath([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  return [string]::Equals($a.TrimEnd('\'), $b.TrimEnd('\'), $script:IgnoreCase)
}

# $path is $base itself or somewhere below it (compared with a trailing backslash).
function Test-Inside([string]$path, [string]$base) {
  if (-not $path -or -not $base) { return $false }
  $b = $base.TrimEnd('\') + '\'
  $p = $path.TrimEnd('\') + '\'
  return $p.StartsWith($b, $script:IgnoreCase)
}

# Does free text (a command line, a registry value) name $root or anything under it?
# The character after the match must end the path (\ / " ' space or end), so C:\IRIS never
# matches C:\IRIS-upg.
function Test-Mentions([string]$text, [string]$root) {
  if (-not $text -or -not $root) { return $false }
  $t = $text.Replace('/', '\')
  $r = $root.TrimEnd('\')
  $i = 0
  while ($true) {
    $i = $t.IndexOf($r, $i, $script:IgnoreCase)
    if ($i -lt 0) { return $false }
    $end = $i + $r.Length
    if ($end -ge $t.Length) { return $true }
    $c = $t[$end]
    if ($c -eq '\' -or $c -eq '"' -or $c -eq "'" -or $c -eq ' ' -or $c -eq ';') { return $true }
    $i = $end
  }
}

function Test-Reparse([string]$path) {
  try {
    $a = [IO.File]::GetAttributes($path)
    return (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  } catch { return $false }
}

# Locations the uninstaller must never delete, whatever a receipt says. Returns a reason or $null.
function Get-DangerReason([string]$root) {
  if (-not $root) { return 'empty' }
  if ($root -notmatch '^[A-Za-z]:\\.+') { return 'not-a-local-folder' }
  $full = Normalize-Dir $root
  if ($full.Length -le 3) { return 'drive-root' }
  $protected = @($env:SystemRoot, $env:windir, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432,
    $env:ProgramData, $env:USERPROFILE, $env:PUBLIC, $env:APPDATA, $env:LOCALAPPDATA,
    [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'))
  if ($env:SystemDrive) { $protected += ($env:SystemDrive + '\Users') }
  foreach ($p in $protected) {
    if (-not $p) { continue }
    $pn = Normalize-Dir $p
    # the root IS a protected folder, or contains one
    if (Test-Inside $pn $full) { return 'protected-location' }
  }
  foreach ($p in @($env:SystemRoot, $env:windir, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) {
    if ($p -and (Test-Inside $full (Normalize-Dir $p))) { return 'protected-location' }
  }
  return $null
}

# ---------------------------------------------------------------- registry (HKCU only)
# .NET instead of Get-ItemProperty: reads the raw value (REG_EXPAND_SZ stays unexpanded)
# and writes it back with the same kind, so a restored %USERPROFILE%\... stays a variable.

function Get-RegValue([string]$sub, [string]$name) {
  $r = @{ Exists = $false; Value = $null; Kind = [Microsoft.Win32.RegistryValueKind]::String }
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $false)
  if (-not $k) { return $r }
  try {
    $v = $k.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $v) { $r.Exists = $true; $r.Value = [string]$v; $r.Kind = $k.GetValueKind($name) }
  } finally { $k.Close() }
  return $r
}

function Get-RegNames([string]$sub) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $false)
  if (-not $k) { return @() }
  try { return @($k.GetValueNames()) } finally { $k.Close() }
}

function Set-RegValue([string]$sub, [string]$name, [string]$value, $kind) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
  if (-not $k) { throw "registry key missing: HKCU\$sub" }
  try { $k.SetValue($name, $value, $kind) } finally { $k.Close() }
}

function Remove-RegValue([string]$sub, [string]$name) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
  if (-not $k) { return }
  try { $k.DeleteValue($name, $false) } finally { $k.Close() }
}

# Tell Explorer (and new terminals) that HKCU\Environment changed. Skipped for test subkeys.
function Send-EnvBroadcast {
  if (-not $script:DefaultEnvKey) { return }
  try {
    if (-not ('IrisUninstall.Native' -as [type])) {
      Add-Type -Namespace IrisUninstall -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
  uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $res = [UIntPtr]::Zero
    [void][IrisUninstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$res)
  } catch { Write-Log ('broadcast failed: ' + $_.Exception.Message) }
}

# ---------------------------------------------------------------- discovery

function Get-ReceiptPath([string]$root) { return (Join-Path $root '_agent\setup\package-receipt.json') }

# $null = no receipt file; @{ Bad = $true } = a file that is not JSON; else the parsed object.
function Read-Receipt([string]$root) {
  $p = Get-ReceiptPath $root
  if (-not [IO.File]::Exists($p)) { return $null }
  try {
    $o = Read-JsonFile $p
    if ($null -eq $o -or $o -isnot [psobject]) { return @{ Bad = $true } }
    return $o
  } catch { return @{ Bad = $true } }
}

function Get-Prop($obj, [string]$dotted) {
  $cur = $obj
  foreach ($part in $dotted.Split('.')) {
    if ($null -eq $cur) { return $null }
    if ($cur -is [hashtable]) { $cur = $cur[$part]; continue }
    $p = $cur.PSObject.Properties[$part]
    if (-not $p) { return $null }
    $cur = $p.Value
  }
  return $cur
}

# Values the variables had before IRIS set them (receipt env.previous; 2.x also keeps a
# copy under setup.<stage>.recorded.userEnv.previous).
function Get-PreviousEnv($receipt) {
  $prev = @{}
  $sources = @()
  $sources += , (Get-Prop $receipt 'env.previous')
  $setup = Get-Prop $receipt 'setup'
  if ($setup -and $setup -isnot [hashtable]) {
    foreach ($st in $setup.PSObject.Properties) { $sources += , (Get-Prop $st.Value 'recorded.userEnv.previous') }
  }
  foreach ($src in $sources) {
    if ($null -eq $src -or $src -is [string]) { continue }
    foreach ($p in $src.PSObject.Properties) {
      if (-not $prev.ContainsKey($p.Name) -and $null -ne $p.Value -and [string]$p.Value -ne '') { $prev[$p.Name] = [string]$p.Value }
    }
  }
  return $prev
}

function New-Install([string]$root, $receipt) {
  $ver = [string](Get-Prop $receipt 'package.version')
  $schema = Get-Prop $receipt 'schema'
  return [pscustomobject]@{
    Root     = $root
    Receipt  = $receipt
    Version  = $ver
    Schema   = $schema
    SoulRoot = [string](Get-Prop $receipt 'soul.root')
    Previous = (Get-PreviousEnv $receipt)
  }
}

# Folder names on a drive that are never an IRIS install and are not worth opening.
$script:SkipTopNames = @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users',
  '$Recycle.Bin', 'System Volume Information', 'Recovery', 'PerfLogs', 'Config.Msi', 'MSOCache',
  'Documents and Settings', '$WINDOWS.~BT', '$Windows.~WS', 'OneDriveTemp')

function Get-ScanParents {
  if ($ScanRoots) { return @($ScanRoots.Split(';') | Where-Object { $_ } | ForEach-Object { Normalize-Dir $_ }) }
  $out = @()
  foreach ($d in [IO.DriveInfo]::GetDrives()) {
    try { if ($d.DriveType -eq 'Fixed' -and $d.IsReady) { $out += $d.RootDirectory.FullName } } catch { }
  }
  return $out
}

# The root an env value such as <root>\_agent\claude belongs to (text before \_agent\).
function Get-RootFromValue([string]$value) {
  if (-not $value) { return $null }
  $v = [Environment]::ExpandEnvironmentVariables($value).Replace('/', '\')
  $m = [regex]::Match($v, '([A-Za-z]:\\[^";]*?)\\_agent(\\|$|")', 'IgnoreCase')
  if (-not $m.Success) { return $null }
  return (Normalize-Dir $m.Groups[1].Value)
}

# Every folder on this PC that has an IRIS receipt: <drive>\<top folder> plus the root the
# current CLAUDE_CONFIG_DIR points at. Bad (non-JSON) receipts are listed with Bad = $true.
function Find-Installs {
  $seen = @{}
  $found = New-Object System.Collections.ArrayList
  $cands = New-Object System.Collections.ArrayList
  foreach ($parent in Get-ScanParents) {
    $dirs = @()
    try { $dirs = [IO.Directory]::GetDirectories($parent) } catch { continue }
    foreach ($d in $dirs) {
      $leaf = [IO.Path]::GetFileName($d)
      if ($script:SkipTopNames -contains $leaf) { continue }
      if (Test-Reparse $d) { continue }
      [void]$cands.Add($d)
    }
  }
  foreach ($n in @('CLAUDE_CONFIG_DIR', 'CODEX_HOME')) {
    $r = Get-RootFromValue (Get-RegValue $EnvSubKey $n).Value
    if ($r) { [void]$cands.Add($r) }
  }
  foreach ($d in $cands) {
    $key = (Normalize-Dir $d).ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $rc = Read-Receipt $d
    if ($null -eq $rc) { continue }
    if ($rc -is [hashtable]) { [void]$found.Add([pscustomobject]@{ Root = (Normalize-Dir $d); Bad = $true }); continue }
    [void]$found.Add((New-Install (Normalize-Dir $d) $rc))
  }
  return $found
}

# Which install to offer first: the one this user's CLAUDE_CONFIG_DIR points at, then C:\IRIS.
function Select-Default($installs) {
  $good = @($installs | Where-Object { -not $_.PSObject.Properties['Bad'] })
  if ($good.Count -eq 0) { return $null }
  $cfgRoot = Get-RootFromValue (Get-RegValue $EnvSubKey 'CLAUDE_CONFIG_DIR').Value
  foreach ($i in $good) { if (Test-SamePath $i.Root $cfgRoot) { return $i } }
  foreach ($i in $good) { if (Test-SamePath $i.Root 'C:\IRIS') { return $i } }
  return $good[0]
}

# ---------------------------------------------------------------- plan
# A plan is computed before anything changes (the UI shows it, -DryRun prints it) and again
# before each retry, so a rerun always starts from what is really left.

function Get-TopItems([string]$root) {
  $out = New-Object System.Collections.ArrayList
  foreach ($fi in (New-Object IO.DirectoryInfo $root).GetFileSystemInfos()) {
    $isDir = (($fi.Attributes -band [IO.FileAttributes]::Directory) -ne 0)
    $isLink = (($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    [void]$out.Add([pscustomobject]@{ Name = $fi.Name; Path = $fi.FullName; IsDir = $isDir; IsLink = $isLink })
  }
  return $out
}

function Test-DirEmpty([string]$p) {
  try { return -not ([IO.Directory]::EnumerateFileSystemEntries($p).GetEnumerator().MoveNext()) } catch { return $false }
}

# What the package laid down at the top of the root. Everything else is the user's.
function Test-SystemItem($item) {
  $n = $item.Name
  if ($item.IsDir) {
    if ($script:SystemDirs -contains $n) { return $true }
    if ($script:EmptyOnlyDirs -contains $n) { return ($item.IsLink -or (Test-DirEmpty $item.Path)) }
    return $false
  }
  if ($script:SystemFiles -contains $n) { return $true }
  if ($n -like '* Face.cmd') { return $true }
  return $false
}

# <parent>\<leaf>-<archiveWord>-yyyy-MM-dd. A folder of that name that is already there is
# reused (a rerun after a partial run puts the rest of the work next to what the first run
# moved, or a second uninstall on the same day; Get-UniqueDest keeps every name apart and the
# root AGENTS.md copy keeps changed rules beside the old ones). -2, -3 ... only when the name is taken by a
# file or a link.
function Get-ArchivePath([string]$root) {
  $parent = [IO.Path]::GetDirectoryName($root)
  $leaf = [IO.Path]::GetFileName($root)
  $base = Join-Path $parent ($leaf + '-' + (T 'archiveWord') + '-' + (Get-Date -Format 'yyyy-MM-dd'))
  $p = $base
  $i = 2
  while ((Test-Path -LiteralPath $p) -and (-not [IO.Directory]::Exists($p) -or (Test-Reparse $p))) { $p = $base + '-' + $i; $i++ }
  return $p
}

# Is this the value IRIS itself wrote (for this root)? Only such values are ever changed.
function Test-IrisValue([string]$name, [string]$value, $roots) {
  if (-not $value) { return $false }
  if ($name -eq 'ANTHROPIC_BASE_URL') { return ($value.Trim() -match $script:RelayUrlRe) }
  $exp = [Environment]::ExpandEnvironmentVariables($value)
  foreach ($r in $roots) { if (Test-Mentions $exp $r) { return $true } }
  return $false
}

# restore = put the value the user had before IRIS back (same registry kind);
# delete = IRIS created the variable. A variable the user changed since is left alone.
function Get-EnvPlan($roots, $previous, [bool]$othersRemain) {
  $acts = New-Object System.Collections.ArrayList
  # The relay address names no folder, so it goes only when no other IRIS remains AND the
  # user's CLAUDE_CONFIG_DIR does not belong to another folder that still exists (a PC
  # set up by hand has no receipt but still uses the relay).
  $relayInUse = $othersRemain
  $cfgRoot = Get-RootFromValue (Get-RegValue $EnvSubKey 'CLAUDE_CONFIG_DIR').Value
  if ($cfgRoot -and (Test-Path -LiteralPath $cfgRoot)) {
    $mine = $false
    foreach ($r in $roots) { if (Test-SamePath $cfgRoot $r) { $mine = $true } }
    if (-not $mine) { $relayInUse = $true }
  }
  foreach ($n in $script:EnvNames) {
    $cur = Get-RegValue $EnvSubKey $n
    if (-not $cur.Exists) { continue }
    if (-not (Test-IrisValue $n $cur.Value $roots)) { continue }
    if ($n -eq 'ANTHROPIC_BASE_URL' -and $relayInUse) { continue }
    $prev = $null
    if ($previous -and $previous.ContainsKey($n)) { $prev = [string]$previous[$n] }
    if ($prev -and -not (Test-IrisValue $n $prev $roots)) {
      [void]$acts.Add([pscustomobject]@{ Name = $n; Action = 'restore'; Value = $prev; Kind = $cur.Kind; Current = $cur.Value })
    } else {
      [void]$acts.Add([pscustomobject]@{ Name = $n; Action = 'delete'; Value = $null; Kind = $cur.Kind; Current = $cur.Value })
    }
  }
  return $acts
}

# Only the Path entries that point inside the root go; every other entry stays byte for byte.
function Get-PathPlan($roots) {
  $cur = Get-RegValue $EnvSubKey 'Path'
  if (-not $cur.Exists) { return $null }
  $keep = New-Object System.Collections.ArrayList
  $removed = New-Object System.Collections.ArrayList
  foreach ($seg in $cur.Value.Split(';')) {
    $exp = [Environment]::ExpandEnvironmentVariables($seg.Trim().Trim('"'))
    $hit = $false
    if ($exp) { foreach ($r in $roots) { if (Test-Inside $exp $r) { $hit = $true } } }
    if ($hit) { [void]$removed.Add($seg) } else { [void]$keep.Add($seg) }
  }
  if ($removed.Count -eq 0) { return $null }
  $new = ($keep -join ';')
  return [pscustomobject]@{ Removed = @($removed); NewValue = $new; Kind = $cur.Kind; Delete = ($new.Trim(';', ' ') -eq '') }
}

# The logon autostart IRIS registers ("IRIS relay"), or any other Run value that starts
# something from <root>\_agent. A user's own Run values are not touched.
function Get-RunPlan($roots) {
  $acts = New-Object System.Collections.ArrayList
  foreach ($n in Get-RegNames $RunSubKey) {
    $v = (Get-RegValue $RunSubKey $n).Value
    if (-not $v) { continue }
    $exp = [Environment]::ExpandEnvironmentVariables($v)
    foreach ($r in $roots) {
      if ((Test-Mentions $exp $r) -and ($n -eq $script:RunValueName -or (Test-Mentions $exp (Join-Path $r '_agent')))) {
        [void]$acts.Add([pscustomobject]@{ Name = $n; Value = $v })
        break
      }
    }
  }
  return $acts
}

function Get-DesktopDirs {
  if ($DesktopDir) { return @($DesktopDir) }
  $out = @()
  foreach ($d in @([Environment]::GetFolderPath('Desktop'), $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'Desktop' }))) {
    if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
    $dup = $false
    foreach ($o in $out) { if (Test-SamePath $o $d) { $dup = $true } }
    if (-not $dup) { $out += $d }
  }
  return $out
}

# Desktop shortcuts whose target is inside the root (the installer makes "<name>.lnk").
function Get-LnkPlan($roots) {
  $out = New-Object System.Collections.ArrayList
  $sh = $null
  try { $sh = New-Object -ComObject WScript.Shell } catch { return $out }
  foreach ($d in Get-DesktopDirs) {
    $files = @()
    try { $files = [IO.Directory]::GetFiles($d, '*.lnk') } catch { }
    foreach ($f in $files) {
      $t = $null
      try { $t = $sh.CreateShortcut($f).TargetPath } catch { }
      if (-not $t) { continue }
      foreach ($r in $roots) { if (Test-Inside $t $r) { [void]$out.Add($f); break } }
    }
  }
  return $out
}

function Get-WorkDirPath {
  if ($WorkDir) { return (Normalize-Dir $WorkDir) }
  if (-not $env:LOCALAPPDATA) { return $null }
  return (Join-Path $env:LOCALAPPDATA 'IRIS-Installer')
}

function New-Plan($inst, [string]$archive) {
  $roots = @($inst.Root)
  if ($inst.SoulRoot -and -not (Test-SamePath $inst.SoulRoot $inst.Root)) {
    try {
      $sr = Normalize-Dir $inst.SoulRoot
      if ($sr -and -not (Test-Path -LiteralPath $sr) -and -not (Get-DangerReason $sr)) { $roots += $sr }
    } catch { }
  }
  $othersRemain = (@($script:Installs | Where-Object { -not (Test-SamePath $_.Root $inst.Root) }).Count -gt 0)
  $user = New-Object System.Collections.ArrayList
  $system = New-Object System.Collections.ArrayList
  foreach ($it in @(Get-TopItems $inst.Root)) {
    if (Test-SystemItem $it) { [void]$system.Add($it) } else { [void]$user.Add($it) }
  }
  if (-not $archive -and $user.Count -gt 0) { $archive = Get-ArchivePath $inst.Root }
  $wd = Get-WorkDirPath
  if ($othersRemain -or -not $wd -or -not (Test-Path -LiteralPath $wd)) { $wd = $null }
  return [pscustomobject]@{
    Kind         = 'install'
    Root         = $inst.Root
    Roots        = $roots
    Version      = $inst.Version
    Install      = $inst
    UserItems    = $user
    SystemItems  = $system
    Archive      = $archive
    Env          = @(Get-EnvPlan $roots $inst.Previous $othersRemain)
    PathPlan     = (Get-PathPlan $roots)
    Run          = @(Get-RunPlan $roots)
    Lnks         = @(Get-LnkPlan $roots)
    WorkDir      = $wd
    OthersRemain = $othersRemain
  }
}

# Roots that settings still point at but that no longer exist (the folder was deleted by
# hand). Only their settings are cleaned; there are no files to touch.
function Find-OrphanRoots {
  $vals = New-Object System.Collections.ArrayList
  foreach ($n in $script:EnvNames) { [void]$vals.Add((Get-RegValue $EnvSubKey $n).Value) }
  $p = (Get-RegValue $EnvSubKey 'Path').Value
  if ($p) { foreach ($seg in $p.Split(';')) { [void]$vals.Add($seg) } }
  foreach ($n in Get-RegNames $RunSubKey) { if ($n -eq $script:RunValueName) { [void]$vals.Add((Get-RegValue $RunSubKey $n).Value) } }
  $out = New-Object System.Collections.ArrayList
  foreach ($v in $vals) {
    $r = Get-RootFromValue $v
    if (-not $r) { continue }
    if (Test-Path -LiteralPath $r) { continue }
    if (Get-DangerReason $r) { continue }
    $dup = $false
    foreach ($o in $out) { if (Test-SamePath $o $r) { $dup = $true } }
    if (-not $dup) { [void]$out.Add($r) }
  }
  return $out
}

function New-TracePlan($roots) {
  $othersRemain = (@($script:Installs).Count -gt 0)
  $wd = Get-WorkDirPath
  if ($othersRemain -or -not $wd -or -not (Test-Path -LiteralPath $wd)) { $wd = $null }
  $plan = [pscustomobject]@{
    Kind         = 'traces'
    Root         = $roots[0]
    Roots        = @($roots)
    Version      = $null
    Install      = $null
    UserItems    = @()
    SystemItems  = @()
    Archive      = $null
    Env          = @(Get-EnvPlan $roots @{} $othersRemain)
    PathPlan     = (Get-PathPlan $roots)
    Run          = @(Get-RunPlan $roots)
    Lnks         = @(Get-LnkPlan $roots)
    WorkDir      = $wd
    OthersRemain = $othersRemain
  }
  return $plan
}

# The installer work folder is not counted: on its own it may belong to an install that is
# running right now (no receipt yet), so it is only removed together with real traces.
function Get-TraceCount($plan) {
  $n = @($plan.Env).Count + @($plan.Run).Count + @($plan.Lnks).Count
  if ($plan.PathPlan) { $n += @($plan.PathPlan.Removed).Count }
  return $n
}

# ---------------------------------------------------------------- processes (PID only)

$script:Pump = $null   # the UI sets this to DoEvents so the window stays alive during long steps
function Invoke-Pump { if ($script:Pump) { & $script:Pump } }

function Get-ProcessTable {
  try {
    return @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine -ErrorAction Stop)
  } catch {
    return @(Get-WmiObject -Class Win32_Process -ErrorAction SilentlyContinue)
  }
}

# Processes that run IRIS from this root: any program under <root>\, a script host (node,
# python, powershell, cmd, wscript ...) whose command line names the root, their script-host
# children, a browser started with --user-data-dir inside the root, and anything under the
# installer's work folder when that folder is about to go. Never this process or its parents.
function Get-KillTargets($roots, [string]$workDir) {
  $all = Get-ProcessTable
  $byPid = @{}
  foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
  $protect = @{}
  $cur = $PID
  for ($i = 0; $i -lt 64 -and $byPid.ContainsKey($cur) -and -not $protect.ContainsKey($cur); $i++) {
    $protect[$cur] = $true
    $cur = [int]$byPid[$cur].ParentProcessId
  }
  $protect[$PID] = $true
  $bases = @($roots)
  if ($workDir) { $bases += $workDir }
  $hit = @{}
  foreach ($p in $all) {
    $id = [int]$p.ProcessId
    if ($id -le 4 -or $protect.ContainsKey($id)) { continue }
    $name = ([string]$p.Name).ToLowerInvariant()
    $exe = [string]$p.ExecutablePath
    $cl = [string]$p.CommandLine
    $isHost = (($script:HostNames -contains $name) -or ($name -like 'python*.exe'))
    foreach ($b in $bases) {
      if ($exe -and (Test-Inside $exe $b)) { $hit[$id] = $p; break }
      if ($isHost -and (Test-Mentions $cl $b)) { $hit[$id] = $p; break }
      if ($script:BrowserNames -contains $name) {
        $m = [regex]::Match($cl, '--user-data-dir=(?:"([^"]*)"|(\S+))')
        if ($m.Success) {
          $ud = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
          if (Test-Inside $ud.Replace('/', '\') $b) { $hit[$id] = $p; break }
        }
      }
    }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId
      if ($hit.ContainsKey($id) -or $protect.ContainsKey($id)) { continue }
      $name = ([string]$p.Name).ToLowerInvariant()
      if (-not (($script:HostNames -contains $name) -or ($name -like 'python*.exe'))) { continue }
      if ($hit.ContainsKey([int]$p.ParentProcessId)) { $hit[$id] = $p; $changed = $true }
    }
  }
  $out = @()
  foreach ($p in $hit.Values) {
    $out += [pscustomobject]@{ Pid = [int]$p.ProcessId; Name = [string]$p.Name; Exe = [string]$p.ExecutablePath }
  }
  return $out
}

# Up to three passes: a supervisor killed in pass 1 may have restarted a child meanwhile.
function Stop-IrisProcesses($roots, [string]$workDir) {
  $killed = New-Object System.Collections.ArrayList
  for ($pass = 0; $pass -lt 3; $pass++) {
    $targets = @(Get-KillTargets $roots $workDir)
    if ($targets.Count -eq 0) { break }
    foreach ($t in $targets) {
      try {
        $p = [Diagnostics.Process]::GetProcessById($t.Pid)
        if (-not [string]::Equals($p.ProcessName, [IO.Path]::GetFileNameWithoutExtension($t.Name), $script:IgnoreCase)) { continue }
        $p.Kill()
        [void]$p.WaitForExit(3000)
        [void]$killed.Add(('{0} (pid {1})' -f $t.Name, $t.Pid))
        Write-Log ('stopped pid {0} {1}' -f $t.Pid, $t.Name)
      } catch { Write-Log ('stop pid {0} failed: {1}' -f $t.Pid, $_.Exception.Message) }
      Invoke-Pump
    }
    Start-Sleep -Milliseconds 300
  }
  return $killed
}

# Programs that still hold files under $path (Restart Manager; helper is optional).
function Get-Holders([string]$path) {
  $helper = $null
  foreach ($c in @((Join-Path $script:Here 'file-holders.ps1'), (Join-Path $script:Here 'lib\file-holders.ps1'))) {
    if (Test-Path -LiteralPath $c) { $helper = $c; break }
  }
  if (-not $helper -or -not (Test-Path -LiteralPath $path)) { return @() }
  try {
    $txt = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -Path $path 2>$null | Out-String
    $arr = @($txt | ConvertFrom-Json)
    $names = @()
    foreach ($h in $arr) {
      if ($null -eq $h) { continue }
      $label = if ($h.app) { [string]$h.app } else { [string]$h.name }
      $s = '{0} (pid {1})' -f $label, $h.pid
      if ($names -notcontains $s) { $names += $s }
    }
    return $names
  } catch { return @() }
}

# ---------------------------------------------------------------- files

# Every delete goes through here: $path must be strictly inside $base.
function Assert-Under([string]$path, [string]$base) {
  if (-not (Test-Inside $path $base) -or (Test-SamePath $path $base)) {
    throw ('refusing to delete outside the IRIS folder: ' + $path)
  }
}

function Clear-Attributes([string]$p) {
  try {
    $a = [IO.File]::GetAttributes($p)
    $keep = $a -band [IO.FileAttributes]::Directory
    if ($a -ne $keep) { [IO.File]::SetAttributes($p, $(if ($keep) { $keep } else { [IO.FileAttributes]::Normal })) }
  } catch { }
}

# Managed fallback for names cmd.exe would mangle (a '%' could expand as a variable).
# Never descends into a junction or symlink; only the link itself is removed.
function Remove-TreeManaged([string]$dir) {
  $lp = if ($dir.StartsWith('\\?\')) { $dir } else { '\\?\' + $dir }
  $entries = @()
  try { $entries = [IO.Directory]::GetFileSystemEntries($lp) } catch { }
  foreach ($e in $entries) {
    try {
      $a = [IO.File]::GetAttributes($e)
      if (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if (($a -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($e, $false) } else { [IO.File]::Delete($e) }
      } elseif (($a -band [IO.FileAttributes]::Directory) -ne 0) {
        Remove-TreeManaged $e
      } else {
        Clear-Attributes $e
        [IO.File]::Delete($e)
      }
    } catch { }
  }
  try { Clear-Attributes $lp; [IO.Directory]::Delete($lp, $false) } catch { }
}

# rd /s /q in a child process: handles read-only, hidden, system and long paths and does not
# follow junctions. It exits 0 even when a locked file stays, so the caller checks what is left.
function Invoke-Rd([string]$dir) {
  if ($dir.Contains('%')) { Remove-TreeManaged $dir; return }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $psi.Arguments = '/d /c rd /s /q "\\?\' + $dir + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = [IO.Path]::GetTempPath()
  $p = [Diagnostics.Process]::Start($psi)
  $errTask = $p.StandardError.ReadToEndAsync()
  $outTask = $p.StandardOutput.ReadToEndAsync()
  while (-not $p.WaitForExit(100)) { Invoke-Pump }
  $p.WaitForExit()
  $err = $errTask.Result
  if ($err) { Write-Log ('rd: ' + ($err.Trim() -replace '\s*\r?\n\s*', ' | ')) }
}

# Removes one item (file, folder, or link) that lies strictly inside $base. True when gone.
function Remove-InsideItem([string]$path, [string]$base) {
  Assert-Under $path $base
  if (-not (Test-Path -LiteralPath $path)) { return $true }
  $a = [IO.File]::GetAttributes($path)
  $isDir = (($a -band [IO.FileAttributes]::Directory) -ne 0)
  try {
    if (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      if ($isDir) { [IO.Directory]::Delete($path, $false) } else { [IO.File]::Delete($path) }
    } elseif ($isDir) {
      Clear-Attributes $path
      Invoke-Rd $path
    } else {
      Clear-Attributes $path
      [IO.File]::Delete($path)
    }
  } catch { Write-Log ('delete failed: ' + $path + ' -- ' + $_.Exception.Message) }
  $gone = -not (Test-Path -LiteralPath $path)
  if ($gone) { Write-Log ('removed ' + $path) } else { Write-Log ('still there: ' + $path) }
  return $gone
}

function Get-ChildNames([string]$dir) {
  try { return @([IO.Directory]::GetFileSystemEntries($dir) | ForEach-Object { [IO.Path]::GetFileName($_) }) } catch { return @() }
}

# What is still inside the root, as short relative names (for the partial screen and JSON).
function Get-Remaining([string]$root) {
  $out = @()
  if (-not (Test-Path -LiteralPath $root)) { return $out }
  foreach ($n in Get-ChildNames $root) {
    if ($n -ne '_agent') { $out += $n; continue }
    foreach ($c in Get-ChildNames (Join-Path $root '_agent')) {
      if ($c -ne 'setup') { $out += ('_agent\' + $c); continue }
      foreach ($s in Get-ChildNames (Join-Path $root '_agent\setup')) {
        if ($s -ne 'package-receipt.json') { $out += ('_agent\setup\' + $s) }
      }
    }
  }
  return $out
}

# A taken name gets " (2)", " (3)" ... A folder keeps its whole name ("D02.01-x (2)", ".agents (2)");
# a file keeps its extension ("notes (2).txt") unless it has no stem (".gitignore (2)").
function Get-UniqueDest([string]$dir, [string]$name, [bool]$isDir) {
  $d = Join-Path $dir $name
  $stem = [IO.Path]::GetFileNameWithoutExtension($name)
  $ext = [IO.Path]::GetExtension($name)
  if ($isDir -or -not $stem) { $stem = $name; $ext = '' }
  $i = 2
  while (Test-Path -LiteralPath $d) {
    $d = Join-Path $dir ('{0} ({1}){2}' -f $stem, $i, $ext)
    $i++
  }
  return $d
}

# ---------------------------------------------------------------- run a plan
# Steps (the progress screen shows the same eight lines):
#   1 stop IRIS programs  2 logon autostart  3 environment variables  4 PATH
#   5 desktop shortcut    6 move my work     7 delete the IRIS folder  8 installer work folder

$script:OnStep = $null   # UI: { param($n, $state, $detail) }  state = run | ok | skip | fail

function Set-Step([int]$n, [string]$state, [string]$detail) {
  Write-Log ('step {0} {1} {2}' -f $n, $state, $detail)
  if ($script:OnStep) { & $script:OnStep $n $state $detail }
  Invoke-Pump
}

function Get-CountLabel([int]$n) { if ($n -gt 0) { return (T 'stepCount' $n) } else { return (T 'stepSkip') } }

function New-Result($plan, [string]$mode) {
  return [ordered]@{
    ok = $false; status = $null; kind = $plan.Kind; root = $plan.Root; mode = $mode; version = $plan.Version
    archive = $null; moved = @(); moveFailed = @(); removed = @(); remaining = @(); holders = @()
    killed = @(); env = @(); path = @(); run = @(); lnks = @(); workDir = $null
    leftEmpty = $false; dryRun = [bool]$DryRun; log = $script:LogPath; error = $null; reason = $null
  }
}

# What a run would do, without doing it.
function Get-DryRunResult($plan, [string]$mode) {
  $res = New-Result $plan $mode
  $res.status = 'dry-run'
  $res.ok = $true
  $users = @($plan.UserItems | ForEach-Object { $_.Name })
  if ($plan.Kind -eq 'install') {
    if ($mode -eq 'keep') { $res.moved = $users; if ($users.Count -gt 0) { $res.archive = $plan.Archive } }
    else { $res.removed += $users }
    $res.removed += @($plan.SystemItems | ForEach-Object { $_.Name })
  }
  $res.killed = @(Get-KillTargets $plan.Roots $plan.WorkDir | ForEach-Object { '{0} (pid {1})' -f $_.Name, $_.Pid })
  $res.env = @($plan.Env | ForEach-Object { '{0}:{1}' -f $_.Name, $_.Action })
  if ($plan.PathPlan) { $res.path = @($plan.PathPlan.Removed) }
  $res.run = @($plan.Run | ForEach-Object { $_.Name })
  $res.lnks = @($plan.Lnks)
  $res.workDir = $plan.WorkDir
  return $res
}

function Invoke-Plan($plan, [string]$mode) {
  $res = New-Result $plan $mode
  $isInstall = ($plan.Kind -eq 'install')
  if ($isInstall) {
    $danger = Get-DangerReason $plan.Root
    if ($danger) { throw ('refused location: ' + $danger) }
    if (Test-Reparse $plan.Root) { throw 'refused: the IRIS folder is a link to another place' }
    if (-not [IO.File]::Exists((Get-ReceiptPath $plan.Root))) { throw 'the receipt disappeared before the run' }
  }
  Write-Log ('run kind={0} root={1} mode={2} version={3}' -f $plan.Kind, $plan.Root, $mode, $plan.Version)

  # 1 -- programs running from the root (and from the installer work folder if it goes)
  Set-Step 1 'run' ''
  $res.killed = @(Stop-IrisProcesses $plan.Roots $plan.WorkDir)
  Set-Step 1 'ok' (Get-CountLabel $res.killed.Count)

  # 2 -- logon autostart
  Set-Step 2 'run' ''
  foreach ($r in $plan.Run) {
    Remove-RegValue $RunSubKey $r.Name
    $res.run += $r.Name
    Write-Log ('run value removed: ' + $r.Name)
  }
  Set-Step 2 'ok' (Get-CountLabel $res.run.Count)

  # 3 -- environment variables: restore what was there before IRIS, else remove
  Set-Step 3 'run' ''
  foreach ($e in $plan.Env) {
    if ($e.Action -eq 'restore') { Set-RegValue $EnvSubKey $e.Name $e.Value $e.Kind }
    else { Remove-RegValue $EnvSubKey $e.Name }
    $res.env += ('{0}:{1}' -f $e.Name, $e.Action)
    Write-Log ('env {0} {1}' -f $e.Name, $e.Action)
  }
  Set-Step 3 'ok' (Get-CountLabel $res.env.Count)

  # 4 -- PATH entries inside the root
  Set-Step 4 'run' ''
  if ($plan.PathPlan) {
    if ($plan.PathPlan.Delete) { Remove-RegValue $EnvSubKey 'Path' }
    else { Set-RegValue $EnvSubKey 'Path' $plan.PathPlan.NewValue $plan.PathPlan.Kind }
    $res.path = @($plan.PathPlan.Removed)
    Write-Log ('path entries removed: ' + ($res.path -join ' | '))
  }
  if ($res.env.Count -gt 0 -or $res.path.Count -gt 0) { Send-EnvBroadcast }
  Set-Step 4 'ok' (Get-CountLabel $res.path.Count)

  # 5 -- desktop shortcuts that open the root
  Set-Step 5 'run' ''
  foreach ($l in $plan.Lnks) {
    try { [IO.File]::Delete($l); $res.lnks += $l; Write-Log ('shortcut removed: ' + $l) }
    catch { Write-Log ('shortcut delete failed: ' + $l + ' -- ' + $_.Exception.Message) }
  }
  Set-Step 5 'ok' (Get-CountLabel $res.lnks.Count)

  # 6 -- keep mode: user items move next to the root (a failed move stays in place, never deleted)
  if ($isInstall -and $mode -eq 'keep' -and @($plan.UserItems).Count -gt 0) {
    Set-Step 6 'run' ''
    $arch = $plan.Archive
    if (-not $arch -or (Test-Inside $arch $plan.Root)) { throw 'bad archive folder' }
    [void][IO.Directory]::CreateDirectory($arch)
    foreach ($it in $plan.UserItems) {
      $dest = Get-UniqueDest $arch $it.Name ([bool]$it.IsDir)
      try {
        if ($it.IsDir) { [IO.Directory]::Move($it.Path, $dest) } else { [IO.File]::Move($it.Path, $dest) }
        $res.moved += $it.Name
        Write-Log ('moved ' + $it.Path + ' -> ' + $dest)
      } catch {
        $res.moveFailed += $it.Name
        Write-Log ('move failed (left in place): ' + $it.Path + ' -- ' + $_.Exception.Message)
      }
      Invoke-Pump
    }
    if ($res.moved.Count -gt 0) {
      $res.archive = $arch
      # the root AGENTS.md holds the user's own rules as well; keep a copy with their work. An
      # archive reused from an earlier run may already hold older rules: those stay, rules that
      # changed since go beside them as "AGENTS (2).md", and the same rules are not copied twice.
      $ag = Join-Path $plan.Root 'AGENTS.md'
      if ([IO.File]::Exists($ag)) {
        try {
          $want = [Convert]::ToBase64String([IO.File]::ReadAllBytes($ag))
          $agDest = Join-Path $arch 'AGENTS.md'
          $have = $false
          $i = 2
          while (Test-Path -LiteralPath $agDest) {
            if ([IO.File]::Exists($agDest) -and ([Convert]::ToBase64String([IO.File]::ReadAllBytes($agDest)) -eq $want)) { $have = $true; break }
            $agDest = Join-Path $arch ('AGENTS ({0}).md' -f $i)
            $i++
          }
          if (-not $have) { [IO.File]::Copy($ag, $agDest) }
        } catch { Write-Log ('AGENTS.md copy failed: ' + $_.Exception.Message) }
      }
    } elseif (Test-DirEmpty $arch) {
      try { [IO.Directory]::Delete($arch, $false) } catch { }
    }
    Set-Step 6 $(if ($res.moveFailed.Count -gt 0) { 'fail' } else { 'ok' }) (Get-CountLabel $res.moved.Count)
  } else {
    Set-Step 6 'skip' (T 'stepSkip')
  }

  # 7 -- the root: user items (all mode), system items, _agent except the receipt, then the rest
  if ($isInstall) {
    Set-Step 7 'run' ''
    $root = $plan.Root
    $order = @()
    if ($mode -eq 'all') { $order += @($plan.UserItems) }
    $order += @($plan.SystemItems | Where-Object { $_.Name -ne '_agent' })
    foreach ($it in $order) {
      if ($res.moveFailed -contains $it.Name) { continue }
      if (Remove-InsideItem $it.Path $root) { $res.removed += $it.Name }
    }
    $agent = Join-Path $root '_agent'
    if (Test-Path -LiteralPath $agent) {
      if (Test-Reparse $agent) {
        [void](Remove-InsideItem $agent $root)
      } else {
        foreach ($c in Get-ChildNames $agent) {
          if ($c -ne 'setup') { [void](Remove-InsideItem (Join-Path $agent $c) $root) }
        }
        $setup = Join-Path $agent 'setup'
        foreach ($c in Get-ChildNames $setup) {
          if ($c -ne 'package-receipt.json') { [void](Remove-InsideItem (Join-Path $setup $c) $root) }
        }
      }
    }
    # the receipt goes last, and only when nothing else is left (a rerun must pass the gate)
    if (@(Get-Remaining $root).Count -eq 0) {
      $rcpt = Get-ReceiptPath $root
      try { if ([IO.File]::Exists($rcpt)) { Clear-Attributes $rcpt; [IO.File]::Delete($rcpt) } } catch { Write-Log ('receipt delete failed: ' + $_.Exception.Message) }
      foreach ($d in @((Join-Path $root '_agent\setup'), (Join-Path $root '_agent'), $root)) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        Clear-Attributes $d
        try { [IO.Directory]::Delete($d, $false) } catch { Write-Log ('could not remove folder: ' + $d + ' -- ' + $_.Exception.Message) }
      }
      if (Test-Path -LiteralPath $root) { $res.leftEmpty = $true; Write-Log ('left an empty folder: ' + $root) }
      else { $res.removed += '_agent'; Write-Log ('root removed: ' + $root) }
    }
    $res.remaining = @(Get-Remaining $root)
    if ($res.remaining.Count -gt 0) {
      $res.holders = @(Get-Holders $root)
      Set-Step 7 'fail' (T 'stepFail')
    } else {
      Set-Step 7 'ok' ''
    }
  } else {
    Set-Step 7 'skip' (T 'stepSkip')
  }

  # 8 -- the installer's work folder, only when no other IRIS remains and the root is gone
  if ($plan.WorkDir -and $res.remaining.Count -eq 0) {
    Set-Step 8 'run' ''
    $wd = $plan.WorkDir
    $okName = ($WorkDir -or [string]::Equals([IO.Path]::GetFileName($wd), 'IRIS-Installer', $script:IgnoreCase))
    if ($okName -and -not (Get-DangerReason $wd)) {
      if (Test-Reparse $wd) { try { [IO.Directory]::Delete($wd, $false) } catch { } }
      else { Clear-Attributes $wd; Invoke-Rd $wd }
    }
    if (-not (Test-Path -LiteralPath $wd)) { $res.workDir = $wd; Set-Step 8 'ok' '' }
    else { Write-Log ('work folder left: ' + $wd); Set-Step 8 'fail' (T 'stepFail') }
  } else {
    Set-Step 8 'skip' (T 'stepSkip')
  }

  if (-not $isInstall) { $res.status = 'traces-done' }
  elseif ($res.remaining.Count -gt 0) { $res.status = 'partial' }
  else { $res.status = 'done' }
  $res.ok = ($res.status -ne 'partial')
  Write-Log ('result ' + $res.status)
  return $res
}

# ---------------------------------------------------------------- target + headless

# -> Status install | traces | refused | notfound, with Install / Plan / Reason / Root.
function Resolve-Target {
  $script:Installs = @(Find-Installs)
  if ($Root) {
    $r = $null
    try { $r = Normalize-Dir $Root } catch { }
    if (-not $r) { return @{ Status = 'refused'; Reason = 'danger'; Root = $Root } }
    if (Get-DangerReason $r) { return @{ Status = 'refused'; Reason = 'danger'; Root = $r } }
    if (-not (Test-Path -LiteralPath $r)) {
      $script:Installs = @($script:Installs | Where-Object { -not (Test-SamePath $_.Root $r) })
      $tp = New-TracePlan @($r)
      if ((Get-TraceCount $tp) -gt 0) { return @{ Status = 'traces'; Plan = $tp; Root = $r } }
      return @{ Status = 'notfound'; Root = $r }
    }
    if (Test-Reparse $r) { return @{ Status = 'refused'; Reason = 'reparse'; Root = $r } }
    $rc = Read-Receipt $r
    if ($null -eq $rc -or $rc -is [hashtable]) { return @{ Status = 'refused'; Reason = 'noReceipt'; Root = $r } }
    return @{ Status = 'install'; Install = (New-Install $r $rc); Root = $r }
  }
  $inst = Select-Default $script:Installs
  if ($inst) {
    if (Get-DangerReason $inst.Root) { return @{ Status = 'refused'; Reason = 'danger'; Root = $inst.Root } }
    if (Test-Reparse $inst.Root) { return @{ Status = 'refused'; Reason = 'reparse'; Root = $inst.Root } }
    return @{ Status = 'install'; Install = $inst; Root = $inst.Root }
  }
  $orphans = @(Find-OrphanRoots)
  if ($orphans.Count -gt 0) {
    $tp = New-TracePlan $orphans
    if ((Get-TraceCount $tp) -gt 0) { return @{ Status = 'traces'; Plan = $tp; Root = $tp.Root } }
  }
  $bad = @($script:Installs | Where-Object { $_.PSObject.Properties['Bad'] })
  if ($bad.Count -gt 0) { return @{ Status = 'refused'; Reason = 'noReceipt'; Root = $bad[0].Root } }
  return @{ Status = 'notfound'; Root = $null }
}

function Get-ExitCode([string]$status) {
  switch ($status) {
    'done' { return 0 } 'traces-done' { return 0 } 'dry-run' { return 0 }
    'partial' { return 1 }
    'refused' { return 2 } 'notfound' { return 2 } 'confirm-required' { return 2 }
    'cancelled' { return 3 }
    default { return 4 }
  }
}

function Write-ResultJson($res) {
  if (-not $Json) { return }
  try { [IO.File]::WriteAllText($Json, ($res | ConvertTo-Json -Depth 6), $script:Utf8) }
  catch { Write-Log ('json write failed: ' + $_.Exception.Message) }
}

function New-StatusResult([string]$status, [string]$root, [string]$reason) {
  return [ordered]@{ ok = $false; status = $status; kind = $null; root = $root; mode = $Mode; reason = $reason;
    dryRun = [bool]$DryRun; log = $script:LogPath; error = $null }
}

function Invoke-Headless {
  $t = Resolve-Target
  $res = $null
  switch ($t.Status) {
    'install' {
      if ($Mode -eq 'all' -and -not $Yes -and -not $DryRun) {
        $res = New-StatusResult 'confirm-required' $t.Root 'mode all needs -Yes'
      } else {
        $plan = New-Plan $t.Install $null
        if ($DryRun) { $res = @(Get-DryRunResult $plan $Mode)[-1] } else { $res = @(Invoke-Plan $plan $Mode)[-1] }
      }
    }
    'traces' {
      if ($DryRun) { $res = @(Get-DryRunResult $t.Plan $Mode)[-1] } else { $res = @(Invoke-Plan $t.Plan $Mode)[-1] }
    }
    default { $res = New-StatusResult $t.Status $t.Root $t.Reason }
  }
  Write-ResultJson $res
  Write-Log ('exit status ' + $res.status)
  return (Get-ExitCode $res.status)
}

# -Scan: what the uninstaller sees on this PC, as JSON on stdout. Changes nothing.
function Invoke-Scan {
  $t = Resolve-Target
  $out = [ordered]@{
    status   = $t.Status
    root     = $t.Root
    reason   = $t.Reason
    installs = @($script:Installs | ForEach-Object {
        if ($_.PSObject.Properties['Bad']) { [ordered]@{ root = $_.Root; bad = $true } }
        else { [ordered]@{ root = $_.Root; version = $_.Version; schema = $_.Schema } } })
  }
  $plan = $null
  if ($t.Status -eq 'install') { $plan = New-Plan $t.Install $null } elseif ($t.Status -eq 'traces') { $plan = $t.Plan }
  if ($plan) {
    $out.plan = [ordered]@{
      kind    = $plan.Kind
      roots   = @($plan.Roots)
      user    = @($plan.UserItems | ForEach-Object { $_.Name })
      system  = @($plan.SystemItems | ForEach-Object { $_.Name })
      archive = $plan.Archive
      env     = @($plan.Env | ForEach-Object { '{0}:{1}' -f $_.Name, $_.Action })
      path    = $(if ($plan.PathPlan) { @($plan.PathPlan.Removed) } else { @() })
      run     = @($plan.Run | ForEach-Object { $_.Name })
      lnks    = @($plan.Lnks)
      workDir = $plan.WorkDir
    }
  }
  $txt = $out | ConvertTo-Json -Depth 6
  if ($Json) { [IO.File]::WriteAllText($Json, $txt, $script:Utf8) } else { [Console]::Out.WriteLine($txt) }
  return 0
}

# ---------------------------------------------------------------- window (WinForms)
# One fixed window whose middle part is rebuilt for each screen: intro -> (confirm) -> progress
# -> done | partial, or notfound / traces / refused / error. The process is DPI aware (sharp
# text at 150%) with AutoScaleMode off, so every pixel size goes through Px().

$script:Ui = @{ Scale = 1.0; ExitCode = 3; Busy = $false; Archive = $null; Mode = 'keep' }

function Initialize-Forms {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  try {
    if (-not ('IrisUninstall.Dpi' -as [type])) {
      Add-Type -Namespace IrisUninstall -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
    }
    [void][IrisUninstall.Dpi]::SetProcessDPIAware()
  } catch { Write-Log ('dpi: ' + $_.Exception.Message) }
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  try { $script:Ui.Scale = $g.DpiX / 96.0 } finally { $g.Dispose() }
  $script:Pump = { [System.Windows.Forms.Application]::DoEvents() }
}

function Px([double]$v) { return [int][Math]::Round($v * $script:Ui.Scale) }
function Hex([string]$html) { return [System.Drawing.ColorTranslator]::FromHtml($html) }
function New-Pad([int]$l, [int]$t, [int]$r, [int]$b) { return (New-Object System.Windows.Forms.Padding((Px $l), (Px $t), (Px $r), (Px $b))) }

$script:Navy = '#1f3a5f'
$script:Red = '#b3261e'
$script:Amber = '#8a5a00'
$script:Gray = '#5f6b7a'

function New-UiForm {
  $u = $script:Ui
  $f = New-Object System.Windows.Forms.Form
  $f.Text = (T 'title')
  $f.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
  $f.Font = New-Object System.Drawing.Font('Malgun Gothic', 10)
  $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $f.MaximizeBox = $false
  $f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  # a small screen at 175% gets a shorter window; the middle part scrolls
  $h = (Px 560)
  try { $h = [Math]::Min($h, [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height - (Px 60)) } catch { }
  $f.ClientSize = New-Object System.Drawing.Size((Px 640), [Math]::Max($h, (Px 360)))
  $f.BackColor = [System.Drawing.Color]::White

  # the scrolling middle part (added first: docking is laid out in reverse order)
  $content = New-Object System.Windows.Forms.Panel
  $content.Dock = [System.Windows.Forms.DockStyle]::Fill
  $content.AutoScroll = $true
  $content.AutoScrollMargin = New-Object System.Drawing.Size(0, (Px 16))
  $flow = New-Object System.Windows.Forms.FlowLayoutPanel
  $flow.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
  $flow.WrapContents = $false
  $flow.AutoSize = $true
  $flow.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
  $flow.Location = New-Object System.Drawing.Point((Px 24), (Px 4))
  $flow.Margin = New-Object System.Windows.Forms.Padding(0)
  $content.Controls.Add($flow)

  $head = New-Object System.Windows.Forms.Label
  $head.Dock = [System.Windows.Forms.DockStyle]::Top
  $head.AutoSize = $false
  $head.Height = (Px 64)
  $head.Padding = New-Pad 22 8 16 0
  $head.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $head.Font = New-Object System.Drawing.Font('Malgun Gothic', 15, [System.Drawing.FontStyle]::Bold)
  $head.UseMnemonic = $false

  $bar = New-Object System.Windows.Forms.Panel
  $bar.Dock = [System.Windows.Forms.DockStyle]::Bottom
  $bar.Height = (Px 60)
  $bar.BackColor = Hex '#f3f5f8'
  $btns = New-Object System.Windows.Forms.FlowLayoutPanel
  $btns.Dock = [System.Windows.Forms.DockStyle]::Fill
  $btns.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
  $btns.WrapContents = $false
  $btns.Padding = New-Pad 12 13 16 8
  $bar.Controls.Add($btns)

  $f.Controls.Add($content)
  $f.Controls.Add($head)
  $f.Controls.Add($bar)
  # no closing while files are being deleted
  $f.Add_FormClosing({ param($s, $e) if ($script:Ui.Busy) { $e.Cancel = $true } })

  $u.Form = $f
  $u.Content = $content
  $u.Flow = $flow
  $u.Head = $head
  $u.Buttons = $btns
  $u.W = (Px 640) - (Px 48) - [System.Windows.Forms.SystemInformation]::VerticalScrollBarWidth - (Px 4)
}

function Clear-Screen([string]$heading, [string]$color = $script:Navy) {
  $u = $script:Ui
  $u.Flow.SuspendLayout()
  $u.Flow.Controls.Clear()
  $u.Buttons.Controls.Clear()
  $u.Form.AcceptButton = $null
  $u.Form.CancelButton = $null
  $u.Focus = $null
  $u.Head.Text = $heading
  $u.Head.ForeColor = Hex $color
  $u.Content.AutoScrollPosition = New-Object System.Drawing.Point(0, 0)
}

function Complete-Screen {
  $u = $script:Ui
  $u.Flow.ResumeLayout($true)
  # ActiveControl also works before the window is shown (Focus() does not)
  if ($u.Focus) { try { $u.Form.ActiveControl = $u.Focus } catch { } }
  $u.Focus = $null
  Invoke-Pump
}

# A wrapping label; the new label is left in $script:Ui.Last (nothing is returned, so screen
# builders never leak objects into the pipeline).
function New-TextLabel([string]$text, [int]$maxW, [string]$color, [switch]$Bold) {
  $l = New-Object System.Windows.Forms.Label
  $l.AutoSize = $true
  $l.UseMnemonic = $false
  $l.MaximumSize = New-Object System.Drawing.Size($maxW, 0)
  $l.Text = $text
  if ($color) { $l.ForeColor = Hex $color }
  if ($Bold) { $l.Font = New-Object System.Drawing.Font($script:Ui.Form.Font, [System.Drawing.FontStyle]::Bold) }
  return $l
}

# Lines that start with a bullet (U+2022) get a hanging indent, so a wrapped line lines up
# with the text above it instead of with the bullet.
function Add-Text([string]$text, [string]$color, [switch]$Bold, [int]$Indent = 0, [int]$Gap = 10) {
  $u = $script:Ui
  $maxW = $u.W - (Px $Indent)
  $lines = @($text -split "`r?`n")
  $bullet = [string][char]0x2022
  if (@($lines | Where-Object { $_.StartsWith($bullet) }).Count -eq 0) {
    $l = New-TextLabel ($lines -join "`r`n") $maxW $color -Bold:$Bold
    $l.Margin = New-Pad $Indent 0 0 $Gap
    $u.Flow.Controls.Add($l)
    $u.Last = $l
    return
  }
  $tl = New-Object System.Windows.Forms.TableLayoutPanel
  $tl.ColumnCount = 2
  $tl.AutoSize = $true
  $tl.Margin = New-Pad $Indent 0 0 $Gap
  [void]$tl.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, [single](Px 16))))
  [void]$tl.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
  $row = 0
  foreach ($line in $lines) {
    if ($line.StartsWith($bullet)) {
      $b = New-TextLabel $bullet (Px 16) $color -Bold:$Bold
      $b.Margin = New-Pad 2 0 0 3
      $t = New-TextLabel ($line.Substring(1).TrimStart()) ($maxW - (Px 16)) $color -Bold:$Bold
      $t.Margin = New-Pad 0 0 0 3
      $tl.Controls.Add($b, 0, $row)
      $tl.Controls.Add($t, 1, $row)
    } else {
      $t = New-TextLabel $line $maxW $color -Bold:$Bold
      $t.Margin = New-Pad 0 0 0 3
      $tl.Controls.Add($t, 0, $row)
      $tl.SetColumnSpan($t, 2)
    }
    $row++
  }
  $tl.RowCount = $row
  $u.Flow.Controls.Add($tl)
  $u.Last = $tl
}

# A path in a read-only box: long paths scroll instead of being cut, and can be copied.
function Add-PathBox([string]$path, [int]$Gap = 12) {
  $u = $script:Ui
  $b = New-Object System.Windows.Forms.TextBox
  $b.ReadOnly = $true
  $b.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  $b.BackColor = Hex '#f7f9fc'
  $b.Width = $u.W
  $b.Text = $path
  $b.TabStop = $false
  $b.Margin = New-Pad 0 0 0 $Gap
  $u.Flow.Controls.Add($b)
}

function Add-Lines($lines, [int]$MaxLines = 7, [int]$Gap = 12) {
  $u = $script:Ui
  $arr = @($lines | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  $b = New-Object System.Windows.Forms.TextBox
  $b.Multiline = $true
  $b.ReadOnly = $true
  $b.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  $b.BackColor = Hex '#f7f9fc'
  $b.TabStop = $false
  $b.Width = $u.W
  $shown = [Math]::Min([Math]::Max($arr.Count, 1), $MaxLines)
  $b.Height = $shown * $u.Form.Font.Height + (Px 10)
  if ($arr.Count -gt $MaxLines) { $b.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical }
  $b.Text = ($arr -join "`r`n")
  $b.Margin = New-Pad 0 0 0 $Gap
  $u.Flow.Controls.Add($b)
}

# Buttons fill the bar from the right, so call this in right-to-left order. The action runs
# through Invoke-Safe: an error inside a click shows the error screen instead of a .NET dialog.
# -Primary = coloured + Enter key; -Accent = coloured only (a button that starts deleting must
# be clicked on purpose); -Danger = red; -Cancel = Esc key.
function Add-Button([string]$text, [scriptblock]$action, [switch]$Primary, [switch]$Accent, [switch]$Danger, [switch]$Cancel) {
  $u = $script:Ui
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.AutoSize = $true
  $b.MinimumSize = New-Object System.Drawing.Size((Px 104), (Px 34))
  $b.Padding = New-Pad 8 0 8 0
  $b.Margin = New-Pad 8 0 0 0
  $b.Tag = $action
  if ($Primary -or $Accent -or $Danger) {
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $b.FlatAppearance.BorderSize = 0
    $b.BackColor = Hex $(if ($Danger) { $script:Red } else { $script:Navy })
    $b.ForeColor = [System.Drawing.Color]::White
    $b.Font = New-Object System.Drawing.Font($u.Form.Font, [System.Drawing.FontStyle]::Bold)
  }
  # Enter never triggers a destructive button; Esc is the safe way out
  if ($Primary) { $u.Form.AcceptButton = $b; $u.Focus = $b }
  if ($Cancel) { $u.Form.CancelButton = $b; if ($Danger -or -not $u.Focus) { $u.Focus = $b } }
  $b.Add_Click({ Invoke-Safe $this.Tag })
  $u.Buttons.Controls.Add($b)
}

function Invoke-Safe([scriptblock]$action) {
  try { & $action }
  catch {
    $script:Ui.Busy = $false
    $msg = $_.Exception.Message
    Write-Log ('ui error: ' + $msg + ' ' + $_.InvocationInfo.PositionMessage)
    try { Show-Error $msg } catch { }
  }
}

function Open-Path([string]$exe, [string]$target) {
  if (-not $target) { return }
  try { Start-Process -FilePath $exe -ArgumentList ('"' + $target + '"') } catch { Write-Log ('open failed: ' + $_.Exception.Message) }
}

function Close-Ui { $script:Ui.Form.Close() }

# ---------------------------------------------------------------- progress screen

$script:StepIcons = @{ run = 0x25B6; ok = 0x2714; skip = 0x2013; fail = 0x2716; wait = 0x25CB }
$script:StepColors = @{ run = '#1f6fd1'; ok = '#2e7d32'; skip = '#9aa5b1'; fail = '#b3261e'; wait = '#9aa5b1' }

function Show-Progress {
  $u = $script:Ui
  Clear-Screen (T 'progressHeading')
  $tl = New-Object System.Windows.Forms.TableLayoutPanel
  $tl.ColumnCount = 3
  $tl.RowCount = 8
  $tl.AutoSize = $true
  $tl.Margin = New-Pad 0 4 0 0
  for ($c = 0; $c -lt 3; $c++) {
    [void]$tl.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
  }
  $sym = New-Object System.Drawing.Font('Segoe UI Symbol', 11)
  $u.StepIcon = @{}
  $u.StepName = @{}
  $u.StepDetail = @{}
  for ($n = 1; $n -le 8; $n++) {
    $ic = New-Object System.Windows.Forms.Label
    $ic.AutoSize = $true
    $ic.Font = $sym
    $ic.Margin = New-Pad 0 3 8 3
    $nm = New-Object System.Windows.Forms.Label
    $nm.AutoSize = $true
    $nm.UseMnemonic = $false
    $nm.Text = (T ('step' + $n))
    $nm.Margin = New-Pad 0 5 16 5
    $dt = New-Object System.Windows.Forms.Label
    $dt.AutoSize = $true
    $dt.UseMnemonic = $false
    $dt.ForeColor = Hex $script:Gray
    $dt.Margin = New-Pad 0 5 0 5
    $tl.Controls.Add($ic, 0, ($n - 1))
    $tl.Controls.Add($nm, 1, ($n - 1))
    $tl.Controls.Add($dt, 2, ($n - 1))
    $u.StepIcon[$n] = $ic
    $u.StepName[$n] = $nm
    $u.StepDetail[$n] = $dt
    Set-StepLook $n 'wait'
  }
  $u.Flow.Controls.Add($tl)
  $pb = New-Object System.Windows.Forms.ProgressBar
  $pb.Minimum = 0
  $pb.Maximum = 8
  $pb.Width = $u.W
  $pb.Height = (Px 16)
  $pb.Margin = New-Pad 0 16 0 0
  $u.Flow.Controls.Add($pb)
  $u.Bar = $pb
  Complete-Screen
}

function Set-StepLook([int]$n, [string]$state) {
  $u = $script:Ui
  $ic = $u.StepIcon[$n]
  $ic.Text = [string][char]$script:StepIcons[$state]
  $ic.ForeColor = Hex $script:StepColors[$state]
  $style = if ($state -eq 'run') { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $u.StepName[$n].Font = New-Object System.Drawing.Font($u.Form.Font, $style)
  $u.StepName[$n].ForeColor = Hex $(if ($state -eq 'skip' -or $state -eq 'wait') { $script:Gray } else { '#222222' })
}

function Update-Step([int]$n, [string]$state, [string]$detail) {
  $u = $script:Ui
  if (-not $u.StepIcon -or -not $u.StepIcon.ContainsKey($n)) { return }
  Set-StepLook $n $state
  if ($state -ne 'run') {
    $u.StepDetail[$n].Text = $detail
    $u.StepDetail[$n].ForeColor = Hex $(if ($state -eq 'fail') { $script:Red } else { $script:Gray })
    if ($u.Bar.Value -lt $n) { $u.Bar.Value = $n }
  }
}

function Start-Run($plan, [string]$mode) {
  $u = $script:Ui
  $u.Plan = $plan
  $u.Mode = $mode
  Show-Progress
  $script:OnStep = { param($n, $state, $detail) Update-Step $n $state $detail }
  $u.Busy = $true
  $res = $null
  $err = $null
  try { $res = @(Invoke-Plan $plan $mode)[-1] }
  catch {
    $err = $_.Exception.Message
    Write-Log ('run error: ' + $err + ' ' + $_.InvocationInfo.PositionMessage)
  } finally {
    $u.Busy = $false
    $script:OnStep = $null
  }
  if ($err) { Show-Error $err; return }
  # let the last check marks show for a moment
  for ($i = 0; $i -lt 6; $i++) { Invoke-Pump; Start-Sleep -Milliseconds 100 }
  $u.Result = $res
  if ($res.archive) { $u.Archive = $res.archive }
  if ($res.status -eq 'partial') { Show-Partial $res } else { Show-Done $res }
}

# ---------------------------------------------------------------- screens
# Event handlers only use $script:Ui (a handler does not see the locals of the function that
# attached it), and each screen ends with Complete-Screen.

function Get-VersionText($plan) {
  $v = if ($plan.Version) { $plan.Version } else { '?' }
  return (T 'introVersion' $v)
}

function Get-KeepDesc($plan) {
  if (@($plan.UserItems).Count -gt 0) { return (T 'optKeepDesc' $plan.Archive) }
  return (T 'optKeepNone')
}

function Show-Intro {
  $u = $script:Ui
  $plan = $u.Plan
  $u.ExitCode = 3
  Clear-Screen (T 'introHeading')
  Add-Text (T 'introFound') -Bold -Gap 4
  $good = @($script:Installs | Where-Object { -not $_.PSObject.Properties['Bad'] })
  if ($good.Count -gt 1 -and -not $u.Fixed) {
    $cb = New-Object System.Windows.Forms.ComboBox
    $cb.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    $cb.Width = $u.W
    $cb.Margin = New-Pad 0 0 0 6
    $sel = 0
    for ($i = 0; $i -lt $good.Count; $i++) {
      $label = $good[$i].Root
      if ($good[$i].Version) { $label += '    (' + $good[$i].Version + ')' }
      [void]$cb.Items.Add($label)
      if (Test-SamePath $good[$i].Root $plan.Root) { $sel = $i }
    }
    $cb.SelectedIndex = $sel
    $u.Choices = $good
    # attached after SelectedIndex, so building the screen does not re-plan
    $cb.Add_SelectedIndexChanged({ $script:Ui.Pick = $this.SelectedIndex; Invoke-Safe { Select-Install } })
    $u.Flow.Controls.Add($cb)
  } else {
    Add-PathBox $plan.Root -Gap 6
  }
  Add-Text (Get-VersionText $plan) $script:Gray -Gap 16
  $u.VerLabel = $u.Last
  Add-Text (T 'introWhat') -Gap 18

  $bold = New-Object System.Drawing.Font($u.Form.Font, [System.Drawing.FontStyle]::Bold)
  $rk = New-Object System.Windows.Forms.RadioButton
  $rk.Text = (T 'optKeep')
  $rk.AutoSize = $true
  $rk.Font = $bold
  $rk.Margin = New-Pad 0 0 0 2
  $rk.Checked = ($u.Mode -ne 'all')
  $u.Flow.Controls.Add($rk)
  Add-Text (Get-KeepDesc $plan) $script:Gray -Indent 20 -Gap 12
  $u.KeepDesc = $u.Last
  $ra = New-Object System.Windows.Forms.RadioButton
  $ra.Text = (T 'optAll')
  $ra.AutoSize = $true
  $ra.Font = $bold
  $ra.Margin = New-Pad 0 0 0 2
  $ra.Checked = ($u.Mode -eq 'all')
  $u.Flow.Controls.Add($ra)
  Add-Text (T 'optAllDesc') $script:Gray -Indent 20 -Gap 4
  $u.RbKeep = $rk
  $u.RbAll = $ra

  Add-Button (T 'btnCancel') { $script:Ui.ExitCode = 3; Close-Ui } -Cancel
  Add-Button (T 'btnStart') { Start-FromIntro } -Accent
  Complete-Screen
}

function Select-Install {
  $u = $script:Ui
  $inst = $u.Choices[$u.Pick]
  $u.Archive = $null
  $u.Plan = New-Plan $inst $null
  $u.VerLabel.Text = (Get-VersionText $u.Plan)
  $u.KeepDesc.Text = ((Get-KeepDesc $u.Plan) -replace "`r?`n", "`r`n")
}

function Start-FromIntro {
  $u = $script:Ui
  $u.Mode = if ($u.RbAll.Checked) { 'all' } else { 'keep' }
  # plan again right before running: the folder may have changed while the window was open
  $u.Plan = New-Plan $u.Plan.Install $null
  if ($u.Mode -eq 'all') { Show-Confirm } else { Start-Run $u.Plan 'keep' }
}

function Show-Confirm {
  $u = $script:Ui
  Clear-Screen (T 'confirmHeading') $script:Red
  Add-Text (T 'confirmBody') -Gap 12
  $names = @($u.Plan.UserItems | ForEach-Object { if ($_.IsDir) { $_.Name + '\' } else { $_.Name } })
  if ($names.Count -gt 0) { Add-Lines $names 12 } else { Add-Text (T 'confirmNone') $script:Gray }
  Add-Button (T 'confirmNo') { Show-Intro } -Cancel
  Add-Button (T 'confirmYes') { Start-Run $script:Ui.Plan 'all' } -Danger
  Complete-Screen
}

function Add-ArchiveInfo {
  $u = $script:Ui
  if (-not $u.Archive) { return }
  Add-Text ((T 'doneArchive' '').TrimEnd()) -Gap 4
  Add-PathBox $u.Archive
}

function Show-Done($res) {
  $u = $script:Ui
  $u.ExitCode = Get-ExitCode $res.status
  Clear-Screen (T 'doneHeading') '#2e7d32'
  if ($res.kind -eq 'traces') { Add-Text (T 'doneTraces') -Gap 14 }
  elseif ($u.Archive) { Add-ArchiveInfo }
  elseif ($res.mode -eq 'keep') { Add-Text (T 'doneNoArchive') -Gap 14 }
  if ($res.leftEmpty) { Add-Text (T 'doneLeftEmpty' $res.root) $script:Amber -Gap 14 }
  Add-Text (T 'doneNotes') -Gap 14
  Add-Text (T 'logPath' $res.log) $script:Gray
  Add-Button (T 'btnClose') { Close-Ui } -Primary -Cancel
  if ($u.Archive) { Add-Button (T 'btnOpenArchive') { Open-Path 'explorer.exe' $script:Ui.Archive } }
  Complete-Screen
}

function Show-Partial($res) {
  $u = $script:Ui
  $u.ExitCode = Get-ExitCode $res.status
  Clear-Screen (T 'partialHeading') $script:Amber
  Add-Text (T 'partialBody') -Gap 14
  if (@($res.holders).Count -gt 0) { Add-Text (T 'partialHolders' (@($res.holders) -join ', ')) -Bold -Gap 14 }
  if (@($res.moveFailed).Count -gt 0) {
    Add-Text (T 'partialMoveFailed') -Gap 4
    Add-Lines $res.moveFailed 4
  }
  if (@($res.remaining).Count -gt 0) {
    Add-Text (T 'partialRemaining') -Gap 4
    Add-Lines $res.remaining 6
  }
  Add-ArchiveInfo
  Add-Text (T 'logPath' $res.log) $script:Gray
  Add-Button (T 'btnClose') { Close-Ui } -Cancel
  Add-Button (T 'btnOpenLog') { Open-Path 'notepad.exe' $script:LogPath }
  if ($u.Archive) { Add-Button (T 'btnOpenArchive') { Open-Path 'explorer.exe' $script:Ui.Archive } }
  Add-Button (T 'btnRetry') { $v = $script:Ui; Start-Run (New-Plan $v.Plan.Install $v.Archive) $v.Mode } -Primary
  Complete-Screen
}

function Get-TraceLines($plan) {
  $out = @()
  foreach ($e in @($plan.Env)) { $out += (T 'traceEnv' $e.Name) }
  if ($plan.PathPlan) { foreach ($s in @($plan.PathPlan.Removed)) { $out += (T 'tracePath' $s) } }
  foreach ($r in @($plan.Run)) { $out += (T 'traceRun' $r.Name) }
  foreach ($l in @($plan.Lnks)) { $out += (T 'traceLnk' $l) }
  if ($plan.WorkDir) { $out += (T 'traceWork' $plan.WorkDir) }
  return $out
}

function Show-Traces {
  $u = $script:Ui
  $u.ExitCode = 3
  Clear-Screen (T 'tracesHeading')
  Add-Text (T 'tracesBody' (@($u.Plan.Roots) -join ', ')) -Gap 12
  Add-Lines @(Get-TraceLines $u.Plan) 10
  Add-Button (T 'btnCancel') { $script:Ui.ExitCode = 3; Close-Ui } -Cancel
  Add-Button (T 'btnTraces') { Start-Run $script:Ui.Plan 'keep' } -Accent
  Complete-Screen
}

function Show-NotFound {
  $u = $script:Ui
  $u.ExitCode = 2
  Clear-Screen (T 'notFoundHeading')
  Add-Text (T 'notFoundBody')
  Add-Button (T 'btnClose') { Close-Ui } -Primary -Cancel
  Complete-Screen
}

function Show-Refused([string]$reason, [string]$root) {
  $u = $script:Ui
  $u.ExitCode = 2
  Clear-Screen (T 'refusedHeading') $script:Red
  $key = switch ($reason) { 'danger' { 'refusedDanger' } 'reparse' { 'refusedReparse' } default { 'refusedNoReceipt' } }
  Add-Text (T $key $root)
  Add-Button (T 'btnClose') { Close-Ui } -Primary -Cancel
  Complete-Screen
}

function Show-Error([string]$msg) {
  $u = $script:Ui
  $u.ExitCode = 4
  Clear-Screen (T 'errorHeading') $script:Red
  Add-Text (T 'errorBody' $msg) -Gap 14
  Add-Text (T 'logPath' $script:LogPath) $script:Gray
  Add-Button (T 'btnClose') { Close-Ui } -Primary -Cancel
  Add-Button (T 'btnOpenLog') { Open-Path 'notepad.exe' $script:LogPath }
  Complete-Screen
}

function Invoke-Ui {
  Initialize-Forms
  New-UiForm
  $u = $script:Ui
  $t = Resolve-Target
  switch ($t.Status) {
    'install' { $u.Plan = New-Plan $t.Install $null; $u.Fixed = [bool]$Root; Show-Intro }
    'traces' { $u.Plan = $t.Plan; Show-Traces }
    'refused' { Show-Refused $t.Reason $t.Root }
    default { Show-NotFound }
  }
  [void]$u.Form.ShowDialog()
  $u.Form.Dispose()
  return $u.ExitCode
}

# -Screenshot <dir>: every screen drawn into a PNG from sample data (no registry, no files
# outside <dir>), so the layout can be checked at any DPI without a real install.
function Save-Shot([string]$dir, [string]$name) {
  $f = $script:Ui.Form
  for ($i = 0; $i -lt 3; $i++) { Invoke-Pump }
  $bmp = New-Object System.Drawing.Bitmap($f.Width, $f.Height)
  try {
    $f.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $f.Width, $f.Height)))
    $p = Join-Path $dir ($name + '.png')
    $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
    [Console]::Out.WriteLine($p)
  } finally { $bmp.Dispose() }
}

function Invoke-Screenshots([string]$dir) {
  Initialize-Forms
  New-UiForm
  $u = $script:Ui
  $dir = Normalize-Dir $dir
  [void][IO.Directory]::CreateDirectory($dir)
  $f = $u.Form
  $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $f.Location = New-Object System.Drawing.Point(-20000, -20000)
  $f.ShowInTaskbar = $false
  $f.Show()

  $arch = 'C:\IRIS-' + (T 'archiveWord') + '-2026-09-29'
  $inst = [pscustomobject]@{ Root = 'C:\IRIS'; Version = '2.0.39'; SoulRoot = 'C:\IRIS'; Previous = @{} }
  $inst2 = [pscustomobject]@{ Root = 'D:\IRIS'; Version = '2.0.30'; SoulRoot = 'D:\IRIS'; Previous = @{} }
  $r = 'C:\IRIS'
  $items = @(
    [pscustomobject]@{ Name = 'R01-Teacher(Teacher)'; Path = "$r\R01-Teacher(Teacher)"; IsDir = $true; IsLink = $false },
    [pscustomobject]@{ Name = 'R02-Research(Research)'; Path = "$r\R02-Research(Research)"; IsDir = $true; IsLink = $false },
    [pscustomobject]@{ Name = 'notes.txt'; Path = "$r\notes.txt"; IsDir = $false; IsLink = $false })
  $plan = [pscustomobject]@{ Kind = 'install'; Root = 'C:\IRIS'; Roots = @('C:\IRIS'); Version = '2.0.39'; Install = $inst
    UserItems = $items; SystemItems = @(); Archive = $arch; Env = @(); PathPlan = $null; Run = @(); Lnks = @()
    WorkDir = $null; OthersRemain = $false }
  $tplan = [pscustomobject]@{ Kind = 'traces'; Root = 'C:\IRIS'; Roots = @('C:\IRIS'); Version = $null; Install = $null
    UserItems = @(); SystemItems = @(); Archive = $null
    Env = @([pscustomobject]@{ Name = 'CLAUDE_CONFIG_DIR'; Action = 'delete' }, [pscustomobject]@{ Name = 'CODEX_HOME'; Action = 'delete' })
    PathPlan = [pscustomobject]@{ Removed = @("$r\_agent\shared\shims") }
    Run = @([pscustomobject]@{ Name = 'IRIS relay' }); Lnks = @('%USERPROFILE%\Desktop\IRIS.lnk')
    WorkDir = '%LOCALAPPDATA%\IRIS-Installer'; OthersRemain = $false }
  $done = New-Result $plan 'keep'
  $done.status = 'done'
  $done.log = $script:LogPath
  $part = New-Result $plan 'keep'
  $part.status = 'partial'
  $part.log = $script:LogPath
  $part.holders = @('Windows Explorer (pid 1234)')
  $part.moveFailed = @('R02-Research(Research)')
  $part.remaining = @('R02-Research(Research)', '_agent\claude', '_agent\shared')

  $script:Installs = @($inst)
  $u.Plan = $plan
  $u.Fixed = $false
  Show-Intro; Save-Shot $dir '01-intro'
  $script:Installs = @($inst, $inst2)
  Show-Intro; Save-Shot $dir '02-intro-choose'
  $u.RbAll.Checked = $true
  Show-Confirm; Save-Shot $dir '03-confirm'
  Show-Progress
  Update-Step 1 'ok' (T 'stepCount' 3)
  Update-Step 2 'ok' (T 'stepCount' 1)
  Update-Step 3 'ok' (T 'stepCount' 4)
  Update-Step 4 'ok' (T 'stepCount' 2)
  Update-Step 5 'ok' (T 'stepCount' 1)
  Update-Step 6 'ok' (T 'stepCount' 3)
  Update-Step 7 'run' ''
  Save-Shot $dir '04-progress'
  $u.Archive = $arch
  Show-Done $done; Save-Shot $dir '05-done'
  Show-Partial $part; Save-Shot $dir '06-partial'
  $u.Archive = $null
  Show-NotFound; Save-Shot $dir '07-notfound'
  $u.Plan = $tplan
  Show-Traces; Save-Shot $dir '08-traces'
  Show-Refused 'danger' '%USERPROFILE%'; Save-Shot $dir '09-refused'
  Show-Error 'Access to the path is denied.'; Save-Shot $dir '10-error'
  $f.Close()
  $f.Dispose()
  return 0
}

# ---------------------------------------------------------------- main

$script:ExitCode = 4
$script:Mutex = $null
try {
  # never keep the folder being deleted open as the current directory
  $tmp = [IO.Path]::GetTempPath()
  [Environment]::CurrentDirectory = $tmp
  Set-Location -LiteralPath $tmp
  Load-Strings
  Write-Log ('IRIS uninstaller  ps ' + $PSVersionTable.PSVersion + '  from ' + $script:Here)
  if ($Screenshot) {
    $script:ExitCode = @(Invoke-Screenshots $Screenshot)[-1]
  } elseif ($Scan) {
    $script:ExitCode = @(Invoke-Scan)[-1]
  } else {
    # one uninstaller at a time (a second double-click while the first is running)
    $script:Mutex = New-Object Threading.Mutex($false, 'Local\IRIS-uninstaller')
    $owned = $false
    try { $owned = $script:Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) {
      Write-Log 'another uninstaller is running'
      if ($NoUi) {
        $r = New-StatusResult 'error' $Root 'already-running'
        $r.error = 'another uninstaller is running'
        Write-ResultJson $r
      } else {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show((T 'alreadyRunning'), (T 'title'), 'OK', 'Information')
      }
      $script:ExitCode = 4
    } elseif ($NoUi) {
      $script:ExitCode = @(Invoke-Headless)[-1]
    } else {
      $script:ExitCode = @(Invoke-Ui)[-1]
    }
  }
} catch {
  $msg = $_.Exception.Message
  Write-Log ('fatal: ' + $msg + ' ' + $_.InvocationInfo.PositionMessage)
  if ($NoUi -or $Scan) {
    $r = New-StatusResult 'error' $Root $null
    $r.error = $msg
    Write-ResultJson $r
  } elseif (-not $Screenshot) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      $title = 'IRIS'
      if ($script:S) { $title = (T 'title') }
      [void][System.Windows.Forms.MessageBox]::Show($msg + "`r`n`r`n" + $script:LogPath, $title, 'OK', 'Error')
    } catch { }
  }
  $script:ExitCode = 4
}
Write-Log ('exit ' + $script:ExitCode)
exit ([int]$script:ExitCode)
