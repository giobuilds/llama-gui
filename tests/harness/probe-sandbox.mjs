#!/usr/bin/env node
/**
 * Stage 0 sandbox probe.
 *
 * Says whether the isolation this machine offers is enough for a coding run
 * to execute anything. Meant to be run on the packaging target — a clean
 * Fedora install of the RPM — not only on the development machine. If it
 * says no, Coding launches read-only and shows why; it never runs
 * unsandboxed and calls that a sandbox.
 *
 *   node tests/harness/probe-sandbox.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'

const checks = []
const check = (name, fn, required) => {
  try {
    const value = fn()
    checks.push({ name, ok: Boolean(value), value: String(value), required })
  } catch (err) {
    checks.push({ name, ok: false, value: err.message.split('\n')[0], required })
  }
}

const read = (path) => readFileSync(path, 'utf8').trim()

check('kernel', () => release(), false)

// bubblewrap is what the candidate sandbox library drives on Linux. Without
// it there is no filesystem or network containment for child processes.
check('bubblewrap', () => execFileSync('bwrap', ['--version']).toString().trim(), true)

// Unprivileged user namespaces are what let bwrap run without setuid.
check('unprivileged user namespaces', () => {
  const max = Number(read('/proc/sys/user/max_user_namespaces'))
  if (max <= 0) throw new Error('max_user_namespaces is 0')
  try {
    if (read('/proc/sys/kernel/unprivileged_userns_clone') === '0') throw new Error('unprivileged_userns_clone is 0')
  } catch (err) {
    if (!/ENOENT/.test(err.message)) throw err // absent on kernels that always allow it
  }
  return `max ${max}`
}, true)

// Landlock gives an unprivileged process a filesystem boundary of its own,
// which is the second layer when a process bypasses the tool API.
check('landlock in the LSM list', () => {
  const lsm = read('/sys/kernel/security/lsm')
  if (!lsm.split(',').includes('landlock')) throw new Error(`lsm=${lsm}`)
  return lsm
}, true)

check('seccomp', () => {
  const status = read('/proc/self/status')
  const m = status.match(/^Seccomp:\s*(\d)/m)
  return m ? `mode ${m[1]} available` : 'unknown'
}, false)

const width = Math.max(...checks.map((c) => c.name.length))
for (const c of checks) {
  const mark = c.ok ? 'ok  ' : c.required ? 'MISSING' : 'n/a '
  console.log(`  ${mark.padEnd(7)} ${c.name.padEnd(width)}  ${c.value}`)
}
const missing = checks.filter((c) => c.required && !c.ok)
console.log()
if (missing.length) {
  console.log(`Coding would launch read-only here: ${missing.map((c) => c.name).join(', ')} not available.`)
  process.exit(1)
}
console.log('Execution containment is available on this machine.')
