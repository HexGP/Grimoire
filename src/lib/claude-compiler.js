// claude-compiler.js — Claude AI image prompt compiler
// Claude performs best with: clear hierarchy, explicit constraints, precise reference roles,
// clean instruction language, minimal repetition, no tag spam.
// Output is logically structured — each section has one job.

// ── Label maps ────────────────────────────────────────────────────────────────

const SHOT_LABELS = {
  low_angle:         'low-angle framing',
  dutch_angle:       'Dutch angle',
  over_the_shoulder: 'over-the-shoulder framing',
  high_angle:        'high-angle views',
  wide_establishing: 'wide establishing shots',
  close_up:          'close-up emotional framing',
  medium_shot:       'medium shots',
  extreme_close_up:  'extreme close-ups',
  two_shot:          'two-character shots',
  group_shot:        'group ensemble shots',
  dynamic:           'dynamic cinematic angles',
};

const AVOID_LABELS = {
  flat_front_view:             'flat front-facing compositions',
  static_centered_composition: 'static centered shots',
  text_in_image:               'text embedded in the image',
};

const INTERACTION_DESCRIPTIONS = {
  serious_discussion: 'a serious and important discussion. Their body language, eye contact, and expressions should convey tension, urgency, and interpersonal weight.',
  battle:             'intense combat. Their postures and expressions should convey dynamic impact and fierce determination.',
  romance:            'an intimate and emotionally resonant moment. Body language should convey warmth, vulnerability, and genuine connection.',
  exploration:        'exploring their environment with curiosity and purpose. Composition should emphasize the scale of the world around them.',
  confrontation:      'a tense face-to-face confrontation. Their stances should radiate resolve, threat, and high emotional stakes.',
  rest:               'a quiet, reflective moment. The scene should convey stillness, introspection, and atmosphere.',
  celebration:        'a triumphant celebration. Energy should feel joyful, dynamic, and emotionally charged.',
};

const ROLE_LABELS = {
  character_reference:    'character identity reference',
  style_reference:        'style and visual treatment reference',
  pose_reference:         'pose and body language reference',
  background_reference:   'background and environment reference',
  composition_reference:  'composition and framing reference',
  color_palette_reference:'color palette reference',
  outfit_reference:       'clothing and costume reference',
  object_reference:       'object and prop reference',
  scene_reference:        'full scene reference',
};

const MODE_INSTRUCTIONS = {
  preserve:  'Preserve it exactly — do not redesign, simplify, or alter it.',
  inspire:   'Use it as inspiration — capture its spirit and aesthetic without copying it literally.',
  transform: 'Use it as a starting point and apply the requested transformation.',
  combine:   'Use it as one element to be combined with the other provided references.',
  layout:    'Apply its compositional framing, camera angle, and spatial layout only — not its content.',
};

const CHAR_PRESERVE = 'facial structure, silhouette, clothing design, proportions, color palette, and stylization';

const LIGHTING_LABELS = {
  volumetric: 'volumetric lighting with god rays',
  cinematic:  'cinematic lighting',
  dramatic:   'dramatic high-contrast lighting',
  golden_hour:'warm golden-hour light',
  backlit:    'backlit silhouette lighting',
  rim_light:  'rim lighting',
  soft:       'soft diffused ambient light',
  neon:       'neon atmospheric lighting',
  moonlit:    'cool moonlit lighting',
};

const STYLE_LABELS = {
  graphic_novel:   'a high-quality graphic novel page with rich linework, color, and visual storytelling',
  anime:           'premium cinematic anime concept art — stylized, atmospheric, and emotionally expressive',
  concept_art:     'professional concept art — polished, purposeful, and cinematic',
  cinematic_still: 'a cinematic film still — precise photographic composition with directorial intent',
  photorealistic:  'a photorealistic render with precise detail, accurate lighting, and immersive depth',
  illustration:    'a polished illustration with clear composition, expressive line, and strong visual hierarchy',
};

