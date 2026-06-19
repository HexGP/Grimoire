// chatgpt-compiler.js — ChatGPT "film director brief" compiler
// ChatGPT responds best to explicit, structured, repeated reference instructions.
// When reference images are attached, output uses labeled sections + numbered image directives.
// Without references, output is a single cohesive cinematic brief.

// ── Label maps ────────────────────────────────────────────────────────────────

const SHOT_LABELS = {
  low_angle:         'low-angle shots',
  dutch_angle:       'Dutch-angle framing',
  over_the_shoulder: 'over-the-shoulder framing',
  high_angle:        'high-angle views',
  wide_establishing: 'wide establishing shots',
  close_up:          'close-up emotional framing',
  medium_shot:       'medium shots',
  extreme_close_up:  'extreme close-ups',
  two_shot:          'intimate two-character shots',
  group_shot:        'group ensemble shots',
  dynamic:           'dynamic cinematic camera angles',
};

const AVOID_LABELS = {
  flat_front_view:             'flat front-facing compositions',
  static_centered_composition: 'static centered shots',
  text_in_image:               'text elements embedded in the image',
};

const INTERACTION_DESCRIPTIONS = {
  serious_discussion: (ir) =>
    'engaged in a serious and important discussion. Their body language, eye contact, and gestures should convey emotional tension, urgency, and believable interpersonal weight.',
  battle: () =>
    'locked in intense combat. Their postures, expressions, and energy should convey dynamic impact, fierce determination, and cinematic power.',
  romance: () =>
    'sharing an intimate and emotionally resonant moment. Their body language should radiate warmth, vulnerability, and genuine connection.',
  exploration: () =>
    'exploring their environment with curiosity and purpose. Composition should emphasize the scale of the world around them.',
  confrontation: () =>
    'locked in a tense face-to-face confrontation. Their stances and expressions should radiate resolve, threat, and high emotional stakes.',
  rest: () =>
    'at rest or in a quiet reflective moment. The scene should convey stillness, introspection, and atmosphere.',
  celebration: () =>
    'celebrating or sharing a triumphant moment. Energy should feel joyful, dynamic, and emotionally charged.',
};

const STYLE_CLOSING = {
  graphic_novel:   'high-quality fantasy graphic novel page — rich in linework, color, atmosphere, and visual storytelling.',
  anime:           'premium cinematic anime concept art — stylized, atmospheric, and emotionally expressive.',
  concept_art:     'professional concept art — polished, purposeful, and cinematic.',
  cinematic_still: 'cinematic film still — photographic composition, realistic lighting, and directorial intent.',
  photorealistic:  'photorealistic render — precise detail, accurate lighting, and immersive depth.',
  illustration:    'polished editorial illustration — clear composition, expressive line, and strong visual hierarchy.',
};

