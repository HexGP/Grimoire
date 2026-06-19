// venice-compiler.js — Venice AI prompt compiler
// Venice AI interprets expressive, atmospheric, cinematic prose.
// NOT tag-oriented (no Danbooru ontology). NOT a rigid structure.
// Output: hybrid cinematic prose — structured but creatively open.
// Sits between ChatGPT's sectioned format and NB Pro's atmospheric prose.

// ── Label maps ────────────────────────────────────────────────────────────────

const SHOT_PHRASES = {
  low_angle:         'low-angle perspective shots',
  dutch_angle:       'Dutch-angle framing',
  over_the_shoulder: 'over-the-shoulder compositions',
  high_angle:        'high-angle overhead views',
  wide_establishing: 'wide establishing shots',
  close_up:          'close-up emotional framing',
  medium_shot:       'medium shots',
  extreme_close_up:  'extreme close-ups',
  two_shot:          'intimate two-character framing',
  group_shot:        'ensemble group compositions',
  dynamic:           'dynamic cinematic angles',
};

const INTERACTION_PROSE = {
  serious_discussion:
    'engaged in a serious, weighted discussion — body language, eye contact, and expression should carry emotional tension and interpersonal urgency.',
  battle:
    'locked in intense combat — postures and expressions should radiate dynamic energy, fierce resolve, and cinematic impact.',
  romance:
    'sharing an intimate and emotionally resonant moment — body language should convey warmth, vulnerability, and genuine connection.',
  exploration:
    'exploring their environment with curiosity and purpose — composition should emphasize scale, wonder, and the characters\' relationship with the world around them.',
  confrontation:
    'in a tense face-to-face confrontation — stances should radiate resolve, threat, and dramatic emotional stakes.',
  rest:
    'in a quiet, reflective moment — the scene should breathe with stillness, introspection, and atmospheric mood.',
  celebration:
    'sharing a triumphant celebration — energy should feel joyful, cinematic, and emotionally charged.',
};

const STYLE_CLOSINGS = {
  graphic_novel:   'a premium graphic novel — rich linework, expressive color, and immersive visual storytelling.',
  anime:           'cinematic anime — stylized, atmospheric, and emotionally expressive.',
  concept_art:     'professional concept art — polished, purposeful, and cinematic in scope.',
  cinematic_still: 'a cinematic film still — precise photographic composition with directorial intent and depth.',
  photorealistic:  'a photorealistic render — accurate lighting, precise detail, and immersive depth of field.',
  illustration:    'a polished illustration — expressive line, strong visual hierarchy, and cohesive composition.',
};

const LIGHTING_PROSE = {
  volumetric:  'volumetric lighting with dramatic light shafts and atmospheric depth',
  cinematic:   'cinematic lighting with purposeful shadow and highlight',
  dramatic:    'high-contrast dramatic lighting',
  golden_hour: 'warm golden-hour light casting long shadows',
  backlit:     'striking backlit silhouette lighting',
  rim_light:   'rim lighting that separates subjects from the background',
  soft:        'soft, diffused ambient light',
  neon:        'atmospheric neon lighting',
  moonlit:     'cool moonlit night lighting',
};

const CHAR_PRESERVE = 'facial structure, silhouette, clothing design, proportions, color palette, and stylization';

const ROLE_LABELS = {
  character_reference:    'character identity reference',
  style_reference:        'style and visual treatment reference',
  pose_reference:         'pose and body language reference',
  background_reference:   'background and environment reference',
  composition_reference:  'compositional framing reference',
  color_palette_reference:'color palette reference',
  outfit_reference:       'clothing and costume reference',
  object_reference:       'object and prop reference',
  scene_reference:        'full scene reference',
};

// ── Reference block builder ───────────────────────────────────────────────────

