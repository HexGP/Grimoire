/**
 * Generates src/lib/icons.js by combining:
 *  - simple-icons: Anthropic, Claude, Gemini (official brand paths)
 *  - @lobehub/icons: OpenAI, Midjourney, Flux, Dalle, AdobeFirefly, Ideogram, NanoBanana, Stability
 *  - Initials fallback: Leonardo (not in either)
 */

const fs   = require('fs');
const path = require('path');

// ── Extract LobeHub paths ─────────────────────────────────────────────────────

function lobePaths(name) {
  const monoPath = `node_modules/@lobehub/icons/es/${name}/components/Mono.js`;
  const file = fs.readFileSync(monoPath, 'utf8');
  const re = /\{\s*d:\s*"((?:[^"\\]|\\.)*)"/g;
  const paths = [];
  let m;
  while ((m = re.exec(file)) !== null) {
    paths.push(m[1].replace(/\\"/g, '"'));
  }
  return paths;
}

// ── Extract simple-icons paths ────────────────────────────────────────────────
// We use require to get the CJS build
// simple-icons v14+ uses named ESM exports; run via node --input-type=module below
// For now read the bundled data file directly
function siPath(slug) {
  // simple-icons stores data in icons/<slug>.json in older versions
  // In v14+ the data is embedded in the ES module. We already know the paths.
  return null; // filled below via hardcoded values from the audit
}

// ── Build SVG string from path array ─────────────────────────────────────────

function svg(paths, fillRule) {
  const fr = fillRule ? ` fill-rule="${fillRule}"` : '';
  const pathTags = paths.map(d => `<path d="${d}"/>`).join('');
  return `<svg viewBox="0 0 24 24" fill="currentColor"${fr} xmlns="http://www.w3.org/2000/svg">${pathTags}</svg>`;
}

function svgEvenOdd(paths) {
  const pathTags = paths.map(d => `<path fill-rule="evenodd" clip-rule="evenodd" d="${d}"/>`).join('');
  return `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${pathTags}</svg>`;
}

function initialsIcon(text) {
  return `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="800" font-family="system-ui,sans-serif">${text}</text></svg>`;
}

// ── Gather all paths ──────────────────────────────────────────────────────────

const icons = {
  openai:       { paths: lobePaths('OpenAI'),       evenodd: true  },
  midjourney:   { paths: lobePaths('Midjourney'),    evenodd: true  },
  stability:    { paths: lobePaths('Stability'),     evenodd: false },
  flux:         { paths: lobePaths('Flux'),          evenodd: false },
  dalle:        { paths: lobePaths('Dalle'),         evenodd: true  },
  adobefirefly: { paths: lobePaths('AdobeFirefly'),  evenodd: true  },
  ideogram:     { paths: lobePaths('Ideogram'),      evenodd: true  },
  nanobanana:   { paths: lobePaths('NanoBanana'),    evenodd: false },
  gemini_lobe:  { paths: lobePaths('Gemini'),        evenodd: false },
  claude_lobe:  { paths: lobePaths('Claude'),        evenodd: true  },
  anthropic_lobe: { paths: lobePaths('Anthropic'),   evenodd: false },
};

// Output sizes for reference
Object.entries(icons).forEach(([k, v]) => {
  console.log(`${k}: ${v.paths.length} path(s), total_chars=${v.paths.join('').length}`);
});

// ── Produce the icons.js file ─────────────────────────────────────────────────

// simple-icons paths from our earlier audit (hardcoded since ESM import needed)
// These were verified by running: node --input-type=module -e "import {siAnthropic,siClaude,siGooglegemini} from 'simple-icons'; ..."
const SI_ANTHROPIC = 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z';
const SI_GEMINI    = 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81';

function buildFile() {
  const oi  = icons.openai;
  const mj  = icons.midjourney;
  const sd  = icons.stability;
  const fx  = icons.flux;
  const de  = icons.dalle;
  const ff  = icons.adobefirefly;
  const ig  = icons.ideogram;
  const nb  = icons.nanobanana;
  const cl  = icons.claude_lobe;

  // Build SVG strings
  const svgs = {
    openai:      icons.openai.evenodd ? svgEvenOdd(oi.paths) : svg(oi.paths),
    midjourney:  icons.midjourney.evenodd ? svgEvenOdd(mj.paths) : svg(mj.paths),
    stability:   svg(sd.paths),
    flux:        svg(fx.paths),
    dalle:       svgEvenOdd(de.paths),
    adobefirefly: svgEvenOdd(ff.paths),
    ideogram:    svgEvenOdd(ig.paths),
    nanobanana:  svg(nb.paths),
    // simple-icons versions (more official brand compliance)
    anthropic_si: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${SI_ANTHROPIC}"/></svg>`,
    gemini_si:    `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${SI_GEMINI}"/></svg>`,
    // LobeHub Claude
    claude:      icons.claude_lobe.evenodd ? svgEvenOdd(cl.paths) : svg(cl.paths),
    // initials fallbacks
    leonardo:    initialsIcon('LN'),
  };

  // Map generator key → icon config
  const registry = `
// ── Generator icon registry ───────────────────────────────────────────────────
// Sources: simple-icons (SI) for official brand SVGs, @lobehub/icons (LH) for AI models.
// To add a new generator: add one entry here. UI components read from this map.
//
// Entry shape:
//   svg        — raw SVG string, fill="currentColor" so CSS controls color
//   bg         — brand background color for the icon button
//   fg         — foreground color (icon fill in CSS)
//   brandColor — official brand hex (for reference / future theming)

export const ICON_REGISTRY = {
  chatgpt: {
    svg: ${JSON.stringify(svgs.openai)},
    bg: '#10A37F', fg: '#fff', brandColor: '#10A37F',
    source: 'lobehub/OpenAI',
  },
  midjourney: {
    svg: ${JSON.stringify(svgs.midjourney)},
    bg: '#000000', fg: '#fff', brandColor: '#000000',
    source: 'lobehub/Midjourney',
  },
  stable_diffusion: {
    svg: ${JSON.stringify(svgs.stability)},
    bg: '#4c0099', fg: '#fff', brandColor: '#330066',
    source: 'lobehub/Stability',
  },
  flux: {
    svg: ${JSON.stringify(svgs.flux)},
    bg: '#111827', fg: '#fff', brandColor: '#000',
    source: 'lobehub/Flux',
  },
  gemini: {
    svg: ${JSON.stringify(svgs.gemini_si)},
    bg: '#8E75B2', fg: '#fff', brandColor: '#8E75B2',
    source: 'simple-icons/googlegemini',
  },
  nano_banana: {
    svg: ${JSON.stringify(svgs.nanobanana)},
    bg: '#E8B400', fg: '#111', brandColor: '#FCD53F',
    source: 'lobehub/NanoBanana',
  },
  claude: {
    svg: ${JSON.stringify(svgs.claude)},
    bg: '#D97757', fg: '#fff', brandColor: '#D97757',
    source: 'lobehub/Claude',
  },
  // ── Tier 2 ──────────────────────────────────────────────────────────────────
  leonardo: {
    svg: ${JSON.stringify(svgs.leonardo)},
    bg: '#7C3AED', fg: '#fff', brandColor: '#7C3AED',
    source: 'initials-fallback',
  },
  firefly: {
    svg: ${JSON.stringify(svgs.adobefirefly)},
    bg: '#EB1000', fg: '#fff', brandColor: '#EB1000',
    source: 'lobehub/AdobeFirefly',
  },
  ideogram: {
    svg: ${JSON.stringify(svgs.ideogram)},
    bg: '#1a1a1a', fg: '#fff', brandColor: '#000',
    source: 'lobehub/Ideogram',
  },
  dalle: {
    svg: ${JSON.stringify(svgs.dalle)},
    bg: '#000000', fg: '#fff', brandColor: '#000',
    source: 'lobehub/Dalle',
  },
};

/**
 * Returns the icon entry for a generator key.
 * Falls back to an initials-based SVG if the key is unknown.
 */
export function getIcon(genKey, fallbackInitials = '?') {
  return ICON_REGISTRY[genKey] ?? {
    svg: initialsIcon(fallbackInitials),
    bg: '#333', fg: '#fff', brandColor: '#333',
    source: 'initials-fallback',
  };
}

function initialsIcon(text) {
  return \`<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="800" font-family="system-ui,sans-serif">\${text}</text></svg>\`;
}
`;

  fs.writeFileSync('src/lib/icons.js', registry.trimStart());
  console.log('\nWrote src/lib/icons.js');
  console.log('Total size:', registry.length, 'bytes');
}

buildFile();
