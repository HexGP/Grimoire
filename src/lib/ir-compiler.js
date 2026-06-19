// ir-compiler.js — Semantic Intent Representation (IR) extractor
// Deterministic, regex-based. No LLM required.
// Transforms a master prompt into a structured IR that all generator compilers consume.

// ── Subject / character patterns ─────────────────────────────────────────────

const SUBJECT_COUNT_PATTERNS = [
  { pattern: /\b(\d+)\s+character/i,                       group: 1 },
  { pattern: /\bgroup\s+of\s+(\d+)\b/i,                    group: 1 },
  { pattern: /\b(six|6)\s+(character|person|figure|subject|girl|boy|woman|man)s?\b/i,   count: 6 },
  { pattern: /\b(five|5)\s+(character|person|figure|subject|girl|boy|woman|man)s?\b/i,  count: 5 },
  { pattern: /\b(four|4)\s+(character|person|figure|subject|girl|boy|woman|man)s?\b/i,  count: 4 },
  { pattern: /\b(three|3)\s+(character|person|figure|subject|girl|boy|woman|man)s?\b/i, count: 3 },
  { pattern: /\b(two|2)\s+(character|person|figure|subject|girl|boy|woman|man)s?\b/i,   count: 2 },
  { pattern: /\b(one|1)\s+(character|person|figure|subject|girl|boy|woman|man)\b/i,     count: 1 },
  { pattern: /\bmultiple\s+(character|person|figure|subject)s?\b/i,                     count: 'multiple' },
];

const REFERENCE_IMAGE_PATTERNS = [
  /reference\s+image/i, /provided\s+character/i, /character\s+reference/i,
  /ref\s+image/i, /image\s+reference/i, /using\s+.{0,20}\s+reference/i,
  /provided\s+ref/i, /with\s+reference/i,
];

const CONSISTENCY_STRICT_PATTERNS = [
  /strict\s+consistency/i, /strictly\s+consistent/i, /exact\s+likeness/i,
  /character\s+consistency/i, /preserve\s+.{0,20}(face|likeness|appearance)/i,
  /consistent.{0,10}(across|throughout)\s+all\s+panel/i,
];
const CONSISTENCY_MODERATE_PATTERNS = [
  /maintain\s+consistency/i, /consistent\s+style/i, /same\s+character/i,
];

// ── Layout patterns ───────────────────────────────────────────────────────────

const LAYOUT_MAP = {
  multi_panel_comic: [
    /multi.panel/i, /comic\s+(page|panel|strip|layout)/i, /multiple\s+panel/i,
    /panel\s+layout/i, /comic\s+book/i, /storyboard/i, /panel\s+sequence/i,
    /comic\s+sequence/i, /panel\s+composition/i,
  ],
  sequence: [
    /sequence\s+of/i, /series\s+of\s+(image|panel|shot|scene)/i, /connected\s+scene/i,
  ],
  single_panel: [/single\s+panel/i, /one\s+panel/i],
  grid:         [/grid\s+layout/i, /image\s+grid/i, /tiled\s+layout/i],
};

const CONTINUITY_PATTERNS = {
  connected_scene: [
    /connected\s+scene/i, /continuous\s+scene/i, /same\s+scene/i,
    /same\s+setting/i, /continuity/i, /linked\s+panel/i,
  ],
  independent: [/independent\s+panel/i, /separate\s+scene/i],
};

// ── Shot / composition patterns ───────────────────────────────────────────────

const SHOT_MAP = {
  low_angle:         [/low.angle/i, /low\s+camera/i, /worm.?s?\s*eye/i, /looking\s+up\s+at/i],
  dutch_angle:       [/dutch.angle/i, /tilted\s+camera/i, /canted\s+frame/i, /diagonal\s+tilt/i],
  over_the_shoulder: [/over.the.shoulder/i, /ots\s+shot/i, /behind.*shoulder/i, /shoulder\s+framing/i],
  high_angle:        [/high.angle/i, /bird.?s?\s*eye/i, /overhead\s+shot/i, /top.down/i, /aerial\s+view/i],
  wide_establishing: [/wide\s+(shot|establishing)/i, /establishing\s+(shot|scene)/i, /long\s+shot/i, /environment\s+shot/i],
  close_up:          [/close.up/i, /closeup/i, /face\s+shot/i, /emotional\s+framing/i, /tight\s+shot/i],
  medium_shot:       [/medium\s+shot/i, /mid.shot/i, /waist\s+shot/i, /mid.range\s+shot/i],
  extreme_close_up:  [/extreme\s+close.up/i, /ecu\s+shot/i, /macro\s+shot/i],
  two_shot:          [/two.shot/i, /2.shot/i, /pair\s+shot/i],
  group_shot:        [/group\s+shot/i, /ensemble\s+shot/i, /all\s+character\s+shot/i],
  dynamic:           [/dynamic\s+(angle|shot|camera|composition)/i, /cinematic\s+angle/i],
};

