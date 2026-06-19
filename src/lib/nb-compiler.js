// nb-compiler.js — Nano Banana compiler ecosystem
// One compiler, two modes:
//   nano_banana_base — compact, tag-oriented, anime/comic-token-focused
//   nano_banana_pro  — cinematic prose + structured shot tags + continuity language

// ── Tag vocabulary ────────────────────────────────────────────────────────────

const SHOT_TAGS = {
  low_angle:         'low angle shot',
  dutch_angle:       'dutch angle',
  over_the_shoulder: 'over-the-shoulder shot',
  high_angle:        'high angle shot',
  wide_establishing: 'wide establishing shot',
  close_up:          'close-up emotional framing',
  medium_shot:       'medium shot',
  extreme_close_up:  'extreme close-up',
  two_shot:          'two-shot',
  group_shot:        'group shot',
  dynamic:           'dynamic cinematic angles',
};

const INTERACTION_TAGS = {
  serious_discussion: ['serious discussion', 'intense expressions', 'eye contact', 'natural interaction'],
  battle:             ['combat scene', 'dynamic action', 'intense energy', 'battle poses'],
  romance:            ['romantic scene', 'intimate moment', 'emotional connection', 'tender expressions'],
  exploration:        ['exploration', 'adventurous', 'curious expressions'],
  confrontation:      ['tense confrontation', 'dramatic standoff', 'intense eye contact'],
  rest:               ['quiet moment', 'peaceful scene', 'reflective atmosphere'],
  celebration:        ['celebration scene', 'joyful energy', 'triumphant mood'],
};

const TONE_TAGS = {
  cinematic:   'cinematic',
  tense:       'dramatic tension',
  dramatic:    'dramatic',
  epic:        'epic scale',
  dark:        'dark atmosphere',
  mysterious:  'mysterious atmosphere',
  intense:     'intense atmosphere',
  melancholic: 'melancholic mood',
  peaceful:    'peaceful atmosphere',
};

const GENRE_TAGS = {
  fantasy:          'fantasy setting',
  sci_fi:           'sci-fi setting',
  horror:           'dark horror setting',
  historical:       'historical setting',
  modern:           'modern urban setting',
  post_apocalyptic: 'post-apocalyptic setting',
  steampunk:        'steampunk setting',
};

const ENV_DETAIL_TAGS = {
  ruins:    'fantasy ruins background',
  forest:   'forest background',
  castle:   'castle background',
  city:     'city background',
  dungeon:  'dungeon background',
  field:    'open field background',
  mountain: 'mountain background',
  ocean:    'ocean background',
  interior: 'interior setting',
};

const STYLE_TAGS = {
  graphic_novel:   'graphic novel style',
  anime:           'anime style',
  concept_art:     'concept art style',
  photorealistic:  'photorealistic',
  cinematic_still: 'cinematic film still',
  illustration:    'illustration style',
  oil_painting:    'oil painting style',
  watercolor:      'watercolor style',
};

// ── Reference block builders ──────────────────────────────────────────────────

const REF_ROLE_SHORT = {
  character_reference:    'character ref',
  style_reference:        'style ref',
  pose_reference:         'pose ref',
  background_reference:   'background ref',
  composition_reference:  'composition ref',
  color_palette_reference:'color palette ref',
  outfit_reference:       'outfit ref',
  object_reference:       'object ref',
  scene_reference:        'scene ref',
};

