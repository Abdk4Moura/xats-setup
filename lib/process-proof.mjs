// Native read-only process/socket probes. Never infer ownership from a task name.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function splitCommandLine(text) {
  // Windows CRT rules: apostrophes are literal, backslashes only escape
  // double quotes when immediately preceding one.
  const args = []; let word = '', quote = false, started = false;
  const input = text.trim();
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\') {
      let n = 1;
      while (input[i + 1] === '\\') { n++; i++; }
      if (input[i + 1] === '"') {
        word += '\\'.repeat(Math.floor(n / 2));
        i++;
        if (n % 2) word += '"'; else quote = !quote;
      } else word += '\\'.repeat(n);
      started = true;
    } else if (c === '"') { quote = !quote; started = true;
    } else if (/\s/.test(c) && !quote) {
      if (started) { args.push(word); word = ''; started = false; }
    } else { word += c; started = true; }
  }
  if (quote) throw new Error('Unterminated command line quote');
  if (started) args.push(word);
  return args;
}

export function nativeProcessProof(pid, port, platform = process.platform, exec = execFileSync) {
  // A cold Windows CIM provider can take more than ten seconds to initialize.
  // Keep a finite cold-start allowance, without retries or weaker evidence.
  const probe = (cmd, args) => exec(cmd, args, { encoding: 'utf8', timeout: platform === 'win32' ? 20000 : 3000, windowsHide: true }).trim();
  if (platform === 'darwin') {
    const argv = splitCommandLine(probe('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']));
    const lines = probe('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fp']).split('\n');
    if (!lines.includes('p' + pid)) return null;
    // ps eww exposes the process environment on macOS. Only use delimited
    // absolute HOME values without spaces; ambiguous legacy scope fails closed.
    const envText = probe('/bin/ps', ['eww', '-p', String(pid), '-o', 'command=']);
    const values = (key) => [...envText.matchAll(new RegExp('(?:^| )' + key + '=(/[^ \\r\\n]+)(?= |$)', 'g'))].map((m) => m[1]);
    const homes = values('HOME'); const states = values('CROSS_AGENT_TEAMS_MCP_HOME');
    const env = homes.length === 1 ? { HOME: homes[0] } : {};
    if (states.length === 1) env.CROSS_AGENT_TEAMS_MCP_HOME = states[0];
    return { argv, env };
  }
  if (platform === 'win32') {
    // PID and port are validated integers by the caller, not shell input.
    // State 2 is LISTEN. Query the provider directly rather than loading the
    // slower NetTCPIP cmdlet module and enumerating unrelated sockets.
    const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; $s=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'LocalPort = ${port} AND OwningProcess = ${pid} AND State = 2'); if ($p -and $s.Count -gt 0) { @{command=$p.CommandLine;exe=$p.ExecutablePath} | ConvertTo-Json -Compress }`;
    const data = JSON.parse(probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
    if (!data.exe) return null;
    const argv = splitCommandLine(data.command);
    if (path.resolve(argv[0]).toLowerCase() !== path.resolve(data.exe).toLowerCase()) return null;
    return { argv };
  }
  return null;
}

export function sameFile(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}
