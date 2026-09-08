# Lowerbeam

A desktop control panel for [llama.cpp](https://github.com/ggml-org/llama.cpp).

Low beam is the dipped headlight: the one you use close to home, that lights the
road in front of you without dazzling anyone. That is the idea here — models
running on your own machine, under your own control, with nothing leaving it.

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
- **Per-model profiles**: the settings that last worked for a model are
  remembered and reapplied when you pick it again
- **Vision**: attach images to a message when the loaded model can read them
- **Tuning**: benchmark launch settings with `llama bench` and apply the fastest
- **Model downloads**: search Hugging Face, see which quantisations fit your GPU
  *before* downloading, and pull one with live progress

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
- **concurrent conversations**: llama.cpp decodes one sequence per slot, so
  several chats can generate at once. Switching away does not interrupt a reply,
  the sidebar marks conversations still generating, and a slot meter shows how
  many of the server's slots are in use (and how many requests are queued)

Model output is markdown-rendered into the DOM, so it is sanitised first — an
unsanitised reply could otherwise carry a script tag or event-handler attribute
into the app.

## Roadmap

Everything on the original roadmap is now built. Natural next steps: multi-GPU
splits, multimodal (`--mmproj`), speculative decoding, and serving on the LAN.

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

## The menu

Electron's default menu is written for a generic web wrapper — its Help points at
electronjs.org and its Edit menu offers clipboard operations that mean nothing
here. It is replaced with the things this app can do, and with the two references
a llama.cpp user actually wants: **Help → llama.cpp Flag Reference** and
**Help → Search Issues**.

The flag reference is built from the installed binary's own `--help`, parsed into
sections with descriptions and environment variables, and searchable. It is not a
bundled copy: llama.cpp adds and renames options often enough that a shipped list
would eventually describe flags that do not exist. On the build here that is 257
options across four sections.

Menu items never act on the app directly — they ask the renderer to do exactly
what its buttons do, so there is one path to every action rather than two that
can drift apart.

## Vision models

A vision model is two files: the model and a multimodal projector (`mmproj`).
Without the projector passed as `--mmproj` the model still loads and still
answers — it simply cannot see, and nothing says so. So the projector is treated
as part of the model rather than as a separate thing to remember:

- projectors are identified from their metadata (`general.architecture = clip`),
  not just their filename, and kept out of the model list — they cannot be
  launched alone
- each is attached to the model it belongs with, matched on name rather than
  merely sharing a directory, so a text model in a flat models folder never
  inherits one
- downloading a vision model fetches its projector too; `llama download` does
  not do this for a specific `--hf-file`
- when no projector matches the model's quantisation, the smaller one is taken:
  VRAM is the binding constraint and a quantised projector is close to lossless,
  while an f16 one can cost several hundred MiB more for no visible gain

Whether images can actually be sent is read from the running server's `/props`
(`modalities.vision`), not inferred from having passed a flag — passing one is
no guarantee it took effect. Attached images travel with the conversation as
data URLs, capped at 8 MB each, which keeps a conversation a single
self-contained document.

## Tuning

Benchmarks launch settings with `llama bench`, so choosing between flash
attention, KV cache types, offload splits, thread counts and batch sizes is based
on measurement rather than folklore. Results are split into generation and prompt
processing — different workloads with different speeds — ranked with the gap to
the best shown, and any row can be pushed straight into the launch settings.

Sampler settings are deliberately absent. Temperature and top-p do not measurably
change throughput, so benchmarking them would be measuring noise; sampler choice
is a quality question and belongs in the chat view.

Two llama.cpp constraints are handled rather than passed on: a quantised KV cache
cannot create a context without flash attention, and `llama bench` crosses `-ctk`
with `-ctv` when given lists, which would produce mismatched K/V pairs nobody
asked for. Sweeps are therefore split into one run per cache type, with quantised
types measured with flash attention on.

## Will a model be fast enough?

Fitting is only half the question. The download page also predicts generation
speed, and labels it by how it feels: **fast**, **comfortable**, **slow** or
**painful**, with the boundaries set around reading pace — roughly 5-10 tokens a
second is where a model stops keeping up with a person.

Generation is memory-bandwidth-bound: every token reads the weights that take
part in it, so throughput is about `bytes read per token / bandwidth`. Two things
make that more than a division:

- **Mixture-of-experts models** read only their active experts each token, so a
  30B model can behave like a 3B one. Judging by file size would predict 2 tok/s
  where reality is nearer 20 — the difference between pointless and usable. The
  active parameter count is computed from the header and matches the figures
  publishers advertise to within about 1% on the models checked.
- **A model too large for VRAM is not simply unusable.** llama.cpp can keep
  attention on the GPU with experts in system RAM (`--cpu-moe`), so the estimate
  blends both bandwidths rather than refusing to answer.

The machine's bandwidth is **measured, not assumed**. Every benchmark and every
binary check contributes a sample, and the Tuning tab has a **Calibrate this
machine** sweep that measures generation with everything on the GPU and again
with nothing on it — the second number decides whether a large mixture-of-experts
model is usable and cannot be guessed from the hardware.

Given samples at more than one model size, time per token is fitted as
`overhead + bytes / bandwidth`, which separates fixed per-token cost from
bandwidth instead of assuming either. The intercept is only trusted from three or
more samples spanning a range of sizes: two large models here implied a ceiling
of 1906 tok/s where small ones showed about 630, so a line through two distant
points puts the intercept wherever the noise wants.

Until something has been measured, no speed is claimed at all, and the Tuning tab
says plainly which figures are measurements and which are still stand-ins. Move
the app to another machine and it recalibrates from one sweep.

## Which model fits your machine

Choosing between eight quantisations of the same model is the real difficulty,
and the answer depends on the card in front of you. Each quantisation is
labelled **fits GPU**, **partial** or **CPU only**, the list can be sorted by fit
or filtered to what fits, and the largest quantisation that still fits entirely
in VRAM is marked as the best choice — more bits is better quality, but spilling
onto the CPU costs far more speed than the extra quality is worth.

This works without downloading anything. The GGUF header is fetched with an HTTP
Range request: one megabyte carries the architecture, layer count, embedding size
and head counts, which is everything the VRAM planner needs. Quantisations of one
model share a shape, so the header is read once per model and reused across its
quants — a repo with twenty files costs one request, not twenty.

Estimates assume a full offload at a 4k context, and inherit the accuracy of the
planner described below.

## Downloads

Search and quant selection come from the Hugging Face API; the transfer itself
is handed to `llama download`, which already resolves repos, matches quants,
fetches a companion mmproj and writes the Hugging Face cache layout correctly.

`llama download` reports no progress when it is not attached to a terminal — it
writes nothing at all until it prints the final path. So progress is *observed*
rather than parsed: the HF cache writes the incoming file as
`blobs/<sha>.downloadInProgress`, and its size against the size the API reports
gives an accurate percentage. Cancelling leaves the partial file in place, and
starting the same download again resumes from it.

Downloads from one repository run one at a time. Two `llama download` processes
on the same repo race to write the cache's `refs/main` and one loses — which is
exactly the pairing the app queues for a vision model.

Note that models land in `~/.cache/huggingface/hub`, where the snapshot entry is
a *symlink* into `blobs/`. The library scan resolves symlinks for this reason;
without that, nothing downloaded through the HF cache would ever appear.

## Per-model profiles

Every model wants different flags, and rediscovering them each time is the exact
friction this app exists to remove. A profile is written **only once a launch has
reached `ready`**, so what is stored is a configuration known to work rather than
whatever was last typed into the form — a launch that crashes is not remembered.

Models are identified by file name and size rather than path, so moving a GGUF
between folders keeps its settings while two genuinely different models cannot
collide. Profiles also record how long the model took to load and the context
llama.cpp actually settled on, which under auto-fit is otherwise not visible
anywhere.

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

Note that `-c` is the **total** context and llama.cpp divides it across slots:
`-c 16384 --parallel 4` gives each conversation 4096 tokens and allocates one
16384-cell cache, not four. The planner accounts for this and the launch panel
shows the resulting per-chat context.

Validated against real launches on an RX 6600: predicted 917 MiB vs 913 measured
on a classic build, and 641 vs 647 on a modern one — 0.4% and 0.9%. The
multi-slot KV figure matches llama.cpp exactly (192.00 MiB at `-c 16384
--parallel 4`).

## Packaging

`npm run dist` produces both an AppImage and an RPM in `dist/`. The AppImage
runs standalone; the RPM installs to `/opt/Lowerbeam` with a desktop entry and
icon, and its dependencies (gtk3, libnotify, libXtst and friends) are ordinary
desktop packages.

On Fedora the RPM target additionally needs `libxcrypt-compat`, because
electron-builder shells out to `fpm`, whose bundled ruby links against
`libcrypt.so.1` while Fedora ships libxcrypt. Without it the AppImage still
builds and only the RPM step fails.

```bash
sudo dnf install libxcrypt-compat
```

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

## Tests

```bash
npm test            # unit suites — nothing but this repo, safe anywhere
npm run test:all    # adds integration suites
```

There is no test framework. Suites are TypeScript that imports the app's own
modules, bundled with esbuild and run as scripts; assertions come from
`node:assert` and each suite prints what it checked, so the output reads as a
description of the behaviour rather than a wall of dots.

The split matters because the tiers need different things. **Unit** suites need
nothing beyond this repository — argument construction, the log ring buffer, the
VRAM planner against recorded measurements, calibration fitting, launch
profiles, the rename migration, and the full server lifecycle against a shim
that speaks llama-server's own stderr and `/health` semantics. **Integration**
suites need a real llama.cpp binary, a model on disk, or network access: they
launch servers, read GGUF headers over HTTP, download models and run benchmarks.

Several of the sharper bugs in this project were found by integration suites
checking the *outcome* rather than trusting a success message — a download that
reported success while the model never appeared in the library, a benchmark that
"ran" while producing nothing usable.

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
