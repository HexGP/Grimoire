import { compileMidjourney }           from './mj-compiler.js';
import { extractIR }                  from './ir-compiler.js';
import { compileChatGPT }             from './chatgpt-compiler.js';
import { compileNanoBanana }          from './nb-compiler.js';
import { compileClaude }              from './claude-compiler.js';
import { compileVenice }              from './venice-compiler.js';
import { compileNovelAI }             from './novelai-compiler.js';
import { compileStableDiffusion, sdFallbackFromMaster } from './sd-compiler.js';

// Quality tags are now managed inside sd-compiler.js per model profile.

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanForKeywords(text) {
  return text
    .replace(/[.!?;]/g, ',')
    .replace(/\b(a|an|the|with|featuring|showing|that|which|and|or|in|on|at|to|of|by|from|through|using|having|very|really|quite|just)\b/gi, ' ')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 1)
    .join(', ');
}

// ── Midjourney ────────────────────────────────────────────────────────────────

export function generateMidjourney(masterPrompt, settings = {}) {
  const resolved = {
    version:     settings.version     ?? 'v6_1',
    aspectRatio: settings.aspectRatio ?? '16:9',
    style:       settings.style       ?? 'raw',
    stylize:     settings.stylize     ?? 100,
  };

  return {
    text: compileMidjourney(masterPrompt, resolved),
    status: 'draft',
    settings: resolved,
  };
}

// ── Stable Diffusion (semantic ontology compiler) ────────────────────────────
// Uses sd-compiler.js — semantic latent activation through ontology tags.
// NOT text rewriting. NOT sentence → underscore conversion.

export function generateStableDiffusion(ir, masterPrompt, settings = {}) {
  const { model = 'pony_xl', sdTags = [] } = settings;

  // Attempt semantic ontology compilation from IR
  const { positive, negative } = compileStableDiffusion(ir, masterPrompt, { model }, sdTags);

  // Safety: if IR produced nothing meaningful, fall back to whitelist-filtered master prompt
  const hasContent = positive && positive.replace(/^[^,]+, ?/, '').trim().length > 0;
  if (!hasContent) {
    const fallback = sdFallbackFromMaster(masterPrompt, model);
    return {
      positive: fallback.positive,
      negative: fallback.negative,
      status: 'draft',
      settings: { model },
    };
  }

  return {
    positive,
    negative,
    status: 'draft',
    settings: { model },
  };
}

// ── FLUX ──────────────────────────────────────────────────────────────────────

export function generateFlux(masterPrompt, settings = {}) {
  const { model = 'flux_dev' } = settings;
  return {
    text: masterPrompt.replace(/\s+/g, ' ').trim(),
    status: 'draft',
    settings: { model },
  };
}

// ── ChatGPT (film director brief, IR-driven) ──────────────────────────────────

export function generateChatGPT(ir, masterPrompt, settings = {}) {
  const { model = 'gpt_image_1' } = settings;
  const text = compileChatGPT(ir, masterPrompt, settings);
  return {
    text,
    status: 'draft',
    settings: { model },
  };
}

// ── Nano Banana (IR-driven, branches on model profile) ────────────────────────

export function generateNanoBananaV2(ir, masterPrompt, settings = {}) {
  const { model = 'nano_banana_base' } = settings;
  const text = compileNanoBanana(ir, masterPrompt, settings);
  return {
    text,
    status: 'draft',
    settings: { model },
  };
}

// ── Claude AI (structured reference-aware compiler) ───────────────────────────

export function generateAI(ir, masterPrompt, settings = {}) {
  const text = compileClaude(ir, masterPrompt, settings);
  return {
    text,
    status: 'draft',
    settings: {},
  };
}

// ── Venice AI (hybrid cinematic prose compiler) ───────────────────────────────

export function generateVenice(ir, masterPrompt, settings = {}) {
  const text = compileVenice(ir, masterPrompt, settings);
  return {
    text,
    status: 'draft',
    settings: {},
  };
}

// ── NovelAI (anime tag compiler, positive + negative) ─────────────────────────

export function generateNovelAI(ir, masterPrompt, settings = {}) {
  const { model = 'nai_anime' } = settings;
  const { positive, negative } = compileNovelAI(ir, masterPrompt, settings);
  return {
    positive,
    negative,
    status: 'draft',
    settings: { model },
  };
}

// ── Leonardo ──────────────────────────────────────────────────────────────────

export function generateLeonardo(masterPrompt) {
  return {
    text: cleanForKeywords(masterPrompt),
    status: 'draft',
    settings: {},
  };
}

// ── Core dispatcher ───────────────────────────────────────────────────────────
// Internal: takes a pre-extracted IR to avoid re-running extraction per generator.

function _dispatchFromIR(genKey, ir, masterPrompt, settings = {}) {
  switch (genKey) {
    case 'midjourney':       return generateMidjourney(masterPrompt, settings);
    case 'stable_diffusion': return generateStableDiffusion(ir, masterPrompt, settings);
    case 'flux':             return generateFlux(masterPrompt, settings);
    case 'chatgpt':          return generateChatGPT(ir, masterPrompt, settings);
    case 'nano_banana':      return generateNanoBananaV2(ir, masterPrompt, settings);
    case 'claude':           return generateAI(ir, masterPrompt, settings);
    case 'venice':           return generateVenice(ir, masterPrompt, settings);
    case 'novelai':          return generateNovelAI(ir, masterPrompt, settings);
    case 'leonardo':         return generateLeonardo(masterPrompt);
    default:
      return { text: masterPrompt.trim(), status: 'draft', settings: {} };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a single variant.
 * Extracts IR from master prompt, compiles, and attaches IR to output.
 */
export function generateVariant(genKey, masterPrompt, settings = {}) {
  const ir     = extractIR(masterPrompt);
  const result = _dispatchFromIR(genKey, ir, masterPrompt, settings);
  return { ...result, ir };
}

/**
 * Generate a variant from a pre-extracted IR.
 * Used by generateAll to compile all variants from the same IR pass.
 */
export function generateVariantFromIR(genKey, ir, masterPrompt, settings = {}) {
  const result = _dispatchFromIR(genKey, ir, masterPrompt, settings);
  return { ...result, ir };
}

/**
 * Export IR extractor so the UI can call it directly (e.g. for generateAll).
 */
export { extractIR };

// ── General workspace (text passthrough) ─────────────────────────────────────
// For General prompts: no IR compilation, no image ontology.
// Each provider gets a clean copy of the master prompt.
// Provider-specific formatting can be layered in later.

export function generateGeneralVariant(genKey, masterPrompt, settings = {}) {
  return {
    text: masterPrompt.replace(/\s+/g, ' ').trim(),
    status: 'draft',
    settings: {},
    ir: null,
  };
}

// ── Migration ─────────────────────────────────────────────────────────────────
// Converts old variant formats → new { text|positive|negative, status, settings, ir? }

export function migrateVariant(key, val) {
  if (!val) return null;
  // Already new format (has status field) — pass through as-is
  if (val && typeof val === 'object' && val.status !== undefined) return val;
  // Old SD object: { positive, negative }
  if (typeof val === 'object' && val.positive !== undefined) {
    return { ...val, status: 'approved', settings: { model: 'pony_xl' } };
  }
  // Old string format
  if (typeof val === 'string') {
    return { text: val, status: 'approved', settings: {} };
  }
  return val;
}