function buildNBBaseRefTags(ir, imageRefs) {
  const tags = [];
  const hasLabeled = imageRefs?.length > 0;
  const irRefs = ir.references;
  if (!hasLabeled && !irRefs?.intent) return tags;

  if (hasLabeled) {
    const charRefs = imageRefs.filter(r => r.role === 'character_reference');
    const otherRefs = imageRefs.filter(r => r.role !== 'character_reference');
    if (charRefs.length) {
      tags.push(`${charRefs.length} character reference${charRefs.length > 1 ? 's' : ''}`);
      tags.push('preserve character identity', 'character design consistency');
      charRefs.forEach((r, i) => {
        const label = r.label?.trim() || `Character ${i + 1}`;
        tags.push(`${label} - character ref`);
      });
      if (charRefs.length > 1) tags.push('separate character designs', 'no character merging');
    }
    otherRefs.forEach((r, i) => {
      const label = r.label?.trim() || `Ref ${imageRefs.indexOf(r) + 1}`;
      const roleShort = REF_ROLE_SHORT[r.role] ?? r.role?.replace(/_/g, ' ') ?? 'reference';
      tags.push(`${label} - ${roleShort}`);
    });
  } else if (irRefs?.intent) {
    const types = irRefs.types ?? ['character'];
    if (types.includes('character')) {
      tags.push('character reference consistency');
      if (irRefs.count && irRefs.count > 1) {
        tags.push(`${irRefs.count} character references`, 'separate character identities');
      }
    }
    if (types.includes('style'))      tags.push('style reference match');
    if (types.includes('background')) tags.push('background reference');
    if (types.includes('pose'))       tags.push('pose reference');
  }
  return tags;
}

function buildNBProRefBlock(ir, imageRefs) {
  const hasLabeled = imageRefs?.length > 0;
  const irRefs = ir.references;
  if (!hasLabeled && !irRefs?.intent) return null;

  const lines = [];

  if (hasLabeled) {
    const charRefs = imageRefs.filter(r => r.role === 'character_reference');
    if (charRefs.length) {
      lines.push('Preserve the identity, outfit, silhouette, color palette, and stylization of each referenced character.');
      lines.push('Keep each character visually distinct — do not blend or merge character designs.');
      if (charRefs.length > 1) {
        charRefs.forEach((r, i) => {
          const label = r.label?.trim() || `Character ${i + 1}`;
          lines.push(`- ${label}: use Image ${imageRefs.indexOf(r) + 1} as the character identity reference.`);
        });
      }
    }
    imageRefs.filter(r => r.role !== 'character_reference').forEach((r, i) => {
      const label = r.label?.trim() || `Image ${imageRefs.indexOf(r) + 1}`;
      const roleShort = REF_ROLE_SHORT[r.role] ?? 'reference';
      const mode = r.mode ?? 'preserve';
      const modePhrase = mode === 'inspire'
        ? `Use ${label} as ${roleShort} inspiration — match its spirit and aesthetic.`
        : `Use ${label} as ${roleShort} — match it closely.`;
      lines.push(`- ${modePhrase}`);
    });
  } else if (irRefs?.intent) {
    const types = irRefs.types ?? ['character'];
    const count = irRefs.count;
    if (types.includes('character')) {
      lines.push('Preserve the identity, outfit, silhouette, color palette, and stylization of each referenced character.');
      if (count && count > 1) {
        lines.push(`Keep all ${count} characters visually distinct — do not blend or merge their designs.`);
      }
    }
    if (types.includes('style'))  lines.push('Match the visual style and artistic treatment of the provided style reference.');
    if (types.includes('background')) lines.push('Use the provided background reference to define the setting and atmosphere.');
  }

  return lines.length ? `Reference handling:\n${lines.join('\n')}` : null;
}

// ── Nano Banana Base ──────────────────────────────────────────────────────────
// Compact, tag-oriented. Optimized for anime/comic token vocabularies.

