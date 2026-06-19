<script>
  import { invoke }   from "@tauri-apps/api/core";
  import { onMount }  from "svelte";
  import { check as checkUpdate } from "@tauri-apps/plugin-updater";
  import { relaunch } from "@tauri-apps/plugin-process";
  import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
  import { listen } from "@tauri-apps/api/event";
  import { generateVariant, generateVariantFromIR, generateGeneralVariant, migrateVariant, extractIR } from "$lib/variants.js";
  import {
    GENERATORS_MAP, GENERATORS, GENERATORS_T1, GENERATORS_T2,
    GENERAL_GENERATORS_MAP, GENERAL_GENERATORS,
    MODEL_PROFILES, DEFAULT_SETTINGS, QUICK_TAGS, SECTIONS,
  } from "$lib/taxonomy.js";

  // ── State ──────────────────────────────────────────────────────────────────

  let prompts        = $state([]);
  let activeSection  = $state("image");
  let search         = $state("");
  let sortMode       = $state("updated"); // 'updated' | 'created' | 'title'
  let toast          = $state(null); // { kind: 'success' | 'error' | 'info', message: string } | null
  let toastTimer     = null;
  let selectedId     = $state(null);
  let showModal      = $state(false);
  let editingPrompt  = $state(null);
  let activeVariant  = $state("midjourney");
  let copiedKey      = $state(null);
  let deleteConfirm  = $state(null);
  let generatingAll    = $state(false);
  // Master Prompt + variant collapse state are BOTH persisted on the prompt object:
  //   prompt.uiMasterCollapsed: bool                 (master prompt)
  //   prompt.uiCollapsedVariants: { [genKey]: bool } (variants)
  // Missing/falsy = expanded (default). Helpers below read/write these fields,
  // so state survives prompt switches AND app restarts via the normal save pipeline.
  let variantViewMode  = $state({});     // { [genKey]: 'prompt' | 'ir' } — missing key → 'prompt'
  let activeVariationId  = $state({});   // { [genKey]: variationId } — which variation is active per generator
  let renamingVarId      = $state(null); // variation ID being renamed inline
  let renameDraft        = $state('');

  // ── Update state ──────────────────────────────────────────────────────────
  let updateStatus  = $state(null);   // null | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  let updateInfo    = $state(null);   // { version, body } from tauri updater
  let updateObj     = $state(null);   // the raw update object for installing

  // ── Inline editing state ───────────────────────────────────────────────────
  let editingTitle      = $state(false);
  let titleDraft        = $state('');
  let editingMaster     = $state(false);
  let masterDraft       = $state('');
  let notesDraft        = $state('');
  let editingVariant    = $state(null);   // { genKey, varId } | null
  let editDraft         = $state({});     // { text? } or { positive?, negative? }

  // Detail-page library tag state
  let detailTagQuery    = $state('');
  let detailTagSuggest  = $state([]);
  let detailShowSuggest = $state(false);
  let detailTagDebounce = null;

  // Detail-page SD generation tag state (ontology overrides for SD compiler)
  let sdTagQuery    = $state('');
  let sdTagSuggest  = $state([]);
  let sdShowSuggest = $state(false);
  let sdTagDebounce = null;

  // Result gallery state
  let galleryPreview   = $state(null);  // { genKey, result, resultIdx }
  let previewNoteDraft = $state('');

  // Simple image lightbox (cover image, reference images) — no metadata, just zoom
  let imagePreview = $state(null); // { src: string, label: string } | null
  function openImagePreview(src, label = '') {
    if (!src) return;
    imagePreview = { src, label };
  }
  function closeImagePreview() { imagePreview = null; }

  // Reset all editing states when selection changes
  $effect(() => {
    if (selectedId) {
      // Master + variant collapse state are persisted on the prompt — do NOT reset
      variantViewMode   = {};     // all variants default back to prompt view
      editingTitle      = false;
      editingMaster     = false;
      editingVariant    = null;
      editDraft         = {};
      detailTagQuery    = '';
      detailTagSuggest  = [];
      detailShowSuggest = false;
      sdTagQuery    = '';
      sdTagSuggest  = [];
      sdShowSuggest = false;
      galleryPreview   = null;
      previewNoteDraft = '';
      activeVariationId = {};
      renamingVarId     = null;
      renameDraft       = '';
    }
  });
  // Sync notes draft when selection changes
  $effect(() => { notesDraft = selected?.notes ?? ''; });

  // Tag autocomplete
  let tagQuery        = $state("");
  let tagSuggestions  = $state([]);
  let showSuggest     = $state(false);
  let suggestDebounce = null;

  // ── Derived ────────────────────────────────────────────────────────────────

  let filtered = $derived((() => {
    const inTrash = activeSection === 'trash';
    const matches = prompts.filter(p => {
      // Trash view: only trashed prompts (any category)
      // Normal view: only non-trashed prompts matching the current category
      if (inTrash) {
        if (!p.deletedAt) return false;
      } else {
        if (p.deletedAt) return false;
        if (p.category !== activeSection) return false;
      }
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        p.title.toLowerCase().includes(q) ||
        (p.master_prompt ?? "").toLowerCase().includes(q) ||
        (p.tags ?? []).some(t => t.toLowerCase().includes(q))
      );
    });
    const sorted = [...matches];
    if (inTrash) {
      // Trash: always sort by recently-deleted first
      sorted.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    } else if (sortMode === 'favorites') {
      // Favorites first, then by recently-updated within each group
      sorted.sort((a, b) => {
        const af = a.isFavorite ? 1 : 0;
        const bf = b.isFavorite ? 1 : 0;
        if (af !== bf) return bf - af;
        return (b.updated_at ?? 0) - (a.updated_at ?? 0);
      });
    } else if (sortMode === 'title') {
      sorted.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
    } else if (sortMode === 'created') {
      sorted.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    } else {
      // 'updated' — default; newest at top
      sorted.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    }
    return sorted;
  })());

  // ── Favorites ──────────────────────────────────────────────────────────────
  let favAnimKey = $state(0); // bump to retrigger the detail-star animation

  async function togglePromptFavorite(id) {
    const idx = prompts.findIndex(p => p.id === id);
    if (idx === -1) return;
    // Toggle isFavorite WITHOUT bumping updated_at — favoriting shouldn't disturb sort order
    prompts[idx] = { ...prompts[idx], isFavorite: !prompts[idx].isFavorite };
    if (prompts[idx].isFavorite) favAnimKey++;
    await persist();
  }

  // ── Trash / Soft Delete ───────────────────────────────────────────────────
  const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  let trashCount = $derived(prompts.filter(p => p.deletedAt).length);

  function daysUntilPurge(deletedAt) {
    if (!deletedAt) return null;
    const ms = TRASH_RETENTION_MS - (Date.now() - deletedAt);
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }

  async function moveToTrash(id) {
    const idx = prompts.findIndex(p => p.id === id);
    if (idx === -1) return;
    prompts[idx] = { ...prompts[idx], deletedAt: Date.now() };
    // Pick next active prompt in same section
    if (selectedId === id) {
      const next = prompts.find(p => p.category === activeSection && !p.deletedAt && p.id !== id);
      selectedId = next?.id ?? null;
    }
    deleteConfirm = null;
    await persistImmediately();
    showToast('Moved to Trash — restorable for 30 days', 'info');
  }

  async function restoreFromTrash(id) {
    const idx = prompts.findIndex(p => p.id === id);
    if (idx === -1) return;
    const restored = { ...prompts[idx] };
    delete restored.deletedAt;
    restored.updated_at = Date.now();
    prompts[idx] = restored;
    // After restore, jump to the prompt in its category
    activeSection = restored.category;
    selectedId = restored.id;
    await persistImmediately();
    showToast(`Restored "${restored.title || 'Untitled'}"`, 'success');
  }

  async function permanentlyDelete(id) {
    const target = prompts.find(p => p.id === id);
    prompts = prompts.filter(p => p.id !== id);
    if (selectedId === id) {
      const nextInTrash = prompts.find(p => p.deletedAt);
      selectedId = nextInTrash?.id ?? null;
    }
    deleteConfirm = null;
    await persistImmediately();
    showToast(`Permanently deleted "${target?.title || 'Untitled'}"`, 'info');
  }

  async function emptyTrash() {
    const count = prompts.filter(p => p.deletedAt).length;
    if (count === 0) return;
    prompts = prompts.filter(p => !p.deletedAt);
    if (selectedId && !prompts.find(p => p.id === selectedId)) {
      selectedId = null;
    }
    deleteConfirm = null;
    await persistImmediately();
    showToast(`Emptied Trash (${count} item${count !== 1 ? 's' : ''})`, 'info');
  }

  // Auto-purge old trashed prompts based on retention policy
  async function purgeExpiredTrash() {
    const now = Date.now();
    const before = prompts.length;
    prompts = prompts.filter(p => !p.deletedAt || (now - p.deletedAt) <= TRASH_RETENTION_MS);
    if (prompts.length !== before) await persist();
  }

  function showToast(message, kind = 'success', ms = 3000) {
    if (toastTimer) clearTimeout(toastTimer);
    toast = { message, kind };
    toastTimer = setTimeout(() => { toast = null; toastTimer = null; }, ms);
  }

  let selected = $derived(prompts.find(p => p.id === selectedId) ?? null);

  // True when the prompt has SD enabled — shows the Generation Tags section
  let hasSDGenerator = $derived(
    (selected?.supported_generators ?? []).includes('stable_diffusion')
  );

  let variantGenerators = $derived(
    (() => {
      if (!selected) return [];
      const genMap = selected.category === 'general' ? GENERAL_GENERATORS_MAP : GENERATORS_MAP;
      return (selected.supported_generators ?? [])
        .filter(k => genMap[k])
        .map(k => genMap[k]);
    })()
  );

  // Auto-reset activeVariant when the selected prompt changes
  $effect(() => {
    if (selected && variantGenerators.length > 0) {
      const keys = variantGenerators.map(g => g.key);
      if (!keys.includes(activeVariant)) {
        activeVariant = keys[0];
      }
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // ── ImageRef factory ──────────────────────────────────────────────────────
  function makeImageRef(dataUrl) {
    return {
      id:     crypto.randomUUID(),
      dataUrl,
      label:  '',
      role:   'character_reference',
      mode:   'preserve',
      usage:  [],
      notes:  '',
    };
  }

  // ── Data migration: flat variant objects → per-generator arrays ───────────────
  function migrateVariantsToMulti(variants) {
    const result = {};
    for (const [genKey, v] of Object.entries(variants)) {
      if (Array.isArray(v)) {
        // Already new format — ensure each variation has required fields
        result[genKey] = v.map((variation, i) => ({
          id:   variation.id   ?? crypto.randomUUID(),
          name: variation.name ?? `Variation ${i + 1}`,
          mode: variation.mode ?? 'generated',
          ...migrateVariant(genKey, variation),
        }));
      } else if (v && typeof v === 'object') {
        // Old format: single object → wrap in array
        result[genKey] = [{
          id:   crypto.randomUUID(),
          name: 'Variation 1',
          mode: 'generated',
          ...migrateVariant(genKey, v),
        }];
      }
    }
    return result;
  }

  // True ONLY after a successful load. Until then, persist() is a no-op so we never
  // overwrite the user's existing on-disk file with an empty array.
  let loadComplete = $state(false);

  onMount(async () => {
    try {
      const loaded = await invoke("load_prompts");
      if (!Array.isArray(loaded)) {
        throw new Error('load_prompts returned a non-array');
      }
      // Migrate prompts on load
      prompts = loaded.map(p => {
        // 1. Migrate personality → general (personality is now a library tag, not a workspace)
        let migrated = p;
        if (p.category === 'personality') {
          const tags = [...new Set([...(p.tags ?? []), 'personality'])];
          migrated = { ...p, category: 'general', tags };
        }
        // 2. Migrate variants to multi-variation format
        const variants = migrateVariantsToMulti(migrated.variants ?? {});
        // 3. Migrate images: string[] → ImageRef[]
        const images = (migrated.images ?? []).map(img =>
          typeof img === 'string' ? makeImageRef(img) : img
        );
        return { ...migrated, variants, images };
      });
      loadComplete = true;
      // Auto-purge trash items past 30-day retention (only after successful load)
      await purgeExpiredTrash();
      const first = prompts.find(p => p.category === activeSection && !p.deletedAt);
      if (first) selectedId = first.id;
    } catch (e) {
      // Load FAILED — keep loadComplete=false so persist() can't clobber the file.
      // Show a recovery modal offering to restore from the rolling backup if one exists.
      console.error('load_prompts failed:', e);
      loadFailed = true;
      loadError = String(e);
      try { dataFilePath  = await invoke('get_data_path'); } catch {}
      try { backupAvailable = await invoke('backup_info'); } catch {}
      showRecoveryModal = true;
    }

    // Close-to-tray and Quit are both handled at the Rust level for reliability.
    // The X click is intercepted natively (see on_window_event in lib.rs) — Rust
    // hides the window instantly, then emits "window-hidden-to-tray" so we can
    // flush any pending autosave in the background. Quit is invoked from the
    // tray menu, emits "tray-quit-requested", we flush, then call quit_app.
    try {
      await listen('window-hidden-to-tray', () => {
        if (persistPending) {
          flushPersistNow().catch(e => console.error('save on hide failed:', e));
        }
      });
      await listen('tray-quit-requested', async () => {
        if (persistPending) await flushPersistNow();
        try { await invoke('quit_app'); } catch { /* 1.5s Rust-side fallback timer will fire */ }
      });
    } catch (e) {
      console.warn('Could not register tray/close event listeners:', e);
    }

    // Belt-and-suspenders: also flush on browser unload (best-effort).
    window.addEventListener('beforeunload', () => {
      if (persistPending) { void flushPersistNow(); }
    });

    checkForUpdate();
  });

  // ── Recovery flow ─────────────────────────────────────────────────────────

  async function restoreFromBackupAction() {
    restoring = true;
    try {
      const data = await invoke('restore_from_backup');
      if (!Array.isArray(data)) throw new Error('Backup did not return a JSON array');
      // Hydrate + migrate exactly like onMount does
      prompts = data.map(p => {
        let migrated = p;
        if (p.category === 'personality') {
          const tags = [...new Set([...(p.tags ?? []), 'personality'])];
          migrated = { ...p, category: 'general', tags };
        }
        const variants = migrateVariantsToMulti(migrated.variants ?? {});
        const images   = (migrated.images ?? []).map(img => typeof img === 'string' ? makeImageRef(img) : img);
        return { ...migrated, variants, images };
      });
      loadFailed = false;
      loadError = '';
      loadComplete = true;
      await purgeExpiredTrash();
      const first = prompts.find(p => p.category === activeSection && !p.deletedAt);
      if (first) selectedId = first.id;
      showRecoveryModal = false;
      showToast(`Restored ${prompts.length} prompt${prompts.length !== 1 ? 's' : ''} from backup`, 'success');
    } catch (e) {
      showToast(`Restore failed: ${e}`, 'error', 6000);
    } finally {
      restoring = false;
    }
  }

  function continueWithEmptyState() {
    // User chose to dismiss recovery — start fresh in memory but keep autosave OFF
    // until they explicitly opt in (preventing the empty state from clobbering disk).
    showRecoveryModal = false;
  }

  async function openDataFolder() {
    try {
      await invoke('open_data_folder');
    } catch (e) {
      showToast(`Could not open data folder: ${e}`, 'error');
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  // Safety flags — if startup load failed we MUST NOT autosave (would overwrite data)
  let loadFailed   = $state(false);
  let loadError    = $state('');
  let dataFilePath = $state('');
  let backupAvailable = $state(null); // { path, size, modified } | null
  let restoring       = $state(false);

  // Recovery modal state
  let showRecoveryModal = $state(false);

  // Debounced autosave — coalesce rapid edits into a single write ~2s after the last change.
  // Critical operations (create / delete / restore / import / empty trash / app close)
  // should call persistImmediately() instead to flush the queued write right away.
  const PERSIST_DEBOUNCE_MS = 2000;
  let persistTimer = null;
  let persistPending = false;

  async function flushPersistNow() {
    if (loadFailed || !loadComplete) return;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistPending = false;
    try {
      await invoke("save_prompts", { prompts });
    } catch (e) {
      console.error('save_prompts failed:', e);
      showToast(`Autosave failed: ${e}`, 'error', 6000);
    }
  }

  // Default — debounced. All existing edit handlers keep calling this.
  function persist() {
    if (loadFailed || !loadComplete) return;
    persistPending = true;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersistNow, PERSIST_DEBOUNCE_MS);
  }

  // Immediate save — for destructive or bulk actions where we want it on disk now.
  async function persistImmediately() { await flushPersistNow(); }

  // ── Import prompts ────────────────────────────────────────────────────────

  async function importPromptsFromFile() {
    try {
      const downloadsDir = await invoke('get_downloads_path');
      const selected = await openFileDialog({
        title: 'Load prompts backup',
        defaultPath: downloadsDir,
        filters: [{ name: 'Grimoire backup', extensions: ['json'] }],
        multiple: false,
      });
      if (!selected) return; // user cancelled

      const imported = await invoke('read_prompts_file', { path: selected });
      const existingIds = new Set(prompts.map(p => p.id));
      const now = Date.now();
      const newOnes = imported
        .filter(p => !existingIds.has(p.id) && !p.deletedAt) // skip duplicates & trashed entries from backup
        .map((p, i) => {
          const variants = migrateVariantsToMulti(p.variants ?? {});
          const images   = (p.images ?? []).map(img => typeof img === 'string' ? makeImageRef(img) : img);
          // Stamp loaded prompts with fresh updated_at so they sort to the top.
          // Stagger by index so original ordering within the batch is preserved.
          let migrated = { ...p, variants, images, updated_at: now - i };
          delete migrated.deletedAt; // defensive — never import as trashed
          if (migrated.category === 'personality') {
            const tags = [...new Set([...(migrated.tags ?? []), 'personality'])];
            migrated = { ...migrated, category: 'general', tags };
          }
          return migrated;
        });
      prompts = [...prompts, ...newOnes];
      await persistImmediately();
      const dupCount = imported.length - newOnes.length;
      showToast(
        `Loaded ${newOnes.length} new prompt${newOnes.length !== 1 ? 's' : ''}` +
          (dupCount > 0 ? ` (${dupCount} duplicate${dupCount !== 1 ? 's' : ''} skipped)` : ''),
        'success'
      );
    } catch (e) {
      showToast(`Load failed: ${e}`, 'error', 5000);
    }
  }

  async function exportPromptsToFile() {
    try {
      const downloadsDir = await invoke('get_downloads_path');
      const stamp = new Date().toISOString().slice(0, 10);
      const suggested = `${downloadsDir}/grimoire-prompts-backup-${stamp}.json`;
      const target = await saveFileDialog({
        title: 'Save prompts backup',
        defaultPath: suggested,
        filters: [{ name: 'Grimoire backup', extensions: ['json'] }],
      });
      if (!target) return; // user cancelled

      // Don't include trashed prompts in backups
      const exportable = prompts.filter(p => !p.deletedAt);
      await invoke('write_prompts_file', { path: target, prompts: exportable });
      showToast(`Saved ${exportable.length} prompt${exportable.length !== 1 ? 's' : ''}`, 'success');
    } catch (e) {
      showToast(`Save failed: ${e}`, 'error', 5000);
    }
  }

  // ── Auto-update ───────────────────────────────────────────────────────────

  async function checkForUpdate() {
    updateStatus = 'checking';
    try {
      const update = await checkUpdate();
      if (update?.available) {
        updateStatus = 'available';
        updateInfo = { version: update.version, body: update.body };
        updateObj  = update;
      } else {
        updateStatus = 'none';
        setTimeout(() => { if (updateStatus === 'none') updateStatus = null; }, 3000);
      }
    } catch {
      updateStatus = null; // silently ignore (no endpoint configured yet)
    }
  }

  async function installUpdate() {
    if (!updateObj) return;
    updateStatus = 'downloading';
    try {
      await updateObj.downloadAndInstall();
      updateStatus = 'ready';
    } catch (e) {
      updateStatus = 'error';
      importMessage = String(e);
    }
  }

  // ── Section switching ──────────────────────────────────────────────────────

  function switchSection(sec) {
    activeSection = sec;
    search = "";
    deleteConfirm = null;
    let first;
    if (sec === 'trash') {
      // Most recently trashed first
      first = [...prompts]
        .filter(p => p.deletedAt)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))[0];
    } else {
      first = prompts.find(p => p.category === sec && !p.deletedAt);
    }
    selectedId = first?.id ?? null;
    activeVariant = "midjourney";
  }

  // ── Generator helpers ──────────────────────────────────────────────────────

  // Effective generators: manually marked OR has an approved variant
  function getEffectiveGenerators(p) {
    const genMap = p.category === 'general' ? GENERAL_GENERATORS_MAP : GENERATORS_MAP;
    const supported = new Set(p.supported_generators ?? []);
    Object.entries(p.variants ?? {}).forEach(([k, vars]) => {
      if (Array.isArray(vars) && vars.some(v => v?.status === 'approved')) supported.add(k);
    });
    return [...supported].map(k => genMap[k]).filter(Boolean);
  }

  // Current generator settings for a key (merged: defaults → prompt settings)
  // For SD: also injects sd_tags so the ontology compiler can merge user overrides.
  // For reference-aware generators (Image workspace only): injects imageRefs.
  function promptGenSettings(genKey) {
    const base = {
      ...(DEFAULT_SETTINGS[genKey] ?? {}),
      ...(selected?.generator_settings?.[genKey] ?? {}),
    };
    if (genKey === 'stable_diffusion') {
      base.sdTags = selected?.sd_tags ?? [];
    }
    // Reference images only apply in Image workspace
    if (selected?.category === 'image' && ['chatgpt', 'claude', 'nano_banana', 'venice'].includes(genKey)) {
      base.imageRefs = (selected?.images ?? []).filter(img => typeof img === 'object' && img.dataUrl);
    }
    return base;
  }

  async function toggleGenerator(genKey) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const gens = prompts[idx].supported_generators ?? [];
    const has = gens.includes(genKey);
    prompts[idx] = {
      ...prompts[idx],
      supported_generators: has ? gens.filter(g => g !== genKey) : [...gens, genKey],
      updated_at: Date.now(),
    };
    await persist();
  }

  async function updateGenSetting(genKey, settingKey, value) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const gs = {
      ...(prompts[idx].generator_settings ?? {}),
      [genKey]: {
        ...(prompts[idx].generator_settings?.[genKey] ?? DEFAULT_SETTINGS[genKey] ?? {}),
        [settingKey]: value,
      },
    };
    prompts[idx] = { ...prompts[idx], generator_settings: gs, updated_at: Date.now() };
    await persist();
  }

  // ── Prompt CRUD ────────────────────────────────────────────────────────────

  function blankPrompt(category = activeSection) {
    return {
      id: crypto.randomUUID(),
      category,
      title: "",
      master_prompt: "",
      supported_generators: [],
      tags: [],        // library/search tags
      sd_tags: [],     // SD ontology generation tags (manual overrides for SD compiler)
      variants: {},
      generator_settings: {},
      images: [],
      notes: "",
      masterThumbnailImage: null,  // { dataUrl } — explicit cover image for sidebar identity
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }

  function openNew() {
    // If user is currently viewing Trash, default new prompt to Image workspace
    const category = activeSection === 'trash' ? 'image' : activeSection;
    editingPrompt = blankPrompt(category);
    tagQuery = "";
    tagSuggestions = [];
    showModal = true;
  }

  function openEdit(p) {
    editingPrompt = {
      ...p,
      supported_generators: [...(p.supported_generators ?? [])],
      tags:      [...(p.tags ?? [])],
      sd_tags:   [...(p.sd_tags ?? [])],
      images:    [...(p.images ?? [])],
      variants:  { ...(p.variants ?? {}) },
      generator_settings: { ...(p.generator_settings ?? {}) },
    };
    tagQuery = "";
    tagSuggestions = [];
    showModal = true;
  }

  function toggleModalGenerator(genKey) {
    const gens = editingPrompt.supported_generators ?? [];
    const active = gens.includes(genKey);
    if (active) {
      editingPrompt.supported_generators = gens.filter(g => g !== genKey);
    } else {
      editingPrompt.supported_generators = [...gens, genKey];
      // Initialize default settings for generators with profiles
      if (DEFAULT_SETTINGS[genKey] && !editingPrompt.generator_settings?.[genKey]) {
        editingPrompt.generator_settings = {
          ...(editingPrompt.generator_settings ?? {}),
          [genKey]: { ...DEFAULT_SETTINGS[genKey] },
        };
      }
    }
  }

  function updateModalGenSetting(genKey, settingKey, value) {
    editingPrompt.generator_settings = {
      ...(editingPrompt.generator_settings ?? {}),
      [genKey]: {
        ...(editingPrompt.generator_settings?.[genKey] ?? DEFAULT_SETTINGS[genKey] ?? {}),
        [settingKey]: value,
      },
    };
  }

  async function saveModal() {
    if (!editingPrompt.title.trim() || !editingPrompt.master_prompt.trim()) return;
    editingPrompt.updated_at = Date.now();
    const idx = prompts.findIndex(p => p.id === editingPrompt.id);
    if (idx >= 0) {
      prompts[idx] = { ...editingPrompt };
    } else {
      prompts = [{ ...editingPrompt }, ...prompts];
    }
    selectedId = editingPrompt.id;
    activeSection = editingPrompt.category;
    showModal = false;
    editingPrompt = null;
    await persistImmediately();
  }

  // Soft-delete entry point (kept name for compatibility — behavior is now "move to trash")
  async function deletePrompt(id) {
    await moveToTrash(id);
  }

  // ── Variants ───────────────────────────────────────────────────────────────

  async function generateV(genKey) {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx < 0) return;
    const result = selected.category === 'general'
      ? generateGeneralVariant(genKey, selected.master_prompt)
      : (() => {
          const gs = promptGenSettings(genKey);
          const ir = extractIR(selected.master_prompt);
          return generateVariantFromIR(genKey, ir, selected.master_prompt, gs);
        })();
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey])
      ? prompts[idx].variants[genKey] : [];
    const newVar = {
      id:   crypto.randomUUID(),
      name: `Variation ${currentVars.length + 1}`,
      mode: 'generated',
      ...result,
    };
    prompts[idx] = {
      ...prompts[idx],
      variants: { ...prompts[idx].variants, [genKey]: [...currentVars, newVar] },
      updated_at: Date.now(),
    };
    activeVariationId = { ...activeVariationId, [genKey]: newVar.id };
    await persist();
  }

  async function generateAll() {
    if (!selected || generatingAll) return;
    const gens = selected.supported_generators ?? [];
    if (!gens.length) return;
    generatingAll = true;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx < 0) { generatingAll = false; return; }
    const ir = selected.category === 'image' ? extractIR(selected.master_prompt) : null;
    const newVariants = { ...(prompts[idx].variants ?? {}) };
    for (const genKey of gens) {
      const existingVars = Array.isArray(newVariants[genKey]) ? newVariants[genKey] : [];
      // Only generate if there are no draft variations (no unprotected content)
      const hasDraft = existingVars.some(v => v.status === 'draft');
      if (hasDraft) continue;
      const result = selected.category === 'general'
        ? generateGeneralVariant(genKey, selected.master_prompt)
        : (() => {
            const gs = promptGenSettings(genKey);
            return generateVariantFromIR(genKey, ir, selected.master_prompt, gs);
          })();
      const newVar = {
        id:   crypto.randomUUID(),
        name: `Variation ${existingVars.length + 1}`,
        mode: 'generated',
        ...result,
      };
      newVariants[genKey] = [...existingVars, newVar];
    }
    prompts[idx] = { ...prompts[idx], variants: newVariants, updated_at: Date.now() };
    await persist();
    generatingAll = false;
  }

  async function approveVariant(genKey, varId) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    const gens = prompts[idx].supported_generators ?? [];
    prompts[idx] = {
      ...prompts[idx],
      supported_generators: gens.includes(genKey) ? gens : [...gens, genKey],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id === varId ? { ...v, status: 'approved' } : v),
      },
      updated_at: Date.now(),
    };
    await persist();
  }

  async function removeVariation(genKey, varId) {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx < 0) return;
    const currentVars = (Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : []).filter(v => v.id !== varId);
    const newVariants = { ...prompts[idx].variants };
    if (currentVars.length === 0) {
      delete newVariants[genKey];
    } else {
      newVariants[genKey] = currentVars;
    }
    if (activeVariationId[genKey] === varId) {
      activeVariationId = { ...activeVariationId, [genKey]: currentVars[0]?.id ?? null };
    }
    if (editingVariant?.genKey === genKey && editingVariant?.varId === varId) {
      editingVariant = null; editDraft = {};
    }
    if (galleryPreview?.varId === varId) closePreview();
    prompts[idx] = { ...prompts[idx], variants: newVariants, updated_at: Date.now() };
    await persist();
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────

  async function copy(text, key) {
    await navigator.clipboard.writeText(text);
    copiedKey = key;
    setTimeout(() => (copiedKey = null), 1800);
  }

  // ── Inline title edit ──────────────────────────────────────────────────────

  function startTitleEdit() {
    titleDraft = selected?.title ?? '';
    editingTitle = true;
  }

  async function saveTitleEdit() {
    if (!titleDraft.trim()) { editingTitle = false; return; }
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) { editingTitle = false; return; }
    prompts[idx] = { ...prompts[idx], title: titleDraft.trim(), updated_at: Date.now() };
    editingTitle = false;
    await persist();
  }

  // ── Inline master prompt edit ──────────────────────────────────────────────

  function startMasterEdit() {
    masterDraft = selected?.master_prompt ?? '';
    editingMaster = true;
    // Do NOT touch masterExpanded — it's a persisted prompt field now and
    // the edit-mode UI shows a textarea, so the expand state is irrelevant
    // during editing. After saving/canceling, the previous state restores.
  }

  async function saveMasterEdit() {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) { editingMaster = false; return; }
    prompts[idx] = { ...prompts[idx], master_prompt: masterDraft, updated_at: Date.now() };
    editingMaster = false;
    await persist();
  }

  // ── Inline notes edit ──────────────────────────────────────────────────────

  async function saveNotesDraft() {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    if ((prompts[idx].notes ?? '') === notesDraft) return; // no change
    prompts[idx] = { ...prompts[idx], notes: notesDraft, updated_at: Date.now() };
    await persist();
  }

  // ── Detail-page tag management ─────────────────────────────────────────────

  function onDetailTagInput(e) {
    detailTagQuery = e.target.value;
    clearTimeout(detailTagDebounce);
    if (detailTagQuery.trim().length < 2) { detailTagSuggest = []; detailShowSuggest = false; return; }
    detailTagDebounce = setTimeout(async () => {
      try {
        detailTagSuggest = await invoke("search_tags", { query: detailTagQuery.trim() });
        detailShowSuggest = detailTagSuggest.length > 0;
      } catch { detailTagSuggest = []; }
    }, 150);
  }

  async function addDetailTag(tag) {
    const clean = tag.trim();
    if (!clean || (selected?.tags ?? []).includes(clean)) return;
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    prompts[idx] = { ...prompts[idx], tags: [...(prompts[idx].tags ?? []), clean], updated_at: Date.now() };
    await persist();
  }

  async function removeDetailTag(tag) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    prompts[idx] = { ...prompts[idx], tags: (prompts[idx].tags ?? []).filter(t => t !== tag), updated_at: Date.now() };
    await persist();
  }

  function onDetailTagKeydown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = detailTagQuery.trim().replace(/,+$/, '');
      if (val) { addDetailTag(val); detailTagQuery = ''; detailTagSuggest = []; detailShowSuggest = false; }
    } else if (e.key === 'Escape') {
      detailShowSuggest = false;
    }
  }

  function pickDetailTagSuggestion(tag) {
    addDetailTag(tag);
    detailTagQuery = '';
    detailTagSuggest = [];
    detailShowSuggest = false;
  }

  // ── SD generation tag management ───────────────────────────────────────────

  function onSDTagInput(e) {
    sdTagQuery = e.target.value;
    clearTimeout(sdTagDebounce);
    if (sdTagQuery.trim().length < 2) { sdTagSuggest = []; sdShowSuggest = false; return; }
    sdTagDebounce = setTimeout(async () => {
      try {
        sdTagSuggest = await invoke("search_tags", { query: sdTagQuery.trim() });
        sdShowSuggest = sdTagSuggest.length > 0;
      } catch { sdTagSuggest = []; }
    }, 150);
  }

  async function addSDTag(tag) {
    const clean = tag.trim().replace(/\s+/g, '_').toLowerCase();
    if (!clean || (selected?.sd_tags ?? []).includes(clean)) return;
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    prompts[idx] = {
      ...prompts[idx],
      sd_tags: [...(prompts[idx].sd_tags ?? []), clean],
      updated_at: Date.now(),
    };
    await persist();
  }

  async function removeSDTag(tag) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    prompts[idx] = {
      ...prompts[idx],
      sd_tags: (prompts[idx].sd_tags ?? []).filter(t => t !== tag),
      updated_at: Date.now(),
    };
    await persist();
  }

  function onSDTagKeydown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = sdTagQuery.trim().replace(/,+$/, '').replace(/\s+/g, '_').toLowerCase();
      if (val) { addSDTag(val); sdTagQuery = ''; sdTagSuggest = []; sdShowSuggest = false; }
    } else if (e.key === 'Escape') {
      sdShowSuggest = false;
    }
  }

  function pickSDTagSuggestion(tag) {
    addSDTag(tag);
    sdTagQuery = '';
    sdTagSuggest = [];
    sdShowSuggest = false;
  }

  // ── Result Gallery ─────────────────────────────────────────────────────────

  function addResultImage(genKey, varId, e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const result = {
        id: crypto.randomUUID(),
        dataUrl: reader.result,
        isFavorite: false,
        note: '',
        metadata: { date: Date.now() },
      };
      await _addResult(genKey, varId, result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function _addResult(genKey, varId, result) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id === varId ? { ...v, results: [...(v.results ?? []), result] } : v),
      },
      updated_at: Date.now(),
    };
    await persist();
  }

  async function removeResult(genKey, varId, resultId) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id === varId ? { ...v, results: (v.results ?? []).filter(r => r.id !== resultId) } : v),
      },
      updated_at: Date.now(),
    };
    if (galleryPreview?.result?.id === resultId) closePreview();
    await persist();
  }

  async function toggleResultFavorite(genKey, varId, resultId) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    let updatedResult;
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => {
          if (v.id !== varId) return v;
          const results = (v.results ?? []).map(r => {
            if (r.id === resultId) { updatedResult = { ...r, isFavorite: !r.isFavorite }; return updatedResult; }
            return r;
          });
          return { ...v, results };
        }),
      },
      updated_at: Date.now(),
    };
    if (galleryPreview?.result?.id === resultId && updatedResult) {
      galleryPreview = { ...galleryPreview, result: updatedResult };
    }
    await persist();
  }

  async function saveResultNote(genKey, varId, resultId, note) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id !== varId ? v : {
          ...v, results: (v.results ?? []).map(r => r.id === resultId ? { ...r, note } : r),
        }),
      },
      updated_at: Date.now(),
    };
    await persist();
  }

  function openPreview(genKey, varId, result, resultIdx) {
    galleryPreview   = { genKey, varId, result, resultIdx };
    previewNoteDraft = result.note ?? '';
  }

  function closePreview() {
    galleryPreview   = null;
    previewNoteDraft = '';
  }

  function closePreviewOverlay(e) {
    if (e.target === e.currentTarget) closePreview();
  }

  function navigatePreview(dir) {
    if (!galleryPreview) return;
    const { genKey, varId, resultIdx } = galleryPreview;
    const vars = selected?.variants?.[genKey] ?? [];
    const variation = Array.isArray(vars) ? vars.find(v => v.id === varId) : null;
    const results = variation?.results ?? [];
    const newIdx = resultIdx + dir;
    if (newIdx < 0 || newIdx >= results.length) return;
    galleryPreview   = { genKey, varId, result: results[newIdx], resultIdx: newIdx };
    previewNoteDraft = results[newIdx].note ?? '';
  }

  async function savePreviewNote() {
    if (!galleryPreview) return;
    await saveResultNote(galleryPreview.genKey, galleryPreview.varId, galleryPreview.result.id, previewNoteDraft);
  }

  // ── Master Thumbnail (cover image) ────────────────────────────────────────

  function setMasterThumbnail(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const idx = prompts.findIndex(p => p.id === selectedId);
      if (idx < 0) return;
      prompts[idx] = {
        ...prompts[idx],
        masterThumbnailImage: { dataUrl: reader.result },
        updated_at: Date.now(),
      };
      await persist();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function clearMasterThumbnail() {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    prompts[idx] = { ...prompts[idx], masterThumbnailImage: null, updated_at: Date.now() };
    await persist();
  }

  // ── Variant expand/collapse ────────────────────────────────────────────────

  // ── Master Prompt collapse (persisted) ────────────────────────────────────
  // Mirrors the variant pattern: prompt.uiMasterCollapsed = true means collapsed.
  // Missing/false = expanded (default), so existing prompts behave unchanged.
  let masterExpanded = $derived(!(selected?.uiMasterCollapsed));

  async function toggleMasterExpanded() {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx === -1) return;
    prompts[idx] = {
      ...prompts[idx],
      uiMasterCollapsed: !prompts[idx].uiMasterCollapsed,
      // NOTE: do NOT bump updated_at — UI state shouldn't disturb sort.
    };
    await persist();
  }

  // Variant collapse state lives on the prompt: prompt.uiCollapsedVariants[genKey] = true
  // means collapsed. Missing/false means expanded (default).
  function isVExpanded(genKey) {
    return !(selected?.uiCollapsedVariants?.[genKey]);
  }

  async function toggleVExpand(genKey) {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx === -1) return;
    const cur = prompts[idx].uiCollapsedVariants ?? {};
    prompts[idx] = {
      ...prompts[idx],
      uiCollapsedVariants: { ...cur, [genKey]: !cur[genKey] },
      // NOTE: do NOT bump updated_at — collapsing is UI state, not editorial.
    };
    await persist();
  }

  // Force a variant to expanded state (used when entering edit / IR view).
  async function expandVariant(genKey) {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx === -1) return;
    const cur = prompts[idx].uiCollapsedVariants ?? {};
    if (!cur[genKey]) return; // already expanded
    prompts[idx] = {
      ...prompts[idx],
      uiCollapsedVariants: { ...cur, [genKey]: false },
    };
    await persist();
  }

  // ── Variant view mode (prompt ↔ IR/JSON) ───────────────────────────────────

  // Missing key → 'prompt'
  function getVViewMode(genKey) { return variantViewMode[genKey] ?? 'prompt'; }

  function toggleVViewMode(genKey) {
    const next = getVViewMode(genKey) === 'ir' ? 'prompt' : 'ir';
    variantViewMode = { ...variantViewMode, [genKey]: next };
    // Auto-expand when switching to IR view
    if (next === 'ir') expandVariant(genKey);
  }

  // ── Variant inline editing ─────────────────────────────────────────────────

  function startVariantEdit(genKey, variation) {
    expandVariant(genKey);
    editingVariant = { genKey, varId: variation.id };
    editDraft = variation.positive !== undefined
      ? { positive: variation.positive, negative: variation.negative ?? '' }
      : { text: variation.text ?? '' };
  }

  async function saveVariantEdit() {
    if (!editingVariant) return;
    const { genKey, varId } = editingVariant;
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id === varId ? { ...v, ...editDraft, status: 'curated' } : v),
      },
      updated_at: Date.now(),
    };
    editingVariant = null;
    editDraft = {};
    await persist();
  }

  function discardVariantEdit() {
    editingVariant = null;
    editDraft = {};
  }

  // Toggle between draft ↔ curated (manual protection from Generate All)
  async function toggleCurated(genKey, varId) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id === varId ? { ...v, status: v.status === 'curated' ? 'draft' : 'curated' } : v),
      },
      updated_at: Date.now(),
    };
    await persist();
  }

  // ── Variation helpers ─────────────────────────────────────────────────────────

  function getActiveVariation(genKey) {
    const vars = selected?.variants?.[genKey];
    if (!Array.isArray(vars) || vars.length === 0) return null;
    const activeId = activeVariationId[genKey];
    return (activeId ? vars.find(v => v.id === activeId) : null) ?? vars[0];
  }

  function isActiveVar(genKey, varId) {
    return getActiveVariation(genKey)?.id === varId;
  }

  function setActiveVariation(genKey, varId) {
    activeVariationId = { ...activeVariationId, [genKey]: varId };
    // Exit edit/rename mode when switching variations
    if (editingVariant?.genKey === genKey) { editingVariant = null; editDraft = {}; }
    renamingVarId = null;
  }

  function startRenameVar(varId, currentName) {
    renamingVarId = varId;
    renameDraft   = currentName;
  }

  // Svelte action: immediately focus the node and select all text
  function focusAndSelect(node) {
    // Use rAF so Svelte finishes rendering before we steal focus
    requestAnimationFrame(() => { node.focus(); node.select(); });
  }

  async function saveRename(genKey, varId) {
    if (!renameDraft.trim()) { renamingVarId = null; return; }
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) { renamingVarId = null; return; }
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id === varId ? { ...v, name: renameDraft.trim() } : v),
      },
      updated_at: Date.now(),
    };
    renamingVarId = null;
    await persist();
  }

  async function addManualVariation(genKey) {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    const isPosneg = selected.category === 'image' && ['stable_diffusion', 'novelai'].includes(genKey);
    const newVar = {
      id:   crypto.randomUUID(),
      name: `Variation ${currentVars.length + 1}`,
      mode: 'manual',
      status: 'draft',
      settings: { ...(DEFAULT_SETTINGS[genKey] ?? {}) },
      results: [],
      ...(isPosneg ? { positive: '', negative: '' } : { text: '' }),
    };
    prompts[idx] = {
      ...prompts[idx],
      variants: { ...prompts[idx].variants, [genKey]: [...currentVars, newVar] },
      updated_at: Date.now(),
    };
    activeVariationId = { ...activeVariationId, [genKey]: newVar.id };
    editingVariant    = { genKey, varId: newVar.id };
    editDraft         = isPosneg ? { positive: '', negative: '' } : { text: '' };
    await persist();
    expandVariant(genKey);
  }

  async function duplicateVariation(genKey, varId) {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    const source = currentVars.find(v => v.id === varId);
    if (!source) return;
    const newVar = { ...source, id: crypto.randomUUID(), name: `${source.name} (copy)`, mode: 'duplicate', status: 'draft', results: [] };
    const insertAt = currentVars.findIndex(v => v.id === varId) + 1;
    const newVars = [...currentVars.slice(0, insertAt), newVar, ...currentVars.slice(insertAt)];
    prompts[idx] = {
      ...prompts[idx],
      variants: { ...prompts[idx].variants, [genKey]: newVars },
      updated_at: Date.now(),
    };
    activeVariationId = { ...activeVariationId, [genKey]: newVar.id };
    await persist();
  }

  async function regenVariation(genKey, varId) {
    if (!selected) return;
    const idx = prompts.findIndex(p => p.id === selected.id);
    if (idx < 0) return;
    const currentVars = Array.isArray(prompts[idx].variants?.[genKey]) ? prompts[idx].variants[genKey] : [];
    const target = currentVars.find(v => v.id === varId);
    if (!target || target.status === 'curated' || target.status === 'approved') return;
    const result = selected.category === 'general'
      ? generateGeneralVariant(genKey, selected.master_prompt)
      : (() => {
          const gs = promptGenSettings(genKey);
          const ir = extractIR(selected.master_prompt);
          return generateVariantFromIR(genKey, ir, selected.master_prompt, gs);
        })();
    prompts[idx] = {
      ...prompts[idx],
      variants: {
        ...prompts[idx].variants,
        [genKey]: currentVars.map(v => v.id === varId ? { ...v, ...result, mode: 'generated' } : v),
      },
      updated_at: Date.now(),
    };
    await persist();
  }

  // ── Tag autocomplete ───────────────────────────────────────────────────────

  function onTagInput(e) {
    tagQuery = e.target.value;
    clearTimeout(suggestDebounce);
    if (tagQuery.trim().length < 2) { tagSuggestions = []; showSuggest = false; return; }
    suggestDebounce = setTimeout(async () => {
      try {
        tagSuggestions = await invoke("search_tags", { query: tagQuery.trim() });
        showSuggest = tagSuggestions.length > 0;
      } catch { tagSuggestions = []; }
    }, 150);
  }

  function pickSuggestion(tag) {
    addTag(tag);
    tagQuery = "";
    tagSuggestions = [];
    showSuggest = false;
  }

  function addTag(tag) {
    const clean = tag.trim();
    if (!clean || editingPrompt.tags.includes(clean)) return;
    editingPrompt.tags = [...editingPrompt.tags, clean];
  }

  function onTagKeydown(e) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = tagQuery.trim().replace(/,+$/, "");
      if (val) addTag(val);
      tagQuery = "";
      tagSuggestions = [];
      showSuggest = false;
    } else if (e.key === "Escape") {
      showSuggest = false;
    }
  }

  function removeTag(tag) {
    editingPrompt.tags = editingPrompt.tags.filter(t => t !== tag);
  }

  // ── Reference Images (modal) ──────────────────────────────────────────────

  function addImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      editingPrompt.images = [...editingPrompt.images, makeImageRef(reader.result)];
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function removeImage(i) {
    editingPrompt.images = editingPrompt.images.filter((_, idx) => idx !== i);
  }

  function updateEditingImage(i, field, value) {
    const imgs = [...editingPrompt.images];
    imgs[i] = { ...imgs[i], [field]: value };
    editingPrompt.images = imgs;
  }

  // ── Reference Images (detail view inline) ─────────────────────────────────

  function addReferenceImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const idx = prompts.findIndex(p => p.id === selectedId);
      if (idx < 0) return;
      prompts[idx] = {
        ...prompts[idx],
        images: [...(prompts[idx].images ?? []), makeImageRef(reader.result)],
        updated_at: Date.now(),
      };
      await persist();
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  async function removeReferenceImage(imgId) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    prompts[idx] = {
      ...prompts[idx],
      images: (prompts[idx].images ?? []).filter(img => img.id !== imgId),
      updated_at: Date.now(),
    };
    await persist();
  }

  async function updateImageRefField(imgId, field, value) {
    const idx = prompts.findIndex(p => p.id === selectedId);
    if (idx < 0) return;
    prompts[idx] = {
      ...prompts[idx],
      images: (prompts[idx].images ?? []).map(img =>
        img.id === imgId ? { ...img, [field]: value } : img
      ),
      updated_at: Date.now(),
    };
    await persist();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function sectionLabel(s) {
    return { image: "Image", general: "General", trash: "Trash" }[s] ?? s;
  }
  function sectionIcon(s) {
    return { image: "🖼", general: "📝", trash: "🗑" }[s] ?? "•";
  }

  function closeOverlay(e) {
    if (e.target === e.currentTarget) showModal = false;
  }

  // MJ aspect ratio options
  const MJ_RATIOS = ["1:1","4:3","3:4","16:9","9:16","2:3","3:2","21:9"];
  const MJ_STYLES = [{ v:"raw", l:"Raw" }, { v:"cute", l:"Cute" }, { v:"expressive", l:"Expressive" }, { v:"original", l:"Original" }];
</script>

<!-- ═══════════════════════════════════════ LAYOUT ══════════════════════════ -->
{#if loadFailed}
  <div class="load-error-banner" role="alert">
    <div class="load-error-title">⚠ Could not load your prompts file</div>
    <div class="load-error-body">
      Your data is still on disk and has NOT been touched. Autosave is paused so nothing gets overwritten.
      <div class="load-error-path">File: <code>{dataFilePath || '(unknown)'}</code></div>
      <div class="load-error-detail">{loadError}</div>
      <div class="load-error-hint">Restart the app to retry. If a rolling backup exists it lives next to your data as <code>prompts-backup.json</code>.</div>
    </div>
  </div>
{/if}

<div class="layout">

  <!-- ── Sidebar ── -->
  <aside class="sidebar">
    <div class="sidebar-top">
      <span class="logo">
        <svg class="logo-icon" viewBox="0 0 784 784" xmlns="http://www.w3.org/2000/svg" fill-rule="evenodd" clip-rule="evenodd" stroke-linejoin="round" stroke-miterlimit="2">
          <g transform="matrix(1,0,0,1,-43.244091,-43.244119)">
            <g transform="matrix(0.683873,0,0,0.897096,-17.860197,-88.061235)">
              <g transform="matrix(1.316895,0,0,1.003894,-231.972098,5.822004)">
                <path d="M1043.434,140C1082.412,140 1114.01,171.598 1114.01,210.576L1114.01,939.434C1114.01,978.412 1082.412,1010.01 1043.434,1010.01L314.576,1010.01C275.598,1010.01 244,978.412 244,939.434L244,210.576C244,171.598 275.598,140 314.576,140L1043.434,140Z" style="fill:rgb(170,240,209);"/>
              </g>
              <path d="M357.325,462.9C356.886,464.35 355.278,472.264 353.816,480.513C350.745,496.676 340.07,549.402 329.542,600.901C326.033,618.402 320.476,646.159 317.259,662.768C313.896,679.265 309.948,699.999 308.193,708.805L304.976,724.745L295.91,733.329C290.939,738.01 285.382,742.915 283.481,744.141L280.264,746.371C280.264,746.371 285.09,724.523 288.599,710.143C292.108,695.763 297.226,673.692 300.151,661.096C325.887,548.51 345.481,465.13 346.504,463.569C347.236,462.566 349.575,461.451 351.769,461.228C354.108,461.005 356.302,460.671 357.033,460.56C357.618,460.56 357.764,461.563 357.325,462.9ZM541.57,732.437C563.504,735.112 598.452,742.692 614.39,748.043L620.093,749.938L615.122,750.495C609.419,751.164 288.891,750.272 288.014,749.603C287.575,749.269 288.891,747.82 290.939,746.371C294.302,743.807 295.472,743.696 319.306,743.138C345.042,742.469 358.934,741.355 411.575,735.781C477.815,728.647 505.598,727.867 541.57,732.437ZM874.965,731.991C884.616,732.883 908.305,735.335 927.607,737.453C967.672,741.912 990.338,743.584 1010.224,743.584C1023.385,743.696 1024.408,743.807 1029.234,746.928L1034.352,750.161L993.408,750.384C970.889,750.384 899.824,750.718 835.484,750.941C771.145,751.276 715.579,751.164 711.923,750.718C704.027,749.938 704.904,749.492 724.352,744.141C749.357,737.23 784.159,731.434 810.626,729.762C822.324,729.093 855.956,730.208 874.965,731.991ZM526.947,711.369C557.947,714.044 595.674,724.077 626.089,737.676C636.909,742.469 637.348,742.804 634.131,744.03C631.353,745.145 628.282,744.699 615.414,741.132C569.792,728.424 536.744,723.408 498.141,723.408C473.429,723.408 464.947,723.965 411.429,729.65C391.396,731.768 369.023,733.998 361.712,734.666C348.405,735.893 302.49,737.788 302.49,737.119C302.49,736.896 305.122,734.332 308.339,731.434L314.335,726.083L328.519,725.414C336.269,724.968 366.684,721.624 396.075,717.946C467.58,708.917 487.613,707.913 526.947,711.369ZM391.103,444.508C390.226,447.852 386.717,465.353 376.481,517.298C366.684,566.011 346.504,676.367 346.066,682.832L345.627,688.406L351.184,688.74C354.254,688.963 367.122,688.072 379.698,686.845C472.113,677.593 539.377,683.278 597.136,705.461C615.707,712.484 629.744,719.952 642.758,729.873C653.14,737.676 653.871,738.456 650.947,739.237C648.461,739.906 644.659,738.679 634.131,733.886C592.31,714.602 550.343,704.904 503.99,703.789C474.014,703.009 452.811,704.458 407.773,710.254C372.971,714.713 335.537,718.615 322.231,719.172C314.92,719.506 314.92,719.506 315.358,716.274C315.651,714.379 318.137,700.891 320.915,686.177C323.693,671.462 346.066,554.418 348.552,543.494C350.599,534.911 358.934,494.335 363.905,469.923C366.245,457.661 368.585,446.514 369.023,445.177C369.901,442.501 372.533,441.833 384.085,441.61C391.834,441.498 391.981,441.498 391.103,444.508ZM679.9,747.931C684.287,749.046 690.867,751.164 694.376,752.502L700.81,754.954L695.692,758.633C684.871,766.101 663.376,769.222 647.291,765.432C640.272,763.872 627.112,757.518 627.112,755.846C627.112,755.288 629.89,753.728 633.4,752.39C650.801,745.479 665.57,744.141 679.9,747.931ZM991.641,651.345C993.224,658.375 998.887,681.918 1002.913,702.34C1004.521,710.589 1005.837,717.723 1005.837,718.169C1005.837,720.51 979.224,718.057 915.908,709.92C877.159,705.015 868.824,704.235 843.965,703.789C805.654,703.009 782.989,705.238 750.088,713.153C735.758,716.608 701.395,729.204 688.966,735.447C682.824,738.568 679.461,739.571 676.975,739.125C673.758,738.568 674.636,737.788 686.626,729.093C714.409,708.917 748.187,695.986 792.494,688.629C819.399,684.059 834.899,682.944 866.923,682.944C895.437,683.055 905.526,683.724 956.852,688.852C967.672,689.967 972.206,689.075 972.206,685.954C972.206,684.332 968.499,662.107 967.21,656.13L964.928,640.865C965.635,639.84 966.305,638.744 966.941,637.575L969.135,633.674L987.622,636.023L991.641,651.345ZM1021.59,640.661C1028.364,641.468 1033.106,641.584 1034.288,643.316C1036.024,645.862 1039.817,654.192 1041.178,658.123C1041.557,659.216 1043.934,666.126 1047.127,679.1C1050.236,691.728 1054.911,710.205 1061.257,735.001C1067.691,759.859 1068.276,763.537 1065.498,765.655C1064.182,766.659 1023.531,766.993 891.343,766.993L718.942,766.993L711.631,771.898C697.447,781.373 681.654,785.943 663.669,785.943C645.537,785.943 629.744,781.261 616.145,772.009L608.98,766.993L433.216,766.993C264.91,766.993 257.453,766.881 255.259,764.986C251.896,762.2 252.042,760.528 257.014,741.02C259.5,731.657 264.033,713.041 267.396,699.553C270.759,686.065 275.292,667.449 277.632,658.309C286.552,623.307 307.608,537.92 317.113,498.906C323.547,472.71 324.717,470.481 332.759,470.481C335.976,470.481 336.269,470.815 335.537,473.49C335.099,475.274 329.396,499.129 323.108,526.773C310.533,581.06 298.689,631.444 289.33,671.128C272.807,740.909 270.174,753.728 271.783,755.288C273.245,756.626 283.773,756.849 329.981,756.849C361.127,756.961 438.773,757.295 502.674,757.741L618.777,758.41L622.872,761.977C629.013,767.216 642.612,772.344 654.018,773.57C672.881,775.576 689.404,772.009 703.15,762.868L709.73,758.41L869.116,757.518C1057.455,756.515 1046.196,756.738 1048.243,755.177C1049.998,753.839 1048.682,746.705 1035.668,692.865C1033.696,684.667 1032.078,677.983 1030.751,672.617L1030.715,672.479C1028.431,663.252 1025.721,654.637 1024.614,651.46L1021.59,640.661ZM1017.744,653.766C1019.081,660.122 1026.485,690.623 1029.234,701.894C1034.79,724.968 1039.177,744.141 1038.885,744.364C1038.007,745.033 1026.309,735.224 1020.314,728.647C1015.196,723.073 1014.903,722.405 1010.224,697.881C1007.95,685.893 1004.09,667.999 1003.922,667.376C1003.301,664.758 999.589,651.873 998.247,647.954L995.387,637.049C1000.257,637.71 1006.595,638.587 1013.775,639.593L1017.744,653.766ZM787.522,549.179C792.201,553.192 795.272,560.103 793.079,561.664C790.447,563.67 748.48,563.113 748.48,560.995C748.48,560.549 753.013,556.09 758.716,551.074L768.951,541.933L775.824,543.494C780.503,544.497 784.451,546.504 787.522,549.179ZM960.043,657.618C960.355,661.541 962.14,676.225 962.262,677.37C962.701,680.714 962.847,683.39 962.701,683.39C962.555,683.39 959.045,682.944 954.951,682.275C933.894,679.265 890.904,676.479 864.729,676.479C783.135,676.479 715.14,695.094 675.074,728.313L668.055,734.109L668.029,709.409C668.006,687.077 667.976,657.626 667.988,657.279C668.148,652.804 662.984,652.717 662.24,657.788C662.139,658.47 661.07,686.44 660.245,708.297C659.712,722.425 659.282,733.998 659.282,733.998C659.282,733.998 653.433,728.09 648.754,724.857C614.965,701.514 566.575,684.17 506.476,678.374C471.966,674.918 420.202,676.033 372.971,681.16C362.736,682.164 354.254,683.055 354.108,682.944C353.085,682.387 377.212,553.972 393.735,471.93C395.973,460.926 399.492,443.327 401.273,434.411L402.383,428.843C403.926,421.025 404.849,416.211 404.849,415.971C404.849,414.534 413.587,413.676 438.64,412.988C444.673,412.822 451.653,412.667 459.683,412.516L508.039,412.128C508.039,412.128 554.425,413.105 578.531,419.963C588.776,422.377 597.33,425.294 603.656,428.567C609.293,430.839 614.633,433.24 619.625,435.726C639.857,445.803 656.855,459.206 658.679,468.001C659.906,473.914 660.969,540.045 660.984,540.544C661.11,544.761 666.312,544.552 666.707,540.78C666.811,539.793 664.874,473.057 666.364,467.742C668.594,459.784 676.611,453.007 684.42,447.581C690.248,443.531 697.07,439.528 704.704,435.726C709.698,433.24 715.036,430.839 720.673,428.567C726.999,425.294 735.553,422.377 745.799,419.963C759.043,416.195 779.012,414.202 794.319,413.172C795.211,413.114 798.458,412.906 801.3,412.671C801.613,412.644 801.919,412.754 802.09,412.956C802.261,413.157 802.268,413.416 802.108,413.622C795.538,422.353 788.224,437.638 785.182,449.078C783.282,455.878 783.135,476.277 784.89,484.08C786.791,492.886 784.89,493.889 747.017,504.033C729.032,508.938 713.093,513.731 711.485,514.846C702.272,520.977 658.404,574.929 655.626,583.289C654.164,587.748 658.843,591.092 667.763,591.761L675.367,592.318L668.494,598.56C664.838,602.016 657.235,608.258 651.824,612.606C643.051,619.628 641.004,622.081 632.376,637.018C626.966,646.159 622.872,654.296 623.31,655.188C624.773,657.863 628.721,656.748 638.079,651.063C643.197,647.942 652.263,643.706 658.404,641.588C668.787,638.021 669.664,637.352 673.758,631.333C678.584,624.087 704.904,599.229 706.805,599.898C707.536,600.121 710.9,606.809 714.409,614.724C722.744,634.12 726.984,637.241 737.951,632.113C742.777,629.884 749.942,620.409 749.942,616.061C749.942,614.724 752.135,616.284 756.23,620.52C764.418,628.992 772.461,634.343 777.14,634.343C786.498,634.343 791.763,623.53 787.668,612.717C786.352,609.596 784.89,606.141 784.305,604.914C783.282,603.131 783.574,602.908 788.107,603.688C793.225,604.468 798.197,606.252 830.366,618.96C854.201,628.323 863.413,630.107 891.05,630.776L912.984,631.221L917.371,638.021C923.22,647.05 930.092,651.286 940.474,651.955C947.756,652.418 953.702,650.961 958.524,647.514L960.035,657.619L960.043,657.618ZM1003.209,548.043C1002.113,540.379 998.245,523.354 990.338,491.103C988.437,483.077 986.536,475.274 986.097,473.49C985.512,470.703 985.805,470.481 990.484,470.481C997.356,470.481 999.404,472.598 1001.304,481.293C1002.913,488.093 1013.88,532.347 1017.682,547.061C1018.998,552.3 1019.605,559.177 1019.729,562.555L1005.487,562.773C1005.487,562.773 1004.306,555.708 1003.209,548.043ZM956.705,444.658C961.532,442.158 966.303,439.311 971.229,436.025C971.911,437.549 973.43,447.174 973.43,448.338C973.43,449.467 977.736,469.231 977.785,469.227C977.833,469.222 991.428,521.398 996.326,548.823C998.564,561.36 998.427,562.88 998.427,562.88L983.26,563.111L956.705,444.658ZM948.722,551.879C948.181,551.862 947.625,551.854 947.055,551.854C938.72,551.854 937.842,552.077 933.163,555.867C928.191,559.88 928.045,559.992 922.05,558.542C906.404,554.975 891.489,547.73 863.267,529.672C853.616,523.429 838.994,514.289 830.805,509.161C822.763,504.145 816.182,499.909 816.329,499.686C816.621,499.574 823.64,498.683 831.975,497.791C866.484,493.889 885.493,488.873 907.281,478.172C925.852,468.92 925.706,466.356 906.404,464.35C902.017,463.904 897.776,463.235 897.045,463.012C896.46,462.678 903.187,461.005 912.107,459.222C920.227,457.621 927.421,455.883 934.067,453.84L948.722,551.879ZM941.113,451.484C944.148,450.382 947.088,449.195 949.976,447.904L975.828,563.225L968.55,563.336L966.356,560.215C963.704,556.449 960.594,554.123 956.274,552.909L941.113,451.484ZM882.277,712.372C892.805,713.598 917.078,716.608 936.38,719.06C955.536,721.513 979.517,724.188 989.46,724.857L1007.446,726.195L1012.71,731.657L1017.828,737.23L994.724,736.561C978.932,736.115 956.267,734.332 924.682,730.876C858.734,723.742 855.078,723.519 828.612,723.408C791.616,723.296 758.131,728.09 715.725,739.571C698.617,744.141 689.989,745.145 689.989,742.581C689.989,741.355 722.451,728.313 736.343,723.965C758.862,716.831 785.182,711.926 813.55,709.697C825.102,708.805 863.706,710.254 882.277,712.372Z"/>
              <path d="M698.178,588.974L701.834,591.649L691.305,601.57C685.456,607.032 677.999,613.832 674.782,616.73L668.933,621.969L660.744,617.511L666.154,611.603C674.782,602.462 692.036,586.522 693.353,586.41C693.937,586.41 696.131,587.636 698.178,588.974ZM1095.035,244.529C1095.035,272.508 1080.12,311.635 1059.21,338.945C1049.12,352.098 1028.21,368.15 1012.418,374.727C997.795,380.969 979.078,387.1 965.187,390.222C955.828,392.339 954.512,392.897 954.951,395.015C955.39,397.133 956.706,397.579 964.163,398.359C968.989,398.805 979.955,399.028 988.583,398.916C999.988,398.693 1003.937,398.916 1003.205,399.919C999.988,404.155 974.253,425.112 964.309,431.577C943.838,444.842 928.338,449.858 888.857,455.878C864.729,459.556 863.998,459.779 863.998,462.232C863.998,464.35 866.923,465.13 887.102,468.251C896.022,469.7 903.479,471.149 903.479,471.484C903.479,472.933 881.107,481.739 870.871,484.414C858.588,487.536 823.055,492.44 823.055,490.991C823.055,488.204 896.168,423.663 937.696,389.776C946.616,382.53 1032.158,317.988 1032.158,316.205C1032.158,315.648 1014.903,323.116 1001.012,332.368C978.493,347.194 972.644,350.538 954.951,362.019C918.979,385.205 896.607,400.923 861.659,427.453C830.805,450.973 819.253,460.337 798.489,478.729C795.857,481.07 793.225,482.742 792.932,482.408C792.494,482.073 792.201,475.943 792.055,468.585C792.055,453.76 794.98,441.275 800.682,431.577C802.583,428.122 804.923,424.109 805.8,422.548C807.116,420.096 807.847,421.099 812.673,432.469C818.083,445.623 821.008,448.632 825.102,446.068C826.857,444.954 827.442,442.613 827.442,437.597C827.442,428.345 831.244,413.63 835.777,404.713C844.989,387.1 860.05,374.17 897.923,351.764C912.399,343.181 914.008,342.512 912.984,345.299C910.352,352.544 909.475,357.783 909.328,364.918C909.328,370.937 909.767,372.609 911.668,373.166C915.177,374.17 917.517,371.16 918.687,364.583C920.149,356.446 926.437,342.623 932.286,335.378C941.79,323.228 952.904,316.874 988.875,303.163C1006.715,296.363 1027.771,287.445 1035.668,283.432C1051.752,275.407 1077.781,256.902 1086.993,247.093C1090.21,243.749 1093.281,240.851 1094.012,240.851C1094.597,240.851 1095.035,242.523 1095.035,244.529ZM955.243,560.995C969.72,572.142 971.328,613.609 958.022,635.123C952.465,644.264 946.616,646.939 937.696,644.375L933.894,643.26L937.696,640.474C947.932,633.228 953.927,614.389 952.757,593.21C952.026,578.05 949.54,570.247 943.691,563.67C941.206,560.883 940.621,559.434 941.937,559.1C942.814,558.877 944.715,558.431 945.885,558.208C949.833,557.205 950.564,557.428 955.243,560.995ZM772.753,602.908C775.678,605.806 780.649,616.173 780.649,619.406C780.649,622.527 778.31,626.54 776.409,626.54C773.192,626.54 749.942,603.577 749.942,600.344C749.942,599.898 754.621,599.787 760.47,600.233C767.782,600.678 771.437,601.57 772.753,602.908ZM960.069,367.593C960.069,370.38 956.559,373.278 951.88,374.058C945.3,375.173 898.069,412.516 856.541,449.301C843.673,460.671 786.791,513.62 760.178,538.812L736.051,561.775L728.154,561.887C722.159,561.887 720.697,561.552 721.72,560.437C722.598,559.769 729.032,553.638 736.197,546.949C743.362,540.373 750.527,533.573 752.135,531.901C757.692,526.327 794.395,492.217 803.168,484.414C828.758,461.897 859.027,437.82 890.758,414.522C910.206,400.254 932.871,383.422 941.206,377.179C955.974,365.809 959.923,363.803 960.069,367.593ZM731.956,597.223C737.074,597.78 738.39,598.338 739.56,601.236C742.192,606.921 741.461,615.504 737.951,620.966C732.395,629.326 729.909,628.1 723.621,613.721C720.697,606.921 717.772,600.01 717.187,598.226C716.164,595.105 716.31,594.993 720.989,595.774C723.621,596.22 728.593,596.777 731.956,597.223ZM665.131,627.208C665.131,629.995 660.744,633.339 655.041,635.011C651.386,636.015 646.56,637.91 644.367,639.024C642.027,640.251 640.272,640.919 640.272,640.696C640.272,638.801 648.607,626.54 651.678,624.087L655.334,621.078L660.159,623.976C662.938,625.536 665.131,626.986 665.131,627.208ZM764.272,509.718C761.64,512.394 756.083,517.521 752.135,521.2C748.041,524.878 742.777,529.783 740.437,532.124C738.244,534.465 733.418,537.92 729.909,539.704C726.107,541.71 720.404,546.727 715.286,552.523C710.315,558.32 705.343,562.667 702.565,563.782C695.546,566.457 690.282,570.804 689.112,574.594C688.673,576.489 687.503,578.719 686.48,579.61C682.532,583.4 665.131,587.079 665.131,584.181C665.131,582.063 690.428,549.179 703.296,534.465L716.164,519.862L733.418,515.069C742.923,512.394 754.329,509.161 758.716,507.712C769.682,504.368 769.829,504.368 764.272,509.718ZM812.819,506.931C814.866,507.935 826.711,515.403 839.14,523.429C886.81,554.307 905.088,563.224 927.607,566.68L937.842,568.24L940.621,573.702C942.96,578.161 943.545,582.063 943.545,595.328C943.691,605.249 942.96,613.721 941.79,617.176L939.89,622.861L910.352,623.641C867.946,624.868 858.149,623.084 821.008,607.367C798.05,597.669 786.937,595.105 757.984,592.541C719.966,589.308 704.319,586.076 699.494,580.391C697.154,577.715 697.154,577.27 699.202,574.817C704.027,569.244 716.456,568.352 770.414,569.578C790.739,570.024 800.682,568.798 812.965,564.227C818.522,562.221 821.008,560.549 821.3,558.765C822.031,555.198 818.376,554.641 811.357,557.428C807.994,558.765 804.631,559.434 804.046,558.877C803.461,558.431 801.852,555.421 800.536,552.189C797.612,545.389 789.569,539.258 780.796,537.252L774.947,535.914L780.357,530.675C793.371,518.19 807.701,505.148 808.432,505.036C808.871,505.036 810.918,505.928 812.819,506.931ZM1112.29,564.785C1113.136,564.398 1113.944,646.813 1113.944,646.813C1113.944,646.813 1112.061,646.535 1109.073,646.047C1102.932,645.044 1036.545,635.569 1006.13,631.444C989.021,629.103 974.399,626.874 973.522,626.54C972.644,626.094 972.937,622.192 974.545,615.281C977.177,603.577 976.592,585.63 973.229,575.709L971.328,570.024L1021.776,569.355C1069.007,568.686 1108.196,566.68 1112.29,564.785ZM935.649,630.887C935.649,631.333 934.187,633.116 932.578,634.789C929.654,637.575 929.215,637.687 926.875,636.015C925.413,635.011 923.951,633.228 923.512,632.002C922.781,630.107 923.512,629.884 929.215,629.884C932.724,629.884 935.649,630.33 935.649,630.887Z"/>
              <path d="M862.536,822.282C862.536,826.741 858.149,832.761 853.178,835.102C848.791,837.108 842.064,837.22 662.791,837.22L476.938,837.22L472.99,834.879C467.287,831.423 463.631,825.181 464.655,820.165C464.801,819.719 554.292,819.384 663.669,819.384L862.536,819.384L862.536,822.282ZM795.857,846.918C794.248,851.822 791.178,855.835 787.083,858.288C783.135,860.628 782.697,860.628 664.107,860.628C556.485,860.628 544.494,860.405 540.839,858.845C536.16,856.727 532.796,852.714 531.334,847.475L530.311,843.908L796.734,843.908L795.857,846.918ZM757.253,990.492C761.494,992.164 764.565,995.508 766.612,1000.747L767.635,1003.311L559.702,1003.311L560.726,1000.747C562.773,995.508 565.697,992.387 570.376,990.715C574.617,989.043 584.999,988.82 664.107,988.82C740.73,988.82 753.598,989.043 757.253,990.492ZM729.032,874.228C718.065,882.477 709.73,893.401 704.904,905.774C700.225,917.479 699.64,938.769 703.588,949.805C706.952,959.28 713.093,969.09 719.673,975.778C722.744,978.676 725.084,981.24 725.084,981.574C725.084,981.909 712.362,982.02 697.008,981.909L668.787,981.574L668.055,933.642C667.324,887.827 667.178,885.709 664.546,885.375C663.084,885.152 661.329,885.598 660.598,886.49C659.867,887.27 659.282,909.118 659.282,934.979L659.282,982.132L631.499,982.132C616.291,982.132 603.716,981.909 603.716,981.574C603.716,981.351 606.933,977.45 610.735,972.88C622.579,959.057 628.136,941.779 626.673,923.609C624.919,903.433 616.438,888.05 599.914,875.454L589.24,867.317L738.244,867.317L729.032,874.228Z"/>
              <path d="M827.487,245.051C827.519,244.279 826.846,243.594 825.867,243.399C824.888,243.204 823.862,243.551 823.395,244.235C812.384,259.797 795.766,273.298 774.223,282.78C712.321,310.024 633.049,293.832 597.31,246.643C576.682,219.406 575.036,187.757 589.237,160.624C589.631,159.91 589.324,159.084 588.496,158.635C587.669,158.186 586.543,158.235 585.788,158.753C537.087,192.823 524.074,249.278 558.485,294.713C598.292,347.274 686.588,365.309 755.537,334.963C799.575,315.581 825.138,281.118 827.487,245.051Z"/>
            </g>
          </g>
        </svg>
        Grimoire
      </span>
      <div class="sidebar-top-actions">
        {#if activeSection !== 'trash'}
          <button class="btn-new" onclick={openNew} title="Create new prompt" aria-label="New prompt">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            <span>New</span>
          </button>
        {/if}
      </div>
    </div>

    {#if updateStatus === 'available'}
      <div class="update-banner">
        <div>Update available: v{updateInfo.version}</div>
        <div class="update-actions">
          <button class="btn-sm btn-update" onclick={installUpdate}>Install</button>
          <button class="btn-sm btn-dismiss" onclick={() => updateStatus = null}>Dismiss</button>
        </div>
      </div>
    {/if}

    <!-- Section tabs -->
    <div class="section-tabs">
      {#each SECTIONS as sec}
        <button
          class="sec-tab {activeSection === sec ? 'active' : ''}"
          onclick={() => switchSection(sec)}
        >{sectionIcon(sec)} {sectionLabel(sec)}</button>
      {/each}
    </div>

    <!-- Search + Sort -->
    <div class="search-wrap">
      <input class="search" type="text" placeholder={activeSection === 'trash' ? 'Search trash…' : 'Search…'} bind:value={search} />
      {#if activeSection !== 'trash'}
        <select class="sort-select" bind:value={sortMode} title="Sort prompts" aria-label="Sort prompts">
          <option value="updated">Recently updated</option>
          <option value="created">Recently created</option>
          <option value="title">Title (A-Z)</option>
          <option value="favorites">★ Favorites first</option>
        </select>
      {/if}
    </div>

    {#if activeSection === 'trash' && trashCount > 0}
      <div class="trash-toolbar">
        <span class="trash-toolbar-hint">Items auto-purge after 30 days</span>
        {#if deleteConfirm === '__empty_trash__'}
          <button class="btn-danger btn-sm" onclick={() => { emptyTrash(); }}>Confirm empty</button>
          <button class="btn-act btn-sm" onclick={() => deleteConfirm = null}>Cancel</button>
        {:else}
          <button class="btn-danger-outline btn-sm" onclick={() => deleteConfirm = '__empty_trash__'}>Empty Trash</button>
        {/if}
      </div>
    {/if}

    <!-- Prompt list -->
    <div class="prompt-list">
      {#each filtered as p (p.id)}
        {@const effGens = getEffectiveGenerators(p)}
        {@const hasMasterThumb = !!p.masterThumbnailImage?.dataUrl}
        <button
          class="pcard {selectedId === p.id ? 'active' : ''} {p.isFavorite ? 'pcard-fav' : ''}"
          onclick={() => { selectedId = p.id; }}
        >
          <span
            class="pcard-fav-btn {p.isFavorite ? 'on' : ''}"
            role="button"
            tabindex="0"
            onclick={(e) => { e.stopPropagation(); togglePromptFavorite(p.id); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); togglePromptFavorite(p.id); } }}
            title={p.isFavorite ? 'Unpin from favorites' : 'Pin to favorites'}
            aria-label={p.isFavorite ? 'Unpin from favorites' : 'Pin to favorites'}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill={p.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </span>
          {#if hasMasterThumb}
            <!-- Two-column layout: thumbnail left, content right -->
            <div class="pcard-thumb-row">
              <img src={p.masterThumbnailImage.dataUrl} alt="" class="pcard-thumb" />
              <div class="pcard-thumb-text">
                <div class="pcard-row">
                  <span class="pcard-title">{p.title || "Untitled"}</span>
                  {#if effGens.length}
                    <div class="pcard-gens">
                      {#each effGens.slice(0, 3) as gen}
                        <div class="gen-xs" style="--gb:{gen.bg};--gf:{gen.fg}" title={gen.name}>{@html gen.svg}</div>
                      {/each}
                      {#if effGens.length > 3}
                        <span class="gen-xs-more">+{effGens.length - 3}</span>
                      {/if}
                    </div>
                  {/if}
                </div>
                <p class="pcard-preview">{(p.master_prompt ?? "").slice(0, 60)}{(p.master_prompt ?? "").length > 60 ? "…" : ""}</p>
                {#if (p.tags ?? []).length}
                  <div class="pcard-tags">
                    {#each (p.tags ?? []).slice(0, 2) as tag}
                      <span class="tag">{tag}</span>
                    {/each}
                    {#if (p.tags ?? []).length > 2}
                      <span class="tag tag-more">+{p.tags.length - 2}</span>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <!-- Standard text-only layout -->
            <div class="pcard-row">
              <span class="pcard-title">{p.title || "Untitled"}</span>
              {#if effGens.length}
                <div class="pcard-gens">
                  {#each effGens.slice(0, 4) as gen}
                    <div
                      class="gen-xs"
                      style="--gb:{gen.bg};--gf:{gen.fg}"
                      title={gen.name}
                    >{@html gen.svg}</div>
                  {/each}
                  {#if effGens.length > 4}
                    <span class="gen-xs-more">+{effGens.length - 4}</span>
                  {/if}
                </div>
              {/if}
            </div>
            <p class="pcard-preview">{(p.master_prompt ?? "").slice(0, 80)}{(p.master_prompt ?? "").length > 80 ? "…" : ""}</p>
            {#if (p.tags ?? []).length}
              <div class="pcard-tags">
                {#each (p.tags ?? []).slice(0, 3) as tag}
                  <span class="tag">{tag}</span>
                {/each}
                {#if (p.tags ?? []).length > 3}
                  <span class="tag tag-more">+{p.tags.length - 3}</span>
                {/if}
              </div>
            {/if}
          {/if}
        </button>
      {/each}

      {#if filtered.length === 0}
        <p class="list-empty">
          {#if search}
            No results for "{search}"
          {:else if activeSection === 'trash'}
            Trash is empty — deleted prompts will appear here for 30 days
          {:else}
            No {sectionLabel(activeSection).toLowerCase()} prompts yet
          {/if}
        </p>
      {/if}
    </div>

    <!-- Pinned bottom utility bar — application-level file actions + Trash -->
    <div class="sidebar-bottom-actions">
      <button class="btn-icon-only" onclick={exportPromptsToFile} title="Save prompts to a JSON file" aria-label="Save prompts">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      </button>
      <button class="btn-icon-only" onclick={importPromptsFromFile} title="Load prompts from a JSON file" aria-label="Load prompts">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14l6-6 6 6"/><path d="M12 8v13"/><path d="M20 21H4"/></svg>
      </button>
      <button class="btn-icon-only" onclick={openDataFolder} title="Open Grimoire data folder in file explorer" aria-label="Open data folder">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
      <span class="bottom-actions-spacer"></span>
      <button
        class="btn-icon-only btn-trash-toggle {activeSection === 'trash' ? 'active' : ''}"
        onclick={() => switchSection(activeSection === 'trash' ? 'image' : 'trash')}
        title={activeSection === 'trash' ? 'Back to workspace' : `Trash${trashCount > 0 ? ` (${trashCount})` : ''}`}
        aria-label={activeSection === 'trash' ? 'Back to workspace' : 'Open Trash'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {#if trashCount > 0}
          <span class="bottom-trash-badge">{trashCount}</span>
        {/if}
      </button>
    </div>
  </aside>

  <!-- ── Main detail ── -->
  <main class="main">
    {#if selected}
      <div class="detail">

        <!-- Header -->
        <div class="detail-header">
          <div class="detail-title-block">
            <div class="detail-title-row">
              {#if editingTitle}
                <input
                  class="title-edit-input"
                  bind:value={titleDraft}
                  onblur={saveTitleEdit}
                  onkeydown={e => { if (e.key === 'Enter') saveTitleEdit(); else if (e.key === 'Escape') editingTitle = false; }}
                />
              {:else}
                <h2 class="detail-title editable-title" onclick={startTitleEdit} title="Click to rename">{selected.title}</h2>
              {/if}
              {#key favAnimKey}
                <button
                  type="button"
                  class="detail-fav-btn {selected.isFavorite ? 'on' : ''}"
                  onclick={() => togglePromptFavorite(selected.id)}
                  title={selected.isFavorite ? 'Unpin from favorites' : 'Pin to favorites'}
                  aria-label={selected.isFavorite ? 'Unpin from favorites' : 'Pin to favorites'}
                >
                  <svg viewBox="0 0 24 24" width="22" height="22" fill={selected.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                </button>
              {/key}
            </div>
            <div class="detail-meta-row">
              <span class="detail-meta">{sectionIcon(selected.category)} {sectionLabel(selected.category)} · {fmtDate(selected.updated_at)}</span>
              {#if selected.deletedAt}
                <span class="detail-trash-chip" title="Auto-purged after 30 days from deletion">
                  🗑 In Trash · {daysUntilPurge(selected.deletedAt)}d left
                </span>
              {/if}
            </div>

            <!-- Generator / Provider ecosystem — direct toggles, workspace-aware -->
            <div class="gen-ecosystem">
              {#if selected.category === 'general'}
                <!-- General workspace: flat list of text providers -->
                {#each GENERAL_GENERATORS as gen}
                  {@const isEnabled   = (selected.supported_generators ?? []).includes(gen.key)}
                  {@const genVarsArr  = Array.isArray(selected.variants?.[gen.key]) ? selected.variants[gen.key] : []}
                  {@const hasApproved = genVarsArr.some(v => v.status === 'approved')}
                  {@const hasCurated  = genVarsArr.some(v => v.status === 'curated')}
                  {@const hasDraft    = genVarsArr.some(v => v.status === 'draft')}
                  <button
                    class="eco-btn {isEnabled ? 'eco-on' : ''} {hasApproved ? 'eco-approved' : hasCurated ? 'eco-curated' : hasDraft ? 'eco-draft' : ''}"
                    style="--gb:{gen.bg};--gf:{gen.fg}"
                    onclick={() => toggleGenerator(gen.key)}
                    title="{gen.name}{hasApproved ? ' — approved' : hasCurated ? ' — curated' : hasDraft ? ' — draft' : ''}"
                  >
                    <span class="eco-icon">{@html gen.svg}</span>
                    {#if hasApproved}
                      <span class="eco-badge eco-badge-approved">✓</span>
                    {:else if hasCurated}
                      <span class="eco-badge eco-badge-curated">✦</span>
                    {:else if hasDraft}
                      <span class="eco-dot"></span>
                    {/if}
                  </button>
                {/each}
              {:else}
                <!-- Image workspace: T1 + T2 generators -->
                {#each GENERATORS_T1 as gen}
                  {@const isEnabled   = (selected.supported_generators ?? []).includes(gen.key)}
                  {@const genVarsArr  = Array.isArray(selected.variants?.[gen.key]) ? selected.variants[gen.key] : []}
                  {@const hasApproved = genVarsArr.some(v => v.status === 'approved')}
                  {@const hasCurated  = genVarsArr.some(v => v.status === 'curated')}
                  {@const hasDraft    = genVarsArr.some(v => v.status === 'draft')}
                  <button
                    class="eco-btn {isEnabled ? 'eco-on' : ''} {hasApproved ? 'eco-approved' : hasCurated ? 'eco-curated' : hasDraft ? 'eco-draft' : ''}"
                    style="--gb:{gen.bg};--gf:{gen.fg}"
                    onclick={() => toggleGenerator(gen.key)}
                    title="{gen.name}{hasApproved ? ' — approved' : hasCurated ? ' — curated' : hasDraft ? ' — draft' : ''}"
                  >
                    <span class="eco-icon">{@html gen.svg}</span>
                    {#if hasApproved}
                      <span class="eco-badge eco-badge-approved">✓</span>
                    {:else if hasCurated}
                      <span class="eco-badge eco-badge-curated">✦</span>
                    {:else if hasDraft}
                      <span class="eco-dot"></span>
                    {/if}
                  </button>
                {/each}
                <span class="eco-sep"></span>
                {#each GENERATORS_T2 as gen}
                  {@const isEnabled   = (selected.supported_generators ?? []).includes(gen.key)}
                  {@const genVarsArr  = Array.isArray(selected.variants?.[gen.key]) ? selected.variants[gen.key] : []}
                  {@const hasApproved = genVarsArr.some(v => v.status === 'approved')}
                  {@const hasCurated  = genVarsArr.some(v => v.status === 'curated')}
                  {@const hasDraft    = genVarsArr.some(v => v.status === 'draft')}
                  <button
                    class="eco-btn eco-sm {isEnabled ? 'eco-on' : ''} {hasApproved ? 'eco-approved' : hasCurated ? 'eco-curated' : hasDraft ? 'eco-draft' : ''}"
                    style="--gb:{gen.bg};--gf:{gen.fg}"
                    onclick={() => toggleGenerator(gen.key)}
                    title="{gen.name}{hasApproved ? ' — approved' : hasCurated ? ' — curated' : hasDraft ? ' — draft' : ''}"
                  >
                    <span class="eco-icon">{@html gen.svg}</span>
                    {#if hasApproved}
                      <span class="eco-badge eco-badge-approved">✓</span>
                    {:else if hasCurated}
                      <span class="eco-badge eco-badge-curated">✦</span>
                    {:else if hasDraft}
                      <span class="eco-dot"></span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          </div>
          <div class="detail-actions">
            {#if selected.deletedAt}
              <!-- Prompt is in Trash -->
              <button class="btn-act btn-restore" onclick={() => restoreFromTrash(selected.id)} title="Restore to {sectionLabel(selected.category)} workspace">↺ Restore</button>
              {#if deleteConfirm === selected.id}
                <button class="btn-danger" onclick={() => permanentlyDelete(selected.id)}>Delete forever</button>
                <button class="btn-act" onclick={() => deleteConfirm = null}>Cancel</button>
              {:else}
                <button class="btn-danger-outline" onclick={() => deleteConfirm = selected.id} title="Permanently delete — cannot be undone">Delete permanently</button>
              {/if}
            {:else}
              <!-- Active prompt -->
              {#if deleteConfirm === selected.id}
                <button class="btn-danger" onclick={() => deletePrompt(selected.id)} title="Move to Trash — restorable for 30 days">Move to Trash</button>
                <button class="btn-act" onclick={() => deleteConfirm = null}>Cancel</button>
              {:else}
                <button class="btn-act" onclick={() => deleteConfirm = selected.id}>Delete</button>
              {/if}
            {/if}
          </div>
        </div>

        <!-- Master Prompt -->
        <section class="detail-section">
          <div class="section-title-row">
            <span class="section-label">Master Prompt</span>
            <div class="prompt-header-actions">
              <!-- Thumbnail slot: Image workspace only -->
              {#if selected.category === 'image'}
                <div class="master-thumb-slot">
                  {#if selected.masterThumbnailImage}
                    <button
                      type="button"
                      class="master-thumb-slot-imgbtn"
                      onclick={() => openImagePreview(selected.masterThumbnailImage.dataUrl, 'Cover')}
                      title="Click to enlarge cover image"
                      aria-label="Enlarge cover image"
                    >
                      <img
                        src={selected.masterThumbnailImage.dataUrl}
                        alt="Cover"
                        class="master-thumb-slot-img"
                      />
                    </button>
                    <button class="master-thumb-slot-clear" onclick={clearMasterThumbnail} title="Remove cover image">×</button>
                  {:else}
                    <label class="master-thumb-slot-add" title="Set cover image for sidebar">
                      <span>Cover</span>
                      <input type="file" accept="image/*" onchange={setMasterThumbnail} style="display:none" />
                    </label>
                  {/if}
                </div>
              {/if}
              {#if editingMaster}
                <button class="btn-save-inline" onclick={saveMasterEdit}>Save</button>
                <button class="btn-expand-toggle" onclick={() => editingMaster = false}>Cancel</button>
              {:else}
                <button
                  class="btn-copy-sm {copiedKey === 'master' ? 'ok' : ''}"
                  onclick={() => copy(selected.master_prompt, 'master')}
                >{copiedKey === 'master' ? '✓ Copied' : 'Copy'}</button>
                <button class="btn-expand-toggle" onclick={startMasterEdit} title="Edit master prompt">✎</button>
                <button
                  class="btn-expand-toggle"
                  onclick={toggleMasterExpanded}
                  title={masterExpanded ? 'Collapse' : 'Expand'}
                >{masterExpanded ? '↑' : '↓'}</button>
              {/if}
            </div>
          </div>
          {#if editingMaster}
            <textarea
              class="master-edit-textarea"
              bind:value={masterDraft}
              rows="10"
              placeholder="Write your master prompt here…"
            ></textarea>
          {:else}
            <div
              class="prompt-collapse {masterExpanded ? 'expanded' : ''}"
              ondblclick={startMasterEdit}
              role="button"
              tabindex="-1"
              title="Double-click to edit"
            >
              <pre class="prompt-pre">{selected.master_prompt}</pre>
              {#if !masterExpanded}
                <div class="prompt-fade"></div>
              {/if}
            </div>
          {/if}
        </section>

        <!-- Variants panel -->
        <section class="detail-section variants-section">
          <div class="section-title-row">
            <span class="section-label">Variants</span>
            {#if (selected.supported_generators ?? []).length}
              <button
                class="btn-gen-all {generatingAll ? 'loading' : ''}"
                onclick={generateAll}
                disabled={generatingAll}
              >
                {generatingAll ? '⏳ Generating…' : '⚡ Generate All'}
              </button>
            {/if}
          </div>

          {#if variantGenerators.length === 0}
            <div class="variant-empty-state">
              <p>Toggle generators above to start creating variants for this prompt.</p>
            </div>
          {:else}
            <!-- Tabs -->
            <div class="variant-tabs">
              {#each variantGenerators as gen}
                {@const genVars = Array.isArray(selected.variants?.[gen.key]) ? selected.variants[gen.key] : []}
                {@const hasApproved = genVars.some(v => v.status === 'approved')}
                {@const hasCurated  = genVars.some(v => v.status === 'curated')}
                <button
                  class="vtab {activeVariant === gen.key ? 'vtab-active' : ''}"
                  style="--gb:{gen.bg}"
                  onclick={() => activeVariant = gen.key}
                >
                  <span class="vtab-icon">{@html gen.svg}</span>
                  <span class="vtab-name">{gen.short}</span>
                  {#if genVars.length > 1}
                    <span class="vtab-count">{genVars.length}</span>
                  {:else if hasApproved}
                    <span class="vtab-status approved" title="Approved">✓</span>
                  {:else if hasCurated}
                    <span class="vtab-status curated" title="Curated">✦</span>
                  {:else if genVars.length === 1}
                    <span class="vtab-status draft" title="Draft"></span>
                  {/if}
                </button>
              {/each}
            </div>

            <!-- Active variant panel -->
            {#each variantGenerators as gen}
              {#if activeVariant === gen.key}
                {@const genVars  = Array.isArray(selected.variants?.[gen.key]) ? selected.variants[gen.key] : []}
                {@const activeVar = getActiveVariation(gen.key)}
                {@const gs       = promptGenSettings(gen.key)}
                <div class="variant-body">

                  {#if genVars.length === 0}
                    <!-- ── NO VARIATIONS YET ── -->
                    <div class="variant-empty">
                      <div class="ve-icon">{@html gen.svg}</div>
                      <p>No {gen.name} variations yet</p>
                      <div class="ve-actions">
                        <button
                          class="btn-generate"
                          style="--gb:{gen.bg};--gf:{gen.fg}"
                          onclick={() => generateV(gen.key)}
                        >⚡ Generate</button>
                        <button
                          class="btn-add-var"
                          onclick={() => addManualVariation(gen.key)}
                        >+ Add Manually</button>
                      </div>
                    </div>

                  {:else}
                    <!-- ── VARIATION STRIP + ACTIONS ── -->
                    <div class="var-strip-header">
                      {#if genVars.length > 1}
                        <div class="var-strip">
                          {#each genVars as variation}
                            {#if renamingVarId === variation.id}
                              <!-- Rename mode: div, not button — avoids invalid interactive-in-button nesting -->
                              <div class="vstrip-item active status-{variation.status} renaming">
                                <input
                                  class="vstrip-rename"
                                  bind:value={renameDraft}
                                  use:focusAndSelect
                                  onblur={() => saveRename(gen.key, variation.id)}
                                  onmousedown={e => e.stopPropagation()}
                                  onkeydown={e => {
                                    if (e.key === 'Enter') { e.preventDefault(); saveRename(gen.key, variation.id); }
                                    else if (e.key === 'Escape') { e.stopPropagation(); renamingVarId = null; }
                                  }}
                                />
                              </div>
                            {:else}
                              <button
                                class="vstrip-item {isActiveVar(gen.key, variation.id) ? 'active' : ''} status-{variation.status}"
                                onclick={() => setActiveVariation(gen.key, variation.id)}
                                ondblclick={() => startRenameVar(variation.id, variation.name)}
                                title="Double-click to rename"
                              >
                                <span class="vstrip-name">{variation.name}</span>
                                {#if variation.status === 'curated'}<span class="vstrip-badge">✦</span>{/if}
                                {#if variation.status === 'approved'}<span class="vstrip-badge ok">✓</span>{/if}
                                {#if variation.mode === 'manual'}<span class="vstrip-badge manual">M</span>{/if}
                              </button>
                            {/if}
                          {/each}
                        </div>
                      {/if}
                      <div class="var-strip-btns">
                        <button class="btn-gen-new" onclick={() => generateV(gen.key)} title="Generate new variation">⚡ Generate</button>
                        <button class="btn-add-var-sm" onclick={() => addManualVariation(gen.key)} title="Add blank variation">+ Add</button>
                      </div>
                    </div>

                    <!-- ── ACTIVE VARIATION CONTENT ── -->
                    {#if activeVar}
                      {@const vstatus    = activeVar.status}
                      {@const isApproved = vstatus === 'approved'}
                      {@const isCurated  = vstatus === 'curated'}
                      {@const vexpanded  = isVExpanded(gen.key)}
                      {@const vviewMode  = getVViewMode(gen.key)}
                      {@const hasIR      = !!activeVar.ir && (gen.key === 'chatgpt' || gen.key === 'nano_banana')}

                      <!-- PERSISTENT HEADER -->
                      <div class="variant-panel-header">
                        <div class="vph-left">
                          <span class="status-badge {vstatus}">
                            {#if isApproved}✓ Approved{:else if isCurated}✦ Curated{:else}◦ Draft{/if}
                          </span>
                          {#if activeVar.settings?.model}
                            <span class="variant-model-tag">{MODEL_PROFILES[gen.key]?.find(p => p.key === activeVar.settings.model)?.name ?? activeVar.settings.model}</span>
                          {/if}
                          {#if activeVar.settings?.version}
                            <span class="variant-model-tag">{MODEL_PROFILES[gen.key]?.find(p => p.key === activeVar.settings.version)?.name ?? activeVar.settings.version}</span>
                          {/if}
                        </div>
                        <div class="vph-right">
                          {#if hasIR}
                            <button
                              class="btn-ir-toggle {vviewMode === 'ir' ? 'active' : ''}"
                              onclick={() => toggleVViewMode(gen.key)}
                              title={vviewMode === 'ir' ? 'Show prompt view' : 'Show semantic IR (JSON)'}
                            >{ vviewMode === 'ir' ? '◈ IR' : '{ }' }</button>
                          {/if}
                          <button
                            class="btn-expand-toggle"
                            onclick={() => toggleVExpand(gen.key)}
                            title={vexpanded ? 'Collapse' : 'Expand'}
                          >{vexpanded ? '↑' : '↓'}</button>
                        </div>
                      </div>

                      <!-- COLLAPSIBLE BODY -->
                      <div class="variant-collapse {vexpanded ? 'expanded' : ''}">
                        {#if !vexpanded}
                          <div class="variant-fade"></div>
                        {/if}

                        {#if editingVariant?.genKey === gen.key && editingVariant?.varId === activeVar.id}
                          <!-- EDIT MODE -->
                          {#if activeVar.positive !== undefined}
                            <div class="variant-editor">
                              <div class="sd-edit-block">
                                <span class="sd-label pos">Positive</span>
                                <textarea class="variant-textarea" bind:value={editDraft.positive} rows="6"></textarea>
                              </div>
                              <div class="sd-edit-block">
                                <span class="sd-label neg">Negative</span>
                                <textarea class="variant-textarea neg-textarea" bind:value={editDraft.negative} rows="4"></textarea>
                              </div>
                              <div class="editor-footer">
                                <span class="editor-hint">Saving marks this variation as Curated — protected from Generate All</span>
                                <div class="editor-actions">
                                  <button class="btn-act" onclick={discardVariantEdit}>Discard</button>
                                  <button class="btn-save-curated" onclick={saveVariantEdit}>✦ Save as Curated</button>
                                </div>
                              </div>
                            </div>
                          {:else}
                            <div class="variant-editor">
                              <textarea class="variant-textarea" bind:value={editDraft.text} rows="8"></textarea>
                              <div class="editor-footer">
                                <span class="editor-hint">Saving marks this variation as Curated — protected from Generate All</span>
                                <div class="editor-actions">
                                  <button class="btn-act" onclick={discardVariantEdit}>Discard</button>
                                  <button class="btn-save-curated" onclick={saveVariantEdit}>✦ Save as Curated</button>
                                </div>
                              </div>
                            </div>
                          {/if}

                        {:else}
                          <!-- VIEW MODE -->

                          <!-- Settings row -->
                          {#if gen.hasProfiles && MODEL_PROFILES[gen.key] && vviewMode !== 'ir'}
                            <div class="variant-settings">
                              <span class="vs-label">{gen.key === 'midjourney' ? 'Version' : 'Model'}</span>
                              <div class="vs-pills">
                                {#each MODEL_PROFILES[gen.key] as profile}
                                  {@const settingKey = gen.key === 'midjourney' ? 'version' : 'model'}
                                  {@const currentVal = gs[settingKey]}
                                  <button
                                    class="vs-pill {currentVal === profile.key ? 'active' : ''}"
                                    onclick={() => updateGenSetting(gen.key, settingKey, profile.key)}
                                    style="--gb:{gen.bg}"
                                  >{profile.name}</button>
                                {/each}
                              </div>
                              {#if gen.key === 'midjourney'}
                                <span class="vs-label vs-sep">AR</span>
                                <select class="vs-select" value={gs.aspectRatio ?? '16:9'}
                                  onchange={e => updateGenSetting('midjourney', 'aspectRatio', e.target.value)}>
                                  {#each MJ_RATIOS as r}<option value={r}>{r}</option>{/each}
                                </select>
                                <span class="vs-label vs-sep">Style</span>
                                <select class="vs-select" value={gs.style ?? 'raw'}
                                  onchange={e => updateGenSetting('midjourney', 'style', e.target.value)}>
                                  {#each MJ_STYLES as s}<option value={s.v}>{s.l}</option>{/each}
                                </select>
                              {/if}
                            </div>
                          {/if}

                          {#if vviewMode === 'ir' && activeVar.ir}
                            <div class="ir-view-wrap">
                              <div class="ir-view-header">
                                <span class="ir-label">Semantic IR · JSON</span>
                                <button class="btn-copy-sm {copiedKey === 'ir-' + gen.key ? 'ok' : ''}"
                                  onclick={() => copy(JSON.stringify(activeVar.ir, null, 2), 'ir-' + gen.key)}>
                                  {copiedKey === 'ir-' + gen.key ? '✓ Copied' : 'Copy'}
                                </button>
                              </div>
                              <pre class="ir-pre">{JSON.stringify(activeVar.ir, null, 2)}</pre>
                            </div>
                          {:else}
                            <!-- PROMPT VIEW -->
                            {#if activeVar.positive !== undefined}
                              <div class="sd-block">
                                <div class="sd-label-row">
                                  <span class="sd-label pos">Positive</span>
                                  <button class="btn-copy-sm {copiedKey === 'sd-pos-' + activeVar.id ? 'ok' : ''}"
                                    onclick={() => copy(activeVar.positive, 'sd-pos-' + activeVar.id)}>
                                    {copiedKey === 'sd-pos-' + activeVar.id ? '✓' : 'Copy'}
                                  </button>
                                </div>
                                <pre class="prompt-pre" ondblclick={() => startVariantEdit(gen.key, activeVar)} title="Double-click to edit">{activeVar.positive}</pre>
                              </div>
                              <div class="sd-block">
                                <div class="sd-label-row">
                                  <span class="sd-label neg">Negative</span>
                                  <button class="btn-copy-sm {copiedKey === 'sd-neg-' + activeVar.id ? 'ok' : ''}"
                                    onclick={() => copy(activeVar.negative, 'sd-neg-' + activeVar.id)}>
                                    {copiedKey === 'sd-neg-' + activeVar.id ? '✓' : 'Copy'}
                                  </button>
                                </div>
                                <pre class="prompt-pre neg-pre" ondblclick={() => startVariantEdit(gen.key, activeVar)} title="Double-click to edit">{activeVar.negative}</pre>
                              </div>
                            {:else}
                              <pre class="prompt-pre" ondblclick={() => startVariantEdit(gen.key, activeVar)} title="Double-click to edit">{activeVar.text}</pre>
                            {/if}
                          {/if}

                          <!-- Actions -->
                          <div class="variant-actions">
                            {#if activeVar.positive === undefined && vviewMode !== 'ir'}
                              <button class="btn-copy-sm {copiedKey === activeVar.id ? 'ok' : ''}"
                                onclick={() => copy(activeVar.text, activeVar.id)}>
                                {copiedKey === activeVar.id ? '✓ Copied' : 'Copy'}
                              </button>
                            {/if}
                            <button class="btn-act" onclick={() => startVariantEdit(gen.key, activeVar)}>✎ Edit</button>
                            <button class="btn-act" onclick={() => regenVariation(gen.key, activeVar.id)} title={isCurated || isApproved ? 'Protected — cannot regen' : 'Regenerate this variation'} disabled={isCurated || isApproved}>↺ Regen</button>
                            <button class="btn-act" onclick={() => duplicateVariation(gen.key, activeVar.id)}>⧉ Dupe</button>
                            <button class="btn-act" onclick={() => removeVariation(gen.key, activeVar.id)}>✕ Remove</button>
                            {#if !isApproved}
                              <button class="btn-approve" onclick={() => approveVariant(gen.key, activeVar.id)}>✓ Approve</button>
                            {:else}
                              <span class="approved-label">✓ Approved</span>
                            {/if}
                            {#if !isApproved}
                              <button
                                class="btn-curate {isCurated ? 'btn-curate-on' : ''}"
                                onclick={() => toggleCurated(gen.key, activeVar.id)}
                                title={isCurated ? 'Remove curation — allow regeneration' : 'Curate — protect from Generate All'}
                              >{isCurated ? '✦ Curated' : '✦ Curate'}</button>
                            {/if}
                          </div>

                          <!-- Result Gallery — Image workspace only -->
                          {#if selected.category === 'image'}
                            <div class="result-gallery">
                              <div class="rg-header">
                                <span class="rg-label">
                                  Results
                                  {#if (activeVar.results ?? []).length > 0}
                                    <span class="rg-count">{(activeVar.results ?? []).length}</span>
                                  {/if}
                                </span>
                                <label class="rg-add-btn" title="Import a result image">
                                  + Add
                                  <input type="file" accept="image/*" onchange={(e) => addResultImage(gen.key, activeVar.id, e)} style="display:none" />
                                </label>
                              </div>
                              {#if (activeVar.results ?? []).length > 0}
                                <div class="rg-strip">
                                  {#each (activeVar.results ?? []) as result, ri}
                                    <div class="rg-thumb-wrap">
                                      <button class="rg-thumb" onclick={() => openPreview(gen.key, activeVar.id, result, ri)}>
                                        <img src={result.dataUrl} alt="result {ri + 1}" />
                                        {#if result.isFavorite}
                                          <span class="rg-star">★</span>
                                        {/if}
                                      </button>
                                      <button class="rg-rm" onclick={() => removeResult(gen.key, activeVar.id, result.id)} title="Remove">×</button>
                                    </div>
                                  {/each}
                                </div>
                              {/if}
                            </div>
                          {/if}
                        {/if}

                      </div>
                      <!-- end .variant-collapse -->
                    {/if}
                  {/if}

                </div>
              {/if}
            {/each}
          {/if}
        </section>

        <!-- Reference Images — Image workspace only, feeds reference-aware compilers -->
        {#if selected.category === 'image'}
        <section class="detail-section">
          <div class="section-title-row">
            <span class="section-label">Reference Images
              <span class="section-label-sub">feeds ChatGPT · Claude · Nano Banana</span>
            </span>
            <label class="rg-add-btn" title="Attach reference image">
              + Add
              <input type="file" accept="image/*" onchange={addReferenceImage} style="display:none" />
            </label>
          </div>
          {#if (selected.images ?? []).length > 0}
            <div class="ref-strip">
              {#each (selected.images ?? []) as ref, ri}
                {@const refObj = typeof ref === 'object' ? ref : { id: ref, dataUrl: ref, label: '', role: 'character_reference', mode: 'preserve' }}
                <div class="ref-card">
                  <div class="ref-card-thumb-wrap">
                    <button
                      type="button"
                      class="ref-card-thumb-btn"
                      onclick={() => openImagePreview(refObj.dataUrl, refObj.label || `Reference #${ri + 1}`)}
                      title="Click to enlarge"
                      aria-label="Enlarge reference image"
                    >
                      <img src={refObj.dataUrl} alt={refObj.label || 'reference ' + (ri + 1)} class="ref-card-thumb" />
                    </button>
                    <button class="rg-rm" onclick={() => removeReferenceImage(refObj.id)} title="Remove">×</button>
                    <span class="ref-num">#{ri + 1}</span>
                  </div>
                  <input
                    class="ref-card-label"
                    value={refObj.label ?? ''}
                    onblur={(e) => updateImageRefField(refObj.id, 'label', e.target.value)}
                    placeholder="Label…"
                  />
                  <select
                    class="ref-card-role"
                    value={refObj.role ?? 'character_reference'}
                    onchange={(e) => updateImageRefField(refObj.id, 'role', e.target.value)}
                  >
                    <option value="character_reference">Character</option>
                    <option value="style_reference">Style</option>
                    <option value="pose_reference">Pose</option>
                    <option value="background_reference">Background</option>
                    <option value="composition_reference">Composition</option>
                    <option value="color_palette_reference">Color Palette</option>
                    <option value="outfit_reference">Outfit</option>
                    <option value="object_reference">Object</option>
                    <option value="scene_reference">Scene</option>
                  </select>
                  <select
                    class="ref-card-mode"
                    value={refObj.mode ?? 'preserve'}
                    onchange={(e) => updateImageRefField(refObj.id, 'mode', e.target.value)}
                  >
                    <option value="preserve">Preserve</option>
                    <option value="inspire">Inspire</option>
                    <option value="transform">Transform</option>
                    <option value="combine">Combine</option>
                    <option value="layout">Layout</option>
                  </select>
                </div>
              {/each}
            </div>
          {:else}
            <p class="ref-empty-hint">No reference images — attach images to enable reference-aware prompt compilation for ChatGPT, Claude, and Nano Banana.</p>
          {/if}
        </section>
        {/if}

        <!-- Library Tags — prompt organization / search -->
        <section class="detail-section">
          <span class="section-label">Library Tags</span>
          {#if (selected.tags ?? []).length}
            <div class="tags-row detail-tags-row">
              {#each selected.tags as tag}
                <span class="tag tag-pill">
                  {tag}<button class="tag-rm" onclick={() => removeDetailTag(tag)}>×</button>
                </span>
              {/each}
            </div>
          {/if}
          <div class="tag-input-wrap">
            <div class="tags-pill-box">
              <div class="tag-ac-wrap">
                <input
                  class="tag-input"
                  value={detailTagQuery}
                  oninput={onDetailTagInput}
                  onkeydown={onDetailTagKeydown}
                  onblur={() => setTimeout(() => detailShowSuggest = false, 150)}
                  placeholder="Add library tag…"
                />
                {#if detailShowSuggest && detailTagSuggest.length}
                  <ul class="ac-list">
                    {#each detailTagSuggest as s}
                      <li><button class="ac-item" onmousedown={() => pickDetailTagSuggestion(s)}>{s}</button></li>
                    {/each}
                  </ul>
                {/if}
              </div>
            </div>
          </div>
        </section>

        <!-- Generation Tags — SD ontology overrides, only when SD generator is enabled -->
        {#if hasSDGenerator}
          <section class="detail-section">
            <div class="section-title-row">
              <span class="section-label">Generation Tags
                <span class="section-label-sub">SD ontology · merged into SD compiler</span>
              </span>
            </div>
            {#if (selected.sd_tags ?? []).length}
              <div class="tags-row detail-tags-row">
                {#each selected.sd_tags as tag}
                  <span class="tag tag-pill sd-tag-pill">
                    {tag}<button class="tag-rm" onclick={() => removeSDTag(tag)}>×</button>
                  </span>
                {/each}
              </div>
            {/if}
            <div class="tag-input-wrap">
              <div class="tags-pill-box">
                <div class="tag-ac-wrap">
                  <input
                    class="tag-input"
                    value={sdTagQuery}
                    oninput={onSDTagInput}
                    onkeydown={onSDTagKeydown}
                    onblur={() => setTimeout(() => sdShowSuggest = false, 150)}
                    placeholder="Search Danbooru ontology tags…"
                  />
                  {#if sdShowSuggest && sdTagSuggest.length}
                    <ul class="ac-list">
                      {#each sdTagSuggest as s}
                        <li><button class="ac-item" onmousedown={() => pickSDTagSuggestion(s)}>{s}</button></li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </div>
            </div>
            <p class="gen-tag-hint">These tags are compiler overrides — they merge into the SD positive prompt after semantic extraction. Use valid Danbooru ontology tags only.</p>
          </section>
        {/if}

        <!-- Notes — always editable inline -->
        <section class="detail-section">
          <span class="section-label">Notes</span>
          <textarea
            class="detail-notes-textarea"
            bind:value={notesDraft}
            onblur={saveNotesDraft}
            placeholder="Tips, settings, observations, checkpoint ideas…"
            rows="3"
          ></textarea>
        </section>

      </div>
    {:else}
      <div class="empty-state">
        <div class="empty-icon">{sectionIcon(activeSection)}</div>
        {#if activeSection === 'trash'}
          <p class="empty-title">Trash</p>
          <p class="empty-sub">Select a deleted prompt on the left to restore or permanently delete it.</p>
        {:else}
          <p class="empty-title">No {sectionLabel(activeSection).toLowerCase()} prompt selected</p>
          <p class="empty-sub">Pick one from the sidebar or create a new one</p>
          <button class="btn-new" onclick={openNew}>+ New {sectionLabel(activeSection)} Prompt</button>
        {/if}
      </div>
    {/if}
  </main>
</div>

<!-- ═══════════════════════════════════════ TOAST ══════════════════════════ -->
{#if toast}
  <div class="toast" class:toast-error={toast.kind === 'error'} class:toast-info={toast.kind === 'info'} role="status" aria-live="polite">
    {#if toast.kind === 'error'}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    {:else}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
    {/if}
    <span>{toast.message}</span>
  </div>
{/if}

<!-- ═══════════════════════════════════════ MODAL ══════════════════════════ -->
{#if showModal && editingPrompt}
  <div class="overlay" onclick={closeOverlay} role="presentation">
    <div class="modal" role="dialog" aria-modal="true">

      <div class="modal-header">
        <h3>{prompts.find(p => p.id === editingPrompt.id) ? "Edit Prompt" : "New Prompt"}</h3>
        <button class="modal-close" onclick={() => showModal = false}>×</button>
      </div>

      <!-- Category + Title -->
      <div class="form-row-2">
        <label class="field">
          <span>Category</span>
          <div class="cat-tabs">
            {#each SECTIONS as sec}
              <button
                class="cat-tab {editingPrompt.category === sec ? 'active' : ''}"
                onclick={() => editingPrompt.category = sec}
              >{sectionIcon(sec)} {sectionLabel(sec)}</button>
            {/each}
          </div>
        </label>

        <label class="field">
          <span>Title</span>
          <input bind:value={editingPrompt.title} placeholder="Give it a name…" />
        </label>
      </div>

      <!-- Master Prompt -->
      <label class="field">
        <span>Prompt</span>
        <textarea bind:value={editingPrompt.master_prompt} rows="6"
          placeholder="Write your master prompt here. Variants will be generated from this.">
        </textarea>
      </label>

      <!-- Provider / Generator multi-select — workspace-aware -->
      <div class="field">
        <span class="field-label">Works with</span>

        {#if editingPrompt.category === 'general'}
          <!-- General: flat provider list -->
          <div class="gen-grid">
            {#each GENERAL_GENERATORS as gen}
              {@const active = (editingPrompt.supported_generators ?? []).includes(gen.key)}
              <button
                class="gen-btn {active ? 'gen-btn-on' : ''}"
                style="--gb:{gen.bg};--gf:{gen.fg}"
                onclick={() => toggleModalGenerator(gen.key)}
                title={gen.name}
                type="button"
              >
                <span class="gen-btn-icon">{@html gen.svg}</span>
                <span class="gen-btn-label">{gen.name}</span>
              </button>
            {/each}
          </div>
        {:else}
          <!-- Image: Tier 1 + Tier 2 generators -->
          <div class="gen-tier-label">Tier 1 — Primary</div>
          <div class="gen-grid">
            {#each GENERATORS_T1 as gen}
              {@const active = (editingPrompt.supported_generators ?? []).includes(gen.key)}
              <button
                class="gen-btn {active ? 'gen-btn-on' : ''}"
                style="--gb:{gen.bg};--gf:{gen.fg}"
                onclick={() => toggleModalGenerator(gen.key)}
                title={gen.name}
                type="button"
              >
                <span class="gen-btn-icon">{@html gen.svg}</span>
                <span class="gen-btn-label">{gen.name}</span>
              </button>
            {/each}
          </div>

          <div class="gen-tier-label t2">Tier 2 — Extended</div>
          <div class="gen-grid gen-grid-t2">
            {#each GENERATORS_T2 as gen}
              {@const active = (editingPrompt.supported_generators ?? []).includes(gen.key)}
              <button
                class="gen-btn gen-btn-sm {active ? 'gen-btn-on' : ''}"
                style="--gb:{gen.bg};--gf:{gen.fg}"
                onclick={() => toggleModalGenerator(gen.key)}
                title={gen.name}
                type="button"
              >
                <span class="gen-btn-icon">{@html gen.svg}</span>
                <span class="gen-btn-label">{gen.name}</span>
              </button>
            {/each}
          </div>

          <!-- Model profile pickers for selected generators with profiles -->
          {#if (editingPrompt.supported_generators ?? []).some(k => GENERATORS_MAP[k]?.hasProfiles && MODEL_PROFILES[k])}
            {@const profileGens = (editingPrompt.supported_generators ?? []).map(k => GENERATORS_MAP[k]).filter(g => g?.hasProfiles && MODEL_PROFILES[g.key])}
            <div class="modal-profiles">
              {#each profileGens as gen}
                {@const settingKey = gen.key === 'midjourney' ? 'version' : 'model'}
                {@const currentVal = editingPrompt.generator_settings?.[gen.key]?.[settingKey] ?? DEFAULT_SETTINGS[gen.key]?.[settingKey]}
                <div class="mp-row">
                  <div class="mp-gen-icon" style="--gb:{gen.bg};--gf:{gen.fg}">{@html gen.svg}</div>
                  <span class="mp-label">{gen.key === 'midjourney' ? 'Version' : 'Model'}</span>
                  <div class="mp-pills">
                    {#each MODEL_PROFILES[gen.key] as profile}
                      <button
                        class="mp-pill {currentVal === profile.key ? 'active' : ''}"
                        onclick={() => updateModalGenSetting(gen.key, settingKey, profile.key)}
                        style="--gb:{gen.bg}"
                        type="button"
                      >{profile.name}</button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <!-- Tags with autocomplete -->
      <div class="field">
        <span class="field-label">
          Tags
          {#if editingPrompt.category === 'image'}
            <em>(Danbooru autocomplete)</em>
          {/if}
        </span>

        <!-- Quick picks for image prompts -->
        {#if editingPrompt.category === 'image'}
          <div class="quick-picks">
            {#each Object.entries(QUICK_TAGS) as [group, tags]}
              <div class="qp-group">
                <span class="qp-label">{group}</span>
                <div class="qp-tags">
                  {#each tags as qt}
                    <button
                      class="qtag {editingPrompt.tags.includes(qt) ? 'qtag-on' : ''}"
                      onclick={() => editingPrompt.tags.includes(qt) ? removeTag(qt) : addTag(qt)}
                    >{qt}</button>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Tag input + autocomplete -->
        <div class="tag-input-wrap">
          <div class="tags-pill-box">
            {#each editingPrompt.tags as tag}
              <span class="tag tag-pill">
                {tag}<button class="tag-rm" onclick={() => removeTag(tag)}>×</button>
              </span>
            {/each}
            <div class="tag-ac-wrap">
              <input
                class="tag-input"
                value={tagQuery}
                oninput={onTagInput}
                onkeydown={onTagKeydown}
                onblur={() => setTimeout(() => showSuggest = false, 150)}
                placeholder={editingPrompt.category === 'image' ? "Type to search Danbooru tags…" : "Add tag…"}
              />
              {#if showSuggest && tagSuggestions.length}
                <ul class="ac-list">
                  {#each tagSuggestions as s}
                    <li>
                      <button class="ac-item" onmousedown={() => pickSuggestion(s)}>{s}</button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          </div>
        </div>
      </div>

      <!-- Notes -->
      <label class="field">
        <span>Notes <em>(optional)</em></span>
        <textarea bind:value={editingPrompt.notes} rows="2"
          placeholder="Tips, settings, observations…"></textarea>
      </label>

      <!-- Reference Images -->
      <div class="field">
        <span class="field-label">Reference Images <em>(ChatGPT · Claude · Nano Banana)</em></span>
        <label class="file-btn">
          + Add reference
          <input type="file" accept="image/*" onchange={addImage} style="display:none" />
        </label>
        {#if editingPrompt.images.length}
          <div class="modal-ref-list">
            {#each editingPrompt.images as img, i}
              {@const imgObj = typeof img === 'object' ? img : { dataUrl: img, label: '', role: 'character_reference', mode: 'preserve' }}
              <div class="modal-ref-row">
                <div class="modal-ref-thumb-wrap">
                  <img src={imgObj.dataUrl} alt="ref {i+1}" class="modal-ref-thumb" />
                  <button class="rm-img" onclick={() => removeImage(i)}>×</button>
                  <span class="ref-num">#{i+1}</span>
                </div>
                <div class="modal-ref-fields">
                  <input
                    class="modal-ref-label-input"
                    value={imgObj.label ?? ''}
                    oninput={(e) => updateEditingImage(i, 'label', e.target.value)}
                    placeholder="Label (e.g. Tafari, Background Hall)"
                  />
                  <div class="modal-ref-selects">
                    <select
                      class="modal-ref-select"
                      value={imgObj.role ?? 'character_reference'}
                      onchange={(e) => updateEditingImage(i, 'role', e.target.value)}
                    >
                      <option value="character_reference">Character</option>
                      <option value="style_reference">Style</option>
                      <option value="pose_reference">Pose</option>
                      <option value="background_reference">Background</option>
                      <option value="composition_reference">Composition</option>
                      <option value="color_palette_reference">Color Palette</option>
                      <option value="outfit_reference">Outfit</option>
                      <option value="object_reference">Object</option>
                      <option value="scene_reference">Scene</option>
                    </select>
                    <select
                      class="modal-ref-select"
                      value={imgObj.mode ?? 'preserve'}
                      onchange={(e) => updateEditingImage(i, 'mode', e.target.value)}
                    >
                      <option value="preserve">Preserve</option>
                      <option value="inspire">Inspire</option>
                      <option value="transform">Transform</option>
                      <option value="combine">Combine</option>
                      <option value="layout">Layout</option>
                    </select>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn-cancel" onclick={() => showModal = false}>Cancel</button>
        <button
          class="btn-save"
          onclick={saveModal}
          disabled={!editingPrompt.title.trim() || !editingPrompt.master_prompt.trim()}
        >Save</button>
      </div>
    </div>
  </div>
{/if}

<!-- ═══════════════════════════ RECOVERY MODAL ═══════════════════════════════ -->
{#if showRecoveryModal}
  <div class="rec-overlay" role="presentation">
    <div class="rec-panel" role="dialog" aria-modal="true">
      <div class="rec-icon">⚠</div>
      <h2 class="rec-title">Primary data could not be loaded</h2>
      <p class="rec-body">{loadError}</p>
      {#if dataFilePath}
        <div class="rec-path">File: <code>{dataFilePath}</code></div>
      {/if}
      {#if backupAvailable}
        <div class="rec-backup-info">
          ✓ A rolling backup is available — last saved {fmtDate(backupAvailable.modified)}
          ({Math.round(backupAvailable.size / 1024)} KB)
        </div>
        <div class="rec-actions">
          <button class="btn-primary" disabled={restoring} onclick={restoreFromBackupAction}>
            {restoring ? 'Restoring…' : 'Restore from backup'}
          </button>
          <button class="btn-act" onclick={continueWithEmptyState}>Continue with empty state</button>
        </div>
        <p class="rec-hint">"Continue with empty state" leaves your file on disk untouched (autosave stays paused).</p>
      {:else}
        <div class="rec-backup-info rec-no-backup">No backup file found.</div>
        <div class="rec-actions">
          <button class="btn-act" onclick={continueWithEmptyState}>Continue with empty state</button>
        </div>
        <p class="rec-hint">Your primary data file has not been touched. Autosave is paused. Open the data folder to inspect or recover manually.</p>
        <button class="btn-link" onclick={openDataFolder}>📂 Open data folder</button>
      {/if}
    </div>
  </div>
{/if}

<!-- ═══════════════════════════ SIMPLE IMAGE LIGHTBOX ════════════════════════ -->
{#if imagePreview}
  <div class="imgp-overlay" onclick={closeImagePreview} role="presentation">
    <button class="imgp-close" onclick={closeImagePreview} aria-label="Close preview">×</button>
    <div class="imgp-panel" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <img src={imagePreview.src} alt={imagePreview.label || 'Preview'} class="imgp-img" />
      {#if imagePreview.label}
        <div class="imgp-label">{imagePreview.label}</div>
      {/if}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && imagePreview) closeImagePreview(); }} />

<!-- ═══════════════════════════ RESULT GALLERY PREVIEW ═══════════════════════ -->
{#if galleryPreview}
  {@const _gvars = selected?.variants?.[galleryPreview.genKey]}
  {@const _pv    = Array.isArray(_gvars) ? _gvars.find(v => v.id === galleryPreview.varId) : null}
  {@const _pr    = _pv?.results ?? []}
  {@const _pgen  = GENERATORS_MAP[galleryPreview.genKey]}
  <div class="gp-overlay" onclick={closePreviewOverlay} role="presentation">
    <div class="gp-panel" role="dialog" aria-modal="true">
      <button class="gp-close" onclick={closePreview} title="Close">×</button>
      <div class="gp-img-wrap">
        <img src={galleryPreview.result.dataUrl} alt="Result preview" class="gp-img" />
        {#if galleryPreview.resultIdx > 0}
          <button class="gp-nav gp-prev" onclick={() => navigatePreview(-1)}>‹</button>
        {/if}
        {#if galleryPreview.resultIdx < _pr.length - 1}
          <button class="gp-nav gp-next" onclick={() => navigatePreview(1)}>›</button>
        {/if}
      </div>
      <div class="gp-controls">
        <div class="gp-meta">
          {#if _pgen}
            <div class="gp-gen-chip" style="--gb:{_pgen.bg};--gf:{_pgen.fg}">
              <span class="gp-gen-icon">{@html _pgen.svg}</span>
              <span>{_pgen.name}</span>
            </div>
          {/if}
          <span class="gp-date">{fmtDate(galleryPreview.result.metadata?.date ?? Date.now())}</span>
          {#if _pr.length > 1}
            <span class="gp-counter">{galleryPreview.resultIdx + 1} / {_pr.length}</span>
          {/if}
        </div>
        <button
          class="gp-fav {galleryPreview.result.isFavorite ? 'gp-fav-on' : ''}"
          onclick={() => toggleResultFavorite(galleryPreview.genKey, galleryPreview.varId, galleryPreview.result.id)}
          title={galleryPreview.result.isFavorite ? 'Remove favorite' : 'Mark as favorite'}
        >{galleryPreview.result.isFavorite ? '★' : '☆'}</button>
      </div>
      <textarea
        class="gp-note"
        bind:value={previewNoteDraft}
        onblur={savePreviewNote}
        placeholder="Note — seed, settings, observations…"
        rows="2"
      ></textarea>
    </div>
  </div>
{/if}

<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :global(body) {
    background: #111;
    color: #e5e5e5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Layout ── */
  .layout { display: flex; height: 100vh; overflow: hidden; }

  /* ── Sidebar ── */
  .sidebar {
    width: 280px; min-width: 220px;
    /* Content zone color (tabs, search, list) — header + footer use #111 instead.
       No right border: it would draw a visible seam against the #111 header/footer rails. */
    background: #171717;
    display: flex; flex-direction: column; overflow: hidden;
  }

  .sidebar-top {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 14px 10px;
    background: #111; /* match sidebar + main panel — single continuous surface */
  }

  .logo { font-size: 15px; font-weight: 700; color: #AAF0D1; letter-spacing: .03em; display: flex; align-items: center; gap: 7px; }
  .logo-icon { width: 22px; height: 22px; flex-shrink: 0; }

  .sidebar-top-actions { display: flex; gap: 6px; align-items: center; }

  /* Pinned bottom utility bar inside the sidebar — does not scroll with the list */
  .sidebar-bottom-actions {
    flex-shrink: 0;
    display: flex; gap: 8px; align-items: center;
    padding: 12px 12px 18px;
    background: #111; /* match sidebar + main panel — single continuous surface */
  }
  /* Pushes the Trash button to the far right, separating utilities from recovery action */
  .bottom-actions-spacer { flex: 1; }

  /* Trash button — active state when viewing Trash; coral accent for recovery */
  .btn-trash-toggle { position: relative; }
  .btn-trash-toggle.active {
    background: #2a1a14;
    color: #ff9b6b;
    border-color: #4a2920;
  }
  .btn-trash-toggle.active:hover { background: #3a201a; color: #ffb189; border-color: #ff9b6b; }
  .btn-trash-toggle:hover { color: #ff9b6b; border-color: #4a2920; }
  .bottom-trash-badge {
    position: absolute;
    top: -4px; right: -4px;
    background: #ff9b6b; color: #1a1a1a;
    border-radius: 999px;
    font-size: 9px; font-weight: 700;
    padding: 1px 5px;
    min-width: 14px; height: 14px;
    line-height: 12px; text-align: center;
    border: 1px solid #171717;
  }
  .btn-icon { background: none; border: none; color: #AAF0D1; font-size: 18px; cursor: pointer; padding: 4px 6px; border-radius: 4px; }
  .btn-icon:hover { background: #1e1e1e; }
  .btn-icon-only {
    background: transparent;
    border: 1px solid #262626;
    color: #888;
    cursor: pointer;
    padding: 5px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .btn-icon-only:hover { background: #1a1a1a; color: #AAF0D1; border-color: #2e3e36; }
  .btn-icon-only:active { background: #222; }

  .import-banner {
    padding: 10px 12px; margin: 8px 10px 0; background: #0d2419; border: 1px solid #1a4a30; border-radius: 4px;
    font-size: 13px; color: #AAF0D1; text-align: center;
  }
  .import-banner.error { background: #3b0f0f; border-color: #7f1d1d; color: #f87171; }
  .import-banner.done { background: #052e16; border-color: #166534; color: #4ade80; }

  .update-banner {
    padding: 10px 12px; margin: 8px 10px 0; background: #0d1f2a; border: 1px solid #1a4a5a; border-radius: 4px;
    font-size: 13px; color: #60a5fa; display: flex; justify-content: space-between; align-items: center;
  }
  .update-actions { display: flex; gap: 6px; }
  .btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 4px; border: none; cursor: pointer; }
  .btn-update { background: #1e40af; color: #fff; }
  .btn-update:hover { background: #1e3a8a; }
  .btn-dismiss { background: #1e1e1e; color: #aaa; border: 1px solid #2e2e2e; }
  .btn-dismiss:hover { border-color: #555; color: #e5e5e5; }

  /* Section tabs */
  .section-tabs { display: flex; border-bottom: 1px solid #252525; }
  .sec-tab {
    flex: 1; background: none; border: none; color: #666;
    font-size: 11px; font-weight: 600; padding: 8px 4px; cursor: pointer;
    transition: all .15s; border-bottom: 2px solid transparent; white-space: nowrap;
  }
  .sec-tab:hover { color: #aaa; }
  .sec-tab.active { color: #AAF0D1; border-bottom-color: #AAF0D1; }

  /* Trash toolbar above prompt list */
  .trash-toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid #1e1e1e;
    background: #161311;
  }
  .trash-toolbar-hint { font-size: 11px; color: #888; flex: 1; }
  .btn-sm { font-size: 11px; padding: 4px 8px; border-radius: 5px; }

  /* In-detail chip showing days-left countdown for trashed prompts */
  .detail-trash-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: #2a1a14; color: #ff9b6b;
    border: 1px solid #4a2920;
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 11px; font-weight: 600;
  }

  /* Outline danger button — used for permanent delete (extra friction) and empty-trash */
  .btn-danger-outline {
    background: transparent;
    color: #ff8a8a;
    border: 1px solid #5a2828;
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px; font-weight: 500;
    cursor: pointer;
    transition: background .12s, border-color .12s, color .12s;
  }
  .btn-danger-outline:hover { background: #2a1414; border-color: #ff8a8a; color: #ffb8b8; }

  /* Restore button — soft mint */
  .btn-restore { color: #AAF0D1; border-color: #2e3e36 !important; }
  .btn-restore:hover { background: #16241e; border-color: #AAF0D1 !important; }

  /* Search */
  .search-wrap {
    padding: 8px 10px; border-bottom: 1px solid #1e1e1e;
    display: flex; gap: 6px; align-items: center;
  }
  .search {
    flex: 1; min-width: 0;
    background: #1e1e1e; border: 1px solid #2e2e2e;
    border-radius: 6px; color: #e5e5e5; padding: 6px 10px;
    font-size: 13px; outline: none;
  }
  .search:focus { border-color: #AAF0D1; }
  .sort-select {
    background: #1e1e1e; border: 1px solid #2e2e2e;
    border-radius: 6px; color: #c5c5c5; padding: 6px 8px;
    font-size: 11px; outline: none; cursor: pointer;
    font-family: inherit; max-width: 120px;
  }
  .sort-select:hover { border-color: #3e3e3e; }
  .sort-select:focus { border-color: #AAF0D1; }

  /* Toast — bottom-middle popup */
  .toast {
    position: fixed; left: 50%; bottom: 32px;
    transform: translateX(-50%);
    background: #1a1a1a; color: #AAF0D1;
    border: 1px solid #2e3e36;
    border-radius: 8px; padding: 10px 16px;
    font-size: 13px; font-weight: 500;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    display: inline-flex; align-items: center; gap: 8px;
    z-index: 10000;
    animation: toast-in 0.2s ease-out;
    max-width: 80vw;
  }
  .toast-error { color: #ff8a8a; border-color: #4a2020; }
  .toast-info  { color: #9ec5ff; border-color: #1f3550; }
  @keyframes toast-in {
    from { opacity: 0; transform: translate(-50%, 12px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }

  /* Recovery modal — shown if startup load fails (offers Restore from backup) */
  .rec-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 10002;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .rec-panel {
    background: #1a1a1a;
    border: 1px solid #3a2a2a;
    border-radius: 12px;
    padding: 28px;
    max-width: 540px; width: 100%;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    color: #e5e5e5;
  }
  .rec-icon { font-size: 36px; color: #ff9b6b; text-align: center; margin-bottom: 12px; }
  .rec-title { font-size: 18px; font-weight: 700; color: #ff9b6b; margin-bottom: 12px; text-align: center; }
  .rec-body {
    background: #2a1414; color: #ffb8b8;
    border: 1px solid #4a2020;
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12px; font-family: ui-monospace, "SF Mono", Consolas, monospace;
    margin-bottom: 12px;
    word-break: break-word;
  }
  .rec-path { font-size: 12px; color: #888; margin-bottom: 16px; }
  .rec-path code {
    background: #0d0d0d; padding: 2px 6px; border-radius: 3px;
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
  }
  .rec-backup-info {
    background: #0d2419; color: #AAF0D1;
    border: 1px solid #2e3e36;
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 13px;
    margin-bottom: 16px;
  }
  .rec-backup-info.rec-no-backup { background: #1f1a14; color: #d9b27a; border-color: #4a3a20; }
  .rec-actions { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .rec-actions .btn-primary {
    background: #AAF0D1; color: #0d2419; border: none;
    border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600;
    cursor: pointer; transition: background .15s;
  }
  .rec-actions .btn-primary:hover:not(:disabled) { background: #7ADBB4; }
  .rec-actions .btn-primary:disabled { opacity: 0.6; cursor: wait; }
  .rec-hint { font-size: 11px; color: #777; line-height: 1.5; }
  .btn-link {
    background: none; border: none; color: #AAF0D1;
    cursor: pointer; padding: 6px 0; font-size: 12px;
    text-decoration: underline; margin-top: 8px;
  }
  .btn-link:hover { color: #fff; }

  /* Hard error banner — shown when startup load fails. Cannot be dismissed; persists until restart. */
  .load-error-banner {
    position: fixed; top: 0; left: 0; right: 0;
    background: #2a1414; color: #ffb8b8;
    border-bottom: 2px solid #ff8a8a;
    padding: 12px 20px;
    z-index: 10001;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    font-size: 13px;
  }
  .load-error-title { font-weight: 700; color: #ffb8b8; font-size: 14px; margin-bottom: 4px; }
  .load-error-body { line-height: 1.5; }
  .load-error-path, .load-error-detail, .load-error-hint { margin-top: 4px; color: #d8a8a8; }
  .load-error-path code, .load-error-detail code {
    background: #1a0808; padding: 2px 6px; border-radius: 3px;
    font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px;
  }

  /* Cover + reference thumbnail "click to zoom" wrappers */
  .master-thumb-slot-imgbtn,
  .ref-card-thumb-btn {
    display: block; padding: 0; margin: 0; border: 0; background: none;
    cursor: zoom-in; width: 100%; height: 100%;
    border-radius: inherit; overflow: hidden;
  }
  .master-thumb-slot-imgbtn:hover .master-thumb-slot-img,
  .ref-card-thumb-btn:hover .ref-card-thumb {
    transform: scale(1.04);
    filter: brightness(1.08);
  }
  .master-thumb-slot-img,
  .ref-card-thumb {
    transition: transform 0.18s ease, filter 0.18s ease;
  }

  /* Simple image lightbox */
  .imgp-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.88);
    z-index: 9999;
    display: flex; align-items: center; justify-content: center;
    padding: 40px;
    animation: imgp-fade 0.15s ease-out;
  }
  @keyframes imgp-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .imgp-panel {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    max-width: 100%; max-height: 100%;
  }
  .imgp-img {
    max-width: 100%; max-height: calc(100vh - 120px);
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  }
  .imgp-label {
    color: #AAF0D1; font-size: 13px; font-weight: 500;
    background: rgba(20, 20, 20, 0.8);
    padding: 6px 14px; border-radius: 6px;
    border: 1px solid #2a2a2a;
  }
  .imgp-close {
    position: fixed; top: 16px; right: 20px;
    width: 36px; height: 36px;
    background: rgba(20, 20, 20, 0.8);
    border: 1px solid #2a2a2a;
    color: #e5e5e5;
    border-radius: 50%;
    font-size: 22px; line-height: 1;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .imgp-close:hover { background: #2a2a2a; color: #AAF0D1; border-color: #AAF0D1; }

  /* Prompt list */
  .prompt-list { flex: 1; overflow-y: auto; padding: 6px 8px; }
  .prompt-list::-webkit-scrollbar { width: 4px; }
  .prompt-list::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

  .pcard {
    position: relative;
    width: 100%; background: none; border: 1px solid transparent;
    border-radius: 8px; padding: 9px 11px; text-align: left;
    cursor: pointer; color: #ccc; margin-bottom: 4px;
    transition: background .12s, border-color .12s;
  }
  .pcard:hover { background: #1d1d1d; border-color: #2a2a2a; }
  .pcard.active { background: #0d2419; border-color: #AAF0D130; color: #e5e5e5; }
  .pcard.pcard-fav { border-color: #AAF0D125; }

  /* Pin/favorite button on prompt cards — bottom right corner */
  .pcard-fav-btn {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 24px; height: 24px;
    background: transparent;
    border: none;
    color: #3a3a3a;
    cursor: pointer;
    border-radius: 4px;
    display: inline-flex; align-items: center; justify-content: center;
    opacity: 0;
    transition: opacity .12s, color .12s, background .12s, transform .12s;
    z-index: 1;
  }
  .pcard:hover .pcard-fav-btn { opacity: 1; }
  .pcard-fav-btn:hover { background: #1f1f1f; color: #AAF0D1; transform: scale(1.1); }
  .pcard-fav-btn.on {
    color: #FFD66B;
    opacity: 1;
  }
  .pcard-fav-btn.on:hover { color: #FFC93C; background: #1f1f1f; }

  .pcard-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; gap: 6px; }
  .pcard-title { font-size: 13px; font-weight: 600; color: #e5e5e5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .pcard-preview {
    font-size: 12px; color: #666; line-height: 1.4; margin-bottom: 5px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pcard-tags { display: flex; flex-wrap: wrap; gap: 3px; }
  .list-empty { color: #444; font-size: 12px; text-align: center; padding: 28px 12px; }

  /* Sidebar generator XS icons */
  .pcard-gens { display: flex; gap: 3px; flex-shrink: 0; align-items: center; }
  .gen-xs {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; flex-shrink: 0;
    background: var(--gb); color: var(--gf, #fff);
    border-radius: 4px; transition: transform .1s;
  }
  .gen-xs:hover { transform: scale(1.1); }
  .gen-xs :global(svg) { width: 12px; height: 12px; }
  .gen-xs-more {
    font-size: 9px; font-weight: 700; color: #555;
    background: #1e1e1e; border: 1px solid #2a2a2a;
    border-radius: 4px; padding: 1px 4px; line-height: 18px;
  }

  /* ── Main ── */
  .main { flex: 1; overflow-y: auto; background: #111; }
  .main::-webkit-scrollbar { width: 5px; }
  .main::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }

  .detail { max-width: 820px; padding: 26px 30px; display: flex; flex-direction: column; gap: 22px; }

  .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .detail-title { font-size: 22px; font-weight: 700; color: #f0f0f0; margin-bottom: 6px; line-height: 1.2; }
  .detail-meta { font-size: 12px; color: #555; }
  .detail-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }

  .detail-title-block { display: flex; flex-direction: column; gap: 4px; }
  .detail-title-row { display: flex; align-items: center; gap: 10px; }
  .detail-title-row .detail-title,
  .detail-title-row .title-edit-input { margin-bottom: 0; flex: 1; min-width: 0; }

  /* Detail-page favorite star — bigger, animated */
  .detail-fav-btn {
    background: transparent;
    border: 1px solid transparent;
    color: #555;
    cursor: pointer;
    padding: 6px;
    border-radius: 8px;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: color .15s, background .15s, border-color .15s, transform .15s;
  }
  .detail-fav-btn:hover { color: #FFD66B; background: #1a1a1a; }
  .detail-fav-btn.on {
    color: #FFD66B;
    animation: fav-pop 0.45s cubic-bezier(.34, 1.56, .64, 1);
  }
  .detail-fav-btn.on:hover { color: #FFC93C; background: #1a1a1a; }
  @keyframes fav-pop {
    0%   { transform: scale(0.6) rotate(-12deg); filter: drop-shadow(0 0 0 transparent); }
    50%  { transform: scale(1.35) rotate(8deg);  filter: drop-shadow(0 0 12px #FFD66B); }
    75%  { transform: scale(0.92) rotate(-3deg); }
    100% { transform: scale(1) rotate(0);        filter: drop-shadow(0 0 0 transparent); }
  }
  .detail-meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  /* ── Generator ecosystem toggle row ── */
  .gen-ecosystem { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }

  .eco-btn {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 8px; border: 1px solid transparent;
    background: transparent; cursor: pointer; transition: all .15s;
    color: #2e2e2e;
  }
  .eco-btn:hover { background: #1e1e1e; border-color: #333; color: #555; }

  /* Enabled: colored tint */
  .eco-btn.eco-on {
    background: color-mix(in srgb, var(--gb) 14%, transparent);
    border-color: color-mix(in srgb, var(--gb) 35%, transparent);
    color: var(--gf, #fff);
  }
  .eco-btn.eco-on:hover { background: color-mix(in srgb, var(--gb) 22%, transparent); }

  /* Approved: solid fill */
  .eco-btn.eco-approved {
    background: var(--gb); border-color: var(--gb); color: var(--gf, #fff);
    box-shadow: 0 0 8px color-mix(in srgb, var(--gb) 35%, transparent);
  }
  .eco-btn.eco-approved:hover { opacity: .85; }

  .eco-icon { display: inline-flex; width: 17px; height: 17px; }
  .eco-icon :global(svg) { width: 17px; height: 17px; }

  /* T2 smaller */
  .eco-btn.eco-sm { width: 26px; height: 26px; border-radius: 6px; }
  .eco-btn.eco-sm .eco-icon { width: 13px; height: 13px; }
  .eco-btn.eco-sm .eco-icon :global(svg) { width: 13px; height: 13px; }

  /* State indicators */
  .eco-dot {
    position: absolute; top: 3px; right: 3px;
    width: 5px; height: 5px; border-radius: 50%;
    background: #555; border: 1px solid #111;
  }
  .eco-btn.eco-on .eco-dot { background: color-mix(in srgb, var(--gb) 80%, #fff); }
  .eco-badge {
    position: absolute; top: -3px; right: -3px;
    width: 13px; height: 13px; border-radius: 50%;
    font-size: 7px; font-weight: 900;
    display: flex; align-items: center; justify-content: center;
    border: 1.5px solid #111;
  }
  .eco-sep { width: 1px; height: 22px; background: #252525; margin: 0 3px; align-self: center; flex-shrink: 0; }

  /* ── Collapsible master prompt ── */
  .prompt-header-actions { display: flex; align-items: center; gap: 6px; }
  .btn-expand-toggle {
    background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 5px;
    color: #555; font-size: 12px; padding: 3px 8px; line-height: 1.4;
    transition: all .15s;
  }
  .btn-expand-toggle:hover { border-color: #555; color: #aaa; }

  .prompt-collapse {
    position: relative; max-height: 82px; overflow: hidden;
    transition: max-height .28s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .prompt-collapse.expanded { max-height: 1200px; }
  .prompt-fade {
    position: absolute; bottom: 0; left: 0; right: 0; height: 34px;
    background: linear-gradient(transparent, #111); pointer-events: none;
  }

  /* ── Collapsible variant panels ── */
  .variant-panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 0 8px 0;
  }
  .vph-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .variant-collapse {
    /* Collapsed = preview of first ~3 lines, mirroring the Master Prompt collapsed state.
       Not zero-height: users should still see what's inside. */
    position: relative;
    max-height: 92px; overflow: hidden;
    transition: max-height .28s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .variant-collapse.expanded { max-height: 2000px; }
  .variant-fade {
    position: absolute; bottom: 0; left: 0; right: 0; height: 36px;
    background: linear-gradient(transparent, #111);
    pointer-events: none;
    z-index: 2;
  }

  /* Sections */
  .detail-section { display: flex; flex-direction: column; gap: 8px; }
  .section-title-row { display: flex; align-items: center; justify-content: space-between; }
  .section-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .08em; color: #555;
  }

  /* Prompt text */
  .prompt-pre {
    background: #181818; border: 1px solid #252525; border-radius: 8px;
    padding: 14px 16px; font-family: "Menlo", "Consolas", monospace;
    font-size: 13px; line-height: 1.6; color: #ccc;
    white-space: pre-wrap; word-break: break-word;
  }
  .neg-pre { color: #e06c75; }

  /* ── Variants ── */
  .variant-empty-state {
    background: #181818; border: 1px dashed #2a2a2a; border-radius: 8px;
    padding: 20px; text-align: center; color: #555; font-size: 13px;
  }
  .link-btn { background: none; border: none; color: #AAF0D1; font-size: 13px; cursor: pointer; text-decoration: underline; padding: 0; }

  /* Generate All button */
  .btn-gen-all {
    background: #0d2419; color: #AAF0D1; border: 1px solid #AAF0D130;
    border-radius: 6px; padding: 5px 14px; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all .15s;
  }
  .btn-gen-all:hover:not(:disabled) { background: #AAF0D1; color: #0d2419; border-color: #AAF0D1; }
  .btn-gen-all:disabled { opacity: .5; cursor: default; }
  .btn-gen-all.loading { animation: pulse .8s ease-in-out infinite alternate; }
  @keyframes pulse { from { opacity: .5; } to { opacity: 1; } }

  /* Variant tabs */
  .variant-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .vtab {
    display: flex; align-items: center; gap: 5px;
    background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 6px;
    color: #888; font-size: 11px; font-weight: 700; padding: 5px 10px;
    cursor: pointer; transition: all .15s; position: relative;
  }
  .vtab:hover { color: var(--gb); border-color: var(--gb); }
  .vtab.vtab-active { background: color-mix(in srgb, var(--gb) 15%, transparent); color: color-mix(in srgb, var(--gb) 90%, #fff); border-color: var(--gb); }
  .vtab-icon { display: inline-flex; width: 14px; height: 14px; }
  .vtab-icon :global(svg) { width: 14px; height: 14px; }
  .vtab-name { font-family: "Menlo", monospace; letter-spacing: .04em; }
  /* vtab-status styles are in the new block at the bottom */

  /* Variant settings row */
  .variant-settings {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    background: #181818; border: 1px solid #222; border-radius: 8px; padding: 8px 12px;
  }
  .vs-label { font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .05em; }
  .vs-sep { margin-left: 6px; }
  .vs-pills { display: flex; gap: 4px; flex-wrap: wrap; }
  .vs-pill {
    background: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 4px;
    color: #666; font-size: 11px; padding: 3px 8px; cursor: pointer; transition: all .12s;
  }
  .vs-pill:hover { color: #aaa; border-color: #444; }
  .vs-pill.active { background: color-mix(in srgb, var(--gb) 20%, transparent); color: color-mix(in srgb, var(--gb) 90%, #fff); border-color: var(--gb); }
  .vs-select {
    background: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 4px;
    color: #aaa; font-size: 11px; padding: 3px 6px; outline: none; cursor: pointer;
  }
  .vs-select:focus { border-color: #555; }

  /* Variant body */
  .variant-body { display: flex; flex-direction: column; gap: 10px; }
  .variant-empty {
    display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
    padding: 20px; background: #181818; border: 1px dashed #2a2a2a; border-radius: 8px;
  }
  .ve-icon { display: inline-flex; width: 24px; height: 24px; color: #333; }
  .ve-icon :global(svg) { width: 24px; height: 24px; }
  .variant-empty p { font-size: 13px; color: #555; }

  /* Status row */
  .status-row { display: flex; align-items: center; gap: 8px; }
  .status-badge {
    font-size: 11px; font-weight: 600; letter-spacing: .03em;
    border-radius: 4px; padding: 2px 8px;
  }
  .status-badge.approved { color: #22c55e; background: #052e16; border: 1px solid #166534; }
  .status-badge.draft    { color: #888;    background: #1a1a1a; border: 1px solid #2a2a2a; }
  .variant-model-tag {
    font-size: 10px; color: #555; background: #1a1a1a; border: 1px solid #222;
    border-radius: 3px; padding: 2px 6px; font-family: "Menlo", monospace;
  }

  /* Variant actions */
  .variant-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .btn-approve {
    background: #052e16; color: #22c55e; border: 1px solid #166534;
    border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all .15s;
  }
  .btn-approve:hover { background: #166534; }
  .approved-label { font-size: 12px; color: #22c55e; font-weight: 600; }

  /* Generate button */
  .btn-generate {
    background: var(--gb); color: var(--gf, #fff);
    border: none; border-radius: 6px; padding: 8px 18px;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity .15s;
  }
  .btn-generate:hover { opacity: .85; }

  /* SD blocks */
  .sd-block { display: flex; flex-direction: column; gap: 6px; }
  .sd-label-row { display: flex; align-items: center; justify-content: space-between; }
  .sd-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  .sd-label.pos { color: #4fc1a6; }
  .sd-label.neg { color: #e06c75; }

  /* Tags */
  .tags-row { display: flex; flex-wrap: wrap; gap: 5px; }
  .notes-text { font-size: 13px; color: #888; line-height: 1.5; }
  .images-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
  .result-img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; border: 1px solid #252525; }

  .tag {
    display: inline-flex; align-items: center;
    background: #0d2419; color: #AAF0D1;
    border: 1px solid #1a4a30; border-radius: 4px;
    padding: 2px 7px; font-size: 11px; font-weight: 500;
  }
  .tag-more { background: #1a1a1a; color: #555; border-color: #2a2a2a; }
  .tag-pill { gap: 4px; padding-right: 4px; }
  .tag-rm { background: none; border: none; color: #666; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 1px; }
  .tag-rm:hover { color: #e06c75; }

  /* Empty state */
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 10px; }
  .empty-icon { font-size: 36px; }
  .empty-title { font-size: 15px; font-weight: 600; color: #555; }
  .empty-sub { font-size: 13px; color: #3a3a3a; margin-bottom: 8px; }

  /* Buttons */
  button { cursor: pointer; font-family: inherit; }

  .btn-new {
    background: #AAF0D1; color: #0d2419; border: none;
    border-radius: 6px; padding: 6px 10px; font-size: 13px; font-weight: 600;
    transition: background .15s;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .btn-new:hover { background: #7ADBB4; }

  .btn-copy-sm {
    background: #1e1e1e; color: #999; border: 1px solid #2e2e2e;
    border-radius: 5px; padding: 4px 10px; font-size: 12px; transition: all .15s;
  }
  .btn-copy-sm:hover { border-color: #AAF0D1; color: #AAF0D1; }
  .btn-copy-sm.ok { background: #14532d; color: #4ade80; border-color: #166534; }

  .btn-act {
    background: #1e1e1e; color: #aaa; border: 1px solid #2e2e2e;
    border-radius: 6px; padding: 6px 12px; font-size: 13px; transition: all .15s;
  }
  .btn-act:hover { border-color: #555; color: #e5e5e5; }

  .btn-danger {
    background: #3b0f0f; color: #f87171; border: 1px solid #7f1d1d;
    border-radius: 6px; padding: 6px 12px; font-size: 13px;
  }
  .btn-danger:hover { background: #7f1d1d; }

  /* ── Modal ── */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.75);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; backdrop-filter: blur(2px);
  }

  .modal {
    background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 12px;
    width: 680px; max-width: 96vw; max-height: 92vh; overflow-y: auto;
    padding: 22px; display: flex; flex-direction: column; gap: 14px;
  }
  .modal::-webkit-scrollbar { width: 4px; }
  .modal::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

  .modal-header { display: flex; justify-content: space-between; align-items: center; }
  .modal-header h3 { font-size: 16px; font-weight: 700; color: #f0f0f0; }
  .modal-close { background: none; border: none; color: #555; font-size: 22px; line-height: 1; }
  .modal-close:hover { color: #e5e5e5; }

  .form-row-2 { display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: start; }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field > span, .field-label {
    font-size: 11px; font-weight: 700; color: #666;
    text-transform: uppercase; letter-spacing: .05em;
  }
  .field > span em, .field-label em { font-style: normal; font-weight: 400; color: #444; text-transform: none; letter-spacing: 0; }

  .field input, .field textarea {
    background: #111; border: 1px solid #2a2a2a; border-radius: 6px;
    color: #e5e5e5; padding: 8px 10px; font-size: 13px;
    font-family: inherit; outline: none; resize: vertical; transition: border-color .15s;
  }
  .field input:focus, .field textarea:focus { border-color: #AAF0D1; }

  /* Category tabs */
  .cat-tabs { display: flex; gap: 5px; }
  .cat-tab {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
    color: #666; font-size: 12px; padding: 6px 10px; cursor: pointer;
    transition: all .15s; white-space: nowrap;
  }
  .cat-tab:hover { color: #aaa; border-color: #444; }
  .cat-tab.active { background: #0d2419; color: #AAF0D1; border-color: #AAF0D1; }

  /* Generator grid */
  .gen-tier-label {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
    color: #444; margin-bottom: -2px; margin-top: 4px;
  }
  .gen-tier-label.t2 { margin-top: 8px; }

  .gen-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
    gap: 6px;
  }
  .gen-grid-t2 {
    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
  }

  .gen-btn {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 6px; padding: 12px 6px;
    background: #161616; border: 1.5px solid #2a2a2a;
    border-radius: 8px; cursor: pointer;
    transition: all .15s; position: relative; overflow: hidden;
  }
  .gen-btn-sm { padding: 9px 5px; gap: 4px; }

  .gen-btn::before {
    content: ''; position: absolute; inset: 0;
    background: var(--gb); opacity: 0; transition: opacity .15s;
  }
  .gen-btn:hover::before { opacity: .12; }
  .gen-btn:hover { border-color: var(--gb); }

  .gen-btn.gen-btn-on {
    background: var(--gb); border-color: var(--gb);
    box-shadow: 0 0 16px color-mix(in srgb, var(--gb) 35%, transparent);
  }
  .gen-btn.gen-btn-on::before { display: none; }

  .gen-btn-icon {
    display: inline-flex; width: 22px; height: 22px; position: relative; z-index: 1;
    color: #555; transition: color .15s;
  }
  .gen-btn-sm .gen-btn-icon { width: 18px; height: 18px; }
  .gen-btn-icon :global(svg) { width: 100%; height: 100%; }
  .gen-btn.gen-btn-on .gen-btn-icon { color: var(--gf, #fff); }
  .gen-btn:hover:not(.gen-btn-on) .gen-btn-icon { color: var(--gb); }

  .gen-btn-label {
    font-size: 9px; font-weight: 700; text-align: center;
    color: #555; line-height: 1.2; transition: color .15s;
    position: relative; z-index: 1;
  }
  .gen-btn-sm .gen-btn-label { font-size: 8.5px; }
  .gen-btn.gen-btn-on .gen-btn-label { color: var(--gf, #fff); }
  .gen-btn:hover:not(.gen-btn-on) .gen-btn-label { color: #ccc; }

  /* Model profile pickers in modal */
  .modal-profiles {
    background: #111; border: 1px solid #1e1e1e; border-radius: 8px;
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; margin-top: 4px;
  }
  .mp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .mp-gen-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 5px;
    background: var(--gb); color: var(--gf, #fff); flex-shrink: 0;
  }
  .mp-gen-icon :global(svg) { width: 13px; height: 13px; }
  .mp-label { font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .05em; flex-shrink: 0; }
  .mp-pills { display: flex; gap: 4px; flex-wrap: wrap; }
  .mp-pill {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 4px;
    color: #666; font-size: 10px; padding: 3px 8px; cursor: pointer; transition: all .12s;
  }
  .mp-pill:hover { color: #aaa; border-color: #444; }
  .mp-pill.active { background: color-mix(in srgb, var(--gb) 20%, transparent); color: color-mix(in srgb, var(--gb) 90%, #fff); border-color: var(--gb); }

  /* Quick pick tags */
  .quick-picks {
    display: flex; flex-direction: column; gap: 6px;
    background: #111; border: 1px solid #1e1e1e; border-radius: 8px; padding: 10px;
    max-height: 160px; overflow-y: auto;
  }
  .quick-picks::-webkit-scrollbar { width: 3px; }
  .quick-picks::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

  .qp-group { display: flex; gap: 6px; align-items: flex-start; }
  .qp-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #444; width: 52px; flex-shrink: 0; padding-top: 3px; }
  .qp-tags { display: flex; flex-wrap: wrap; gap: 3px; }

  .qtag {
    background: #1a1a1a; border: 1px solid #252525; border-radius: 3px;
    color: #666; font-size: 10px; font-family: "Menlo", monospace;
    padding: 2px 6px; cursor: pointer; transition: all .1s;
  }
  .qtag:hover { color: #AAF0D1; border-color: #AAF0D1; }
  .qtag.qtag-on { background: #0d2419; color: #AAF0D1; border-color: #AAF0D1; }

  /* Tag input */
  .tag-input-wrap { position: relative; }
  .tags-pill-box {
    display: flex; flex-wrap: wrap; gap: 5px; align-items: center;
    background: #111; border: 1px solid #2a2a2a; border-radius: 6px;
    padding: 6px 8px; min-height: 38px;
  }
  .tags-pill-box:focus-within { border-color: #AAF0D1; }
  .tag-ac-wrap { position: relative; flex: 1; min-width: 140px; }
  .tag-input { background: none; border: none; outline: none; color: #e5e5e5; font-size: 13px; width: 100%; padding: 2px 0; }

  .ac-list {
    position: absolute; top: calc(100% + 4px); left: 0;
    background: #1e1e1e; border: 1px solid #333; border-radius: 6px;
    list-style: none; padding: 4px; z-index: 200; min-width: 220px; max-height: 200px; overflow-y: auto;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
  }
  .ac-item {
    width: 100%; text-align: left; background: none; border: none;
    color: #ccc; font-size: 12px; font-family: "Menlo", monospace;
    padding: 5px 8px; border-radius: 4px; cursor: pointer; transition: background .1s;
  }
  .ac-item:hover { background: #2a2a2a; color: #AAF0D1; }

  /* File / images */
  .file-btn {
    display: inline-flex; background: #1a1a1a; border: 1px dashed #2e2e2e;
    border-radius: 6px; color: #666; padding: 7px 14px; font-size: 13px;
    cursor: pointer; width: fit-content; transition: all .15s;
  }
  .file-btn:hover { border-color: #AAF0D1; color: #AAF0D1; }

  .modal-imgs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .modal-img-wrap { position: relative; width: 80px; height: 80px; }
  .rm-img { position: absolute; top: -5px; right: -5px; background: #e53e3e; color: #fff; border: none; border-radius: 50%; width: 18px; height: 18px; font-size: 12px; display: flex; align-items: center; justify-content: center; }

  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 6px; border-top: 1px solid #222; }

  .btn-cancel { background: #1e1e1e; color: #aaa; border: 1px solid #2e2e2e; border-radius: 6px; padding: 8px 18px; font-size: 13px; }
  .btn-cancel:hover { color: #e5e5e5; border-color: #555; }

  .btn-save { background: #AAF0D1; color: #0d2419; border: none; border-radius: 6px; padding: 8px 22px; font-size: 13px; font-weight: 600; transition: background .15s; }
  .btn-save:hover:not(:disabled) { background: #7ADBB4; }
  .btn-save:disabled { opacity: .4; cursor: not-allowed; }

  /* ── Inline title editing ── */
  .editable-title { cursor: text; }
  .editable-title:hover { color: #fff; }
  .title-edit-input {
    font-size: 22px; font-weight: 700; color: #f0f0f0;
    background: #1a1a1a; border: 1.5px solid #AAF0D1;
    border-radius: 6px; padding: 4px 10px; outline: none;
    width: 100%; font-family: inherit; line-height: 1.2;
  }

  /* ── Inline master prompt editing ── */
  .btn-save-inline {
    background: #AAF0D1; color: #0d2419; border: none;
    border-radius: 5px; padding: 3px 10px; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: background .15s;
  }
  .btn-save-inline:hover { background: #7ADBB4; }

  .master-edit-textarea {
    width: 100%; background: #181818; border: 1.5px solid #AAF0D1;
    border-radius: 8px; color: #e5e5e5; padding: 14px 16px;
    font-family: "Menlo", "Consolas", monospace; font-size: 13px; line-height: 1.6;
    outline: none; resize: vertical; transition: border-color .15s;
  }
  .master-edit-textarea:focus { border-color: #AAF0D1; }

  /* ── Curated status badge ── */
  .status-badge.curated { color: #AAF0D1; background: #0d2419; border: 1px solid #AAF0D130; }

  /* ── Curated eco-badge ── */
  .eco-btn.eco-curated {
    background: color-mix(in srgb, var(--gb) 10%, transparent);
    border-color: color-mix(in srgb, var(--gb) 25%, transparent);
    color: var(--gb);
  }
  .eco-badge-approved { background: #22c55e; color: #fff; }
  .eco-badge-curated  { background: #AAF0D1; color: #0d2419; }

  /* ── Curated vtab status ── */
  .vtab-status {
    font-size: 8px; font-weight: 900; line-height: 1;
    flex-shrink: 0; margin-left: 1px;
  }
  .vtab-status.approved { color: #22c55e; }
  .vtab-status.curated  { color: #AAF0D1; }
  .vtab-status.draft    { width: 5px; height: 5px; border-radius: 50%; background: #444; display: inline-block; }

  /* ── Variant inline editor ── */
  .variant-editor {
    display: flex; flex-direction: column; gap: 10px;
    background: #141414; border: 1.5px solid #AAF0D130;
    border-radius: 8px; padding: 14px;
  }
  .variant-textarea {
    width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a;
    border-radius: 6px; color: #e5e5e5; padding: 12px 14px;
    font-family: "Menlo", "Consolas", monospace; font-size: 13px; line-height: 1.6;
    outline: none; resize: vertical; transition: border-color .15s;
  }
  .variant-textarea:focus { border-color: #AAF0D1; }
  .neg-textarea { color: #e06c75; }

  .sd-edit-block { display: flex; flex-direction: column; gap: 5px; }

  .editor-footer {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 8px; padding-top: 4px;
    border-top: 1px solid #222;
  }
  .editor-hint { font-size: 11px; color: #AAF0D1; opacity: .7; font-style: italic; }
  .editor-actions { display: flex; gap: 6px; }

  .btn-save-curated {
    background: #0d2419; color: #AAF0D1; border: 1px solid #AAF0D130;
    border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 700;
    cursor: pointer; transition: all .15s;
  }
  .btn-save-curated:hover { background: #AAF0D1; color: #0d2419; border-color: #AAF0D1; }

  /* ── Curate toggle button ── */
  .btn-curate {
    background: #1a1a1a; color: #555; border: 1px solid #2a2a2a;
    border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 700;
    cursor: pointer; transition: all .15s; letter-spacing: .02em;
  }
  .btn-curate:hover { color: #AAF0D1; border-color: #AAF0D130; }
  .btn-curate.btn-curate-on {
    background: #0d2419; color: #AAF0D1; border-color: #AAF0D130;
  }
  .btn-curate.btn-curate-on:hover { background: #1a3a28; }

  /* ── Inline notes textarea ── */
  .detail-notes-textarea {
    width: 100%; background: #181818; border: 1px solid #222;
    border-radius: 8px; color: #888; padding: 10px 14px;
    font-family: inherit; font-size: 13px; line-height: 1.5;
    outline: none; resize: vertical; transition: border-color .15s;
  }
  .detail-notes-textarea:focus { border-color: #AAF0D1; color: #ccc; }
  .detail-notes-textarea::placeholder { color: #333; }

  /* ── Detail tags row with remove buttons ── */
  .detail-tags-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 4px; }

  /* ── Library tag sub-label ── */
  .section-label-sub {
    font-size: 9px; font-weight: 400; color: #3a3a3a; text-transform: none;
    letter-spacing: 0; margin-left: 6px; font-style: italic;
  }

  /* ── SD generation tag pills (ontology tags) ── */
  .sd-tag-pill {
    background: #0f1f1a; color: #7addb4; border-color: #1a3a2e;
    font-family: "Menlo", "Consolas", monospace; font-size: 10px;
  }

  /* ── Generation tag hint text ── */
  .gen-tag-hint {
    font-size: 10px; color: #3a3a3a; font-style: italic; line-height: 1.5; margin: 0;
  }

  /* ── Variant panel header — right side ── */
  .vph-right { display: flex; align-items: center; gap: 4px; }

  /* ── IR / JSON view toggle ── */
  .btn-ir-toggle {
    background: #1a1a1a; border: 1px solid #2e2e2e;
    border-radius: 5px; color: #555; font-size: 11px; font-weight: 700;
    padding: 3px 9px; line-height: 1.4; transition: all .15s;
    font-family: "Menlo", "Consolas", monospace; letter-spacing: .02em;
  }
  .btn-ir-toggle:hover { border-color: #AAF0D130; color: #AAF0D1; }
  .btn-ir-toggle.active {
    background: #0d2419; color: #AAF0D1;
    border-color: #AAF0D160;
    box-shadow: 0 0 8px #AAF0D120;
  }

  /* ── IR / JSON view panel ── */
  .ir-view-wrap {
    display: flex; flex-direction: column; gap: 6px;
    background: #0a0f0d; border: 1px solid #1a3328;
    border-radius: 8px; padding: 12px 14px;
  }
  .ir-view-header {
    display: flex; align-items: center; justify-content: space-between;
  }
  .ir-label {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
    color: #AAF0D180;
  }
  .ir-pre {
    background: none; border: none; padding: 0; margin: 0;
    color: #AAF0D1; font-family: "Menlo", "Consolas", monospace;
    font-size: 11.5px; line-height: 1.7; white-space: pre; overflow-x: auto;
    opacity: .9;
  }

  /* ── Result Gallery — thumbnail strip ── */
  .result-gallery {
    display: flex; flex-direction: column; gap: 8px;
    border-top: 1px solid #1e1e1e; padding-top: 10px; margin-top: 2px;
  }

  .rg-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }

  .rg-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .08em; color: #3a3a3a;
    display: flex; align-items: center; gap: 5px;
  }

  .rg-count {
    background: #1e1e1e; color: #555; border: 1px solid #2a2a2a;
    border-radius: 10px; font-size: 9px; font-weight: 700;
    padding: 1px 6px; letter-spacing: 0; text-transform: none;
  }

  .rg-add-btn {
    display: inline-flex; align-items: center; gap: 4px;
    background: #161616; border: 1px dashed #2a2a2a; border-radius: 5px;
    color: #555; font-size: 11px; padding: 3px 10px;
    cursor: pointer; transition: all .15s; user-select: none;
  }
  .rg-add-btn:hover { border-color: #AAF0D1; color: #AAF0D1; }

  /* Horizontal scrollable strip */
  .rg-strip {
    display: flex; gap: 6px;
    overflow-x: auto; padding-bottom: 4px;
  }
  .rg-strip::-webkit-scrollbar { height: 3px; }
  .rg-strip::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

  /* Individual thumbnail — fixed height, flexible width to preserve aspect ratio.
     Vertical images render narrow & tall; horizontal images render wide. Whole
     image visible (no crop), letterboxed/pillarboxed inside its own border. */
  .rg-thumb-wrap {
    position: relative; flex-shrink: 0;
    height: 96px;
    display: flex;
  }
  .rg-thumb-wrap:hover .rg-rm { opacity: 1; }

  .rg-thumb {
    height: 96px; padding: 0;
    border-radius: 7px; overflow: hidden; cursor: pointer;
    border: 1.5px solid #252525; background: #111;
    transition: border-color .12s, transform .12s;
    display: flex; align-items: center; justify-content: center;
    position: relative;
    min-width: 56px; max-width: 200px;
  }
  .rg-thumb:hover { border-color: #555; transform: scale(1.03); }
  .rg-thumb img {
    height: 100%; width: auto;
    max-width: 100%;
    object-fit: contain;
    display: block;
  }

  /* Favorite star overlay */
  .rg-star {
    position: absolute; top: 3px; right: 4px;
    font-size: 11px; color: #f59e0b; text-shadow: 0 1px 3px rgba(0,0,0,.8);
    pointer-events: none; line-height: 1;
  }

  /* Remove button — appears on hover */
  .rg-rm {
    position: absolute; top: -5px; right: -5px;
    width: 17px; height: 17px; border-radius: 50%;
    background: #e53e3e; color: #fff; border: none;
    font-size: 11px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .12s;
    z-index: 2;
  }
  .rg-rm:hover { background: #c53030; }

  /* ── Gallery Preview Overlay ── */
  .gp-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, .88);
    display: flex; align-items: center; justify-content: center;
    z-index: 300; backdrop-filter: blur(6px);
  }

  .gp-panel {
    position: relative;
    background: #161616; border: 1px solid #2a2a2a; border-radius: 14px;
    display: flex; flex-direction: column; gap: 12px;
    padding: 20px; max-width: 92vw; max-height: 92vh;
    overflow: hidden;
    box-shadow: 0 24px 80px rgba(0,0,0,.7);
  }

  .gp-close {
    position: absolute; top: 10px; right: 12px;
    background: none; border: none; color: #444;
    font-size: 22px; line-height: 1; cursor: pointer; z-index: 1;
    transition: color .12s;
  }
  .gp-close:hover { color: #e5e5e5; }

  /* Image area — flex wrapper centers the image; sizing happens on the image itself
     using viewport-based math so it works at ANY window size, not just fullscreen. */
  .gp-img-wrap {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    min-height: 0; border-radius: 8px;
    background: #0d0d0d;
  }

  .gp-img {
    /* Cap the image to viewport minus the panel chrome (padding + controls + note + gaps).
       Both axes constrained → portrait AND landscape always fit on screen. */
    max-width:  calc(92vw - 60px);
    max-height: calc(92vh - 200px);
    width: auto; height: auto;
    object-fit: contain; display: block; border-radius: 6px;
  }

  /* Prev / Next navigation */
  .gp-nav {
    position: absolute; top: 50%; transform: translateY(-50%);
    background: rgba(0,0,0,.55); color: #ccc; border: none;
    font-size: 28px; line-height: 1; padding: 6px 12px;
    cursor: pointer; border-radius: 6px;
    transition: background .12s, color .12s;
    backdrop-filter: blur(4px);
  }
  .gp-nav:hover { background: rgba(0,0,0,.8); color: #fff; }
  .gp-prev { left: 8px; }
  .gp-next { right: 8px; }

  /* Controls row */
  .gp-controls {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; flex-shrink: 0;
  }

  .gp-meta {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }

  .gp-gen-chip {
    display: inline-flex; align-items: center; gap: 5px;
    background: color-mix(in srgb, var(--gb) 18%, transparent);
    border: 1px solid color-mix(in srgb, var(--gb) 35%, transparent);
    color: color-mix(in srgb, var(--gb) 90%, #fff);
    border-radius: 5px; padding: 3px 8px;
    font-size: 11px; font-weight: 600;
  }
  .gp-gen-icon { display: inline-flex; width: 12px; height: 12px; }
  .gp-gen-icon :global(svg) { width: 12px; height: 12px; }

  .gp-date { font-size: 11px; color: #444; }

  .gp-counter {
    font-size: 10px; color: #333; font-family: "Menlo", monospace;
    background: #1a1a1a; border: 1px solid #252525;
    border-radius: 4px; padding: 2px 6px;
  }

  /* Favorite button */
  .gp-fav {
    background: #1a1a1a; border: 1px solid #2a2a2a;
    border-radius: 6px; padding: 5px 12px;
    font-size: 16px; cursor: pointer; transition: all .15s;
    color: #444; line-height: 1;
  }
  .gp-fav:hover { border-color: #f59e0b; color: #f59e0b; }
  .gp-fav.gp-fav-on {
    background: #1c1500; border-color: #a16207;
    color: #f59e0b;
    box-shadow: 0 0 10px #f59e0b22;
  }

  /* Note textarea */
  .gp-note {
    width: 100%; background: #111; border: 1px solid #222;
    border-radius: 7px; color: #888; padding: 8px 12px;
    font-family: inherit; font-size: 12px; line-height: 1.5;
    outline: none; resize: none; transition: border-color .15s;
    flex-shrink: 0;
  }
  .gp-note:focus { border-color: #AAF0D1; color: #ccc; }
  .gp-note::placeholder { color: #333; }

  /* ── Reference Images — detail view strip ── */
  .ref-strip {
    display: flex; gap: 8px; flex-wrap: wrap;
  }

  .ref-card {
    display: flex; flex-direction: column; gap: 5px;
    width: 88px; flex-shrink: 0;
  }

  .ref-card-thumb-wrap {
    position: relative; width: 88px; height: 72px;
  }
  .ref-card-thumb-wrap:hover .rg-rm { opacity: 1; }

  .ref-card-thumb {
    width: 88px; height: 72px; object-fit: cover;
    border-radius: 6px; border: 1.5px solid #252525;
    display: block; background: #111;
  }

  .ref-num {
    position: absolute; bottom: 3px; left: 4px;
    font-size: 9px; font-weight: 700; color: #fff;
    background: rgba(0,0,0,.6); border-radius: 3px;
    padding: 1px 4px; pointer-events: none; line-height: 1.4;
    font-family: "Menlo", monospace;
  }

  .ref-card-label {
    width: 100%; background: #161616; border: 1px solid #252525;
    border-radius: 4px; color: #ccc; font-size: 10px;
    padding: 3px 5px; outline: none; font-family: inherit;
    transition: border-color .12s;
  }
  .ref-card-label:focus { border-color: #AAF0D1; }
  .ref-card-label::placeholder { color: #3a3a3a; }

  .ref-card-role,
  .ref-card-mode {
    width: 100%; background: #161616; border: 1px solid #252525;
    border-radius: 4px; color: #666; font-size: 9px;
    padding: 2px 4px; outline: none; cursor: pointer;
    transition: border-color .12s;
  }
  .ref-card-role:hover, .ref-card-mode:hover { border-color: #444; }
  .ref-card-role:focus, .ref-card-mode:focus { border-color: #AAF0D1; }

  .ref-empty-hint {
    font-size: 11px; color: #2e2e2e; font-style: italic; line-height: 1.5;
  }

  /* ── Reference Images — modal ── */
  .modal-ref-list {
    display: flex; flex-direction: column; gap: 8px; margin-top: 6px;
  }

  .modal-ref-row {
    display: flex; gap: 10px; align-items: flex-start;
    background: #111; border: 1px solid #1e1e1e; border-radius: 8px; padding: 8px;
  }

  .modal-ref-thumb-wrap {
    position: relative; flex-shrink: 0; width: 72px; height: 72px;
  }

  .modal-ref-thumb {
    width: 72px; height: 72px; object-fit: cover;
    border-radius: 6px; border: 1px solid #2e2e2e; display: block;
  }

  .modal-ref-fields {
    flex: 1; display: flex; flex-direction: column; gap: 5px; min-width: 0;
  }

  .modal-ref-label-input {
    width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a;
    border-radius: 5px; color: #e5e5e5; font-size: 12px;
    padding: 5px 8px; outline: none; font-family: inherit;
    transition: border-color .12s;
  }
  .modal-ref-label-input:focus { border-color: #AAF0D1; }
  .modal-ref-label-input::placeholder { color: #444; }

  .modal-ref-selects {
    display: flex; gap: 5px;
  }

  .modal-ref-select {
    flex: 1; background: #1a1a1a; border: 1px solid #2a2a2a;
    border-radius: 5px; color: #888; font-size: 11px;
    padding: 4px 6px; outline: none; cursor: pointer;
    transition: border-color .12s;
  }
  .modal-ref-select:focus { border-color: #AAF0D1; color: #ccc; }

  /* ── Sidebar card thumbnail layout ── */
  .pcard-thumb-row {
    display: flex; gap: 8px; align-items: flex-start;
  }
  .pcard-thumb {
    width: 52px; height: 52px; object-fit: cover;
    border-radius: 5px; flex-shrink: 0;
    border: 1px solid #1e1e1e;
  }
  .pcard-thumb-text {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; gap: 3px;
  }

  /* ── Master Thumbnail slot (cover image in prompt header) ── */
  .master-thumb-slot {
    position: relative; flex-shrink: 0;
    width: 36px; height: 36px;
  }
  .master-thumb-slot-img {
    width: 36px; height: 36px; object-fit: cover;
    border-radius: 5px; border: 1px solid #2a2a2a;
    display: block; cursor: default;
  }
  .master-thumb-slot-clear {
    position: absolute; top: -5px; right: -5px;
    width: 14px; height: 14px; border-radius: 50%;
    background: #c53030; border: none; color: #fff;
    font-size: 9px; line-height: 14px; text-align: center;
    cursor: pointer; display: none; padding: 0;
  }
  .master-thumb-slot:hover .master-thumb-slot-clear { display: block; }
  .master-thumb-slot-add {
    display: flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
    border: 1px dashed #333; border-radius: 5px;
    font-size: 10px; color: #444; cursor: pointer;
    transition: all .15s; text-align: center; line-height: 1.2;
  }
  .master-thumb-slot-add:hover { border-color: #AAF0D1; color: #AAF0D1; }

  /* ── Variation strip ── */
  .var-strip-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 14px 0;
    border-bottom: 1px solid #1c1c1c;
    background: #111;
  }
  .var-strip {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }
  .vstrip-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 4px;
    border: 1px solid #2a2a2a;
    background: #181818;
    color: #666;
    font-size: 11px;
    cursor: pointer;
    transition: all .12s;
    white-space: nowrap;
  }
  .vstrip-item:hover { border-color: #3a3a3a; color: #aaa; }
  .vstrip-item.active { border-color: #AAF0D1; color: #AAF0D1; background: #0a1f17; }
  .vstrip-item.status-curated { border-color: #7c6f2e; color: #c4a82b; }
  .vstrip-item.status-curated.active { border-color: #c4a82b; }
  .vstrip-item.status-approved { border-color: #1e4a2d; color: #4ade80; }
  .vstrip-item.status-approved.active { border-color: #4ade80; }
  .vstrip-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
  .vstrip-badge { font-size: 9px; opacity: .8; }
  .vstrip-badge.ok { color: #4ade80; }
  .vstrip-badge.manual { color: #888; font-size: 8px; background: #222; padding: 0 3px; border-radius: 2px; }
  .vstrip-rename {
    background: transparent;
    border: none;
    outline: none;
    color: #AAF0D1;
    font-size: 11px;
    width: 100px;
    padding: 0;
  }
  .var-strip-btns {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    margin-left: auto;
    padding-bottom: 6px;
  }
  .btn-gen-new {
    padding: 3px 9px;
    border-radius: 4px;
    border: 1px solid #2a2a2a;
    background: #181818;
    color: #888;
    font-size: 11px;
    cursor: pointer;
    transition: all .12s;
  }
  .btn-gen-new:hover { border-color: #AAF0D1; color: #AAF0D1; }
  .btn-add-var-sm {
    padding: 3px 9px;
    border-radius: 4px;
    border: 1px dashed #2a2a2a;
    background: transparent;
    color: #666;
    font-size: 11px;
    cursor: pointer;
    transition: all .12s;
  }
  .btn-add-var-sm:hover { border-color: #AAF0D1; color: #AAF0D1; }

  /* ── Empty state with two buttons ── */
  .ve-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }
  .btn-add-var {
    padding: 7px 16px;
    border-radius: 6px;
    border: 1px dashed #333;
    background: transparent;
    color: #666;
    font-size: 12px;
    cursor: pointer;
    transition: all .15s;
  }
  .btn-add-var:hover { border-color: #AAF0D1; color: #AAF0D1; }

  /* ── Variation count badge on tabs ── */
  .vtab-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: #2a2a2a;
    color: #888;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
  }
  .vtab-active .vtab-count {
    background: #AAF0D1;
    color: #111;
  }
</style>