function buildReferenceBlock(ir, imageRefs) {
  const hasLabeled = imageRefs?.length > 0;
  const irRefs     = ir.references;
  if (!hasLabeled && !irRefs?.intent) return null;

  const lines = [];

  if (hasLabeled) {
    imageRefs.forEach((ref, i) => {
      const num       = i + 1;
      const label     = ref.label?.trim() || `Image ${num}`;
      const roleLabel = ROLE_LABELS[ref.role] ?? ref.role?.replace(/_/g, ' ') ?? 'reference';
      const mode      = ref.mode ?? 'preserve';

      if (ref.role === 'character_reference') {
        const attrs = ref.usage?.length ? ref.usage.join(', ') : CHAR_PRESERVE;
        const modeNote = mode === 'inspire'
          ? 'Draw inspiration from their design without copying it exactly.'
          : mode === 'transform'
          ? 'Use their design as a starting point and apply the requested transformation.'
          : `Preserve their ${attrs} faithfully.`;
        lines.push(`Image ${num} (${label}) — ${roleLabel}. ${modeNote}`);
      } else if (ref.role === 'style_reference') {
        const modeNote = mode === 'inspire'
          ? 'Use it as inspiration — capture its spirit and aesthetic without copying it literally.'
          : 'Match this visual style, rendering technique, and artistic atmosphere closely.';
        lines.push(`Image ${num} (${label}) — ${roleLabel}. ${modeNote}`);
      } else if (ref.role === 'pose_reference') {
        lines.push(`Image ${num} (${label}) — ${roleLabel}. Apply the body pose, gesture, and spatial arrangement shown.`);
      } else if (ref.role === 'background_reference' || ref.role === 'scene_reference') {
        const modeNote = mode === 'inspire'
          ? 'Use it to inspire the environment\'s mood and architecture.'
          : 'Replicate the setting, architecture, and atmosphere of this reference.';
        lines.push(`Image ${num} (${label}) — ${roleLabel}. ${modeNote}`);
      } else {
        lines.push(`Image ${num} (${label}) — ${roleLabel}.`);
      }
    });

    const charRefs = imageRefs.filter(r => r.role === 'character_reference');
    if (charRefs.length > 1) {
      lines.push('Keep each character visually distinct — do not merge, blend, or confuse their designs across images.');
    }
  } else {
    const types = irRefs?.types ?? ['character'];
    const count = irRefs?.count;

    if (types.includes('character')) {
      if (count && count > 1) {
        lines.push(`Use the provided reference images as character identity references for all ${count} characters.`);
        lines.push(`Preserve each character's ${CHAR_PRESERVE}. Keep every character visually distinct.`);
      } else {
        lines.push('Use the provided reference image as the character identity reference.');
        lines.push(`Preserve the character's ${CHAR_PRESERVE}.`);
      }
    }
    if (types.includes('style'))      lines.push('Match the visual style, color palette, and artistic atmosphere of the style reference.');
    if (types.includes('background') || types.includes('scene'))
      lines.push('Use the environment reference to define the setting, architecture, and atmospheric mood.');
    if (types.includes('pose'))       lines.push('Apply the pose, body language, and spatial arrangement from the pose reference.');
    if (types.includes('outfit'))     lines.push('Preserve the exact clothing, costume, and accessories shown in the reference.');
  }

  return lines.length
    ? `Reference images:\n${lines.map(l => `- ${l}`).join('\n')}`
    : null;
}

// ── Main compiler ─────────────────────────────────────────────────────────────

