<p align="center">
  <img src="static/grimoire-logo.png" width="128" alt="Grimoire logo" />
</p>

<h1 align="center">Grimoire</h1>

<p align="center">
  <strong>Offline desktop prompt manager: one master prompt, tailored variants for every generator.</strong>
</p>

<p align="center">
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" /></a>
  <a href="https://svelte.dev"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white" alt="Svelte 5" /></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust" /></a>
  <img src="https://img.shields.io/badge/Windows-tested-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/license-MIT-AAF0D1?style=flat-square" alt="MIT License" />
</p>

---

Grimoire is a local-first desktop app for organizing AI prompts. Write one **master prompt**, then generate tailored versions for Midjourney, Stable Diffusion, FLUX, NovelAI, ChatGPT, and more — only when you ask for them.

Everything stays on your machine. No accounts, no cloud sync, no telemetry.

## Features

| | |
|---|---|
| **Variant engine** | Rule-based compilers turn a single master prompt into generator-ready output in one click |
| **Two workspaces** | **Image** for visual generators · **General** for writing, coding, research, and system prompts |
| **Rich prompt cards** | Tags, favorites, notes, cover images, and a result gallery per prompt |
| **Offline by default** | Per-file local storage with backup recovery — works without an internet connection |
| **System tray** | Runs quietly in the background; open from the tray when you need it |

## Supported generators

**Image** — Midjourney · Stable Diffusion · FLUX · NovelAI · Nano Banana · ChatGPT Image · Venice · Leonardo · Firefly · Ideogram

**General** — ChatGPT · Claude · Gemini · Perplexity · Cursor · Copilot · Suno · ElevenLabs · and more

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org) · [Rust](https://rustup.rs) · [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri dev
```

Build a release installer:

```bash
npm run tauri build
```

Installers are written to `src-tauri/target/release/bundle/`.

## Privacy

Grimoire does not phone home. Your prompts, images, and settings live in a local `app_data` folder on your computer. The only optional network use is the built-in app updater.

---

<p align="center">
  <sub>Built with care for people who live in their prompts.</sub>
</p>
