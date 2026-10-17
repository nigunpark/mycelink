/* Windows-user DPAPI escrow for an opted-in host claim. Never expose the raw
 * capability in argv, environment, logs or the controller journal. This does
 * not grant authority to the WSL worker and is not production dispatch. */
import { spawnSync } from 'node:child_process';

const PREFIX = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; ' +
  '$v=[Console]::In.ReadToEnd() | ConvertFrom-Json; ' +
  '$e=[Text.Encoding]::UTF8.GetBytes([string]$v.scope); ';
const PROTECT = PREFIX +
  '$p=[Text.Encoding]::UTF8.GetBytes([string]$v.value); ' +
  '[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(' +
  '$p,$e,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))';
const UNPROTECT = PREFIX +
  '$p=[Convert]::FromBase64String([string]$v.value); ' +
  '[Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect(' +
  '$p,$e,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))';

function dpapi(command: string, value: string, scope: string): string {
  if (process.platform !== 'win32' || !scope || scope.length > 512 || !value || value.length > 4096)
    throw new Error('WSL_CODEX_ESCROW_UNAVAILABLE');
  const response = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: JSON.stringify({ value, scope }), encoding: 'utf8', timeout: 15_000,
    windowsHide: true, maxBuffer: 8192,
  });
  if (response.error || response.status !== 0 || !response.stdout?.trim())
    throw new Error('WSL_CODEX_ESCROW_DENIED');
  return response.stdout.trim();
}

export function protectExperimentalWslCapability(capability: string, scope: string): string {
  const encrypted = dpapi(PROTECT, capability, scope);
  if (!/^[A-Za-z0-9+/=]{100,8192}$/.test(encrypted) || encrypted.includes(capability))
    throw new Error('WSL_CODEX_ESCROW_INVALID');
  return encrypted;
}

export function unprotectExperimentalWslCapability(encrypted: string, scope: string): string {
  if (!/^[A-Za-z0-9+/=]{100,8192}$/.test(encrypted))
    throw new Error('WSL_CODEX_ESCROW_INVALID');
  return dpapi(UNPROTECT, encrypted, scope);
}
