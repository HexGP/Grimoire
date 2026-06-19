// sd-compiler.js — Stable Diffusion semantic ontology compiler
//
// This is NOT text rewriting. This is semantic latent activation through ontology tags.
//
// Pipeline:
//   IR → SD Semantic Extraction → Ontology Mapping → Model Filtering → Prompt Assembly
//
// Key principle: Stable Diffusion prompting is compressed visual semantic activation.
// DO NOT convert sentence fragments to underscored pseudo-tags.
// DO map semantic intent to valid ontology entries learned during model training.
//
// Tag ontology source: curated subset of Danbooru tag vocabulary.
// For production quality, validate against:
//   https://github.com/BetaDoggo/danbooru-tag-list

// ── Quality tags per model ────────────────────────────────────────────────────

const QUALITY = {
  pony_xl: {
    pos: ['score_9', 'score_8_up', 'score_7_up', 'score_6_up', 'source_anime'],
    neg: ['score_4', 'score_3', 'score_2', 'score_1', 'worst_quality', 'bad_quality',
          'lowres', 'bad_anatomy', 'bad_hands', 'text', 'error', 'cropped',
          'jpeg_artifacts', 'watermark', 'blurry', 'extra_limbs', 'missing_limb'],
  },
  sdxl: {
    pos: ['masterpiece', 'best_quality', 'highres', 'ultra-detailed'],
    neg: ['worst_quality', 'low_quality', 'lowres', 'bad_anatomy', 'bad_hands', 'text',
          'error', 'missing_fingers', 'extra_digit', 'fewer_digits', 'cropped',
          'jpeg_artifacts', 'signature', 'watermark', 'username', 'blurry'],
  },
  sd15: {
    // SD1.5 uses spaces, not underscores, in quality tags
    pos: ['masterpiece', 'best quality', 'highly detailed', '8k', 'sharp focus'],
    neg: ['worst quality', 'low quality', 'normal quality', 'lowres', 'bad anatomy',
          'bad hands', 'error', 'extra fingers', 'fewer digits', 'cropped',
          'jpeg artifacts', 'signature', 'watermark', 'text'],
  },
  illustrious: {
    pos: ['masterpiece', 'best_quality', 'newest', 'absurdres', 'highres', 'very_aesthetic'],
    neg: ['worst_quality', 'low_quality', 'bad_anatomy', 'bad_hands', 'text',
          'watermark', 'signature', 'worst_aesthetic', 'blurry'],
  },
  custom: {
    pos: [],
    neg: [],
  },
};

// ── Model capability profiles ─────────────────────────────────────────────────

const PROFILES = {
  pony_xl: {
    tagStyle:     'danbooru',   // Pure Danbooru ontology, no prose
    proseSupport: false,        // PonyXL learned from tag-only captions
    maxTags:      55,
    banned:       new Set(['photorealistic', 'photo_realistic', 'photography', 'realistic',
                            '3d_render', 'cg_art']),
    preferred:    ['anime_style', 'vibrant_colors', 'colorful'],
  },
  sdxl: {
    tagStyle:     'hybrid',     // Tags + optional prose footer
    proseSupport: true,         // SDXL benefits from natural-language prose
    maxTags:      40,
    banned:       new Set(['score_9', 'score_8_up', 'score_7_up', 'score_6_up', 'source_anime']),
    preferred:    ['intricate_detail', 'sharp_focus'],
  },
  sd15: {
    tagStyle:     'classic',    // Classic SD1.5: fewer tags, space-separated quality
    proseSupport: false,
    maxTags:      35,
    banned:       new Set(['score_9', 'score_8_up', 'score_7_up', 'multiple_panels', 'absurdres']),
    preferred:    [],
  },
  illustrious: {
    tagStyle:     'hybrid',
    proseSupport: true,         // Illustrious handles prose well
    maxTags:      50,
    banned:       new Set(['score_9', 'score_8_up', 'score_7_up']),
    preferred:    ['cinematic_composition', 'expressive', 'vibrant'],
  },
  custom: {
    tagStyle:     'hybrid',
    proseSupport: true,
    maxTags:      60,
    banned:       new Set(),
    preferred:    [],
  },
};