const LIGHTING_LABELS = {
  volumetric: 'volumetric lighting with visible light shafts',
  cinematic:  'cinematic three-point lighting',
  dramatic:   'dramatic high-contrast lighting',
  golden_hour:'warm golden-hour lighting',
  backlit:    'backlit silhouette lighting',
  rim_light:  'rim lighting to separate subjects from background',
  soft:       'soft, diffused ambient lighting',
  neon:       'neon atmospheric lighting',
  moonlit:    'cool moonlit night lighting',
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

const CHAR_PRESERVE = 'facial structure, silhouette, clothing design, proportions, color palette, and stylization';

// ── Reference block builder ───────────────────────────────────────────────────

function buildReferenceBlock(ir, imageRefs) {
  const hasLabeled = imageRefs?.length > 0;
  const irRefs     = ir.references;

  if (!hasLabeled && !irRefs?.intent) return null;

  const lines = [];

  if (hasLabeled) {
    // Per-image explicit instructions — ChatGPT handles these well when numbered
    imageRefs.forEach((ref, i) => {
      const num       = i + 1;
      const label     = ref.label?.trim() || `Image ${num}`;
      const roleLabel = ROLE_LABELS[ref.role] ?? ref.role?.replace(/_/g, ' ') ?? 'reference';
      const mode      = ref.mode ?? 'preserve';

      if (ref.role === 'character_reference') {
        const attrs = ref.usage?.length ? ref.usage.join(', ') : CHAR_PRESERVE;
        lines.push(`- Use Image ${num} (${label}) as the ${roleLabel}.`);
        lines.push(`  Preserve their ${attrs}. Do not redesign or alter this character.`);
      } else if (ref.role === 'style_reference') {
        const modePhrase = mode === 'inspire' ? 'Use it as inspiration — capture its spirit without copying it exactly.'
                         : mode === 'transform' ? 'Apply this style as a transformation of the base content.'
                         : 'Match this visual style precisely.';
        lines.push(`- Use Image ${num} (${label}) as the ${roleLabel}. ${modePhrase}`);
      } else if (ref.role === 'background_reference' || ref.role === 'scene_reference') {
        const modePhrase = mode === 'inspire' ? 'Use it as inspiration for the setting, architecture, and atmosphere.'
                         : 'Replicate the environment, architecture, and mood of this reference.';
        lines.push(`- Use Image ${num} (${label}) as the ${roleLabel}. ${modePhrase}`);
      } else if (ref.role === 'pose_reference') {
        lines.push(`- Use Image ${num} (${label}) as the ${roleLabel}. Match the body pose, gesture, and spatial arrangement.`);
      } else if (ref.role === 'composition_reference') {
        lines.push(`- Use Image ${num} (${label}) as the ${roleLabel}. Apply the framing, camera angle, and compositional structure.`);
      } else {
        lines.push(`- Use Image ${num} (${label}) as the ${roleLabel}.`);
      }
    });

    // Global consistency rules for multiple character references
    const charRefs = imageRefs.filter(r => r.role === 'character_reference');
    if (charRefs.length > 1) {
      lines.push('- Do not merge, blend, or redesign any of the referenced characters.');
      lines.push('- Keep every character visually distinct and consistent across all panels.');
    }
  } else {
    // No labeled refs — derive from IR text detection
    const types = irRefs?.types ?? ['character'];
    const count = irRefs?.count;

    if (types.includes('character')) {
      if (count && count > 1) {
        lines.push(`- Use the provided reference images as character identity references for all ${count} characters.`);
        lines.push(`- Preserve each character's ${CHAR_PRESERVE}.`);
        lines.push('- Do not merge or redesign any character. Keep each visually distinct.');
      } else {
        lines.push('- Use the provided reference image as the character identity reference.');
        lines.push(`- Preserve the character's ${CHAR_PRESERVE}.`);
      }
    }
    if (types.includes('style'))  lines.push('- Match the visual style, color palette, and artistic character of the reference.');
    if (types.includes('background') || types.includes('scene'))
      lines.push('- Use the reference to define the background setting, architecture, and atmosphere.');
    if (types.includes('pose'))   lines.push('- Apply the pose, body language, and spatial arrangement from the reference image.');
    if (types.includes('outfit')) lines.push('- Preserve the exact clothing, costume, and accessories shown in the reference.');
  }

  return lines.length ? `Reference usage:\n${lines.join('\n')}` : null;
}

// ── Main compiler ─────────────────────────────────────────────────────────────

export function compileChatGPT(ir, masterPrompt, settings = {}) {
  const imageRefs = settings.imageRefs ?? [];
  const hasRefs   = imageRefs.length > 0 || ir.references?.intent;

  // Use structured multi-section format when references are present
  if (hasRefs) {
    return compileChatGPTStructured(ir, masterPrompt, imageRefs);
  }
  return compileChatGPTBrief(ir, masterPrompt);
}

// ── Structured (reference-aware) output ──────────────────────────────────────
// Multi-section format: Opening → References → Scene → Composition → Lighting → Background → Style

function compileChatGPTStructured(ir, masterPrompt, imageRefs) {
  const sections = [];

  // Opening
  const genrePart = ir.environment?.genre ? ir.environment.genre.replace(/_/g, ' ') + ' ' : '';
  const layoutPhrase = ir.layout?.type === 'multi_panel_comic'
    ? 'comic scene composed of multiple connected panels'
    : ir.layout?.type === 'sequence'
    ? 'visual sequence with strong narrative flow'
    : 'image';
  sections.push(`Using the provided reference images, create a cinematic ${genrePart}${layoutPhrase}.`);

  // References
  const refBlock = buildReferenceBlock(ir, imageRefs);
  if (refBlock) sections.push(refBlock);

  // Scene
  if (ir.interaction?.type) {
    const descFn = INTERACTION_DESCRIPTIONS[ir.interaction.type];
    const desc   = descFn ? descFn(ir) : ir.interaction.type.replace(/_/g, ' ') + '.';
    sections.push(`Scene:\nThe characters are ${desc}`);
  } else {
    // Pull scene from master prompt as fallback
    const stripped = masterPrompt
      .replace(/\b(use|take|attach|with|based on|provided|reference|image\s+\d).{0,60}/gi, '')
      .replace(/\s+/g, ' ').trim();
    if (stripped.length > 20) sections.push(`Scene:\n${stripped.charAt(0).toUpperCase() + stripped.slice(1)}`);
  }

  // Composition
  if (ir.composition?.preferredShots?.length || ir.composition?.avoid?.length) {
    const compLines = [];
    if (ir.composition.preferredShots?.length) {
      const shots = [...new Set(ir.composition.preferredShots.map(s => SHOT_LABELS[s] ?? s.replace(/_/g, ' ')))];
      compLines.push(`Use dynamic cinematic camera angles including ${shots.join(', ')}.`);
    }
    if (ir.composition.avoid?.length) {
      const avoids = ir.composition.avoid.map(a => AVOID_LABELS[a] ?? a.replace(/_/g, ' '));
      compLines.push(`Avoid ${avoids.join(' and ')}.`);
    }
    sections.push(`Composition:\n${compLines.join('\n')}`);
  }

  // Lighting
  if (ir.lighting?.length) {
    const lights = ir.lighting.map(l => LIGHTING_LABELS[l] ?? l.replace(/_/g, ' ')).slice(0, 3);
    sections.push(`Lighting:\n${lights.join(', ')}.`);
  }

  // Background
  if (ir.environment?.backgrounds) {
    const envParts = [];
    if (ir.environment.genre)   envParts.push(ir.environment.genre.replace(/_/g, ' '));
    if (ir.environment.details?.length) {
      ir.environment.details.slice(0, 2).forEach(d => envParts.push(d.replace(/_/g, ' ')));
    }
    const envDesc = [...new Set(envParts)].join(' ');
    sections.push(
      `Background:\nAdd rich ${envDesc} backgrounds that support the atmosphere and enhance the storytelling while keeping characters readable.`
        .replace(/\s+/g, ' ').trim()
    );
  }

  // Style
  const styleKey    = ir.style?.mode ?? null;
  const stylePhrase = styleKey ? (STYLE_CLOSING[styleKey] ?? `${styleKey.replace(/_/g, ' ')}.`) : null;
  if (stylePhrase) sections.push(`Style:\nThe final result should feel like a ${stylePhrase}`);

  return sections.join('\n\n');
}

// ── Single-brief (no references) output ──────────────────────────────────────

function compileChatGPTBrief(ir, masterPrompt) {
  const sentences = [];

  // Opening directive
  const refPart  = ir.subjects?.source === 'reference_images'
    ? 'Using the provided character reference images, '
    : '';
  const genrePart = ir.environment?.genre
    ? ir.environment.genre.replace(/_/g, ' ') + ' '
    : '';

  if (ir.layout?.type === 'multi_panel_comic') {
    sentences.push(`${refPart}create a cinematic ${genrePart}comic scene composed of multiple connected panels.`.replace(/\s+/g, ' ').trim());
  } else if (ir.layout?.type === 'sequence') {
    sentences.push(`${refPart}create a cinematic ${genrePart}visual sequence with strong narrative flow.`.replace(/\s+/g, ' ').trim());
  } else {
    sentences.push(`${refPart}create a cinematic ${genrePart}image.`.replace(/\s+/g, ' ').trim());
  }

  // Character consistency
  if (ir.subjects?.consistency === 'strict') {
    sentences.push('Maintain strict character consistency across all panels — including facial structure, silhouettes, clothing, proportions, color palette, and artistic style.');
  } else if (ir.subjects?.consistency === 'moderate') {
    sentences.push('Maintain consistent character appearance, style, and proportions throughout all panels.');
  }

  // Camera
  if (ir.composition?.preferredShots?.length) {
    const shots = [...new Set(ir.composition.preferredShots.map(s => SHOT_LABELS[s] ?? s.replace(/_/g, ' ')))];
    sentences.push(`Use dynamic cinematic camera work including ${shots.join(', ')}.`);
  }
  if (ir.composition?.avoid?.length) {
    const avoids = ir.composition.avoid.map(a => AVOID_LABELS[a] ?? a.replace(/_/g, ' '));
    sentences.push(`Avoid ${avoids.join(' and ')}.`);
  }

  // Interaction
  if (ir.interaction?.type) {
    const descFn = INTERACTION_DESCRIPTIONS[ir.interaction.type];
    if (descFn) sentences.push(`The characters should appear ${descFn(ir)}`);
  }

  // Lighting
  if (ir.lighting?.length) {
    const lights = ir.lighting.map(l => LIGHTING_LABELS[l] ?? l.replace(/_/g, ' ')).slice(0, 3);
    sentences.push(`Lighting: ${lights.join(', ')}.`);
  }

  // Environment
  if (ir.environment?.backgrounds) {
    const envParts = [];
    if (ir.environment.genre) envParts.push(ir.environment.genre.replace(/_/g, ' '));
    if (ir.environment.details?.length) {
      ir.environment.details.slice(0, 2).forEach(d => envParts.push(d.replace(/_/g, ' ')));
    }
    const envDesc = [...new Set(envParts)].join(' ');
    sentences.push(
      `Include rich ${envDesc} backgrounds that support the atmosphere and enhance the storytelling while keeping characters readable.`
        .replace(/\s+/g, ' ').trim()
    );
  }

  // DOF
  if (ir.quality?.includes('depth_of_field')) {
    sentences.push('Apply depth of field to guide viewer focus and reinforce cinematic depth.');
  }

  // Style
  const styleKey    = ir.style?.mode ?? null;
  const stylePhrase = styleKey ? (STYLE_CLOSING[styleKey] ?? `${styleKey.replace(/_/g, ' ')}.`) : null;
  if (stylePhrase) sentences.push(`The final result should feel like a ${stylePhrase}`);

  // Fallback
  if (sentences.length <= 1) {
    let p = masterPrompt.trim().replace(/\s+/g, ' ');
    if (!p.match(/[.!?]$/)) p += '.';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  return sentences.join(' ');
}
