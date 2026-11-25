<#
.SYNOPSIS
  Adds a TikTok account to a StreamAnywhere server from a cookies file on this computer.

.DESCRIPTION
  For an account that cannot scan the QR code and a screen that cannot paste (the car): the
  cookies.txt export of a browser that is signed in to tiktok.com is sent from this computer to
  the server, which adds an account, signs it in with the cookies and makes it the active one.
  Every browser that opens the site then finds it under the profile icon.

  The cookies go from this computer straight to YOUR server (over HTTPS) and nowhere else; the
  script prints no cookie value. The site password is asked for here and is not stored.

  The main account on the server is not touched: the new account gets a folder of its own.

.PARAMETER Server
  The site, e.g. https://example.duckdns.org

.PARAMETER Cookies
  The cookies file (a cookies.txt export, a cookie extension's JSON, or a Cookie: header).

.PARAMETER Label
  What the account is called in the list. An account with this label that already exists is
  signed in again instead of adding a second one.

.PARAMETER Test
  Also switch on the test "For You without the browser" for this account (never possible for the
  main account). TikTok may restrict an account for it: only for an account you can lose.

.PARAMETER BackToMain
  Make the main account the active one again when done (default: the new account stays active).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\add-tiktok-account.ps1 -Server https://example.duckdns.org -Cookies "$env:USERPROFILE\.streamanywhere\spare-tiktok-cookies.txt" -Label Spare -Test
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Cookies,
  [string]$Label = 'Spare',
  [switch]$Test,
  [switch]$BackToMain
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$Server = $Server.TrimEnd('/')

# .NET HttpClient, not Invoke-WebRequest: Windows PowerShell 5.1's web cmdlet drops the socket on the
# sign-in POST, which the server holds open for a minute or two while it starts its browser ("the
# underlying connection was closed"). One client, so the site-password cookie is kept between calls.
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Web
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.CookieContainer = New-Object System.Net.CookieContainer
$handler.AllowAutoRedirect = $true
$client = New-Object System.Net.Http.HttpClient($handler)

# The request bodies are flat {string/bool} objects. Built by hand, escaping each string with .NET's
# own encoder: Windows PowerShell 5.1's ConvertTo-Json blows a cookies file up to tens of MB, and its
# JavaScriptSerializer trips over PowerShell values - both avoided here.
function ConvertTo-JsonBody($h) {
  $parts = foreach ($k in $h.Keys) {
    $v = $h[$k]
    if ($v -is [bool]) { $val = $(if ($v) { 'true' } else { 'false' }) }
    elseif ($v -is [int] -or $v -is [long] -or $v -is [double]) { $val = "$v" }
    else { $val = '"' + [System.Web.HttpUtility]::JavaScriptStringEncode([string]$v) + '"' }
    '"' + [System.Web.HttpUtility]::JavaScriptStringEncode([string]$k) + '":' + $val
  }
  '{' + ($parts -join ',') + '}'
}

# One API call; returns @{ status; body } and never throws on an HTTP error (the body carries the reason).
function Invoke-Api([string]$Method, [string]$Path, $Body, [int]$TimeoutSec = 60) {
  $msg = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::$Method), "$Server$Path"
  if ($null -ne $Body) {
    $msg.Content = New-Object System.Net.Http.StringContent((ConvertTo-JsonBody $Body), [Text.Encoding]::UTF8, 'application/json')
  }
  $cts = New-Object System.Threading.CancellationTokenSource ([TimeSpan]::FromSeconds($TimeoutSec))
  try {
    $resp = $client.SendAsync($msg, $cts.Token).GetAwaiter().GetResult()
    $status = [int]$resp.StatusCode
    $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  } finally {
    $cts.Dispose(); $msg.Dispose()
  }
  $json = $null
  try { if ($text) { $json = $text | ConvertFrom-Json } } catch { }
  return @{ status = $status; body = $json; text = $text }
}

function Show-Accounts($list) {
  foreach ($a in $list) {
    $who = if ($a.username) { '@' + $a.username } elseif ($a.saved) { 'saved sign-in' } else { 'not signed in' }
    $flags = @()
    if ($a.active) { $flags += 'ACTIVE' }
    if ($a.direct) { $flags += 'test: For You without the browser' }
    Write-Host ("    {0,-22} {1,-18} {2}" -f $who, $a.label, ($flags -join ', '))
  }
}

if (-not (Test-Path -LiteralPath $Cookies)) { Write-Host "The cookies file was not found: $Cookies" -ForegroundColor Red; exit 2 }
$cookieText = Get-Content -LiteralPath $Cookies -Raw -Encoding UTF8
if ($cookieText -notmatch 'sessionid') { Write-Host 'That file carries no TikTok sign-in (no "sessionid" in it).' -ForegroundColor Red; exit 2 }

