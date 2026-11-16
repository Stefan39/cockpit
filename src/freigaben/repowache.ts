/**
 * Die Freigabe-Inbox, Teil 1 (COPI-139): der lesende Abruf der Entwürfe der Repo-Wache aus n8n
 * (`GET {REPOWACHE_URL}/webhook/repowache/eintraege?status=offen,info&limit=100`, `Authorization: Bearer <Token>`).
 *
 *   * **Der Token bleibt im Server.** Er steht nur im Kopf dieses einen Aufrufs, nie in einer Seite, einem Link oder einem Log.
 *   * **Wirft nie.** 403, Zeitüberschreitung, Netzfehler und unlesbare Antworten kommen als Ergebnis zurück; die Seite
 *     zeigt dann einen Hinweistext statt eines Fehlers.
 *   * **Fremde Texte** (`original_text`, Titel, Entwürfe) werden hier nur durchgereicht; die Templates escapen sie.
 *   * **Zählen** der offenen Einträge für die Navigation geht über dieselbe Abfrage, kurz zwischengespeichert, damit
 *     nicht jede Seite n8n fragt.
 */

/** So lange wartet das Cockpit höchstens auf n8n. */
export const ZEITLIMIT_MS = 5000;

/** Wie lange die Navigation ein Ergebnis (auch einen Fehlschlag) wiederverwendet. */
export const ZWISCHENSPEICHER_MS = 30_000;

export interface RepowacheKonfiguration {
  readonly url: string;
  readonly token: string;
}

/** Was aus der Umgebung kommt (`env.ts`). */
export interface RepowacheUmgebung {
  readonly repowacheUrl?: string | undefined;
  readonly repowacheToken?: string | undefined;
}