// ── Reference section builder ─────────────────────────────────────────────────

function buildReferenceSection(ir, imageRefs) {
  const hasLabeled = imageRefs?.length > 0;
  const irRefs     = ir.references;

  if (!hasLabeled && !irRefs?.intent) return null;

  const lines = [];

  if (hasLabeled) {
    // Precise per-image instructions
    imageRefs.forEach((ref, i) => {
      const num       = i + 1;
      const label     = ref.label?.trim() || `Image ${num}`;
      const roleLabel = ROLE_LABELS[ref.role] ?? ref.role?.replace(/_/g, ' ') ?? 'reference';
      const mode      = ref.mode ?? 'preserve';
      const modeNote  = MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS.preserve;

      if (ref.role === 'character_reference') {
        const attrs = ref.usage?.length ? ref.usage.join(', ') : CHAR_PRESERVE;
        lines.push(`- Image ${num} (${label}) — ${roleLabel}.`);
        lines.push(`  Preserve their ${attrs}. ${modeNote}`);
      } else {
        lines.push(`- Image ${num} (${label}) — ${roleLabel}.`);
        lines.push(`  ${modeNote}`);
      }
    });

    // Global rules for character references
    const charRefs = imageRefs.filter(r => r.role === 'character_reference');
    if (charRefs.length > 1) {
      lines.push('- Keep each referenced character visually distinct — do not merge or blend character designs.');
      lines.push('- Maintain visual consistency for each character across all panels and angles.');
    } else if (charRefs.length === 1) {
      lines.push('- Do not redesign, simplify, or replace the referenced character.');
    }
  } else {
    // IR-detected intent — no labeled refs
    const types   = irRefs?.types ?? ['character'];
    const count   = irRefs?.count;
    const mode    = irRefs?.mode ?? 'preserve';

    if (types.includes('character')) {
      if (count && count > 1) {
        lines.push(`- Use the provided reference images as character identity references for all ${count} characters.`);
        lines.push(`- Preserve each character's ${CHAR_PRESERVE}.`);
        lines.push('- Do not merge, simplify, or replace any referenced character. Keep all designs visually distinct.');
      } else {
        lines.push('- Use the provided reference image as the character identity reference.');
        lines.push(`- Preserve the character's ${CHAR_PRESERVE}.`);
        lines.push('- Do not redesign or simplify the referenced character.');
      }
    }
    if (types.includes('style'))      lines.push('- Match the visual style, color treatment, and artistic character of the reference.');
    if (types.includes('background') || types.includes('scene'))
      lines.push('- Use the reference to define the background environment, architecture, and atmosphere.');
    if (types.includes('pose'))       lines.push('- Apply the pose, body language, and spatial arrangement shown in the reference.');
    if (types.includes('outfit'))     lines.push('- Preserve the exact clothing, accessories, and costume shown in the reference.');
    if (types.includes('color_palette')) lines.push('- Apply the color palette from the reference image consistently.');
  }

  return lines.length ? `Use the references as follows:\n${lines.join('\n')}` : null;
}

// ── Avoid section builder ─────────────────────────────────────────────────────

function buildAvoidSection(ir, imageRefs) {
  const items = [];

  if (ir.composition?.avoid?.length) {
    ir.composition.avoid.forEach(a => {
      items.push(AVOID_LABELS[a] ?? a.replace(/_/g, ' '));
    });
  }

  const charRefs = (imageRefs ?? []).filter(r => r.role === 'character_reference');
  if (charRefs.length > 0) {
    items.push('redesigning or simplifying the referenced characters');
    if (charRefs.length > 1) {
      items.push('mixing up which reference belongs to which character');
      items.push('blending or merging character designs');
    }
  } else if (ir.references?.intent) {
    items.push('redesigning the referenced character or elements');
  }

  return items.length
    ? `Avoid:\n${items.map(a => `- ${a}`).join('\n')}`
    : null;
}