Write-Host "Server: $Server"
$r = Invoke-Api GET '/api/session/accounts' $null
if ($r.status -eq 401) {
  # The site password: typed here, sent to the site's own sign-in (which sets the auth cookie on the
  # client above), kept nowhere by this script.
  $secure = Read-Host 'Site password' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  # The form body as a plain string: PowerShell cannot cast a hashtable to the Dictionary[string,string]
  # that FormUrlEncodedContent wants ("Cannot create object of type ... Dictionary`2").
  $form = New-Object System.Net.Http.StringContent(('password=' + [Uri]::EscapeDataString($plain) + '&next=%2Fapi%2Fhealth'), [Text.Encoding]::UTF8, 'application/x-www-form-urlencoded')
  $plain = $null
  $loginError = $null
  try { $client.PostAsync("$Server/login", $form).GetAwaiter().GetResult() | Out-Null } catch { $loginError = $_.Exception.GetBaseException().Message }
  $form.Dispose()
  if ($loginError) { Write-Host "The site's sign-in could not be reached: $loginError" -ForegroundColor Red; exit 3 }
  $r = Invoke-Api GET '/api/session/accounts' $null
  if ($r.status -eq 401) { Write-Host 'The site did not accept that password.' -ForegroundColor Red; exit 3 }
}
if ($r.status -ne 200 -or -not $r.body.accounts) { Write-Host "The server did not give its account list (HTTP $($r.status)). Is it running the build with accounts?" -ForegroundColor Red; exit 4 }

Write-Host 'Accounts on the server now:'
Show-Accounts $r.body.accounts
$before = $r.body.active

# The same label again: that account is signed in again; else a new one. Either way it becomes the active one.
$existing = $r.body.accounts | Where-Object { -not $_.main -and $_.label -eq $Label } | Select-Object -First 1
$created = $false
if ($existing) {
  Write-Host "An account called ""$Label"" exists: switching to it..."
  $id = $existing.id
  if (-not $existing.active) { $r = Invoke-Api POST '/api/session/accounts' @{ action = 'switch'; id = $id } 180 }
} else {
  Write-Host "Adding an account called ""$Label""..."
  $r = Invoke-Api POST '/api/session/accounts' @{ action = 'add'; label = $Label } 180
  if ($r.status -ne 200) { Write-Host "The server did not add the account: $($r.body.error)" -ForegroundColor Red; exit 5 }
  $id = $r.body.active
  $created = $true
}

# Give the server a moment to finish checking the account it just switched to.
for ($i = 0; $i -lt 60; $i++) {
  $s = Invoke-Api GET '/api/session' $null
  if (-not $s.body.probing -and $s.body.state -ne 'login_pending') { break }
  Start-Sleep -Seconds 3
}

if ($s.body.state -eq 'logged_in' -and $s.body.account -eq $id) {
  Write-Host "That account is signed in already as @$($s.body.username); the cookies were not needed."
} else {
  Write-Host 'Signing it in with the cookies (the server starts its TikTok browser: up to a minute or two on a small server)...'
  $login = Invoke-Api POST '/api/session/login' @{ platform = 'tiktok'; mode = 'cookies'; cookies = $cookieText } 420
  if ($login.body.state -ne 'logged_in') {
    $why = if ($login.body.error) { $login.body.error } else { "HTTP $($login.status)" }
    Write-Host "TikTok did not accept the cookies: $why" -ForegroundColor Red
    # Leave the server as it was: back to the account that was active, and no empty account behind.
    Invoke-Api POST '/api/session/accounts' @{ action = 'switch'; id = $before } 180 | Out-Null
    if ($created) { Invoke-Api POST '/api/session/accounts' @{ action = 'remove'; id = $id } 60 | Out-Null }
    Write-Host 'The server is back on the account it was using; nothing was added.'
    exit 6
  }
  Write-Host "Signed in as @$($login.body.username)." -ForegroundColor Green
}

if ($Test) {
  $t = Invoke-Api POST '/api/session/accounts' @{ action = 'direct'; id = $id; on = $true } 60
  if ($t.status -eq 200) { Write-Host 'Test switched on: this account''s For You is asked without the browser.' -ForegroundColor Green }
  else { Write-Host "The test could not be switched on: $($t.body.error)" -ForegroundColor Yellow }
}

if ($BackToMain) {
  Write-Host 'Switching back to the main account...'
  Invoke-Api POST '/api/session/accounts' @{ action = 'switch'; id = 'main' } 180 | Out-Null
}

$r = Invoke-Api GET '/api/session/accounts' $null
Write-Host 'Accounts on the server now:'
Show-Accounts $r.body.accounts
Write-Host ''
if ($BackToMain) { Write-Host 'Done. The main account is the active one; pick the new one from the profile icon on any device.' }
else { Write-Host 'Done. The new account is the active one on every device; pick "Main account" from the profile icon to go back.' }