// ── Ontology registry ─────────────────────────────────────────────────────────
// Curated subset of valid Danbooru semantic tags, grouped by category.
// These are tags models have meaningfully learned during training.

// Subject count → valid Danbooru tags
const COUNT_ONTOLOGY = {
  1:        ['solo'],
  2:        ['multiple_people'],
  3:        ['multiple_people', 'group'],
  4:        ['multiple_people', 'group'],
  5:        ['multiple_people', 'group'],
  6:        ['multiple_people', 'group', '6+girls'],
  multiple: ['multiple_people', 'group'],
};

// Layout / panel structure → valid tags
const LAYOUT_ONTOLOGY = {
  multi_panel_comic: ['comic', 'multiple_panels', 'panel', 'manga_page', 'comic_page'],
  sequence:          ['sequential_art', 'multiple_views'],
  single_panel:      [],
  grid:              ['multiple_views', 'grid'],
};

// Shot type → valid Danbooru composition tags
const SHOT_ONTOLOGY = {
  low_angle:         ['from_below', 'upward_angle', 'worm\'s-eye_view'],
  dutch_angle:       ['dutch_angle'],
  over_the_shoulder: ['over_the_shoulder'],
  high_angle:        ['from_above', 'bird\'s-eye_view'],
  wide_establishing: ['from_distance', 'wide_shot'],
  close_up:          ['close-up', 'face_focus'],
  medium_shot:       ['upper_body'],
  extreme_close_up:  ['close-up', 'extreme_close-up'],
  two_shot:          ['looking_at_another'],
  group_shot:        ['group', 'full_body'],
  dynamic:           ['dynamic_angle', 'dynamic_pose', 'action'],
};

// Interaction type → valid Danbooru emotion/action tags
const INTERACTION_ONTOLOGY = {
  serious_discussion: ['talking', 'serious', 'looking_at_another', 'multiple_people', 'conversation'],
  battle:             ['fighting', 'battle', 'action', 'dynamic_pose', 'intense'],
  romance:            ['couple', 'looking_at_another', 'romantic', 'close_proximity'],
  exploration:        ['walking', 'looking_at_viewer', 'adventurer', 'outdoors'],
  confrontation:      ['confrontation', 'angry', 'tense_atmosphere', 'glaring'],
  rest:               ['sitting', 'resting', 'peaceful', 'calm'],
  celebration:        ['happy', 'smile', 'arms_up', 'joyful'],
};

// Mood/tone → valid Danbooru atmosphere tags
const TONE_ONTOLOGY = {
  cinematic:   ['cinematic_composition', 'dramatic_lighting'],
  tense:       ['tense_atmosphere', 'dramatic'],
  dramatic:    ['dramatic', 'dramatic_lighting'],
  epic:        ['epic', 'grand_scenery'],
  dark:        ['dark_atmosphere', 'moody'],
  mysterious:  ['mysterious', 'atmospheric', 'fog'],
  intense:     ['intense', 'dynamic'],
  melancholic: ['sad', 'melancholy', 'wistful'],
  peaceful:    ['peaceful', 'calm', 'serene'],
};

// Genre → valid Danbooru world/setting tags
const GENRE_ONTOLOGY = {
  fantasy:          ['fantasy', 'medieval', 'magic', 'fantasy_world'],
  sci_fi:           ['science_fiction', 'futuristic', 'technology', 'mecha'],
  horror:           ['horror', 'dark', 'monster', 'dark_atmosphere'],
  historical:       ['historical', 'period_costume', 'ancient', 'armor_(historical)'],
  modern:           ['contemporary', 'urban', 'city'],
  post_apocalyptic: ['post-apocalyptic', 'ruins', 'wasteland'],
  steampunk:        ['steampunk', 'gear', 'victorian'],
};