export function compileVenice(ir, masterPrompt, settings = {}) {
  const { model = 'venice_default' } = settings;
  const imageRefs = settings.imageRefs ?? [];
  const hasRefs   = imageRefs.length > 0 || ir.references?.intent;

  const parts = [];

  // ── Opening directive ──────────────────────────────────────────────────────
  const genrePart = ir.environment?.genre
    ? ir.environment.genre.replace(/_/g, ' ') + ' '
    : '';
  const refPhrase = hasRefs ? 'Using the provided reference images, ' : '';

  if (ir.layout?.type === 'multi_panel_comic') {
    parts.push(
      `${refPhrase}Create a cinematic ${genrePart}comic sequence with strong visual continuity and expressive atmosphere.`
        .replace(/\s+/g, ' ').trim()
    );
  } else if (ir.layout?.type === 'sequence') {
    parts.push(
      `${refPhrase}Create a cinematic ${genrePart}visual sequence with strong narrative flow and atmospheric depth.`
        .replace(/\s+/g, ' ').trim()
    );
  } else {
    parts.push(
      `${refPhrase}Create a ${genrePart}image with expressive atmosphere and cinematic visual language.`
        .replace(/\s+/g, ' ').trim()
    );
  }

  // ── Reference block ────────────────────────────────────────────────────────
  const refBlock = buildReferenceBlock(ir, imageRefs);
  if (refBlock) parts.push(refBlock);

  // ── Character consistency (when refs present and no explicit labeled refs) ─
  const charRefs = imageRefs.filter(r => r.role === 'character_reference');
  if (charRefs.length > 0) {
    const names = charRefs.map((r, i) => r.label?.trim() || `Character ${i + 1}`).join(', ');
    parts.push(
      `Maintain strong visual consistency for ${names} across all panels and angles — faces, proportions, clothing, silhouette, color palette, and overall stylization must remain faithful to the references.`
    );
  } else if (ir.subjects?.consistency === 'strict' || ir.references?.intent) {
    parts.push(
      'Preserve strict character consistency across all compositions — including facial structure, silhouette, clothing, proportions, color palette, and artistic stylization.'
    );
  }

  // ── Scene / interaction ────────────────────────────────────────────────────
  if (ir.interaction?.type) {
    const desc = INTERACTION_PROSE[ir.interaction.type] ?? ir.interaction.type.replace(/_/g, ' ') + '.';
    parts.push(`The characters are ${desc}`);
  }

  // ── Composition ────────────────────────────────────────────────────────────
  const shotPhrases = (ir.composition?.preferredShots ?? [])
    .map(s => SHOT_PHRASES[s] ?? s.replace(/_/g, ' '))
    .filter(Boolean);

  const panelNote = ir.layout?.type === 'multi_panel_comic'
    ? 'Vary panel perspectives across the sequence — '
    : '';

  if (shotPhrases.length) {
    parts.push(`${panelNote}Use varied camera compositions including ${shotPhrases.join(', ')}.`.replace(/\s+/g, ' ').trim());
  } else if (panelNote) {
    parts.push('Vary panel perspectives, mixing wide shots with close-up emotional framing and dynamic angles.');
  }

  // ── Lighting ───────────────────────────────────────────────────────────────
  if (ir.lighting?.length) {
    const lights = ir.lighting
      .map(l => LIGHTING_PROSE[l] ?? l.replace(/_/g, ' '))
      .slice(0, 3);
    parts.push(`Lighting: ${lights.join(', ')}.`);
  }

  // ── Environment ────────────────────────────────────────────────────────────
  if (ir.environment?.backgrounds) {
    const envParts = [];
    if (ir.environment.genre) envParts.push(ir.environment.genre.replace(/_/g, ' '));
    if (ir.environment.details?.length) {
      ir.environment.details.slice(0, 2).forEach(d => envParts.push(d.replace(/_/g, ' ')));
    }
    const envDesc = [...new Set(envParts)].join(', ');
    parts.push(
      `Set the scene in an atmospheric ${envDesc} environment — detailed, immersive, and narratively supportive while keeping characters visually dominant.`
        .replace(/\s+/g, ' ').trim()
    );
  }

  // ── Style closing ──────────────────────────────────────────────────────────
  if (ir.style?.mode) {
    const closing = STYLE_CLOSINGS[ir.style.mode] ?? `${ir.style.mode.replace(/_/g, ' ')}.`;
    parts.push(`The final result should feel like ${closing}`);
  } else {
    // Default closing — Venice AI benefits from explicit quality framing
    parts.push('The final result should feel visually polished, atmospherically rich, and cinematically cohesive.');
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  if (parts.length <= 1 && !hasRefs) {
    let p = masterPrompt.trim().replace(/\s+/g, ' ');
    if (!p.match(/[.!?]$/)) p += '.';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  return parts.join('\n\n');
}
