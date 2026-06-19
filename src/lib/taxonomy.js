import { ICON_REGISTRY } from './icons.js';

// ── Generator definitions ─────────────────────────────────────────────────────
// To add a new generator:
//   1. Add its icon to src/lib/icons.js (run build-icons.cjs or add manually)
//   2. Add one entry here
//   3. That's it — the UI picks it up automatically
//
// Internal structure uses provider/model separation.
// UI exposes generator ecosystem names, not raw provider branding.

function makeGen(key, name, short, tier, type, extra = {}) {
  const icon = ICON_REGISTRY[key] ?? { svg: initialsIcon(short), bg: '#333', fg: '#fff' };
  return { key, name, short, tier, type, bg: icon.bg, fg: icon.fg, svg: icon.svg, ...extra };
}

function initialsIcon(text) {
  return `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="800" font-family="system-ui,sans-serif">${text}</text></svg>`;
}

// ── Active generator map ──────────────────────────────────────────────────────
// Generators the UI exposes. Ordered by UX clarity, not provider naming.
//
// Removed generators (legacy, kept in LEGACY_GENERATOR_KEYS for migration):
//   - gemini      → represented by nano_banana ecosystem
//   - dalle       → represented by chatgpt ecosystem

// ── Image workspace generators ────────────────────────────────────────────────

export const GENERATORS_MAP = {
  // ── Tier 1 ─────────────────────────────────────────────────────────────────
  chatgpt:          makeGen('chatgpt',          'ChatGPT',          'GPT', 1, 'both',  { hasProfiles: true,  provider: 'openai' }),
  midjourney:       makeGen('midjourney',        'Midjourney',       'MJ',  1, 'image', { hasProfiles: true,  provider: 'midjourney' }),
  stable_diffusion: makeGen('stable_diffusion',  'Stable Diffusion', 'SD',  1, 'image', { hasProfiles: true,  provider: 'stability' }),
  flux:             makeGen('flux',              'FLUX',             'FX',  1, 'image', { hasProfiles: true,  provider: 'blackforest' }),
  nano_banana:      makeGen('nano_banana',        'Nano Banana',      'NB',  1, 'image', { hasProfiles: true,  provider: 'google' }),
  claude:           makeGen('claude',            'Claude',           'CL',  1, 'ai',   { hasProfiles: false, provider: 'anthropic' }),
  venice:           makeGen('venice',            'Venice AI',        'VC',  1, 'image', { hasProfiles: false, provider: 'venice' }),
  novelai:          makeGen('novelai',           'NovelAI',          'NA',  1, 'image', { hasProfiles: true,  provider: 'novelai' }),
  // ── Tier 2 ─────────────────────────────────────────────────────────────────
  leonardo:         makeGen('leonardo',          'Leonardo',         'LN',  2, 'image', { provider: 'leonardo' }),
  firefly:          makeGen('firefly',           'Firefly',          'FF',  2, 'image', { provider: 'adobe' }),
  ideogram:         makeGen('ideogram',          'Ideogram',         'IG',  2, 'image', { provider: 'ideogram' }),
};

// ── General workspace providers ───────────────────────────────────────────────
// Text-first: writing, coding, research, music, voice, agent, system prompts, etc.
// No image-specific tools (SD/NovelAI/NanoBanana).
// Gemini here instead of Nano Banana (Nano Banana = Gemini image side only).

export const GENERAL_GENERATORS_MAP = {
  chatgpt:    makeGen('chatgpt',    'ChatGPT',    'GPT', 1, 'text', { hasProfiles: false, provider: 'openai' }),
  claude:     makeGen('claude',     'Claude',     'CL',  1, 'text', { hasProfiles: false, provider: 'anthropic' }),
  gemini:     makeGen('gemini',     'Gemini',     'GM',  1, 'text', { hasProfiles: false, provider: 'google' }),
  venice:     makeGen('venice',     'Venice AI',  'VC',  1, 'text', { hasProfiles: false, provider: 'venice' }),
  perplexity: makeGen('perplexity', 'Perplexity', 'PX',  1, 'text', { hasProfiles: false, provider: 'perplexity' }),
  cursor:     makeGen('cursor',     'Cursor',     'CS',  1, 'text', { hasProfiles: false, provider: 'cursor' }),
  copilot:    makeGen('copilot',    'Copilot',    'CO',  1, 'text', { hasProfiles: false, provider: 'microsoft' }),
  suno:       makeGen('suno',       'Suno',       'SN',  1, 'text', { hasProfiles: false, provider: 'suno' }),
  elevenlabs: makeGen('elevenlabs', 'ElevenLabs', 'EL',  1, 'text', { hasProfiles: false, provider: 'elevenlabs' }),
  custom:     makeGen('custom',     'Custom',     'CU',  1, 'text', { hasProfiles: false, provider: 'custom' }),
};

