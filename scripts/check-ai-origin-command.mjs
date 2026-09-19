#!/usr/bin/env node
/**
 * Measures the command the settings screen hands the user to allow this site in
 * Ollama. Pure: nothing is executed, no network, no database — the generated
 * command would change the machine it runs on, so this bench only reads it.
 *
 * What it proves:
 *
 * 1. The origin is carried EXACTLY as the page reports it (production origin,
 *    and an origin with a port), on all three systems.
 *
 * 2. The command is a TRUST BOUNDARY. A booby-trapped origin — a quote, a
 *    space, a `;`, a `$(`, a newline, a non-http scheme — is REFUSED rather
 *    than escaped, so nothing of it can reach a shell.
 *
 * 3. Each command PERSISTS across a reboot, ADDS to any existing value instead
 *    of overwriting it, and restarts Ollama.
 *
 * 4. The macOS and Linux commands are syntactically valid for `bash -n` AND
 *    `zsh -n` (syntax only, NEVER executed).
 *
 * 5. The visitor's own system is read from the user agent.
 *
 * Negative control — proves the bench can see the defect it exists for:
 *   node --experimental-strip-types scripts/check-ai-origin-command.mjs --break=<case>
 *
 *   node --experimental-strip-types scripts/check-ai-origin-command.mjs
 */
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `lib/` imports its siblings without an extension (the bundler resolves them);
// node needs to be told. Hook first, then load the module under test.
register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs'
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) {
      const url = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(url)) return next(url.href, context)
    }
    return next(specifier, context)
  }