function compileNBBase(ir, masterPrompt, imageRefs = []) {
  const tags = [];

  // Reference tags (inserted first — most important signal)
  const refTags = buildNBBaseRefTags(ir, imageRefs);
  if (refTags.length) tags.push(...refTags);

  // Layout
  if (ir.layout?.type === 'multi_panel_comic') tags.push('multi-panel comic page');
  else if (ir.layout?.type === 'sequence')     tags.push('sequential panels');

  // Genre / environment
  if (ir.environment?.genre) {
    tags.push(GENRE_TAGS[ir.environment.genre] ?? (ir.environment.genre.replace(/_/g, ' ') + ' setting'));
  }
  if (ir.environment?.details?.length) {
    ir.environment.details.slice(0, 2).forEach(d => {
      tags.push(ENV_DETAIL_TAGS[d] ?? (d.replace(/_/g, ' ') + ' background'));
    });
  }

  // Subjects
  if (ir.subjects?.count)                   tags.push(`${ir.subjects.count} characters`);
  if (ir.subjects?.source === 'reference_images' && !tags.includes('character reference consistency'))
    tags.push('character reference consistency');
  if (ir.subjects?.consistency === 'strict') tags.push('strict character consistency');

  // Interaction
  if (ir.interaction?.type) {
    const interTags = INTERACTION_TAGS[ir.interaction.type] ?? [ir.interaction.type.replace(/_/g, ' ')];
    tags.push(...interTags.slice(0, 3));
  }

  // Composition / shots
  if (ir.composition?.preferredShots?.length) {
    tags.push('dynamic cinematic angles');
    ir.composition.preferredShots.slice(0, 5).forEach(s => {
      if (SHOT_TAGS[s]) tags.push(SHOT_TAGS[s]);
    });
  }

  // Tone
  if (ir.interaction?.tone?.length) {
    ir.interaction.tone.slice(0, 2).forEach(t => {
      if (TONE_TAGS[t]) tags.push(TONE_TAGS[t]);
    });
  }

  // Lighting
  if (ir.lighting?.length) {
    if (ir.lighting.includes('volumetric')) tags.push('volumetric light');
    if (ir.lighting.includes('cinematic'))  tags.push('cinematic lighting');
    if (ir.lighting.includes('dramatic'))   tags.push('dramatic lighting');
  }

  // Quality
  if (ir.quality?.includes('depth_of_field')) tags.push('depth of field');

  // Style
  if (ir.style?.mode) tags.push(STYLE_TAGS[ir.style.mode] ?? ir.style.mode.replace(/_/g, ' '));

  // Always add dynamic composition if not already present
  if (!tags.includes('dynamic composition')) tags.push('dynamic composition');

  // Fallback: if IR produced very little, extract from master prompt directly
  if (tags.length < 4) {
    return masterPrompt
      .replace(/[.!?;]/g, ',')
      .replace(/\b(a|an|the|with|and|in|on|of|by|to)\b/gi, ' ')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 2)
      .join(', ') || masterPrompt.trim();
  }

  return [...new Set(tags)].join(', ');
}

// ── Nano Banana Pro ───────────────────────────────────────────────────────────
// More cinematic, more atmospheric, more continuity-focused.
// Combines structured shot tags with cinematic prose blocks.

const PRO_INTERACTION_BODY = {
  serious_discussion:
    'Their body language should convey tension, urgency, eye contact, and natural interaction. Alternate between intimate two-character exchanges and wider group panels.',
  battle:
    'Their postures and expressions should convey dynamic energy, fierce determination, and cinematic impact. Vary between action-packed wide shots and intense close-up reactions.',
  romance:
    'Their body language should convey warmth, intimacy, and emotional depth. Mix tender close-up framing with gentle wider compositions.',
  exploration:
    'Composition should emphasize scale, wonder, and the characters\' relationship with the environment. Mix wide shots with close-up reactions.',
  confrontation:
    'Their body language should convey resolve, threat, and dramatic emotional stakes. Use tension-building framing and strategic negative space.',
  rest:
    'The scene should breathe — quiet compositions, soft framing, and an emphasis on mood and introspective atmosphere.',
  celebration:
    'Energy should feel joyful and cinematic — dynamic group compositions balanced with individual emotional close-ups.',
};

