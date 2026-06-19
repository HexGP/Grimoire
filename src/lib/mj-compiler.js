// ── MidJourney Prompt Compiler ────────────────────────────────────────────────
// Deterministic, LLM-free. Extracts visual concepts from a master prompt,
// maps them to canonical MidJourney keyword phrases, assembles them in
// semantic order, and sanitizes the final output.

// ── Category registry ─────────────────────────────────────────────────────────
// Canonical MJ-friendly phrases organized by semantic category.
// Extend any bucket to add new vocabulary the compiler can emit.

export const MJ_REGISTRY = {
  subject: [
    'portrait', 'character', 'figure', 'person', 'warrior', 'creature',
    'silhouette', 'couple', 'group', 'crowd', 'robot', 'animal',
    'conversation scene', 'two characters', 'single figure',
  ],
  action: [
    'standing', 'sitting', 'running', 'walking', 'speaking', 'looking',
    'fighting', 'reaching', 'falling', 'flying', 'resting', 'confronting',
    'embracing', 'expressive character acting',
  ],
  scene: [
    'interior', 'exterior', 'urban', 'landscape', 'forest', 'desert', 'ocean',
    'city street', 'room', 'battlefield', 'hallway', 'rooftop', 'alley', 'ruins',
    'cafe', 'office', 'school', 'courtyard', 'corridor', 'conversation scene',
  ],
  composition: [
    'rule of thirds', 'centered composition', 'asymmetrical composition',
    'layered depth', 'foreground interest', 'off-axis composition',
    'leading lines', 'negative space', 'symmetrical composition',
  ],
  perspective: [
    'over-the-shoulder', 'low-angle', 'high-angle', "worm's-eye view",
    "bird's-eye view", 'eye-level', 'Dutch angle', 'isometric', 'aerial view',
    'ground-level',
  ],
  camera: [
    'shallow depth of field', 'deep depth of field', 'foreground blur',
    'foreground silhouette blur', 'speaking character in focus', 'bokeh',
    'soft background blur', 'rack focus', 'wide angle', 'telephoto',
    'macro', 'fish-eye', 'anamorphic lens', 'cinematic framing', 'dynamic angle',
  ],
  framing: [
    'close-up', 'extreme close-up', 'medium shot', 'wide shot', 'full body',
    'half body', 'bust shot', 'head shot', 'waist-up framing', 'chest-up framing',
    'three-quarter view', 'full-length portrait',
  ],
  lighting: [
    'cinematic lighting', 'dramatic lighting', 'soft lighting', 'rim lighting',
    'backlit', 'golden hour', 'natural light', 'studio lighting',
    'volumetric lighting', 'god rays', 'low-key lighting', 'high-key lighting',
    'neon lighting', 'candlelight', 'moonlight', 'diffused lighting',
    'harsh shadows',
  ],
  color: [
    'grayscale', 'monochrome', 'black and white', 'muted tones', 'high contrast',
    'soft tonal separation', 'warm palette', 'cool palette', 'desaturated',
    'vibrant colors', 'pastel palette', 'earth tones', 'neon accents',
    'sepia', 'duotone',
  ],
  mood: [
    'emotional', 'tense', 'intimate', 'dramatic', 'quiet', 'melancholic',
    'mysterious', 'hopeful', 'ominous', 'peaceful', 'joyful', 'sorrowful',
    'suspenseful', 'nostalgic', 'romantic',
  ],
  atmosphere: [
    'atmospheric', 'foggy', 'misty', 'hazy', 'smoky', 'dusty',
    'ethereal', 'oppressive', 'expansive', 'claustrophobic', 'serene',
  ],
  style: [
    'Korean webtoon style', 'Japanese manga style', 'cinematic storyboard',
    'semi-realistic illustration', 'animated drama style', 'concept art',
    'comic panel style', 'graphic novel style', 'anime style',
    'photorealistic', 'hyperrealistic', 'painterly', 'impressionistic',
    'surrealist', 'minimalist', 'noir style', 'art nouveau',
  ],
  genre: [
    'fantasy', 'sci-fi', 'horror', 'romance', 'action', 'thriller',
    'cyberpunk', 'steampunk', 'post-apocalyptic', 'historical', 'slice of life',
  ],
  artMedium: [
    'oil painting', 'watercolor', 'ink illustration', 'charcoal sketch',
    'digital painting', 'pencil drawing', 'gouache', 'cel shading', '3D render',
  ],
  render: [
    'controlled linework', 'soft painterly shading', 'clean silhouettes',
    'polished composition', 'clean rendering', 'professional illustration',
    'smooth gradients', 'hard edges', 'loose brushwork',
  ],
  texture: [
    'rough texture', 'smooth surface', 'grainy', 'glossy', 'matte finish',
    'fabric texture', 'weathered surface',
  ],
  material: [
    'metal', 'glass', 'fabric', 'stone', 'wood', 'leather', 'fur',
    'plastic', 'liquid', 'crystal',
  ],
  era: [
    'contemporary', 'futuristic', 'medieval', 'Victorian era', 'ancient',
    '1920s', '1950s', '1980s', '1990s', 'feudal Japan',
  ],
  culturalInfluence: [
    'Korean', 'Japanese', 'Chinese', 'European', 'Nordic', 'South Asian',
  ],
  time: [
    'daytime', 'night', 'dusk', 'dawn', 'midday', 'twilight', 'midnight',
    'early morning', 'late afternoon',
  ],
  season: ['spring', 'summer', 'autumn', 'winter'],
  weather: ['clear sky', 'overcast', 'rainy', 'stormy', 'snowy', 'foggy', 'windy'],
  movement: [
    'static', 'dynamic pose', 'flowing', 'frozen motion', 'motion blur',
    'action pose', 'relaxed pose', 'tense pose',
  ],
  scale: ['epic scale', 'intimate scale', 'grand landscape', 'monumental', 'human scale'],
  levelOfDetail: [
    'highly detailed', 'intricate detail', 'minimalist', 'simplified',
    'broad strokes', 'ultra-detailed',
  ],
  detailConstraints: [
    'minimal detail', 'simplified clothing', 'large clean shapes',
    'broad tonal separation', 'no micro-detail', 'no noisy textures',
    'no busy background', 'clean composition',
  ],
  anatomyConstraints: [
    'believable anatomy', 'natural proportions', 'subtle facial expression',
    'clean hands', 'symmetrical eyes',
  ],
  negatives: [
    'no text', 'no logos', 'no symbols', 'no watermarks', 'no clutter',
    'no warped anatomy', 'no distorted face', 'no malformed hands',
    'no floating objects', 'no broken perspective', 'no speech bubbles',
    'no borders', 'no signature',
  ],
};