const AVOID_MAP = {
  flat_front_view:             [/avoid.*flat/i, /no\s+flat/i, /flat.*front/i, /avoid.*front.facing/i],
  static_centered_composition: [/avoid.*static/i, /no\s+static/i, /avoid.*centered\s+comp/i],
  text_in_image:               [/no\s+text/i, /avoid\s+text/i, /without\s+text\s+in/i],
};

const COMPOSITION_STYLE_MAP = {
  dynamic_cinematic: [/dynamic\s+cinematic/i, /cinematic.*dynamic/i, /cinematic.*composition/i, /dynamic.*perspective/i],
  rule_of_thirds:    [/rule\s+of\s+thirds/i],
  diagonal:          [/diagonal\s+composition/i, /diagonal\s+framing/i, /dramatic\s+diagonal/i],
  symmetrical:       [/symmetrical\s+composition/i, /symmetric/i],
};

// ── Interaction / emotion patterns ────────────────────────────────────────────

const INTERACTION_MAP = {
  serious_discussion: [
    /serious\s+(discussion|conversation|talk)/i, /important\s+discussion/i,
    /intense\s+(talk|conversation|exchange)/i, /urgent\s+conversation/i,
  ],
  battle:         [/battle|fight\s+scene|combat|clash|duel|skirmish|war\s+scene/i],
  romance:        [/romance|romantic|love\s+scene|embrace|kiss|tender\s+moment/i],
  exploration:    [/explor/i, /adventur(?:ing|ous)|journey|quest|travel/i],
  rest:           [/resting|relaxing|sleeping|at\s+peace|quiet\s+moment/i],
  celebration:    [/celebrat|festival|party\s+scene|joy|triumphant/i],
  confrontation:  [/confront|standoff|stare.?down|tense\s+face.to.face/i],
};

const TONE_MAP = {
  cinematic:   [/cinematic/i],
  tense:       [/tense|tension|suspense/i],
  dramatic:    [/dramatic/i],
  epic:        [/epic/i],
  melancholic: [/melanchol|somber|forlorn|bleak/i],
  hopeful:     [/hopeful|optimist/i],
  mysterious:  [/mysteri/i],
  dark:        [/\bdark\b/i, /grim(?!\s+oire)/i, /ominous/i],
  intense:     [/intense|fervent/i],
  peaceful:    [/peaceful|serene|tranquil/i],
};

// ── Environment patterns ──────────────────────────────────────────────────────

const GENRE_MAP = {
  fantasy:          [/\bfantasy\b/i, /\bmagical\b/i, /sorcery|wizard|mage|elf|elven|dwarv/i],
  sci_fi:           [/sci.fi|science\s+fiction|futuristic|space\s+(station|ship)|cyberpunk|mech/i],
  horror:           [/horror|haunted|zombie|monster|demonic|hellscape/i],
  historical:       [/historical|medieval|ancient\s+(?!ruin)|renaissance|victorian|samurai|feudal/i],
  modern:           [/modern\s+day|contemporary|urban\s+setting|city\s+street/i],
  post_apocalyptic: [/post.apocalyptic|wasteland|ruins\s+of\s+civilization/i],
  steampunk:        [/steampunk/i],
};

const ENV_DETAIL_MAP = {
  ruins:    [/ruins?/i, /ruined\s+(castle|city|temple|wall)/i, /crumbling/i],
  forest:   [/forest|woods|jungle|woodland|grove/i],
  castle:   [/castle|fortress|citadel|stronghold|palace/i],
  city:     [/city(?:scape)?|town|village|urban(?!\s+setting)/i],
  dungeon:  [/dungeon|cave|cavern|underground\s+chamber/i],
  field:    [/field|meadow|plains|grassland|open\s+plain/i],
  mountain: [/mountain|cliff|peak|summit|highland/i],
  ocean:    [/ocean|sea|beach|coast|shore/i],
  interior: [/interior|indoor|inside|chamber|great\s+hall/i],
};