// Environment details → valid Danbooru location tags
const ENV_DETAIL_ONTOLOGY = {
  ruins:    ['ruins', 'crumbling_wall', 'ancient_ruins', 'stone_wall'],
  forest:   ['forest', 'nature', 'trees', 'outdoors', 'leaves'],
  castle:   ['castle', 'stone_wall', 'architecture', 'turret'],
  city:     ['city', 'buildings', 'urban', 'cityscape'],
  dungeon:  ['dungeon', 'cave', 'dark_room', 'underground'],
  field:    ['field', 'grass', 'outdoors', 'open_sky'],
  mountain: ['mountain', 'cliff', 'rocky_terrain', 'alpine'],
  ocean:    ['ocean', 'sea', 'beach', 'water', 'waves'],
  interior: ['indoors', 'room', 'interior'],
};

// Background presence → valid Danbooru background quality tags
const BACKGROUND_ONTOLOGY = ['detailed_background', 'complex_background'];

// Lighting → valid Danbooru lighting tags
const LIGHTING_ONTOLOGY = {
  volumetric: ['volumetric_lighting', 'light_particles', 'light_rays'],
  golden_hour:['sunlight', 'warm_light', 'sunset', 'golden_hour'],
  cinematic:  ['cinematic_lighting', 'dramatic_lighting'],
  dramatic:   ['dramatic_lighting', 'strong_shadow'],
  soft:       ['soft_lighting', 'ambient_light', 'diffuse_light'],
  neon:       ['neon_lights', 'neon', 'colorful_lighting'],
  moonlit:    ['moonlight', 'night', 'moon'],
  backlit:    ['backlighting', 'silhouette', 'rim_light'],
  rim_light:  ['rim_lighting', 'rim_light'],
};

// Style mode → valid Danbooru media/style tags
const STYLE_ONTOLOGY = {
  graphic_novel:   ['western_comics', 'comic_style', 'bold_lineart'],
  anime:           ['anime_style', 'manga_style'],
  photorealistic:  ['photorealistic', 'realistic'],
  oil_painting:    ['oil_painting_(medium)', 'painterly', 'traditional_media_(artwork)'],
  watercolor:      ['watercolor_(medium)', 'soft_colors', 'traditional_media_(artwork)'],
  concept_art:     ['concept_art', 'digital_media_(artwork)', 'illustration'],
  cinematic_still: ['cinematic', 'film_still', 'realistic'],
  illustration:    ['illustration', 'digital_media_(artwork)', 'colorful'],
  sketch:          ['sketch', 'pencil_sketch', 'traditional_media_(artwork)', 'monochrome'],
};

// Quality attributes → valid Danbooru tags
const QUALITY_ATTRIBUTE_ONTOLOGY = {
  high_detail:    ['intricate_detail', 'detailed'],
  depth_of_field: ['depth_of_field', 'bokeh', 'blurry_background'],
  high_resolution:['absurdres', 'highres'],
  premium:        ['professional', 'high_quality'],
};

// ── IR → Candidate tags ───────────────────────────────────────────────────────
// Exported so other compilers (e.g. NovelAI) can share the Danbooru IR→tags pass.

