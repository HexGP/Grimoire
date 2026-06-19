// novelai-compiler.js — NovelAI semantic tag compiler
//
// Pipeline:
//   IR → Danbooru semantic extraction (shared with SD) → NovelAI profile filtering → pos/neg assembly
//
// Key principles:
//   - Tag-first, anime-focused. NO prose footers.
//   - Uses the same Danbooru IR extraction as SD but applies NovelAI-specific quality
//     tags, banned-tag filters, and assembly ordering.
//   - Output: { positive, negative } — same shape as the SD compiler.
//   - Hard rule: never manufacture underscore-joined pseudo-tags that don't exist in
//     the Danbooru ontology. Only emit tags known to NovelAI's training corpus.
//
// NovelAI quality tag vocabulary (NAI Anime v3/v4):
//   positive boosters → "best quality", "amazing quality", "very aesthetic"
//   medium tag        → "anime illustration"
//   NOT PonyXL score_ tags, NOT old SD "masterpiece", NOT SDXL intricate_detail

import { extractSDTags } from './sd-compiler.js';

// ── Quality tag profiles ───────────────────────────────────────────────────────

const QUALITY = {
  nai_anime: {
    pos: ['best quality', 'amazing quality', 'very aesthetic', 'anime illustration'],
    neg: [
      'low quality', 'worst quality', 'bad anatomy', 'bad hands', 'extra fingers',
      'missing fingers', 'malformed hands', 'blurry', 'jpeg artifacts', 'watermark',
      'text', 'logo', 'signature', 'cropped', 'out of frame', 'duplicate',
      'deformed', 'mutated', 'poorly drawn face', 'poorly drawn eyes',
    ],
  },
  custom: {
    pos: [],
    neg: [],
  },
};

// ── Model capability profiles ──────────────────────────────────────────────────

const PROFILES = {
  nai_anime: {
    tagStyle:     'danbooru',
    proseSupport: false,   // NAI Anime is tag-first — no natural-language footers
    maxTags:      50,
    banned: new Set([
      // PonyXL scoring tags — irrelevant to NovelAI
      'score_9', 'score_8_up', 'score_7_up', 'score_6_up', 'score_5_up',
      'score_4', 'score_3', 'score_2', 'score_1',
      'source_anime', 'source_furry', 'source_pony',
      // Photo/realism tags — NAI is anime-only
      'photorealistic', 'photo_realistic', 'photography', 'realistic',
      '3d_render', 'cg_art', 'film_still', 'cinematic_still',
      // SDXL-specific quality boosters
      'masterpiece', 'intricate_detail', 'ultra-detailed', 'sharp_focus',
      // NAI has its own quality path; don't double-declare via SD quality tags
      'highres', 'absurdres', 'newest', 'worst_aesthetic',
    ]),
    preferred: [],
  },
  custom: {
    tagStyle:     'danbooru',
    proseSupport: false,
    maxTags:      60,
    banned:       new Set(),
    preferred:    [],
  },
};

// ── NovelAI-specific tag assembly ──────────────────────────────────────────────
// Ordering: quality → count → layout → interaction → composition → environment → lighting → style
// Quality tags are pre-pended and excluded from the body dedup pass.

function assembleNAITags(qualityPos, tagGroups, profile) {
  const orderedSections = [
    tagGroups.count,
    tagGroups.layout,
    tagGroups.interaction,
    tagGroups.composition,
    tagGroups.environment,
    tagGroups.lighting,
    tagGroups.style,
  ];

  // Seed seen-set with quality tags so they are never duplicated in body
  const seen = new Set(qualityPos);
  const bodyTags = [];

  for (const section of orderedSections) {
    for (const tag of (section ?? [])) {
      if (!seen.has(tag) && !profile.banned.has(tag)) {
        seen.add(tag);
        bodyTags.push(tag);
      }
    }
  }

  // Quality leads; body respects maxTags cap
  return [...qualityPos, ...bodyTags.slice(0, profile.maxTags)];
}

// ── Sparse-IR fallback ─────────────────────────────────────────────────────────
// When IR extraction produces no meaningful semantic tags, extract safe single
// words from the master prompt rather than emitting empty/broken output.

function naiFallback(masterPrompt, quality, model) {
  const SAFE_SINGLES = new Set([
    'solo', 'group', 'fantasy', 'ruins', 'forest', 'castle', 'dungeon', 'mountain',
    'ocean', 'indoors', 'outdoors', 'night', 'sunset', 'moonlight', 'sunlight',
    'serious', 'happy', 'sad', 'angry', 'talking', 'fighting', 'sitting',
    'comic', 'anime', 'fantasy', 'medieval', 'futuristic',
    'cinematic', 'dramatic', 'epic', 'dark', 'mysterious',
  ]);

  const words = masterPrompt.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => SAFE_SINGLES.has(w));

  const safeTags = [...new Set(words)].slice(0, 12);
  return {
    positive: [...quality.pos, ...safeTags].join(', ') || masterPrompt.trim(),
    negative: quality.neg.join(', '),
  };
}

// ── Main compiler ──────────────────────────────────────────────────────────────

export function compileNovelAI(ir, masterPrompt, settings = {}) {
  const model   = settings.model ?? 'nai_anime';
  const quality = QUALITY[model]  ?? QUALITY.nai_anime;
  const profile = PROFILES[model] ?? PROFILES.nai_anime;

  // ── Semantic extraction (shared Danbooru IR→tags infrastructure) ──────────
  const rawGroups = extractSDTags(ir);

  // ── Profile filtering: deduplicate within groups, remove banned tags ───────
  const filteredGroups = {};
  for (const [group, tags] of Object.entries(rawGroups)) {
    const seen = new Set();
    filteredGroups[group] = [];
    for (const tag of tags) {
      if (!seen.has(tag) && !profile.banned.has(tag)) {
        seen.add(tag);
        filteredGroups[group].push(tag);
      }
    }
  }

  // ── Tag assembly in NovelAI semantic order ────────────────────────────────
  const allTags = assembleNAITags(quality.pos, filteredGroups, profile);

  // Sparse IR guard: if no body tags were produced, fall back to master prompt tokens
  const bodyCount = allTags.length - quality.pos.length;
  if (bodyCount === 0) {
    return naiFallback(masterPrompt, quality, model);
  }

  return {
    positive: allTags.join(', '),
    negative: quality.neg.join(', '),
  };
}