// ── Category output order ─────────────────────────────────────────────────────
// Controls the semantic flow of the assembled MJ prompt.

const CATEGORY_ORDER = [
  'subject', 'action', 'scene', 'genre', 'era', 'culturalInfluence',
  'perspective', 'framing', 'camera', 'composition',
  'lighting', 'time', 'season', 'weather', 'atmosphere',
  'color', 'mood', 'movement', 'scale',
  'style', 'artMedium', 'render', 'texture', 'material',
  'levelOfDetail', 'detailConstraints', 'anatomyConstraints', 'negatives',
];

// ── Concept map ───────────────────────────────────────────────────────────────
// Maps natural language patterns (from master prompt) to canonical MJ phrases.
// Longer / more specific patterns must come before generic overlaps.
// `value` may be comma-separated to emit multiple phrases into one bucket.

const CONCEPT_MAP = [
  // ── Subject / Action ───────────────────────────────────────────────────────
  { pattern: /conversation\s+scene|two\s+characters?\s+(?:talking|speaking|discussing)/i,   maps: 'scene',       value: 'conversation scene' },
  { pattern: /expressive\s+(?:character\s+)?acting/i,                                        maps: 'action',      value: 'expressive character acting' },
  { pattern: /speaking\s+character|character\s+speaking/i,                                   maps: 'camera',      value: 'speaking character in focus' },

  // ── Perspective ────────────────────────────────────────────────────────────
  { pattern: /framed?\s+from\s+behind|over[\s-]+(?:the[\s-]+)?shoulder|behind\s+(?:one|a|the)?\s*character/i, maps: 'perspective', value: 'over-the-shoulder' },
  { pattern: /low[\s-]+angle/i,                    maps: 'perspective', value: 'low-angle' },
  { pattern: /high[\s-]+angle/i,                   maps: 'perspective', value: 'high-angle' },
  { pattern: /worm['s]*[\s-]+eye/i,                maps: 'perspective', value: "worm's-eye view" },
  { pattern: /bird['s]*[\s-]+eye|aerial\s+view/i,  maps: 'perspective', value: "bird's-eye view" },
  { pattern: /dutch[\s-]+angle|canted\s+angle/i,   maps: 'perspective', value: 'Dutch angle' },
  { pattern: /isometric/i,                         maps: 'perspective', value: 'isometric' },
  { pattern: /\beye[\s-]+level\b/i,                maps: 'perspective', value: 'eye-level' },

  // ── Framing ────────────────────────────────────────────────────────────────
  { pattern: /extreme\s+close[\s-]+up/i,           maps: 'framing', value: 'extreme close-up' },
  { pattern: /close[\s-]+up/i,                     maps: 'framing', value: 'close-up' },
  { pattern: /wide\s+shot/i,                       maps: 'framing', value: 'wide shot' },
  { pattern: /medium\s+shot/i,                     maps: 'framing', value: 'medium shot' },
  { pattern: /full[\s-]+body|full\s+figure/i,      maps: 'framing', value: 'full body' },
  { pattern: /waist[\s-]+up/i,                     maps: 'framing', value: 'waist-up framing' },
  { pattern: /chest[\s-]+up/i,                     maps: 'framing', value: 'chest-up framing' },
  { pattern: /bust[\s-]+shot/i,                    maps: 'framing', value: 'bust shot' },
  { pattern: /three[\s-]+quarter/i,                maps: 'framing', value: 'three-quarter view' },
  { pattern: /\bportrait\b/i,                      maps: 'framing', value: 'close-up' },

  // ── Camera / DOF ───────────────────────────────────────────────────────────
  { pattern: /foreground\s+silhouette/i,            maps: 'camera', value: 'foreground silhouette blur' },
  { pattern: /shallow\s+(?:depth\s+of\s+field|dof)/i, maps: 'camera', value: 'shallow depth of field' },
  { pattern: /foreground\s+(?:blur|bokeh)/i,        maps: 'camera', value: 'foreground blur' },
  { pattern: /\bbokeh\b/i,                          maps: 'camera', value: 'bokeh' },
  { pattern: /soft\s+background\s+blur/i,           maps: 'camera', value: 'soft background blur' },
  { pattern: /anamorphic/i,                         maps: 'camera', value: 'anamorphic lens' },
  { pattern: /fish[\s-]?eye\s+lens/i,               maps: 'camera', value: 'fish-eye' },
  { pattern: /telephoto/i,                          maps: 'camera', value: 'telephoto' },
  { pattern: /cinematic\s+framing/i,                maps: 'camera', value: 'cinematic framing' },
  { pattern: /dynamic\s+angle/i,                    maps: 'camera', value: 'dynamic angle' },

  // ── Composition ────────────────────────────────────────────────────────────
  { pattern: /rule\s+of\s+thirds/i,                 maps: 'composition', value: 'rule of thirds' },
  { pattern: /layered\s+depth/i,                    maps: 'composition', value: 'layered depth' },
  { pattern: /negative\s+space/i,                   maps: 'composition', value: 'negative space' },
  { pattern: /leading\s+lines/i,                    maps: 'composition', value: 'leading lines' },
  { pattern: /asymmetric/i,                         maps: 'composition', value: 'asymmetrical composition' },
  { pattern: /off[\s-]+axis/i,                      maps: 'composition', value: 'off-axis composition' },
  { pattern: /foreground\s+interest/i,              maps: 'composition', value: 'foreground interest' },

  // ── Lighting ───────────────────────────────────────────────────────────────
  { pattern: /golden\s+hour/i,                      maps: 'lighting', value: 'golden hour' },
  { pattern: /volumetric\s+light/i,                 maps: 'lighting', value: 'volumetric lighting' },
  { pattern: /god\s+rays/i,                         maps: 'lighting', value: 'god rays' },
  { pattern: /rim[\s-]+light/i,                     maps: 'lighting', value: 'rim lighting' },
  { pattern: /back[\s-]?lit/i,                      maps: 'lighting', value: 'backlit' },
  { pattern: /low[\s-]?key\s+light/i,               maps: 'lighting', value: 'low-key lighting' },
  { pattern: /high[\s-]?key\s+light/i,              maps: 'lighting', value: 'high-key lighting' },
  { pattern: /dramatic\s+light/i,                   maps: 'lighting', value: 'dramatic lighting' },
  { pattern: /cinematic\s+light/i,                  maps: 'lighting', value: 'cinematic lighting' },
  { pattern: /soft\s+light/i,                       maps: 'lighting', value: 'soft lighting' },
  { pattern: /natural\s+light/i,                    maps: 'lighting', value: 'natural light' },
  { pattern: /studio\s+light/i,                     maps: 'lighting', value: 'studio lighting' },
  { pattern: /candle[\s-]?light/i,                  maps: 'lighting', value: 'candlelight' },
  { pattern: /neon\s+light/i,                       maps: 'lighting', value: 'neon lighting' },
  { pattern: /diffuse[d]?\s+light/i,                maps: 'lighting', value: 'diffused lighting' },
  { pattern: /moonlight/i,                          maps: 'lighting', value: 'moonlight' },
  { pattern: /harsh\s+shadow/i,                     maps: 'lighting', value: 'harsh shadows' },

  // ── Color ──────────────────────────────────────────────────────────────────
  { pattern: /grayscale|gr[ae]y[\s-]?scale/i,       maps: 'color', value: 'grayscale' },
  { pattern: /\bmonochrome\b/i,                      maps: 'color', value: 'monochrome' },
  { pattern: /black\s+and\s+white/i,                 maps: 'color', value: 'black and white' },
  { pattern: /muted\s+(?:tones?|colou?rs?|palette)/i, maps: 'color', value: 'muted tones' },
  { pattern: /high\s+contrast/i,                    maps: 'color', value: 'high contrast' },
  { pattern: /soft\s+tonal/i,                       maps: 'color', value: 'soft tonal separation' },
  { pattern: /warm\s+(?:tones?|colou?rs?|palette)/i, maps: 'color', value: 'warm palette' },
  { pattern: /cool\s+(?:tones?|colou?rs?|palette)/i, maps: 'color', value: 'cool palette' },
  { pattern: /\bvibrant\b/i,                         maps: 'color', value: 'vibrant colors' },
  { pattern: /\bpastel\b/i,                          maps: 'color', value: 'pastel palette' },
  { pattern: /\bsepia\b/i,                           maps: 'color', value: 'sepia' },
  { pattern: /desaturat/i,                           maps: 'color', value: 'desaturated' },
  { pattern: /earth\s+tones?/i,                      maps: 'color', value: 'earth tones' },
  { pattern: /duotone/i,                             maps: 'color', value: 'duotone' },

  // ── Mood ───────────────────────────────────────────────────────────────────
  { pattern: /\bemotional\b/i,                       maps: 'mood', value: 'emotional' },
  { pattern: /\btense\b|\btension\b/i,               maps: 'mood', value: 'tense' },
  { pattern: /\bintimate\b/i,                        maps: 'mood', value: 'intimate' },
  { pattern: /\bdramatic\b/i,                        maps: 'mood', value: 'dramatic' },
  { pattern: /\bquiet\b|\bcalm\b|\bpeaceful\b/i,    maps: 'mood', value: 'quiet' },
  { pattern: /melanchol/i,                           maps: 'mood', value: 'melancholic' },
  { pattern: /mysterious|mystery/i,                  maps: 'mood', value: 'mysterious' },
  { pattern: /\bhopeful\b/i,                         maps: 'mood', value: 'hopeful' },
  { pattern: /\bominous\b/i,                         maps: 'mood', value: 'ominous' },
  { pattern: /nostalgic|nostalgia/i,                 maps: 'mood', value: 'nostalgic' },
  { pattern: /\bromantic\b/i,                        maps: 'mood', value: 'romantic' },
  { pattern: /suspenseful/i,                         maps: 'mood', value: 'suspenseful' },
  { pattern: /\bsorrowful\b|\bsad\b/i,               maps: 'mood', value: 'sorrowful' },

  // ── Atmosphere ─────────────────────────────────────────────────────────────
  { pattern: /\bfoggy\b|\bfog\b/i,                  maps: 'atmosphere', value: 'foggy' },
  { pattern: /\bmisty\b|\bmist\b/i,                  maps: 'atmosphere', value: 'misty' },
  { pattern: /\bsmoky\b|\bsmoke\b/i,                 maps: 'atmosphere', value: 'smoky' },
  { pattern: /\bethereal\b/i,                        maps: 'atmosphere', value: 'ethereal' },
  { pattern: /\batmospheric\b/i,                     maps: 'atmosphere', value: 'atmospheric' },
  { pattern: /\bhazy\b|\bhaze\b/i,                   maps: 'atmosphere', value: 'hazy' },
  { pattern: /\bdusty\b/i,                           maps: 'atmosphere', value: 'dusty' },

  // ── Style ──────────────────────────────────────────────────────────────────
  { pattern: /korean\s+webtoon/i,                    maps: 'style', value: 'Korean webtoon style' },
  { pattern: /\bwebtoon\b/i,                         maps: 'style', value: 'Korean webtoon style' },
  { pattern: /\bmanga[\s-]?inspired\b|\bjapanese\s+manga\b/i, maps: 'style', value: 'Japanese manga style' },
  { pattern: /\banime\b/i,                           maps: 'style', value: 'anime style' },
  { pattern: /\bstoryboard\b/i,                      maps: 'style', value: 'cinematic storyboard' },
  { pattern: /semi[\s-]?realistic/i,                 maps: 'style', value: 'semi-realistic illustration' },
  { pattern: /concept\s+art/i,                       maps: 'style', value: 'concept art' },
  { pattern: /comic\s+(?:panel|style|book)/i,        maps: 'style', value: 'comic panel style' },
  { pattern: /graphic\s+novel/i,                     maps: 'style', value: 'graphic novel style' },
  { pattern: /photoreali/i,                          maps: 'style', value: 'photorealistic' },
  { pattern: /hyperreali/i,                          maps: 'style', value: 'hyperrealistic' },
  { pattern: /\bpainterly\b/i,                       maps: 'style', value: 'painterly' },
  { pattern: /\bnoir\b/i,                            maps: 'style', value: 'noir style' },
  { pattern: /art\s+nouveau/i,                       maps: 'style', value: 'art nouveau' },
  { pattern: /\bminimali[sz]/i,                      maps: 'style', value: 'minimalist' },
  { pattern: /impressionis/i,                        maps: 'style', value: 'impressionistic' },
  { pattern: /\bsurreali[sz]/i,                      maps: 'style', value: 'surrealist' },
  { pattern: /animated\s+drama/i,                    maps: 'style', value: 'animated drama style' },

  // ── Art Medium ─────────────────────────────────────────────────────────────
  { pattern: /oil\s+paint/i,                         maps: 'artMedium', value: 'oil painting' },
  { pattern: /watercolou?r/i,                        maps: 'artMedium', value: 'watercolor' },
  { pattern: /ink\s+(?:illustration|drawing|art)/i,  maps: 'artMedium', value: 'ink illustration' },
  { pattern: /\bcharcoal\b/i,                        maps: 'artMedium', value: 'charcoal sketch' },
  { pattern: /digital\s+paint/i,                     maps: 'artMedium', value: 'digital painting' },
  { pattern: /pencil\s+(?:drawing|sketch|art)/i,     maps: 'artMedium', value: 'pencil drawing' },
  { pattern: /3d\s+render/i,                         maps: 'artMedium', value: '3D render' },
  { pattern: /cel[\s-]?shad/i,                       maps: 'artMedium', value: 'cel shading' },
  { pattern: /\bgouache\b/i,                         maps: 'artMedium', value: 'gouache' },

  // ── Render ─────────────────────────────────────────────────────────────────
  { pattern: /controlled?\s+line(?:work|art)/i,      maps: 'render', value: 'controlled linework' },
  { pattern: /painterly\s+shad/i,                    maps: 'render', value: 'soft painterly shading' },
  { pattern: /clean\s+silhouette/i,                  maps: 'render', value: 'clean silhouettes' },
  { pattern: /clean\s+render/i,                      maps: 'render', value: 'clean rendering' },
  { pattern: /smooth\s+gradient/i,                   maps: 'render', value: 'smooth gradients' },
  { pattern: /polished\s+(?:composition|frame|render)/i, maps: 'render', value: 'polished composition' },

  // ── Genre ──────────────────────────────────────────────────────────────────
  { pattern: /\bcyberpunk\b/i,                       maps: 'genre', value: 'cyberpunk' },
  { pattern: /\bsteampunk\b/i,                       maps: 'genre', value: 'steampunk' },
  { pattern: /\bfantasy\b/i,                         maps: 'genre', value: 'fantasy' },
  { pattern: /sci[\s-]?fi|science\s+fiction/i,       maps: 'genre', value: 'sci-fi' },
  { pattern: /\bhorror\b/i,                          maps: 'genre', value: 'horror' },
  { pattern: /post[\s-]?apocalyptic/i,               maps: 'genre', value: 'post-apocalyptic' },
  { pattern: /slice\s+of\s+life/i,                   maps: 'genre', value: 'slice of life' },
  { pattern: /\bthriller\b/i,                        maps: 'genre', value: 'thriller' },

  // ── Era ────────────────────────────────────────────────────────────────────
  { pattern: /feudal\s+japan/i,                      maps: 'era', value: 'feudal Japan' },
  { pattern: /\bvictorian\b/i,                       maps: 'era', value: 'Victorian era' },
  { pattern: /\bmedieval\b/i,                        maps: 'era', value: 'medieval' },
  { pattern: /\bfuturistic\b/i,                      maps: 'era', value: 'futuristic' },
  { pattern: /contemporary|modern[\s-]+day/i,        maps: 'era', value: 'contemporary' },
  { pattern: /\b1920s?\b/i,                          maps: 'era', value: '1920s' },
  { pattern: /\b1950s?\b/i,                          maps: 'era', value: '1950s' },
  { pattern: /\b1980s?\b/i,                          maps: 'era', value: '1980s' },
  { pattern: /\b1990s?\b/i,                          maps: 'era', value: '1990s' },

  // ── Time / Season / Weather ────────────────────────────────────────────────
  { pattern: /\bnigh?t\b/i,                          maps: 'time', value: 'night' },
  { pattern: /\bdawn\b/i,                            maps: 'time', value: 'dawn' },
  { pattern: /\bdusk\b/i,                            maps: 'time', value: 'dusk' },
  { pattern: /\bmidday\b|\bnoon\b/i,                 maps: 'time', value: 'midday' },
  { pattern: /\btwilight\b/i,                        maps: 'time', value: 'twilight' },
  { pattern: /\bmidnight\b/i,                        maps: 'time', value: 'midnight' },
  { pattern: /early\s+morning/i,                     maps: 'time', value: 'early morning' },
  { pattern: /late\s+afternoon/i,                    maps: 'time', value: 'late afternoon' },
  { pattern: /\bautumn\b|\bfall\b/i,                 maps: 'season', value: 'autumn' },
  { pattern: /\bwinter\b/i,                          maps: 'season', value: 'winter' },
  { pattern: /\bspring\b/i,                          maps: 'season', value: 'spring' },
  { pattern: /\bsummer\b/i,                          maps: 'season', value: 'summer' },
  { pattern: /\brainy?\b|\brain\b/i,                 maps: 'weather', value: 'rainy' },
  { pattern: /\bsnow/i,                              maps: 'weather', value: 'snowy' },
  { pattern: /\bstorm/i,                             maps: 'weather', value: 'stormy' },
  { pattern: /overcast|cloudy/i,                     maps: 'weather', value: 'overcast' },

  // ── Movement ───────────────────────────────────────────────────────────────
  { pattern: /motion\s+blur/i,                       maps: 'movement', value: 'motion blur' },
  { pattern: /action\s+pose/i,                       maps: 'movement', value: 'action pose' },
  { pattern: /frozen\s+motion|stopped\s+motion/i,    maps: 'movement', value: 'frozen motion' },
  { pattern: /dynamic\s+pos/i,                       maps: 'movement', value: 'dynamic pose' },
  { pattern: /\bflowing\b/i,                         maps: 'movement', value: 'flowing' },

  // ── Detail constraints ─────────────────────────────────────────────────────
  { pattern: /minimal\s+detail/i,                    maps: 'detailConstraints', value: 'minimal detail' },
  { pattern: /simplif(?:ied|y)\s+cloth/i,            maps: 'detailConstraints', value: 'simplified clothing' },
  { pattern: /large\s+clean\s+shapes?/i,             maps: 'detailConstraints', value: 'large clean shapes' },
  { pattern: /broad\s+tonal/i,                       maps: 'detailConstraints', value: 'broad tonal separation' },
  { pattern: /no\s+(?:busy|complex)\s+background/i,  maps: 'detailConstraints', value: 'no busy background' },
  { pattern: /no\s+(?:noisy|cluttered)\s+textures?/i, maps: 'detailConstraints', value: 'no noisy textures' },
  { pattern: /no\s+(?:tiny|micro|small)\s+(?:symbol|detail|pattern|texture)/i, maps: 'detailConstraints', value: 'no micro-detail' },
  { pattern: /no\s+(?:embroidery|micro[\s-]?pattern)/i, maps: 'detailConstraints', value: 'no micro-detail' },
  { pattern: /clean\s+(?:shape|form|outline)/i,      maps: 'detailConstraints', value: 'large clean shapes' },

  // ── Anatomy constraints ────────────────────────────────────────────────────
  { pattern: /believable\s+anatomy|correct\s+anatomy/i, maps: 'anatomyConstraints', value: 'believable anatomy' },
  { pattern: /natural\s+proportion/i,                maps: 'anatomyConstraints', value: 'natural proportions' },
  { pattern: /subtle\s+(?:facial\s+)?expression/i,   maps: 'anatomyConstraints', value: 'subtle facial expression' },
  { pattern: /clean\s+hands/i,                       maps: 'anatomyConstraints', value: 'clean hands' },

  // ── Negatives (things to exclude) ─────────────────────────────────────────
  // Compound "avoid small symbols/logos/text" → expands to multiple negatives
  { pattern: /avoid\s+(?:tiny|small|micro)\s+(?:symbol|logo|text|embroidery|pattern)/i, maps: 'negatives', value: 'no text, no logos, no symbols, no micro-detail' },
  { pattern: /no\s+text|avoid\s+text/i,              maps: 'negatives', value: 'no text' },
  { pattern: /no\s+logos?|avoid\s+logos?/i,          maps: 'negatives', value: 'no logos' },
  { pattern: /no\s+symbols?|avoid\s+symbols?/i,      maps: 'negatives', value: 'no symbols' },
  { pattern: /no\s+watermarks?/i,                    maps: 'negatives', value: 'no watermarks' },
  { pattern: /no\s+clutter|avoid\s+clutter/i,        maps: 'negatives', value: 'no clutter' },
  { pattern: /no\s+(?:warped|distorted)\s+anatomy/i, maps: 'negatives', value: 'no warped anatomy' },
  { pattern: /no\s+(?:distorted|warped)\s+face/i,    maps: 'negatives', value: 'no distorted face' },
  { pattern: /no\s+(?:malformed|broken)\s+hands/i,   maps: 'negatives', value: 'no malformed hands' },
  { pattern: /no\s+floating/i,                       maps: 'negatives', value: 'no floating objects' },
  { pattern: /no\s+broken\s+perspective/i,           maps: 'negatives', value: 'no broken perspective' },
  { pattern: /no\s+speech\s+bubble/i,                maps: 'negatives', value: 'no speech bubbles' },
  { pattern: /no\s+(?:borders?|frames?)/i,           maps: 'negatives', value: 'no borders' },
];

// ── Valid MidJourney parameter names ─────────────────────────────────────────
const MJ_PARAM_NAMES = new Set([
  'ar', 'v', 'niji', 'style', 'stylize', 's', 'chaos', 'c', 'no', 'quality', 'q',
  'seed', 'stop', 'tile', 'weird', 'w', 'iw', 'cw', 'sw', 'video', 'fast',
  'relax', 'turbo', 'p', 'sref', 'cref', 'hr',
]);

// ── Concept detector ──────────────────────────────────────────────────────────

function detectConcepts(text) {
  const buckets = {};
  const seen = new Set();

  for (const { pattern, maps, value } of CONCEPT_MAP) {
    if (!pattern.test(text)) continue;
    const values = value.split(',').map(v => v.trim()).filter(Boolean);
    for (const v of values) {
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      (buckets[maps] ??= []).push(v);
    }
  }

  return buckets;
}

// ── Fallback cleaner (no concepts detected) ───────────────────────────────────
// Strips stop words and prose structure. Still preserves compound terms
// by only removing whole words, not substrings.

const STOP_WORDS = /\b(a|an|the|and|or|but|with|featuring|showing|that|which|in|on|at|to|of|by|from|through|using|having|very|really|quite|just|is|are|was|were|will|would|should|could|may|might|have|has|had|do|does|did|be|been|being|it|its|this|these|those|as|if|then|so|for|while|when|where|who|whom|whose|what|how|whether)\b/gi;

function fallbackClean(text) {
  return text
    .replace(/[.!?;]+/g, ',')
    .split(',')
    .map(chunk =>
      chunk
        .replace(STOP_WORDS, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
    )
    .filter(s => s.length > 2)
    .join(', ');
}

// ── Sanitizer ─────────────────────────────────────────────────────────────────

// Compound hyphen repair table — maps broken variants back to canonical forms.
const HYPHEN_REPAIRS = [
  [/over[-\s]*[-\s]*(?:the[-\s]*)?shoulder/gi,    'over-the-shoulder'],
  [/low[-\s]*[-\s]*angle/gi,                       'low-angle'],
  [/high[-\s]*[-\s]*angle/gi,                      'high-angle'],
  [/bird['s]*[-\s]*[-\s]*eye/gi,                   "bird's-eye view"],
  [/worm['s]*[-\s]*[-\s]*eye/gi,                   "worm's-eye view"],
  [/depth[-\s]+of[-\s]+field/gi,                   'depth of field'],
  [/(\w+)-\s+-(\w+)/g,                             '$1-$2'],  // "over- -shoulder" → "over-shoulder"
  [/(\w)-\s+(\w)/g,                                '$1-$2'],  // "fore- ground" (no second dash)
];

function splitBodyAndParams(raw) {
  // Find the first occurrence of a valid MJ param (--paramname)
  const re = /\s(--([a-z]+))\b/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (MJ_PARAM_NAMES.has(m[2])) {
      return [raw.slice(0, m.index).trim(), raw.slice(m.index).trim()];
    }
  }
  return [raw.trim(), ''];
}

function dedupeParams(paramStr) {
  if (!paramStr) return '';
  // Split on whitespace before each --
  const tokens = paramStr.trim().split(/(?=\s--)/);
  const seen = new Set();
  return tokens
    .map(t => t.trim())
    .filter(t => {
      const name = t.match(/^--([a-z]+)/)?.[1];
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .join(' ');
}

export function sanitizeMidjourneyPrompt(raw) {
  let [body, params] = splitBodyAndParams(raw);

  // Repair broken compound hyphen terms
  for (const [re, replacement] of HYPHEN_REPAIRS) {
    body = body.replace(re, replacement);
  }

  // Remove accidental standalone -- in body (not a param)
  // Only remove if it's not followed by a letter (which would make it look like a param)
  body = body.replace(/\s--(?![a-zA-Z])/g, ' ');

  // Normalize commas and whitespace
  body = body
    .replace(/\s*,\s*/g, ', ')
    .replace(/,{2,}/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*$/, '')
    .trim();

  // Deduplicate phrases (case-insensitive)
  const seen = new Set();
  body = body
    .split(/,\s+/)
    .filter(p => {
      const k = p.toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(', ');

  params = dedupeParams(params);

  return (params ? `${body} ${params}` : body).replace(/\s{2,}/g, ' ').trim();
}

// ── Param builder ─────────────────────────────────────────────────────────────

function buildParams({ version = 'v6_1', aspectRatio = '16:9', style = 'raw', stylize = 100 }) {
  const isNiji = version === 'niji6';
  const vNum = version.replace(/^v/, '').replace(/_/g, '.');
  return [
    `--ar ${aspectRatio}`,
    isNiji ? '--niji 6' : `--v ${vNum}`,
    !isNiji && style && style !== 'none' ? `--style ${style}` : '',
    stylize !== 100 ? `--stylize ${stylize}` : '',
  ].filter(Boolean).join(' ');
}

// ── Main compiler ─────────────────────────────────────────────────────────────

export function compileMidjourney(masterPrompt, settings = {}) {
  const buckets = detectConcepts(masterPrompt);

  // Assemble in semantic order, deduplicating across categories
  const emitted = new Set();
  const parts = [];
  for (const cat of CATEGORY_ORDER) {
    for (const phrase of (buckets[cat] ?? [])) {
      const k = phrase.toLowerCase();
      if (!emitted.has(k)) {
        emitted.add(k);
        parts.push(phrase);
      }
    }
  }

  const body = parts.length > 0 ? parts.join(', ') : fallbackClean(masterPrompt);
  const params = buildParams(settings);

  return sanitizeMidjourneyPrompt(`${body} ${params}`);
}