export function extractSDTags(ir) {
  const groups = {
    count:       [],
    layout:      [],
    composition: [],
    interaction: [],
    environment: [],
    lighting:    [],
    style:       [],
  };

  // Subject count
  if (ir.subjects?.count != null) {
    const countKey = typeof ir.subjects.count === 'number'
      ? Math.min(ir.subjects.count, 6)
      : ir.subjects.count;
    groups.count.push(...(COUNT_ONTOLOGY[countKey] ?? COUNT_ONTOLOGY.multiple));
  }

  // Layout / panels
  if (ir.layout?.type && LAYOUT_ONTOLOGY[ir.layout.type]) {
    groups.layout.push(...LAYOUT_ONTOLOGY[ir.layout.type]);
  }

  // Shot types → composition
  if (ir.composition?.preferredShots?.length) {
    for (const shot of ir.composition.preferredShots) {
      if (SHOT_ONTOLOGY[shot]) groups.composition.push(...SHOT_ONTOLOGY[shot]);
    }
    // If many shots, add dynamic composition tags
    if (ir.composition.preferredShots.length >= 3) {
      groups.composition.push('dynamic_angle', 'dynamic_composition');
    }
  }

  // Interaction type → character action tags
  if (ir.interaction?.type && INTERACTION_ONTOLOGY[ir.interaction.type]) {
    groups.interaction.push(...INTERACTION_ONTOLOGY[ir.interaction.type]);
  }

  // Tone → atmosphere/mood
  if (ir.interaction?.tone?.length) {
    for (const tone of ir.interaction.tone) {
      if (TONE_ONTOLOGY[tone]) groups.interaction.push(...TONE_ONTOLOGY[tone]);
    }
  }

  // Genre → world setting
  if (ir.environment?.genre && GENRE_ONTOLOGY[ir.environment.genre]) {
    groups.environment.push(...GENRE_ONTOLOGY[ir.environment.genre]);
  }

  // Environment details
  if (ir.environment?.details?.length) {
    for (const detail of ir.environment.details) {
      if (ENV_DETAIL_ONTOLOGY[detail]) groups.environment.push(...ENV_DETAIL_ONTOLOGY[detail]);
    }
  }

  // Background quality tags
  if (ir.environment?.backgrounds) {
    groups.environment.push(...BACKGROUND_ONTOLOGY);
  }

  // Lighting
  if (ir.lighting?.length) {
    for (const light of ir.lighting) {
      if (LIGHTING_ONTOLOGY[light]) groups.lighting.push(...LIGHTING_ONTOLOGY[light]);
    }
  }

  // Style
  if (ir.style?.mode && STYLE_ONTOLOGY[ir.style.mode]) {
    groups.style.push(...STYLE_ONTOLOGY[ir.style.mode]);
  }

  // Quality attributes
  if (ir.quality?.length) {
    for (const q of ir.quality) {
      if (QUALITY_ATTRIBUTE_ONTOLOGY[q]) groups.style.push(...QUALITY_ATTRIBUTE_ONTOLOGY[q]);
    }
  }

  return groups;
}

// ── Model-specific filtering ──────────────────────────────────────────────────

function filterByModel(groups, model) {
  const profile = PROFILES[model] ?? PROFILES.pony_xl;
  const filtered = {};

  for (const [group, tags] of Object.entries(groups)) {
    // Deduplicate within each group
    const seen = new Set();
    filtered[group] = [];
    for (const tag of tags) {
      if (!seen.has(tag) && !profile.banned.has(tag)) {
        seen.add(tag);
        filtered[group].push(tag);
      }
    }
  }

  return filtered;
}

// ── Prompt assembly ───────────────────────────────────────────────────────────
// Semantic ordering: quality → subject → layout → composition → interaction → environment → lighting → style

function assembleTags(qualityTags, filteredGroups, userTags, profile, model) {
  const sections = [
    filteredGroups.count,
    filteredGroups.layout,
    filteredGroups.composition,
    filteredGroups.interaction,
    filteredGroups.environment,
    filteredGroups.lighting,
    filteredGroups.style,
  ];

  // Flatten and deduplicate across all sections
  const allAutoTags = [];
  const seen = new Set();
  for (const section of sections) {
    for (const tag of section) {
      if (!seen.has(tag)) {
        seen.add(tag);
        allAutoTags.push(tag);
      }
    }
  }

  // Merge user-provided SD tags (skip duplicates and banned tags)
  const mergedUserTags = [];
  for (const tag of (userTags ?? [])) {
    const normalised = tag.trim();
    if (normalised && !seen.has(normalised) && !profile.banned.has(normalised)) {
      seen.add(normalised);
      mergedUserTags.push(normalised);
    }
  }

  // Respect maxTags limit (quality tags don't count toward limit)
  const bodyTags = [...allAutoTags, ...mergedUserTags].slice(0, profile.maxTags);

  return [...qualityTags, ...profile.preferred.filter(t => !seen.has(t)), ...bodyTags];
}