const BACKGROUND_PRESENT_PATTERNS = [
  /with\s+(background|environment|setting)/i,
  /\w+\s+background/i,
  /detailed\s+environment/i,
  /environmental\s+storytelling/i,
  /set\s+in\s+/i,
  /located\s+in\s+/i,
  /fantasy\s+(ruins|forest|city|castle|world)/i,
  /rich\s+background/i,
  /atmospheric\s+background/i,
];

// ── Style patterns ────────────────────────────────────────────────────────────

const STYLE_MAP = {
  graphic_novel:   [/graphic\s+novel/i, /comic\s+art\s+style/i, /comic\s+book\s+style/i],
  anime:           [/\banime\b/i, /\bmanga\b/i, /jrpg\s+style/i],
  photorealistic:  [/photorealistic|photo.realistic|hyperrealistic/i],
  oil_painting:    [/oil\s+paint/i],
  watercolor:      [/watercolou?r/i],
  concept_art:     [/concept\s+art/i, /production\s+art/i],
  cinematic_still: [/cinematic\s+still/i, /film\s+still/i, /movie\s+frame/i],
  illustration:    [/\billustration\b/i, /illustrated/i, /book\s+illustration/i],
  sketch:          [/\bsketch\b/i, /line\s+art/i, /\blineart\b/i],
};

// ── Lighting patterns ─────────────────────────────────────────────────────────

const LIGHTING_MAP = {
  volumetric: [/volumetric\s+light/i, /god\s+rays?/i, /light\s+shaft/i],
  golden_hour:[/golden\s+hour/i, /magic\s+hour/i, /sunset\s+light/i],
  cinematic:  [/cinematic\s+lighting/i, /film\s+lighting/i],
  dramatic:   [/dramatic\s+lighting/i, /high.contrast\s+light/i],
  soft:       [/soft\s+light/i, /diffuse\s+light/i, /ambient\s+light/i],
  neon:       [/neon\s+light/i, /neon.lit/i],
  moonlit:    [/moonlit|moonlight|night\s+scene/i],
  backlit:    [/backlit|back.light|silhouette\s+light/i],
  rim_light:  [/rim\s+light/i, /edge\s+light/i],
};

// ── Quality / render patterns ─────────────────────────────────────────────────

const QUALITY_MAP = {
  high_detail:    [/highly\s+detailed|high\s+detail|intricate\s+detail/i],
  depth_of_field: [/depth\s+of\s+field|\bdof\b|bokeh/i],
  high_resolution:[/high.res(?:olution)?|4k|8k|ultra.detailed|sharp\s+focus/i],
  premium:        [/premium|high.budget|professional\s+grade/i],
};

// ── Reference image detection ─────────────────────────────────────────────────

const REF_INTENT_PATTERNS = [
  /\b(use|using|take|with|attach|attached|provided|provide|given|based on|refer(?:ring)?\s+to)\b.{0,50}\b(image|photo|picture|ref(?:erence)?|character\s+sheet)\b/i,
  /\bimage\s+[1-9]\b/i,
  /\bthese\s+(image|photo|character|reference)s?\b/i,
  /\bthe\s+(attached|provided|given|uploaded)\b/i,
  /\breference\s+(image|photo|character|sheet)\b/i,
  /\bcharacter\s+(sheet|reference|ref)\b/i,
  /\bkeep\s+the\s+same\s+(face|outfit|style|design|character)\b/i,
  /\bmatch\s+the\s+style\s+of\b/i,
  /\bcombine\s+these\b/i,
  /\bmerge\s+these\b/i,
  /\buse.*as\s+(reference|ref)\b/i,
];

const REF_TYPE_PATTERNS = {
  character:     [/\bcharacter\b/i, /\bperson\b/i, /\bface\b/i, /\bportrait\b/i, /\bhero\b/i, /\bprotagonist\b/i, /\bfigure\b/i],
  style:         [/\bstyle\b/i, /\baesthetic\b/i, /\bvibe\b/i, /\bmatch\s+the\s+style\b/i, /\bvisual\s+style\b/i],
  pose:          [/\bpose\b/i, /\bposition\b/i, /\bstance\b/i, /\bgesture\b/i, /\bbody\s+language\b/i],
  background:    [/\bbackground\b/i, /\benvironment\b/i, /\blandscape\b/i, /\binterior\b/i],
  outfit:        [/\boutfit\b/i, /\bclothing\b/i, /\bcostume\b/i, /\battire\b/i, /\bwearing\b/i],
  composition:   [/\bcomposition\b/i, /\blayout\b/i, /\bpanel\s+layout\b/i, /\bframing\b/i],
  color_palette: [/\bcolor\s+palette\b/i, /\bcolou?r\s+scheme\b/i],
  object:        [/\bobject\b/i, /\bprop\b/i, /\bweapon\b/i, /\bitem\b/i],
};