/** Ohne Adresse und Token (oder bei einer ungültigen Adresse) gibt es kein Modul: `undefined`. */
export function repowacheAusUmgebung(umgebung: RepowacheUmgebung): RepowacheKonfiguration | undefined {
  const url = umgebung.repowacheUrl?.trim() ?? '';
  const token = umgebung.repowacheToken?.trim() ?? '';
  if (url === '' || token === '') {
    return undefined;
  }
  try {
    const adresse = new URL(url);
    if (adresse.protocol !== 'https:' && adresse.protocol !== 'http:') {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { url, token };
}

/** Der Status eines Eintrags: `offen` wartet auf eine Entscheidung, `info` ist nur zur Kenntnis. */
export type EintragStatus = 'offen' | 'info';

/** Ein Eintrag der Inbox, wie ihn der Vertrag liefert (Feldnamen des Webhooks, Werte unverändert). */
export interface Eintrag {
  readonly id: string;
  /** Der Quelltyp (`github`); jeder weitere (Social, Blog, Mail) bekommt einen Adapter in `quelle.ts`. */
  readonly quelle: string;
  readonly repo: string | undefined;
  readonly nummer: number | undefined;
  readonly titel: string | undefined;
  readonly url: string | undefined;
  readonly einordnung: string | undefined;
  readonly status: EintragStatus;
  readonly ereignisAm: Date | undefined;
  readonly originalText: string;
  readonly uebersetzungDe: string | undefined;
  readonly entwurf: string | undefined;
  readonly entwurfDe: string | undefined;
}

/** Die Kennzahlen eines Repos (Feld `kennzahlen` der Antwort); fehlende Werte bleiben `undefined`. */
export interface RepoKennzahl {
  readonly repo: string;
  readonly beitraege: number | undefined;
  readonly beantwortet: number | undefined;
  readonly unbeantwortet: number | undefined;
  /** Median der Reaktionszeit in Stunden. */
  readonly medianStunden: number | undefined;
  /** Maximum der Reaktionszeit in Stunden. */
  readonly maxStunden: number | undefined;
  readonly stars: number | undefined;
  readonly forks: number | undefined;
  readonly stand: Date | undefined;
}

export type Abruf =
  | { readonly ok: true; readonly eintraege: readonly Eintrag[]; readonly kennzahlen: readonly RepoKennzahl[] }
  | { readonly ok: false; readonly grund: 'verboten' | 'zeitlimit' | 'netz' | 'antwort' };

const hatText = (wert: unknown): wert is string => typeof wert === 'string' && wert !== '';

function textOderNichts(wert: unknown): string | undefined {
  return hatText(wert) ? wert : undefined;
}

function zahlOderNichts(wert: unknown): number | undefined {
  return typeof wert === 'number' && Number.isInteger(wert) ? wert : undefined;
}

function zeitOderNichts(wert: unknown): Date | undefined {
  if (!hatText(wert)) {
    return undefined;
  }
  const zeit = new Date(wert);
  return Number.isNaN(zeit.getTime()) ? undefined : zeit;
}

/** Ein Eintrag aus dem JSON; ohne `id` oder mit unbekanntem Status ist er unbrauchbar (`undefined`). */
export function eintragLesen(roh: unknown): Eintrag | undefined {
  if (typeof roh !== 'object' || roh === null) {
    return undefined;
  }
  const feld = roh as Record<string, unknown>;
  const id = typeof feld.id === 'number' ? String(feld.id) : textOderNichts(feld.id);
  const status = feld.status;
  if (id === undefined || (status !== 'offen' && status !== 'info')) {
    return undefined;
  }
  return {
    id,
    quelle: textOderNichts(feld.quelle) ?? 'github',
    repo: textOderNichts(feld.repo),
    nummer: zahlOderNichts(feld.nummer),
    titel: textOderNichts(feld.titel),
    url: textOderNichts(feld.url),
    einordnung: textOderNichts(feld.einordnung),
    status,
    ereignisAm: zeitOderNichts(feld.ereignis_am),
    originalText: typeof feld.original_text === 'string' ? feld.original_text : '',
    uebersetzungDe: textOderNichts(feld.uebersetzung_de),
    entwurf: textOderNichts(feld.entwurf),
    entwurfDe: textOderNichts(feld.entwurf_de),
  };
}

function endlicheZahl(wert: unknown): number | undefined {
  return typeof wert === 'number' && Number.isFinite(wert) ? wert : undefined;
}

/** Eine Kennzahl-Zeile; ohne Repo-Name unbrauchbar (`undefined`). */
export function kennzahlLesen(roh: unknown, schluessel?: string): RepoKennzahl | undefined {
  if (typeof roh !== 'object' || roh === null) {
    return undefined;
  }
  const feld = roh as Record<string, unknown>;
  const repo = textOderNichts(feld.repo) ?? schluessel;
  if (repo === undefined || repo === '') {
    return undefined;
  }
  return {
    repo,
    beitraege: endlicheZahl(feld.beitraege),
    beantwortet: endlicheZahl(feld.beantwortet),
    unbeantwortet: endlicheZahl(feld.unbeantwortet),
    medianStunden: endlicheZahl(feld.median_stunden),
    maxStunden: endlicheZahl(feld.max_stunden),
    stars: endlicheZahl(feld.stars),
    forks: endlicheZahl(feld.forks),
    stand: zeitOderNichts(feld.stand),
  };
}

/** Die Kennzahlen aus dem Rumpf: eine Liste oder ein Objekt je Repo-Name; fehlt das Feld oder ist es leer, gibt es keine. */
export function kennzahlenLesen(rumpf: unknown): readonly RepoKennzahl[] {
  const roh = typeof rumpf === 'object' && rumpf !== null && !Array.isArray(rumpf) ? (rumpf as { kennzahlen?: unknown }).kennzahlen : undefined;
  if (Array.isArray(roh)) {
    return (roh as unknown[]).flatMap((zeile) => kennzahlLesen(zeile) ?? []);
  }
  if (typeof roh === 'object' && roh !== null) {
    return Object.entries(roh).flatMap(([name, zeile]) => kennzahlLesen(zeile, name) ?? []);
  }
  return [];
}

/** Die Einträge aus dem Rumpf: ein Feld `eintraege` oder gleich eine Liste. Unbrauchbare Einträge fallen weg. */
export function eintraegeLesen(rumpf: unknown): readonly Eintrag[] | undefined {
  const liste = Array.isArray(rumpf) ? (rumpf as unknown[]) : (rumpf as { eintraege?: unknown } | null)?.eintraege;
  if (!Array.isArray(liste)) {
    return undefined;
  }
  return (liste as unknown[]).flatMap((roh) => eintragLesen(roh) ?? []);
}

export interface AbrufOptionen {
  readonly holen?: typeof fetch;
  readonly zeitlimitMs?: number;
}

/** Holt die offenen Einträge und die Infos. Wirft nie. */
export async function eintraegeAbrufen(konfiguration: RepowacheKonfiguration, optionen: AbrufOptionen = {}): Promise<Abruf> {
  const holen = optionen.holen ?? fetch;
  const adresse = `${konfiguration.url.replace(/\/+$/, '')}/webhook/repowache/eintraege?status=offen,info&limit=100`;
  try {
    const antwort = await holen(adresse, {
      method: 'GET',
      headers: { authorization: `Bearer ${konfiguration.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(optionen.zeitlimitMs ?? ZEITLIMIT_MS),
    });
    if (antwort.status === 401 || antwort.status === 403) {
      return { ok: false, grund: 'verboten' };
    }
    if (!antwort.ok) {
      return { ok: false, grund: 'netz' };
    }
    const rumpf: unknown = await antwort.json();
    const eintraege = eintraegeLesen(rumpf);
    return eintraege === undefined ? { ok: false, grund: 'antwort' } : { ok: true, eintraege, kennzahlen: kennzahlenLesen(rumpf) };
  } catch (fehler) {
    const zeitlimit = fehler instanceof Error && (fehler.name === 'TimeoutError' || fehler.name === 'AbortError');
    return { ok: false, grund: zeitlimit ? 'zeitlimit' : fehler instanceof SyntaxError ? 'antwort' : 'netz' };
  }
}

/** Ein Abruf, den mehrere Seiten kurz teilen. */
export type AbrufHolen = () => Promise<Abruf>;

/** Ein Abruf mit Zwischenspeicher; `vergessen` verwirft ihn, etwa nach einer Aktion (der Zähler „offen" soll stimmen). */
export interface ZwischengespeicherterAbruf extends AbrufHolen {
  readonly vergessen: () => void;
}

export type Aktion = 'senden' | 'aendern' | 'verwerfen';

export const AKTIONEN: readonly Aktion[] = ['senden', 'aendern', 'verwerfen'];

/** Was die Repo-Wache auf eine Aktion antwortet (Vertrag: Kommentar vom 15.10.2026 in COPI-139). */
export type AktionsErgebnis =
  | { readonly art: 'ok'; readonly status: string; readonly antwortUrl: string | undefined }
  | { readonly art: 'konflikt'; readonly fehler: string }
  /** Status `sendet` oder Zeitüberschreitung: ob die Antwort raus ist, weiß niemand. Nicht erneut senden. */
  | { readonly art: 'unklar' }
  | { readonly art: 'fehler'; readonly grund: 'verboten' | 'netz' | 'antwort' };

/**
 * Löst eine Aktion der Inbox aus (`POST {REPOWACHE_URL}/webhook/repowache/aktion`, Bearer-Token, Body
 * `{ id, aktion, text }`, `text` nur bei `aendern`). Wirft nie. Eine Zeitüberschreitung gilt als unklar, nicht als
 * Fehlschlag: die Antwort kann trotzdem hinausgegangen sein.
 */
export async function aktionAusloesen(
  konfiguration: RepowacheKonfiguration,
  anfrage: { readonly id: string; readonly aktion: Aktion; readonly text?: string },
  optionen: AbrufOptionen = {},
): Promise<AktionsErgebnis> {
  const holen = optionen.holen ?? fetch;
  const body = anfrage.aktion === 'aendern' ? { id: anfrage.id, aktion: anfrage.aktion, text: anfrage.text ?? '' } : { id: anfrage.id, aktion: anfrage.aktion };
  try {
    const antwort = await holen(`${konfiguration.url.replace(/\/+$/, '')}/webhook/repowache/aktion`, {
      method: 'POST',
      headers: { authorization: `Bearer ${konfiguration.token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(optionen.zeitlimitMs ?? ZEITLIMIT_MS),
    });
    if (antwort.status === 401 || antwort.status === 403) {
      return { art: 'fehler', grund: 'verboten' };
    }
    const rumpf: unknown = await antwort.json().catch(() => undefined);
    const feld = typeof rumpf === 'object' && rumpf !== null ? (rumpf as Record<string, unknown>) : {};
    if (antwort.status === 409) {
      return { art: 'konflikt', fehler: textOderNichts(feld.fehler) ?? 'Die Aktion ist nicht mehr möglich.' };
    }
    const status = textOderNichts(feld.status);
    if (!antwort.ok || status === undefined) {
      return { art: 'fehler', grund: antwort.ok ? 'antwort' : 'netz' };
    }
    return status === 'sendet' ? { art: 'unklar' } : { art: 'ok', status, antwortUrl: textOderNichts(feld.antwort_url) };
  } catch (fehler) {
    const zeitlimit = fehler instanceof Error && (fehler.name === 'TimeoutError' || fehler.name === 'AbortError');
    return zeitlimit ? { art: 'unklar' } : { art: 'fehler', grund: 'netz' };
  }
}

/** Hinweistext zu einem fehlgeschlagenen Abruf: nie die Ursache im Wortlaut des Servers, nie der Token. */
export function hinweisText(grund: 'verboten' | 'zeitlimit' | 'netz' | 'antwort'): string {
  switch (grund) {
    case 'verboten':
      return 'Die Repo-Wache hat den Zugang abgelehnt (403). Bitte Token in der Konfiguration prüfen.';
    case 'zeitlimit':
      return 'Die Repo-Wache hat nicht rechtzeitig geantwortet. Bitte später noch einmal versuchen.';
    case 'antwort':
      return 'Die Antwort der Repo-Wache war nicht lesbar. Bitte später noch einmal versuchen.';
    case 'netz':
      return 'Die Repo-Wache ist gerade nicht erreichbar. Bitte später noch einmal versuchen.';
  }
}

/** Der Abruf mit kurzem Zwischenspeicher je Prozess (auch ein Fehlschlag zählt, damit eine tote Quelle nicht jede Seite bremst). */
export function abrufMitZwischenspeicher(
  konfiguration: RepowacheKonfiguration,
  jetzt: () => Date,
  optionen: AbrufOptionen = {},
): ZwischengespeicherterAbruf {
  let stand: { readonly bis: number; readonly abruf: Promise<Abruf> } | undefined;
  const holen = (): Promise<Abruf> => {
    const zeit = jetzt().getTime();
    if (stand === undefined || zeit >= stand.bis) {
      stand = { bis: zeit + ZWISCHENSPEICHER_MS, abruf: eintraegeAbrufen(konfiguration, optionen) };
    }
    return stand.abruf;
  };
  return Object.assign(holen, {
    vergessen: () => {
      stand = undefined;
    },
  });
}
