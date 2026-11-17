import type { LatLng } from '../core/geo';
import {
  AVAILABILITY_TEXT,
  MAX_HINTS,
  MAX_HINT_LENGTH,
  judgeAvailability,
  placeToTarget,
  validateFile,
  validatePlace,
  type Availability,
  type LearningPlace,
  type PlacesFile,
} from '../core/places';
import { clearDraft, loadDraft, publishedPlaces, saveDraft } from '../learning/store';
import type { MapillaryProvider, NearbyImage } from '../providers/mapillary';
import type { PanoramaViewer } from '../providers/types';
import { h } from './dom';

/**
 * Správa výukových míst (#sprava). Změny se ukládají jen v tomto prohlížeči;
 * do hry se dostanou, až se stažený soubor nahraje do repozitáře.
 */
export function renderEditor(
  root: HTMLElement,
  provider: MapillaryProvider,
  onExit: () => void,
): () => void {
  let file: PlacesFile = structuredClone(loadDraft() ?? publishedPlaces());
  let selectedId: string | null = file.places[0]?.id ?? null;
  const availability = new Map<string, Availability | 'checking'>();
  let viewer: PanoramaViewer | null = null;
  let viewerFor = '';
  const fromDraft = loadDraft() !== null;

  const listEl = h('ul', { class: 'ed-list' });
  const detailEl = h('section', { class: 'ed-detail', 'aria-live': 'polite' });
  const statusEl = h('p', { class: 'ed-status', role: 'status' });
  const panoEl = h('div', {
    class: 'pano ed-pano',
    role: 'region',
    'aria-label': 'Panorama místa',
  });

  const save = () => {
    saveDraft(file);
    statusEl.textContent =
      'Změny jsou uložené v tomto prohlížeči. Do hry se dostanou po nahrání souboru.';
  };
  const selected = () => file.places.find((p) => p.id === selectedId) ?? null;

  const badge = (p: LearningPlace) => {
    const errs = validatePlace(p);
    const a = availability.get(p.id);
    return h(
      'span',
      { class: 'ed-badges' },
      h(
        'span',
        { class: `ed-badge ed-badge--${p.status}` },
        p.status === 'approved' ? 'Schváleno' : 'Návrh',
      ),
      errs.length > 0 && h('span', { class: 'ed-badge ed-badge--err' }, `${errs.length} chyb`),
      a === 'checking' && h('span', { class: 'ed-badge' }, 'ověřuju...'),
      a &&
        a !== 'checking' &&
        (a.ok
          ? h('span', { class: 'ed-badge ed-badge--ok' }, 'dostupné')
          : h('span', { class: 'ed-badge ed-badge--err' }, 'nedostupné')),
    );
  };

  const renderList = () => {
    listEl.replaceChildren(
      ...file.places.map((p) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'ed-item',
              'aria-current': p.id === selectedId ? 'true' : 'false',
              onclick: () => {
                selectedId = p.id;
                renderAll();
              },
            },
            h('strong', {}, p.title || p.id),
            badge(p),
          ),
        ),
      ),
    );
    if (file.places.length === 0)
      listEl.append(h('li', { class: 'field-note' }, 'Zatím žádné místo. Přidej první.'));
  };

  const showViewer = async (p: LearningPlace, force = false) => {
    if (!force && viewerFor === `${p.imageId}`) return;
    viewer?.destroy();
    viewer = null;
    viewerFor = p.imageId;
    panoEl.replaceChildren(h('p', { class: 'pano__overlay' }, 'Načítám panorama...'));
    try {
      panoEl.replaceChildren();
      viewer = await provider.createViewer(panoEl, placeToTarget(p));
    } catch {
      panoEl.replaceChildren(
        h('p', { class: 'pano__overlay', role: 'alert' }, 'Panorama se nepodařilo načíst.'),
      );
    }
  };

  const check = async (p: LearningPlace) => {
    availability.set(p.id, 'checking');
    renderList();
    const info = await provider.imageInfo(p.imageId);
    availability.set(p.id, judgeAvailability(p, info));
    renderAll();
  };

  const field = (label: string, input: HTMLElement, note?: string) =>
    h(
      'label',
      { class: 'ed-field' },
      h('span', {}, label),
      input,
      note && h('small', { class: 'field-note' }, note),
    );

  const renderDetail = () => {
    const p = selected();
    if (!p) {
      viewer?.destroy();
      viewer = null;
      viewerFor = '';
      detailEl.replaceChildren(
        h('p', { class: 'field-note' }, 'Vyber místo vlevo, nebo přidej nové.'),
      );
      return;
    }
    const update = (patch: Partial<LearningPlace>) => {
      Object.assign(p, patch);
      // Každá změna obsahu vrací místo mezi návrhy, dokud ho někdo znovu nezkontroluje.
      if (!('status' in patch) && p.status === 'approved') {
        p.status = 'draft';
        statusEl.textContent = 'Místo se změnilo, a proto je znovu návrh. Po kontrole ho schval.';
      }
      save();
      renderList();
      renderErrors();
    };
    const errorsEl = h('ul', { class: 'ed-errors' });
    const renderErrors = () => {
      const errs = validatePlace(p);
      const a = availability.get(p.id);
      const items = [...errs];
      if (a && a !== 'checking' && !a.ok) items.push(AVAILABILITY_TEXT[a.reason]);
      errorsEl.replaceChildren(...items.map((e) => h('li', {}, e)));
      errorsEl.hidden = items.length === 0;
    };

    const hintInputs = Array.from({ length: MAX_HINTS }, (_, i) => {
      const input = h('textarea', {
        class: 'input ed-hint',
        rows: 2,
        maxlength: MAX_HINT_LENGTH,
        'aria-label': `Vodítko ${i + 1}`,
        oninput: () => update({ hints: hintInputs.map((t) => t.value) }),
      });
      input.value = p.hints[i] ?? '';
      return input;
    });

    const title = h('input', {
      class: 'input',
      type: 'text',
      value: p.title,
      oninput: (e: Event) => update({ title: (e.target as HTMLInputElement).value }),
    });
    const note = h('textarea', {
      class: 'input',
      rows: 2,
      oninput: (e: Event) => update({ note: (e.target as HTMLTextAreaElement).value }),
    });
    note.value = p.note ?? '';
    const reviewer = h('input', {
      class: 'input',
      type: 'text',
      value: p.reviewedBy ?? '',
      placeholder: 'Tvoje jméno',
    });

    const approveBtn = h(
      'button',
      {
        class: 'btn btn--primary',
        type: 'button',
        onclick: async () => {
          const name = reviewer.value.trim();
          if (!name) {
            statusEl.textContent = 'Před schválením napiš, kdo místo zkontroloval.';
            reviewer.focus();
            return;
          }
          await check(p);
          const a = availability.get(p.id);
          if (!a || a === 'checking' || !a.ok) {
            statusEl.textContent = 'Nedostupné místo nejde schválit.';
            return;
          }
          const today = new Date().toISOString().slice(0, 10);
          const candidate = {
            ...p,
            status: 'approved' as const,
            reviewedBy: name,
            reviewedAt: today,
          };
          const errs = validatePlace(candidate);
          if (errs.length) {
            statusEl.textContent = `Nejde schválit: ${errs.join(' ')}`;
            return;
          }
          Object.assign(p, candidate);
          save();
          statusEl.textContent = `Schváleno (${name}, ${today}).`;
          renderAll();
        },
      },
      'Zkontroloval jsem, schválit',
    );
    let confirmDelete = false;
    const deleteBtn = h(
      'button',
      { class: 'btn btn--ghost ed-danger', type: 'button' },
      'Smazat místo',
    );
    deleteBtn.addEventListener('click', () => {
      if (!confirmDelete) {
        confirmDelete = true;
        deleteBtn.textContent = 'Opravdu smazat? Klepni znovu.';
        return;
      }
      file.places = file.places.filter((x) => x !== p);
      selectedId = file.places[0]?.id ?? null;
      save();
      renderAll();
    });

    detailEl.replaceChildren(
      h('h2', {}, p.title || p.id),
      h(
        'p',
        { class: 'field-note' },
        `ID ${p.id} · snímek Mapillary ${p.imageId} · ${p.position.lat.toFixed(5)}, ${p.position.lng.toFixed(5)} · `,
        h(
          'a',
          {
            href: `https://www.mapillary.com/app/?pKey=${p.imageId}`,
            target: '_blank',
            rel: 'noopener',
          },
          'otevřít v Mapillary',
        ),
      ),
      h('div', { class: 'ed-pano-wrap' }, panoEl),
      h(
        'div',
        { class: 'actions ed-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              const v = await viewer?.getView?.();
              if (!v) return;
              update({
                view: { center: [round3(v.center[0]), round3(v.center[1])], zoom: round3(v.zoom) },
              });
              statusEl.textContent =
                'Výchozí výhled uložen. Vodítka musí odpovídat tomuto výhledu.';
            },
          },
          'Uložit tento výhled jako výchozí',
        ),
        h(
          'button',
          { class: 'btn', type: 'button', onclick: () => void showViewer(p, true) },
          'Zpět na uložený výhled',
        ),
        h(
          'button',
          { class: 'btn', type: 'button', onclick: () => void check(p) },
          'Ověřit dostupnost',
        ),
      ),
      errorsEl,
      field('Název (hráč ho uvidí až po kole)', title),
      h(
        'fieldset',
        { class: 'ed-hints' },
        h(
          'legend',
          {},
          `Vodítka (2 až ${MAX_HINTS}, stručně, jen co je ve výchozím výhledu opravdu vidět)`,
        ),
        ...hintInputs,
      ),
      field('Poznámka pro správce', note, 'Např. co ověřit nebo odkud je informace.'),
      h(
        'div',
        { class: 'ed-review' },
        field(
          'Kontroloval',
          reviewer,
          p.reviewedAt
            ? `Naposledy schváleno ${p.reviewedAt}.`
            : 'Schválit jde až po ruční kontrole vodítek proti panoramatu.',
        ),
        h('div', { class: 'actions' }, approveBtn, deleteBtn),
      ),
    );
    renderErrors();
    void showViewer(p);
  };

  // ---- přidání místa ----
  const addDialog = h('section', { class: 'card ed-add', hidden: true });
  const renderAdd = () => {
    const idInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: 'ID snímku nebo odkaz z mapillary.com',
    });
    const coordInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Souřadnice, např. 50.0865, 14.4114',
    });
    const titleInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Např. Praha, Karlův most',
    });
    const results = h('div', { class: 'ed-results' });
    const msg = h('p', { class: 'field-note', role: 'status' });

    const add = async (imageId: string, pos?: LatLng) => {
      const t = titleInput.value.trim();
      if (!t) {
        msg.textContent = 'Nejdřív napiš název místa.';
        titleInput.focus();
        return;
      }
      let position = pos;
      if (!position) {
        msg.textContent = 'Ověřuju snímek...';
        const info = await provider.imageInfo(imageId);
        if (!info?.exists || !info.position) {
          msg.textContent = 'Snímek se nepodařilo najít.';
          return;
        }
        if (!info.isPano) {
          msg.textContent = 'Tohle není 360° panorama.';
          return;
        }
        position = info.position;
      }
      const place: LearningPlace = {
        id: uniqueId(slug(t), file.places),
        title: t,
        provider: 'mapillary',
        imageId,
        position,
        view: { center: [0.5, 0.5], zoom: 0 },
        hints: [],
        status: 'draft',
      };
      file.places.push(place);
      selectedId = place.id;
      addDialog.hidden = true;
      save();
      renderAll();
    };

    addDialog.replaceChildren(
      h('h2', {}, 'Přidat místo'),
      field('Název', titleInput),
      h(
        'form',
        {
          class: 'ed-row',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const m = /(\d{5,20})/.exec(idInput.value);
            if (m?.[1]) void add(m[1]);
            else msg.textContent = 'Vlož číselné ID snímku nebo odkaz s pKey=...';
          },
        },
        idInput,
        h('button', { class: 'btn', type: 'submit' }, 'Přidat podle ID'),
      ),
      h(
        'form',
        {
          class: 'ed-row',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const nums = coordInput.value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
            const [lat, lng] = nums;
            if (lat === undefined || lng === undefined) {
              msg.textContent = 'Zadej šířku a délku, např. 50.0865, 14.4114.';
              return;
            }
            msg.textContent = 'Hledám 360° snímky v okolí (asi 150 m)...';
            try {
              const found = await provider.nearby({ lat, lng });
              msg.textContent = found.length
                ? `Nalezeno ${found.length}. Vyber snímek.`
                : 'V okolí nejsou žádné 360° snímky.';
              results.replaceChildren(
                ...found.map((f) => resultCard(f, () => void add(f.id, f.position))),
              );
            } catch {
              msg.textContent = 'Hledání se nepodařilo.';
            }
          },
        },
        coordInput,
        h('button', { class: 'btn', type: 'submit' }, 'Najít v okolí'),
      ),
      msg,
      results,
      h(
        'button',
        { class: 'btn btn--ghost', type: 'button', onclick: () => (addDialog.hidden = true) },
        'Zavřít',
      ),
    );
  };

  const exportJson = () => JSON.stringify(file, null, 2) + '\n';
  const download = () => {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'learning-places.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const renderAll = () => {
    renderList();
    renderDetail();
  };

  const { errors } = validateFile(file);
  const screen = h(
    'main',
    { class: 'screen editor' },
    h(
      'header',
      { class: 'ed-head' },
      h('h1', { tabindex: -1 }, 'Správa výukových míst'),
      h(
        'p',
        { class: 'field-note' },
        'Změny se ukládají jen v tomto prohlížeči. Do hry se dostanou, až stažený soubor nahraješ do repozitáře jako src/data/learning-places.json (postup je v README). Hrají se jen schválená a dostupná místa.',
      ),
      h(
        'div',
        { class: 'actions ed-toolbar' },
        h('button', { class: 'btn', type: 'button', onclick: onExit }, 'Zpět do hry'),
        h(
          'button',
          {
            class: 'btn btn--primary',
            type: 'button',
            onclick: () => {
              renderAdd();
              addDialog.hidden = false;
              addDialog.querySelector<HTMLInputElement>('input')?.focus();
            },
          },
          'Přidat místo',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              for (const p of file.places) await check(p);
              statusEl.textContent = 'Dostupnost ověřena.';
            },
          },
          'Ověřit dostupnost všech',
        ),
        h('button', { class: 'btn', type: 'button', onclick: download }, 'Stáhnout JSON'),
        h(
          'button',
          {
            class: 'btn btn--ghost',
            type: 'button',
            onclick: () => {
              clearDraft();
              file = structuredClone(publishedPlaces());
              selectedId = file.places[0]?.id ?? null;
              statusEl.textContent = 'Místní změny zahozeny, zobrazuju zveřejněná místa.';
              renderAll();
            },
          },
          'Zahodit místní změny',
        ),
      ),
      statusEl,
    ),
    addDialog,
    h(
      'div',
      { class: 'ed-body' },
      h('nav', { class: 'ed-nav', 'aria-label': 'Místa' }, listEl),
      detailEl,
    ),
  );
  statusEl.textContent = fromDraft
    ? 'Zobrazuju tvé místní změny (ještě nejsou zveřejněné).'
    : errors.length
      ? `Soubor má chyby: ${errors.join(' ')}`
      : 'Zobrazuju zveřejněná místa.';
  root.replaceChildren(screen);
  renderAll();
  (screen.querySelector('h1') as HTMLElement | null)?.focus();
  // Pro kontrolu a ruční zálohu: aktuální JSON i v konzoli prohlížeče.
  (window as unknown as { ggPlacesJson?: () => string }).ggPlacesJson = exportJson;

  return () => viewer?.destroy();
}

function resultCard(f: NearbyImage, onAdd: () => void): HTMLElement {
  return h(
    'figure',
    { class: 'ed-result' },
    f.thumbUrl
      ? h('img', { src: f.thumbUrl, alt: '', loading: 'lazy' })
      : h('div', { class: 'ed-noimg' }),
    h(
      'figcaption',
      {},
      h(
        'small',
        {},
        `${f.id}${f.capturedAt ? ` · ${new Date(f.capturedAt).getFullYear()}` : ''}${f.creator ? ` · ${f.creator}` : ''}`,
      ),
      h('button', { class: 'btn', type: 'button', onclick: onAdd }, 'Přidat'),
    ),
  );
}

const round3 = (x: number | undefined) => Math.round((x ?? 0) * 1000) / 1000;

function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 36) || 'misto'
  );
}

function uniqueId(base: string, places: LearningPlace[]): string {
  let id = base.length >= 2 ? base : `misto-${base}`;
  let i = 2;
  while (places.some((p) => p.id === id)) id = `${base}-${i++}`;
  return id;
}