`))

const {
  buildOllamaOriginCommand, isSafeOrigin, detectLocalOs, LOCAL_OS_ORDER, OLLAMA_ORIGINS_VAR,
} = await import('../lib/aiClient.ts')

const BREAKAGES = {
  'accepts-any-origin': 'a booby-trapped origin is let through instead of refused',
  'origin-dropped': 'the command no longer carries the origin it was asked for',
  'overwrites-existing': 'the command replaces OLLAMA_ORIGINS instead of adding to it',
}
const BREAK = process.argv.find(a => a.startsWith('--break='))?.slice('--break='.length) ?? null
if (BREAK && !BREAKAGES[BREAK]) {
  console.log(`HARNESS: --break=${BREAK} is not one of ${Object.keys(BREAKAGES).join(', ')}`)
  process.exit(1)
}

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

/** The function under test, with the breakages applied. */
const build = (os, origin) => {
  if (BREAK === 'accepts-any-origin' && !isSafeOrigin(origin)) {
    // What a naive implementation would do: interpolate and hope.
    return `launchctl setenv ${OLLAMA_ORIGINS_VAR} "${origin}"`
  }
  const cmd = buildOllamaOriginCommand(os, origin)
  if (BREAK === 'origin-dropped') return cmd.replaceAll(origin, 'https://elsewhere.test')
  if (BREAK === 'overwrites-existing') return cmd.replace(/\$\{?CUR/g, '${EMPTY')
  return cmd
}

// ── 1. the origin is carried exactly ────────────────────────────────────────
const GOOD_ORIGINS = [
  'https://mail.yumi-lab.com',
  'https://srv1774179.hstgr.cloud',
  'http://localhost:3106',
  'http://127.0.0.1:3000',
]
for (const origin of GOOD_ORIGINS) {
  check(isSafeOrigin(origin), `accepted origin: ${origin}`)
  for (const os of LOCAL_OS_ORDER) {
    let cmd = ''
    try { cmd = build(os, origin) } catch { /* reported by the check below */ }
    check(cmd.includes(origin), `${os}: the command carries ${origin}`)
  }
}

// ── 2. a booby-trapped origin is refused, not escaped ───────────────────────
const TRAPS = [
  'https://evil.test"; rm -rf /; echo "',
  "https://evil.test'; rm -rf /",
  'https://evil.test; touch /tmp/pwned',
  'https://evil.test$(id)',
  'https://evil.test`id`',
  'https://evil.test\nlaunchctl setenv X Y',
  'https://evil.test with a space',
  'https://evil.test|id',
  'https://evil.test&id',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'ftp://evil.test',
  '',
  'mail.yumi-lab.com',
]
for (const origin of TRAPS) {
  let refused = false
  try { build('mac', origin) } catch { refused = true }
  check(refused, `refused, not a plain origin: ${JSON.stringify(origin)}`)
}

// ── 3. persistent, additive, and it restarts Ollama ─────────────────────────
const ORIGIN = 'https://mail.yumi-lab.com'
const MAC = build('mac', ORIGIN)
const LINUX = build('linux', ORIGIN)
const WINDOWS = build('windows', ORIGIN)

check(MAC.includes('LaunchAgents'), 'macOS: the setting survives a reboot (LaunchAgent)')
check(/open -a Ollama/.test(MAC) && /pkill|quit app/.test(MAC), 'macOS: Ollama is stopped then started again')
check(MAC.includes('launchctl getenv ' + OLLAMA_ORIGINS_VAR), 'macOS: the existing value is read first')
check(/\$\{CUR:\+\$CUR,\}/.test(MAC), 'macOS: the origin is ADDED to the existing value')
check(/\*",\$ORIGIN,"\*/.test(MAC), 'macOS: an origin already present is not added twice')

check(LINUX.includes('ollama.service.d'), 'Linux: the setting survives a reboot (systemd drop-in)')
check(LINUX.includes('daemon-reload') && LINUX.includes('restart ollama'), 'Linux: the service is reloaded and restarted')
check(LINUX.includes('systemctl show -p Environment'), 'Linux: the existing value is read first')
check(/\$\{CUR:\+\$CUR,\}/.test(LINUX), 'Linux: the origin is ADDED to the existing value')

check(WINDOWS.includes("'User'"), 'Windows: the setting survives a reboot (user variable)')
check(/Stop-Process/.test(WINDOWS) && /Start-Process/.test(WINDOWS), 'Windows: Ollama is stopped then started again')
check(WINDOWS.includes('GetEnvironmentVariable'), 'Windows: the existing value is read first')
check(WINDOWS.includes('-notcontains'), 'Windows: an origin already present is not added twice')

// ── 4. the shell commands parse, in bash AND zsh (syntax only) ──────────────
const dir = mkdtempSync(join(tmpdir(), 'synapmail-origin-'))
for (const [os, cmd] of [['mac', MAC], ['linux', LINUX]]) {
  const file = join(dir, `${os}.sh`)
  writeFileSync(file, cmd + '\n')
  for (const shell of ['bash', 'zsh']) {
    let ok = false
    let detail = ''
    try {
      execFileSync(shell, ['-n', file], { stdio: 'pipe' })
      ok = true
    } catch (e) {
      detail = String(e.stderr ?? e.message).trim().split('\n')[0]
    }
    check(ok, `${os}: parses under ${shell} -n${ok ? '' : ` — ${detail}`}`)
  }
}

// ── 5. the visitor's own system is read from the user agent ─────────────────
for (const [ua, expected] of [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'mac'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'windows'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'linux'],
  ['', 'linux'],
]) {
  check(detectLocalOs(ua) === expected, `user agent read as ${expected}: ${ua.slice(0, 40) || '(empty)'}`)
}

// ── verdict ─────────────────────────────────────────────────────────────────
if (BREAK) {
  console.log(`\nnegative control --break=${BREAK} (${BREAKAGES[BREAK]}): ${failures} failure(s)`)
  if (failures === 0) {
    console.log('FAIL: the bench saw nothing while the defect was in place')
    process.exit(1)
  }
  console.log('ok   the bench sees the defect')
  process.exit(0)
}
console.log(`\n${failures === 0 ? 'check-ai-origin-command: OK' : `check-ai-origin-command: ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
