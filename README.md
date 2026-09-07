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

**M1 – M3 complete.** Server management, the model library and chat all work end
to end:

- launch `llama-server` with a configured flag set, on an automatically chosen free port
- live state machine — `stopped → starting → loading → ready → degraded / crashed`
- streaming log pane with filtering and follow-tail
- GPU device list and VRAM usage read from `llama-server --list-devices`
- controls hidden automatically when the installed binary does not advertise the flag
- crash diagnostics that name the likely cause instead of `exited unexpectedly (code null)`
- adopts a `llama-server` left running by a previous session instead of spawning a rival
- never leaks a child process: SIGTERM with a SIGKILL escalation, on stop *and* on app quit

- finds every llama.cpp install and lets you choose between them — both the
  standalone `llama-server` and the newer unified `llama serve` CLI
- model library scanned from disk, with architecture, quantisation, layer count,
  trained context and chat-template presence read straight from the GGUF header
- **VRAM planner**: shows what a launch will cost before you start it, broken
  into weights / KV cache / compute / backend reserve, and names the largest
  `-ngl` that should fit
- **Auto-fit**: hands sizing to llama.cpp's own `--fit`, and previews what
  `fit-params` recommends
- **Binary check**: loads the model and generates tokens, so a build that starts
  fine but cannot run inference is caught in seconds rather than mid-chat

### Chat

- streaming replies rendered as markdown, with syntax-highlighted code blocks
  and per-block copy
- conversations persisted to disk, listed newest-first, titled from the first
  message
- stop mid-generation and keep the partial reply; regenerate; edit a message and
  resend from that point
- per-conversation system prompt and sampler settings, so reopening an old chat
  restores the conditions it was created under
- reasoning output from thinking models shown separately and collapsed by default
- throughput recorded per reply

Model output is markdown-rendered into the DOM, so it is sanitised first — an
unsanitised reply could otherwise carry a script tag or event-handler attribute
into the app.

## Roadmap

| Next | Why |
|---|---|
| multi-slot chat | llama.cpp serves 4 slots by default; several conversations can run at once against one loaded model |
| per-model launch profiles | remember the flags that worked for each GGUF and reapply on select |
| downloads via `llama download` | upstream already handles HF repos, quant selection and mmproj — no reason to reimplement it |
| tuning playground with `llama bench` | one-click benchmarks turn sampler/quant tuning into evidence rather than guesswork |

## Which llama.cpp does it use?

llama.cpp ships in two shapes and they are not interchangeable:

| Shape | Invocation | Notes |
|---|---|---|
| standalone | `llama-server --model …` | what distro packages ship |
| unified CLI | `llama serve --model …` | current upstream distribution |

Both are discovered and listed; the unified CLI is preferred because a stale
distro build often sits in `/usr/bin` alongside a current one, and silently
driving the wrong binary makes a working GPU look broken. Use the binary
dropdown to override, or set `LLAMA_SERVER_PATH`.

They differ in argv: the unified CLI needs the `serve` subcommand and takes
`--flash-attn on|off|auto`, where the standalone binary treats `--flash-attn` as
a bare boolean. Passing the wrong form makes llama.cpp exit during argument
parsing, so the app adapts per binary rather than assuming one.

## Auto-fit vs. the planner

Modern llama.cpp defaults `--fit on`, adjusting *unset* arguments to fit device
memory — and passing an explicit `-ngl`/`-c` silently suppresses it. Auto-fit
mode therefore omits both on purpose and lets llama.cpp decide, since it knows
its own allocator better than any external estimate. `llama fit-params` is used
to preview that decision.

The planner is still worth having: it explains *why* a configuration costs what
it does and updates live as you change settings, which a one-shot fitter cannot.
Turn auto-fit off to drive it yourself.

## How the VRAM estimate works

- **KV cache** is exact arithmetic — `2 x layers x ctx x embd_gqa x bytes` —
  and reproduces llama.cpp's own reported size to the byte.
- **Weights** come from the file size, minus an estimate of the token-embedding
  tensor, which stays host-resident even at full offload.
- **Compute buffer** depends on the llama.cpp generation: older builds allocate
  logits for the whole physical batch, newer ones only for emitted tokens — an
  ~8x difference (310 MiB vs 38 MiB measured on the same model). This is the
  least certain term.
- **Backend reserve** (~190 MiB for ROCm) is counted, because on an 8 GB card
  omitting it makes the estimate optimistic exactly when that hurts most.

Validated against real launches on an RX 6600: predicted 917 MiB vs 913 measured
on a classic build, and 641 vs 647 on a modern one — 0.4% and 0.9%.

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