// ── Prose footer (SDXL / Illustrious only) ────────────────────────────────────

function buildProseFooter(ir) {
  const parts = [];

  const genreWord = ir.environment?.genre
    ? ir.environment.genre.replace(/_/g, ' ') + ' '
    : '';

  if (ir.layout?.type === 'multi_panel_comic') {
    parts.push(`Cinematic ${genreWord}comic page.`.replace(/\s+/g, ' ').trim());
  }

  if (ir.interaction?.type) {
    const actionMap = {
      serious_discussion: 'Characters engaged in a serious discussion.',
      battle:             'Dynamic battle scene with intense energy.',
      romance:            'Intimate romantic moment with emotional depth.',
      confrontation:      'Tense face-to-face confrontation.',
      exploration:        'Characters exploring a vast environment.',
    };
    const phrase = actionMap[ir.interaction.type];
    if (phrase) parts.push(phrase);
  }

  if (ir.subjects?.consistency === 'strict') {
    parts.push('Consistent character design throughout.');
  }

  return parts.join(' ');
}

// ── Main compiler ─────────────────────────────────────────────────────────────

export function compileStableDiffusion(ir, masterPrompt, settings = {}, userTags = []) {
  const model   = settings.model ?? 'pony_xl';
  const quality = QUALITY[model] ?? QUALITY.pony_xl;
  const profile = PROFILES[model] ?? PROFILES.pony_xl;

  // Extract semantic tags from IR
  const rawGroups = extractSDTags(ir);

  // Filter per model capabilities and banned tags
  const filteredGroups = filterByModel(rawGroups, model);

  // Assemble in semantic order
  const allTags = assembleTags(quality.pos, filteredGroups, userTags, profile, model);

  // Build positive prompt
  let positive = allTags.join(', ');

  // Append prose footer for hybrid-capable models
  if (profile.proseSupport) {
    const prose = buildProseFooter(ir);
    if (prose) positive = positive + '\n' + prose;
  }

  return {
    positive: positive || masterPrompt.trim(),
    negative: quality.neg.join(', '),
  };
}

// ── Fallback for prompts with minimal IR extraction ───────────────────────────
// Returns tags only when IR is too sparse to produce meaningful semantic output.

export function sdFallbackFromMaster(masterPrompt, model) {
  const quality = QUALITY[model] ?? QUALITY.pony_xl;

  // Extract only known-safe single words / common tags from the master prompt
  // by matching against a whitelist of valid Danbooru single-token tags.
  const SAFE_SINGLES = new Set([
    'solo', 'group', 'fantasy', 'ruins', 'forest', 'castle', 'dungeon', 'mountain',
    'ocean', 'indoors', 'outdoors', 'night', 'sunset', 'moonlight', 'sunlight',
    'serious', 'happy', 'sad', 'angry', 'talking', 'fighting', 'running', 'sitting',
    'comic', 'anime', 'fantasy', 'medieval', 'futuristic', 'ruins',
    'cinematic', 'dramatic', 'epic', 'dark', 'mysterious',
  ]);

  const words = masterPrompt.toLowerCase()
    .replace(/[^a-z0-9\s_]/g, ' ')
    .split(/\s+/)
    .filter(w => SAFE_SINGLES.has(w));

  const safeTags = [...new Set(words)].slice(0, 15);

  return {
    positive: [...quality.pos, ...safeTags].join(', ') || masterPrompt.trim(),
    negative: quality.neg.join(', '),
  };
}