function compileNBPro(ir, masterPrompt, imageRefs = []) {
  const blocks = [];
  const hasRefs = imageRefs.length > 0 || ir.references?.intent;

  // ── Opening block ─────────────────────────────────────────────────────────
  const genrePart = ir.environment?.genre ? ir.environment.genre.replace(/_/g, ' ') + ' ' : '';
  const refPart   = hasRefs ? 'using the provided reference images' : (
    ir.subjects?.source === 'reference_images' ? 'using the provided character references' : ''
  );

  if (ir.layout?.type === 'multi_panel_comic') {
    blocks.push(
      `Create a cinematic ${genrePart}comic sequence ${refPart}.`
        .replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim()
    );
  } else {
    blocks.push(
      `Create a cinematic ${genrePart}scene ${refPart} with atmospheric visual storytelling.`
        .replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim()
    );
  }

  // ── Reference handling block ──────────────────────────────────────────────
  const refBlock = buildNBProRefBlock(ir, imageRefs);
  if (refBlock) {
    blocks.push(`\n${refBlock}`);
  } else if (ir.subjects?.consistency === 'strict') {
    blocks.push(
      '\nPreserve strict character consistency across all panels: faces, outfits, silhouettes, proportions, color palette, and stylization.'
    );
  }

  // ── Panel language block (tag section) ────────────────────────────────────
  const panelTags = [];
  if (ir.layout?.type === 'multi_panel_comic') panelTags.push('multi-panel comic page');
  if (ir.composition?.preferredShots?.length) {
    panelTags.push('dynamic cinematic angles');
    ir.composition.preferredShots.forEach(s => {
      if (SHOT_TAGS[s] && !panelTags.includes(SHOT_TAGS[s])) panelTags.push(SHOT_TAGS[s]);
    });
  }
  if (panelTags.length) {
    blocks.push(`\nPanel language: ${panelTags.join(', ')}.`);
  }

  // ── Character / interaction block ─────────────────────────────────────────
  if (ir.interaction?.type) {
    const typeLabel = ir.interaction.type.replace(/_/g, ' ');
    const bodyDesc  = PRO_INTERACTION_BODY[ir.interaction.type] ?? '';
    blocks.push(`\nThe characters are engaged in a ${typeLabel}. ${bodyDesc}`.trim());
  }

  // ── Visual style block (tag section) ──────────────────────────────────────
  const visualTags = [];

  if (ir.style?.mode)                          visualTags.push(STYLE_TAGS[ir.style.mode] ?? ir.style.mode.replace(/_/g, ' '));
  if (ir.environment?.genre)                   visualTags.push(`atmospheric ${ir.environment.genre.replace(/_/g, ' ')} background`);
  if (ir.environment?.details?.length) {
    ir.environment.details.slice(0, 2).forEach(d => {
      const tag = ENV_DETAIL_TAGS[d] ?? (d.replace(/_/g, ' ') + ' background');
      if (!visualTags.includes(tag)) visualTags.push(tag);
    });
  }
  if (ir.lighting?.includes('volumetric'))     visualTags.push('volumetric lighting');
  if (ir.lighting?.includes('cinematic'))      visualTags.push('cinematic lighting');
  if (ir.lighting?.includes('dramatic'))       visualTags.push('dramatic lighting');
  if (ir.quality?.includes('depth_of_field'))  visualTags.push('depth of field');
  visualTags.push('dramatic composition', 'detailed environmental storytelling', 'cohesive visual continuity');

  if (visualTags.length) {
    blocks.push(`\nVisual style: ${[...new Set(visualTags)].join(', ')}.`);
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  if (blocks.length <= 1) {
    return masterPrompt.replace(/\s+/g, ' ').trim();
  }

  return blocks.join(' ').replace(/  +/g, ' ').replace(/ \n/g, '\n').trim();
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export function compileNanoBanana(ir, masterPrompt, settings = {}) {
  const model     = settings.model ?? 'nano_banana_base';
  const imageRefs = settings.imageRefs ?? [];
  return model === 'nano_banana_pro'
    ? compileNBPro(ir, masterPrompt, imageRefs)
    : compileNBBase(ir, masterPrompt, imageRefs);
}
