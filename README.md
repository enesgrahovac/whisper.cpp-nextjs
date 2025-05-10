# Whisper.cpp on Next.js – 100% Client-side Speech-to-Text

Live demo ➜ **URLCOMINGSOON**

Real-time speech recognition running _entirely in the browser_.  
No server, no external API keys – just WebAssembly, Web Audio, and IndexedDB.

---

## ✨ Features

- Whisper model executed in the browser via WebAssembly (compiled with Emscripten).
- Next.js 15 (App Router) + React 19 + TypeScript.
- Model files (~30–140 MB) are transparently **cached in IndexedDB** after the first download.
- Works offline once a model is cached.
- Shadcn/UI + Tailwind v4 for the UI.

---

## 📺 Quick Start

```bash
git clone https://github.com/your-name/whisper.cpp-nextjs.git
cd whisper.cpp-nextjs
pnpm install         # or npm / yarn / bun
pnpm dev             # localhost:3000
```

The first time you select a model it will be downloaded and stored locally (see “Caching” below).

---

## 🏗️ How the WebAssembly bits are built

The pre-built files already live under `public/whisper/stream/` so you don’t need to build anything to _run_ the demo.  
If you want to rebuild them yourself:

1. Clone [`whisper.cpp`](https://github.com/ggerganov/whisper.cpp).
2. Follow the instructions in [`examples/stream/README.md`](https://github.com/ggerganov/whisper.cpp/tree/master/examples/stream) (`make stream.wasm`, etc.).
3. Copy the generated `stream.js`, `stream.wasm`, `lib*.js`, … into `public/whisper/stream/`.

We are, quite literally, **standing on the shoulders of giants** – enormous thanks to Georgi Gerganov and all contributors to whisper.cpp. 🙏

---

## 🔐 Cross-Origin Isolation

Running large WebAssembly modules that use `SharedArrayBuffer` requires the page to be cross-origin isolated. In Next.js we achieve that by adding the following response header in `next.config.ts`:

```ts
// next.config.ts
export default {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};
```

(You can swap `credentialless` for `require-corp` if you run your own static file server with proper CORP headers.)

---

## 📦 Caching & Storage

- Models are stored in an IndexedDB database called `whisper-model-cache`.
- Use the “Clear Cache” button in the UI, or manually clear the browser’s site-data if you run out of storage.

---

## 📜 License

This repo is released under the MIT license (see `LICENSE`).  
Whisper.cpp itself is licensed under the MIT license as well.

---

## 🤝 Contributing

PRs and issues are very welcome!  
For larger changes, please open an issue first so we can discuss direction and scope.

---

## 🙋 FAQ

<details>
<summary>Which browsers are supported?</summary>

Any browser that supports `SharedArrayBuffer` _and_ cross-origin isolation.  
That includes recent versions of Chrome/Edge/Opera and Firefox with `privacy.partition.always_partition_third_party_non_partitioned_state=false`.

</details>

<details>
<summary>Can I use other Whisper models?</summary>

The UI currently lists Tiny & Base (and their Q5_1 quantised versions).  
If you compile another `ggml-*.bin` model, just add an entry to `MODELS` in `src/components/StreamClient.tsx`.

</details>
<details>
<summary>What about uploading audio files?</summary>

The demo currently only supports real-time transcription of live audio.  
You can feel free to contribute a file upload feature!

</details>

---

## Acknowledgements

- [ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp) – the core magic.
- [shadcn/ui](https://ui.shadcn.com/) – beautiful, headless UI primitives.
- [Geist font](https://vercel.com/font/geist) – typography.
- Everyone who filed issues / PRs and tested early versions. ❤️
