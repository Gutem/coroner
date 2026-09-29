# Provisionamento — Autopsy + MCP remoto

Runbook do que foi feito para controlar a máquina Windows (Autopsy) a partir de outra
máquina. Testado em Windows 10 22H2 (PT-BR) + macOS.

## 1. Windows: OpenSSH Server

O componente nativo às vezes fica sem registro de serviço; o pacote do choco é mais confiável:

```powershell
choco install openssh -y --params "/SSHServerFeature"    # PS como Administrador
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

### Pegadinha do Windows PT-BR (importante)

O `sshd_config` do Win32-OpenSSH traz:

```
AuthorizedKeysFile	.ssh/authorized_keys
Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
```

Em Windows em português o grupo chama-se **Administradores**, então o `Match` **não casa** e
o sshd ignora o `administrators_authorized_keys` — indo sempre atrás de
`C:\Users\<user>\.ssh\authorized_keys`. Coloque a chave **nos dois** arquivos.

E use **SIDs** no `icacls` (nomes como "Administrators"/"SYSTEM" não resolvem em PT-BR):

```powershell
$key = 'ssh-ed25519 AAAA... usuario@origem'
$adminFile = 'C:\ProgramData\ssh\administrators_authorized_keys'
$userFile  = "$env:USERPROFILE\.ssh\authorized_keys"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
Add-Content $adminFile $key -Encoding ascii
Add-Content $userFile  $key -Encoding ascii

icacls $adminFile /inheritance:r
icacls $adminFile /grant "*S-1-5-32-544:F" "*S-1-5-18:F"   # Administradores, SYSTEM
icacls $adminFile /setowner "*S-1-5-32-544"
icacls $userFile /inheritance:r
icacls $userFile /grant "$env:USERNAME:F" "*S-1-5-18:F"
```

Conta **Microsoft** (e-mail) não aceita `net user <conta> <senha>` — erro
"o sistema não é autoritativo para a conta". Use chave pública, ou crie uma conta local
dedicada para automação.

## 2. Windows: server MCP como serviço

```powershell
# PS admin, no clone do repo
.\deploy\windows\install-coroner.ps1 -RepoPath C:\code\coroner -CasesDir C:\Users\<user>\Documents
```

Registra a tarefa `coroner-http` como **SYSTEM** (sobrevive a logoff e sobe no boot).
O launcher usa o **caminho absoluto do bun** — o PATH do SYSTEM não inclui `~/.bun/bin`.

## 3. Máquina do agente: túnel

```bash
./deploy/macos/install-tunnel.sh win-autopsy 3123      # instala autossh + LaunchAgent
```

O server escuta só em `127.0.0.1` no Windows; o túnel expõe em `127.0.0.1:3123` na máquina
do agente. Nenhuma porta extra aberta no firewall.

## 4. Agente

```json
{ "mcp": { "autopsy": { "type": "remote", "url": "http://127.0.0.1:3123/mcp", "enabled": true, "timeout": 60000 } } }
```

## Notas de campo

- `AUTOPSY_CASES_DIR` deve apontar para o diretório que **contém** as pastas de case
  (cada uma com `autopsy.db`); a varredura desce até 4 níveis.
- Case em ingest segura o DB em lock: as tools retornam hint e basta repetir.
- `hex`/`strings`/`extract` exigem `AUTOPSY_EXPORT_DIR` (arquivos exportados do Autopsy,
  casados por SHA-256) ou `AUTOPSY_FILES_ROOT` (mount read-only da imagem).
- **Trilha de auditoria**: ligue com `-AuditLogPath` (o script recusa caminho dentro do diretório
  de cases). Um **arquivo** (`.ndjson`) mantém trilha única; um **diretório** gera uma trilha por
  case (`audit-<case>-<hash8>.ndjson`). É **fail-closed**: sem conseguir gravar, as tools falham —
  é o comportamento desejado em uso pericial, mas atrapalha em teste; aponte para um caminho
  gravável.
- **Selo e carimbo** (uso pericial): `AUTOPSY_SEAL_KEY_FILE` (Ed25519/RSA/EC) e, para não repúdio,
  `AUTOPSY_SEAL_CERT_FILE` (certificado + cadeia, ex.: ICP-Brasil) com `AUTOPSY_TSA_URL`
  (RFC 3161). Verificação por terceiro: `bun scripts/audit-verify.mjs <trilha>`,
  `bun scripts/audit-seal.mjs --verify <selo.json>` e
  `bun scripts/tsa-verify.mjs --seal <selo.json> --ca <cacert.pem>`.
- **Ao mudar env vars**: pare e suba a tarefa (`Stop-ScheduledTask` / `Start-ScheduledTask
  coroner-http`) — o launcher lê o ambiente no start; o log fica em `mcp-http.log`, ao lado
  do repo.