export const GENERAL_GENERATORS = Object.values(GENERAL_GENERATORS_MAP);

// Keys for generators removed from the UI but kept for data migration
export const LEGACY_GENERATOR_KEYS = ['gemini', 'dalle'];

export const GENERATORS    = Object.values(GENERATORS_MAP);
export const GENERATORS_T1 = GENERATORS.filter(g => g.tier === 1);
export const GENERATORS_T2 = GENERATORS.filter(g => g.tier === 2);

// ── Model profiles ────────────────────────────────────────────────────────────
// When a generator has hasProfiles: true, the UI renders a model picker.
// The selected profile drives which compiler branch runs internally.

export const MODEL_PROFILES = {
  chatgpt: [
    { key: 'gpt_image_1', name: 'GPT Image 1', model: 'gpt-image-1', provider: 'openai' },
    // Future: { key: 'gpt_image_2', name: 'GPT Image 2', ... }
  ],
  midjourney: [
    { key: 'v6',    name: 'v6',     model: 'v6',    provider: 'midjourney' },
    { key: 'v6_1',  name: 'v6.1',   model: 'v6.1',  provider: 'midjourney' },
    { key: 'v7',    name: 'v7',     model: 'v7',    provider: 'midjourney' },
    { key: 'niji6', name: 'Niji 6', model: 'niji6', provider: 'midjourney' },
  ],
  stable_diffusion: [
    { key: 'pony_xl',     name: 'Pony XL',     model: 'pony_xl',     provider: 'community' },
    { key: 'sdxl',        name: 'SDXL',        model: 'sdxl',        provider: 'stability' },
    { key: 'sd15',        name: 'SD 1.5',      model: 'sd15',        provider: 'stability' },
    { key: 'illustrious', name: 'Illustrious', model: 'illustrious', provider: 'community' },
    { key: 'custom',      name: 'Custom',      model: 'custom',      provider: 'custom'    },
  ],
  flux: [
    { key: 'flux_dev',     name: 'FLUX Dev',     model: 'flux-dev',     provider: 'blackforest' },
    { key: 'flux_pro',     name: 'FLUX Pro',     model: 'flux-pro',     provider: 'blackforest' },
    { key: 'flux_schnell', name: 'FLUX Schnell', model: 'flux-schnell', provider: 'blackforest' },
    { key: 'flux_kontext', name: 'FLUX Kontext', model: 'flux-kontext', provider: 'blackforest' },
  ],
  nano_banana: [
    { key: 'nano_banana_base', name: 'NB Base', model: 'nano-banana-base', provider: 'google' },
    { key: 'nano_banana_pro',  name: 'NB Pro',  model: 'nano-banana-pro',  provider: 'google' },
  ],
  novelai: [
    { key: 'nai_anime', name: 'Anime',  model: 'nai-diffusion-4-curated', provider: 'novelai' },
    { key: 'custom',    name: 'Custom', model: 'custom',                   provider: 'novelai' },
  ],
};

// ── Default generator settings ────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  chatgpt:          { model: 'gpt_image_1' },
  midjourney:       { version: 'v6_1', aspectRatio: '16:9', style: 'raw', stylize: 100 },
  stable_diffusion: { model: 'pony_xl' },
  flux:             { model: 'flux_dev' },
  nano_banana:      { model: 'nano_banana_base' },
  novelai:          { model: 'nai_anime' },
};

// ── Danbooru tag quick-picks ──────────────────────────────────────────────────

export const QUICK_TAGS = {
  style:    ['cinematic', 'photorealistic', 'anime', 'digital_art', 'watercolor', 'oil_painting', '3d_render', 'illustration', 'concept_art', 'sketch'],
  mood:     ['dramatic', 'moody', 'peaceful', 'ethereal', 'dark', 'vibrant', 'mysterious', 'romantic', 'epic', 'dreamy'],
  lighting: ['golden_hour', 'cinematic_lighting', 'volumetric_lighting', 'neon_lights', 'soft_lighting', 'god_rays', 'backlit', 'candlelight'],
  subject:  ['portrait', 'landscape', 'cityscape', 'architecture', 'nature', 'abstract', 'character', 'creature'],
  quality:  ['highly_detailed', 'intricate_details', 'sharp_focus', '8k', 'masterpiece', 'best_quality'],
};

export const SD_ORDER = ['quality','source','rating','subject','hair','eyes','clothing','pose','camera','scene','style','negative'];
export const SECTIONS  = ['image', 'general'];