const REF_MODE_PATTERNS = {
  preserve:  [/\bkeep\s+the\s+same\b/i, /\bpreserve\b/i, /\bmaintain\s+consistency\b/i, /\bdo\s+not\s+change\b/i, /\bdon.t\s+(change|alter|redesign)\b/i, /\bidentical\b/i, /\bconsistent\b/i, /\bretain\b/i, /\bexact\s+(same|likeness)\b/i],
  inspire:   [/\binspired\s+by\b/i, /\bsimilar\s+to\b/i, /\buse\s+as\s+(mood|vibe)\b/i, /\bin\s+the\s+spirit\s+of\b/i],
  transform: [/\bturn\s+.{0,20}\s+into\b/i, /\bconvert\b/i, /\btransform\b/i, /\bstylize\b/i, /\bmake.*anime\b/i, /\bmake.*fantasy\b/i],
  combine:   [/\bcombine\s+these\b/i, /\bmerge\s+these\b/i, /\bblend\s+these\b/i, /\bput\s+together\b/i],
  layout:    [/\buse.*this\s+pose\b/i, /\buse.*this\s+angle\b/i, /\bsame\s+pose\b/i, /\bsame\s+composition\b/i],
};

const REF_PRESERVE_PATTERNS = {
  face:        [/\bface\b/i, /\bfacial\b/i, /\bfeatures\b/i],
  outfit:      [/\boutfit\b/i, /\bclothing\b/i, /\bcostume\b/i],
  silhouette:  [/\bsilhouette\b/i],
  proportions: [/\bproportions?\b/i],
  style:       [/\bstyle\b/i, /\bstylization\b/i],
  color:       [/\bcolor\s+palette\b/i, /\bcolou?r\b/i],
  identity:    [/\bidentity\b/i, /\blikeness\b/i, /\bcharacter\s+design\b/i],
};

