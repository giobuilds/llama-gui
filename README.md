# llama-gui

A desktop control panel for [llama.cpp](https://github.com/ggml-org/llama.cpp).

llama.cpp ships a web UI, but it only appears *after* you have already started
`llama-server` from a terminal with the right flags — and the flags are the hard
part. On an 8 GB card, `-ngl`, `-c` and `-ctk/-ctv` decide whether a model runs
fast, runs slowly, or fails to load at all. The built-in UI cannot change any of
them.

This app owns the `llama-server` process instead: pick a GGUF, launch it, watch
it load, chat with it, swap models — without touching a shell.

## Status

**M1 complete.** Server lifecycle management works end to end:

- launch `llama-server` with a configured flag set, on an automatically chosen free port
- live state machine — `stopped → starting → loading → ready → degraded / crashed`
- streaming log pane with filtering and follow-tail
- GPU device list and VRAM usage read from `llama-server --list-devices`
- controls hidden automatically when the installed binary does not advertise the flag
- crash diagnostics that name the likely cause instead of `exited unexpectedly (code null)`
- adopts a `llama-server` left running by a previous session instead of spawning a rival
- never leaks a child process: SIGTERM with a SIGKILL escalation, on stop *and* on app quit

Not yet built: model library and GGUF metadata (M2), chat (M3), tuning
playground (M4), Hugging Face downloads (M5). See the milestone table in the
plan for the full sequence.

## Requirements

- Node 20+ (developed on 24)
- `llama-server` on `PATH`, or `LLAMA_SERVER_PATH` pointing at it

Fedora: `sudo dnf install llama-cpp`. The app also looks in `/usr/local/bin`,
`/opt/llama.cpp/bin`, `~/.local/bin` and `~/llama.cpp/build/bin`.

## Troubleshooting

**`llama-server` crashes immediately after loading a model (SIGSEGV).**
Some ROCm builds segfault in the HIP runtime the first time a compute kernel is
launched. Reproduced here on Fedora 44 with `llama-cpp-b6153` on a gfx1032
(RX 6600): the package is built against HIP `7.1.52802-9999`, and the coredump
shows the fault in `libamdhip64.so.7` (`amd::Kernel::getDeviceKernel`) under
`ggml_cuda_op_rms_norm`.

The crash first shows up during the warmup run, so "Skip warmup (`--no-warmup`)"
gets past launch — but it will then crash on the first real request instead,
because the fault is in kernel launch, not warmup. Note that `-ngl 0` is *not*
enough: ggml still schedules ops onto the registered HIP backend. To run purely
on CPU, add `--device none` to the extra flags.

If GPU inference crashes for you, the problem is the llama.cpp build, not this
app or the model — verify with `llama-server` directly before filing anything
here.

## Development

```bash
npm install
npm run dev        # renderer HMR + electron
npm run typecheck
npm run build
npm run dist       # AppImage + rpm via electron-builder
```

## Design notes

**It talks HTTP to `llama-server`, not `libllama`.** The distro package upgrades
on its own schedule; an HTTP client survives that, a native binding does not. It
also means the app can attach to a server it did not start.

**Tokens stream renderer → server directly.** Only privileged work (spawning,
filesystem, downloads) crosses IPC. Piping every token through `ipcRenderer`
would add a serialization hop per token for nothing.

**No native npm dependencies.** No `electron-rebuild` step, nothing to break on
an Electron bump.

**Readiness comes from `GET /health`, not from log scraping.** The logs only
drive the human-readable stage label. Note that `llama-server` emits no
model-load percentage — only per-slot prompt progress — so this app shows
discrete load stages rather than a progress bar it would have to invent.

**Flag support is probed, not assumed.** `llama-server --help` is parsed at
startup and the UI hides controls the installed build does not support. Fedora's
package reports `version: 0 (unknown)`, so the capability cache keys on the
binary's size and mtime rather than its version string.

The stock web UI stays reachable — `--no-webui` is deliberately never passed —
so there is always an escape hatch if this app misbehaves.
