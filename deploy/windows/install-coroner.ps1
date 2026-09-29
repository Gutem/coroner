#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registra o coroner como tarefa agendada (SYSTEM) escutando em 127.0.0.1.
.EXAMPLE
  .\install-coroner.ps1 -RepoPath C:\code\coroner -CasesDir C:\Users\<user>\Documents
#>
param(
  [Parameter(Mandatory = $true)][string]$RepoPath,
  [Parameter(Mandatory = $true)][string]$CasesDir,
  [string]$BunPath = "$env:USERPROFILE\.bun\bin\bun.exe",
  [int]$Port = 3123,
  [string]$TaskName = 'coroner-http',
  [string]$AuditLogPath = '',
  [string]$TsaUrl = '',
  [string]$SealKeyFile = '',
  [string]$SealCertFile = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $RepoPath)) { throw "Repo nao encontrado: $RepoPath" }
if (-not (Test-Path $BunPath)) { throw "bun nao encontrado: $BunPath (informe -BunPath)" }
if (-not (Test-Path $CasesDir)) { throw "CasesDir nao existe: $CasesDir" }

# Trilha de auditoria fora do diretorio de cases (cadeia de custodia)
if (-not $AuditLogPath) { $AuditLogPath = Join-Path (Split-Path $RepoPath -Parent) 'audit\autopsy-audit.ndjson' }
$auditDir = Split-Path $AuditLogPath -Parent
New-Item -ItemType Directory -Force $auditDir | Out-Null
$casesResolved = (Resolve-Path $CasesDir).Path
$auditResolved = [System.IO.Path]::GetFullPath($AuditLogPath)
if ($auditResolved.StartsWith($casesResolved, [StringComparison]::OrdinalIgnoreCase)) {
  throw "AuditLogPath nao pode ficar dentro do diretorio de cases (cadeia de custodia): $auditResolved"
}

# Launcher com caminho absoluto do bun: o PATH do SYSTEM nao inclui ~/.bun/bin
$launcher = @"
@echo off
set AUTOPSY_CASES_DIR=$CasesDir
set AUTOPSY_AUDIT_LOG=$AuditLogPath
set AUTOPSY_TSA_URL=$TsaUrl
set AUTOPSY_SEAL_KEY_FILE=$SealKeyFile
set AUTOPSY_SEAL_CERT_FILE=$SealCertFile
cd /d $RepoPath
"$BunPath" run src\index.js --transport http --host 127.0.0.1 --port $Port
"@
$launcherPath = Join-Path $RepoPath 'run-http.cmd'
Set-Content -Path $launcherPath -Value $launcher -Encoding ascii
Write-Host "launcher: $launcherPath"

# Cuidado com o parse do `cmd /c`: se o comando comeca entre aspas E ha redirecionamento
# fora delas, o cmd remove as aspas externas e monta um comando invalido (exit 1, sem log).
# A forma robusta (aceita espacos no caminho) e /s /c ""<cmd>" >> "<log>" 2>&1"
$taskArgs = "/s /c `"`"$launcherPath`" >> `"$RepoPath\mcp-http.log`" 2>&1`""
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

# Register nao reinicia um processo ja em execucao: sem o Stop, a instancia antiga
# continua servindo (com o launcher/config antigos) e a mudanca parece nao ter efeito.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep 2
Start-ScheduledTask -TaskName $TaskName
Start-Sleep 5

$state = (Get-ScheduledTask -TaskName $TaskName).State
$listening = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "tarefa=$state escutando_em_$Port=$listening"
if ($listening -eq 0) { Write-Host "verifique $RepoPath\mcp-http.log" }