function extractRefCount(text) {
  // Count distinct "image N" references — highest N is the count
  const imgNums = [...text.matchAll(/\bimage\s+([1-9])\b/gi)];
  if (imgNums.length >= 2) {
    return Math.max(...imgNums.map(m => parseInt(m[1], 10)));
  }
  // Word/digit count patterns
  const WORD_COUNTS = [
    { p: /\b(eight|8)\s+(image|photo|ref|character)/i,  n: 8 },
    { p: /\b(seven|7)\s+(image|photo|ref|character)/i,  n: 7 },
    { p: /\b(six|6)\s+(image|photo|ref|character)/i,    n: 6 },
    { p: /\b(five|5)\s+(image|photo|ref|character)/i,   n: 5 },
    { p: /\b(four|4)\s+(image|photo|ref|character)/i,   n: 4 },
    { p: /\b(three|3)\s+(image|photo|ref|character)/i,  n: 3 },
    { p: /\b(two|2)\s+(image|photo|ref|character)/i,    n: 2 },
  ];
  for (const { p, n } of WORD_COUNTS) { if (p.test(text)) return n; }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchAny(text, patterns) {
  return patterns.some(p => p.test(text));
}

function matchMap(text, map) {
  const found = [];
  for (const [key, patterns] of Object.entries(map)) {
    if (matchAny(text, patterns)) found.push(key);
  }
  return found;
}

function extractCount(text) {
  for (const entry of SUBJECT_COUNT_PATTERNS) {
    if (entry.group) {
      const m = text.match(entry.pattern);
      if (m) return parseInt(m[entry.group], 10);
    } else if (entry.pattern.test(text)) {
      return entry.count;
    }
  }
  return null;
}

// ── Main IR extractor ─────────────────────────────────────────────────────────

export function extractIR(masterPrompt) {
  const text = masterPrompt;
  const ir = { task: 'image_generation' };

  // ── Subjects ─────────────────────────────────────────────────────────────────
  const subjectCount  = extractCount(text);
  const hasRefImages  = matchAny(text, REFERENCE_IMAGE_PATTERNS);
  const strictConsist = matchAny(text, CONSISTENCY_STRICT_PATTERNS);
  const modConsist    = matchAny(text, CONSISTENCY_MODERATE_PATTERNS);
  const consistLevel  = strictConsist ? 'strict' : (modConsist || hasRefImages) ? 'moderate' : null;

  const subjectData = {};
  if (subjectCount !== null) subjectData.count = subjectCount;
  if (hasRefImages) subjectData.source = 'reference_images';
  if (consistLevel) subjectData.consistency = consistLevel;
  if (Object.keys(subjectData).length) ir.subjects = subjectData;

  // ── Layout ────────────────────────────────────────────────────────────────────
  const layoutTypes = matchMap(text, LAYOUT_MAP);
  const layoutType  = layoutTypes[0] ?? 'single_image';
  const continuityTypes = matchMap(text, CONTINUITY_PATTERNS);
  const continuity  = continuityTypes[0] ?? null;

  if (layoutType !== 'single_image' || continuity) {
    ir.layout = { type: layoutType };
    if (continuity) ir.layout.continuity = continuity;
  }

  // ── Interaction ───────────────────────────────────────────────────────────────
  const interactionTypes = matchMap(text, INTERACTION_MAP);
  const tones            = matchMap(text, TONE_MAP);

  if (interactionTypes.length || tones.length) {
    ir.interaction = {};
    if (interactionTypes[0]) ir.interaction.type = interactionTypes[0];
    if (tones.length) ir.interaction.tone = tones;
  }

  // ── Composition ───────────────────────────────────────────────────────────────
  const shots            = matchMap(text, SHOT_MAP);
  const avoidList        = matchMap(text, AVOID_MAP);
  const compStyles       = matchMap(text, COMPOSITION_STYLE_MAP);
  const compStyle        = compStyles[0] ?? (shots.length >= 3 ? 'dynamic_cinematic' : null);

  const compData = {};
  if (compStyle)       compData.style          = compStyle;
  if (shots.length)    compData.preferredShots = shots;
  if (avoidList.length) compData.avoid         = avoidList;
  if (Object.keys(compData).length) ir.composition = compData;

  // ── Environment ───────────────────────────────────────────────────────────────
  const genres     = matchMap(text, GENRE_MAP);
  const envDetails = matchMap(text, ENV_DETAIL_MAP);
  const hasBg      = matchAny(text, BACKGROUND_PRESENT_PATTERNS) || genres.length > 0 || envDetails.length > 0;

  if (genres.length || hasBg || envDetails.length) {
    ir.environment = {};
    if (genres[0]) ir.environment.genre = genres[0];
    if (envDetails.length) ir.environment.details = envDetails;
    if (hasBg) ir.environment.backgrounds = true;
  }

  // ── Style ─────────────────────────────────────────────────────────────────────
  const styles = matchMap(text, STYLE_MAP);
  if (styles.length) {
    ir.style = { mode: styles[0] };
    if (styles.length > 1) ir.style.secondary = styles.slice(1);
    if (consistLevel) ir.style.consistency = consistLevel;
  }

  // ── Lighting ──────────────────────────────────────────────────────────────────
  const lighting = matchMap(text, LIGHTING_MAP);
  if (lighting.length) ir.lighting = lighting;

  // ── Quality ───────────────────────────────────────────────────────────────────
  const quality = matchMap(text, QUALITY_MAP);
  if (quality.length) ir.quality = quality;

  // ── Reference images ──────────────────────────────────────────────────────────
  const refIntent = matchAny(text, REF_INTENT_PATTERNS);
  if (refIntent) {
    const refs = { intent: true };

    // How many reference images are mentioned
    const refCount = extractRefCount(text);
    if (refCount) refs.count = refCount;

    // What types of references
    const types = Object.entries(REF_TYPE_PATTERNS)
      .filter(([, patterns]) => matchAny(text, patterns))
      .map(([k]) => k);
    if (types.length) refs.types = types;

    // Reference mode (what to do with the reference)
    for (const [mode, patterns] of Object.entries(REF_MODE_PATTERNS)) {
      if (matchAny(text, patterns)) { refs.mode = mode; break; }
    }

    // Which attributes to preserve (relevant for preserve mode)
    const preserve = Object.entries(REF_PRESERVE_PATTERNS)
      .filter(([, patterns]) => matchAny(text, patterns))
      .map(([k]) => k);
    if (preserve.length) refs.preserve = preserve;

    ir.references = refs;
  }

  return ir;
}