// ── Main compiler ─────────────────────────────────────────────────────────────

export function compileClaude(ir, masterPrompt, settings = {}) {
  const imageRefs = settings.imageRefs ?? [];
  const hasRefs   = imageRefs.length > 0 || ir.references?.intent;

  const sections = [];

  // ── Opening ────────────────────────────────────────────────────────────────
  const genrePart = ir.environment?.genre
    ? ir.environment.genre.replace(/_/g, ' ') + ' '
    : '';
  const refPhrase = hasRefs ? 'using the provided reference images' : '';

  if (ir.layout?.type === 'multi_panel_comic') {
    sections.push(
      `Create a multi-panel ${genrePart}comic scene ${refPhrase}.`
        .replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim()
    );
  } else if (ir.layout?.type === 'sequence') {
    sections.push(
      `Create a cinematic ${genrePart}visual sequence ${refPhrase}.`
        .replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim()
    );
  } else {
    sections.push(
      `Create a ${genrePart}image ${refPhrase}.`
        .replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim()
    );
  }

  // ── Reference section ──────────────────────────────────────────────────────
  const refSection = buildReferenceSection(ir, imageRefs);
  if (refSection) sections.push(refSection);

  // ── Scene description ──────────────────────────────────────────────────────
  if (ir.interaction?.type) {
    const desc = INTERACTION_DESCRIPTIONS[ir.interaction.type]
      ?? ir.interaction.type.replace(/_/g, ' ') + '.';
    sections.push(`Scene description:\nThe characters are engaged in ${desc}`);
  }

  // ── Panel direction ────────────────────────────────────────────────────────
  const dirLines = [];
  if (ir.layout?.type === 'multi_panel_comic') {
    dirLines.push('Show the scene across several connected panels from varied viewpoints.');
  }
  if (ir.composition?.preferredShots?.length) {
    const shots = [...new Set(
      ir.composition.preferredShots.map(s => SHOT_LABELS[s] ?? s.replace(/_/g, ' '))
    )];
    dirLines.push(`Use: ${shots.join(', ')}.`);
  }
  if (dirLines.length) sections.push(`Panel direction:\n${dirLines.join('\n')}`);

  // ── Avoid section ──────────────────────────────────────────────────────────
  const avoidSection = buildAvoidSection(ir, imageRefs);
  if (avoidSection) sections.push(avoidSection);

  // ── Lighting ───────────────────────────────────────────────────────────────
  if (ir.lighting?.length) {
    const lights = ir.lighting.map(l => LIGHTING_LABELS[l] ?? l.replace(/_/g, ' ')).slice(0, 3);
    sections.push(`Lighting:\n${lights.join(', ')}.`);
  }

  // ── Environment ────────────────────────────────────────────────────────────
  if (ir.environment?.backgrounds) {
    const envParts = [];
    if (ir.environment.genre) envParts.push(ir.environment.genre.replace(/_/g, ' '));
    if (ir.environment.details?.length) {
      ir.environment.details.slice(0, 2).forEach(d => envParts.push(d.replace(/_/g, ' ')));
    }
    const envDesc = [...new Set(envParts)].join(', ');
    sections.push(
      `Environment:\nAdd a ${envDesc} background with enough detail to support the scene. Keep the characters readable and visually dominant.`
        .replace(/\s+/g, ' ').replace(/\n /g, '\n').trim()
    );
  }

  // ── Style ──────────────────────────────────────────────────────────────────
  if (ir.style?.mode) {
    const styleLabel = STYLE_LABELS[ir.style.mode] ?? ir.style.mode.replace(/_/g, ' ');
    sections.push(`Style:\nRender the scene as ${styleLabel}.`);
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  if (sections.length <= 1 && !hasRefs) {
    let p = masterPrompt.trim().replace(/\s+/g, ' ');
    if (!p.match(/[.!?]$/)) p += '.';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  return sections.join('\n\n');
}
