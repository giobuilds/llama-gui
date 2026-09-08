# Lowerbeam

A desktop control panel for [llama.cpp](https://github.com/ggml-org/llama.cpp).

llama.cpp ships a web UI, but it only appears *after* you have started a server
with the right flags — and the flags are the hard part. On an 8 GB card, `-ngl`,
`-c` and the KV cache type decide whether a model runs fast, runs slowly, or
fails to load. The built-in UI cannot change any of them.

Lowerbeam owns the server process instead: pick a model, see what will fit,
launch it, and chat — without touching a terminal.

*Low beam is the dipped headlight: the one you use close to home, lighting the
road ahead without dazzling anyone.*

## What it does

**Server** — launches llama.cpp on a free port and tracks it through an explicit
lifecycle, with a live log, GPU and VRAM readout, and crash messages that name a
likely cause. It adopts a server left running by a previous session rather than
starting a rival, and never leaks a child process. A binary check loads a model
and generates tokens, which catches a build that starts fine but cannot actually
run inference.

**Models** — scans your disk and reads each GGUF header for architecture,
quantisation, layers, trained context and chat template. Before launching it
estimates VRAM, broken into weights, KV cache, compute and backend reserve. You
can drive that yourself or hand sizing to llama.cpp's own `--fit`. Settings that
worked for a model are remembered and reapplied next time.

**Chat** — streaming replies as markdown with syntax-highlighted code, persisted
conversations, stop/regenerate/edit, per-conversation system prompt and samplers,
and images for models that can read them. llama.cpp decodes one sequence per
slot, so several conversations can generate at once; switching away doesn't
interrupt a reply.

**Downloads** — search Hugging Face, see which quantisations fit your GPU *and
roughly how fast they will run* before downloading, then pull one with live
progress. Vision models bring their projector automatically.

**Web access** — the model can search and read pages when you switch the tools
on. Everything is built around context rather than bandwidth: one page of raw
HTML is about 14,000 tokens on this hardware, the same page as text about 1,300,
and its search extract about 380 — so the model is shown text, and only when an
extract was not enough. Older results are replaced by a one-line summary once
they have been used, which keeps a five-search conversation at about a fifth of
what it would otherwise cost. Each enabled tool adds roughly 50 tokens to every
message, so they are switched on individually and the running cost is shown.
The default search engine rate-limits after a few queries in a row; point
*File → Tools and MCP Servers* at a SearXNG instance you run to avoid that.

**MCP servers** — any program that speaks the Model Context Protocol over stdin
and stdout can supply more tools. Give Lowerbeam its command and it starts it,
lists what it offers, and adds those tools to the same list chat picks from —
the model cannot tell them apart from the built-in ones. Servers are stopped
when the app quits and restarted when it opens.

**Tuning** — benchmarks launch settings with `llama bench` and applies the
fastest. Sampler settings aren't here on purpose: they don't change throughput.

## Requirements

- Node 20+ (developed on 24)
- llama.cpp — either the unified `llama` CLI or the standalone `llama-server`

Lowerbeam finds both and prefers the unified CLI, since a stale distro build
often sits in `/usr/bin` beside a current one. Override with the binary dropdown
or `LLAMA_SERVER_PATH`. It looks in `~/.local/bin`, `~/bin`, `/usr/local/bin`,
`/usr/bin`, `/opt/llama.cpp/bin` and `~/llama.cpp/build/bin`.

The two shapes are not interchangeable: the unified CLI needs a `serve`
subcommand and takes `--flash-attn on|off|auto`, where the standalone binary
treats `--flash-attn` as a bare switch. Lowerbeam adapts per binary.

## Getting started

```bash
npm install
npm run dev        # renderer hot-reload
npm test           # unit suites
npm run dist       # AppImage + RPM in dist/
```

On Fedora the RPM target also needs `libxcrypt-compat`, because electron-builder
shells out to `fpm`, whose bundled ruby links against `libcrypt.so.1`. Without it
the AppImage still builds.

```bash
sudo dnf install libxcrypt-compat
```

## About the estimates

VRAM: the KV cache figure is exact arithmetic and reproduces llama.cpp's own
reported size to the byte. Weights, compute and backend reserve are calibrated
against measured launches — within about 1% on the machines checked.

Speed: generation is memory-bandwidth-bound, so throughput is roughly bytes read
per token over bandwidth. Two things stop that being a division. A
mixture-of-experts model reads only its active experts, so a 30B model can behave
like a 3B one. And a model too large for VRAM is not unusable — llama.cpp can
keep attention on the GPU with experts in system RAM, so the estimate blends both
bandwidths.

Bandwidth is **measured, not assumed**: every benchmark and binary check
contributes a sample, and the Tuning tab has a calibration sweep. Until something
has been measured, no speed is claimed at all.

## Tests

```bash
npm test            # unit — needs nothing but a checkout
npm run test:all    # adds integration suites
```

No framework: suites import the app's own modules, are bundled with esbuild and
run as scripts, and print what they checked. Unit suites cover argument
construction, the log buffer, the planner against recorded measurements,
calibration, profiles, migration and the full server lifecycle against a shim.
Integration suites need a real binary, a model on disk, or network access.

## Notes

`--no-webui` is deliberately never passed, so llama.cpp's own UI stays reachable
as an escape hatch. Tokens stream from the renderer straight to the server rather
than through IPC. Model output is sanitised before rendering. There are no native
npm dependencies, so there is no rebuild step to break on an Electron bump.

## Licence

MIT — see [LICENSE](LICENSE).
