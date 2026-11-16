/**
 * Anhänge einer Modulzeile herunterladen (COPI-110, freigegebener Entwurf „Anhänge"): `GET
 * /module/:kennung/:id/anhang/:anhang` zeigt die Warnseite, erst `POST` auf dieselbe Adresse liefert aus. Nie ein Link
 * direkt auf den Inhalt.
 *
 * **Vor dem Ausliefern, in dieser Reihenfolge:**
 *
 *   1. Zugriff auf das Modul (`modulZielFinder`), ein Konto, ein Block mit `anhaenge:`, gültige Längen — sonst die
 *      neutrale 404. Die Zeile muss in der Modul-View stehen und der Anhang zu ihr gehören (`anhaenge.ts`), sonst
 *      ebenso: eine fremde oder erfundene Anhang-`id` sieht aus wie eine, die es nicht gibt.
 *   2. Die Herkunft (`herkunftBelegt`; fremd oder fehlend: `403`).
 *   3. Die signierte Bestätigung der Warnseite (`auth/bestaetigung.ts`), gebunden an Konto, Modul, Vorgang, Anhang und
 *      den SHA-256, den die Seite gezeigt hat; zehn Minuten gültig. Abgelaufen oder fremd: zurück auf die Warnseite mit
 *      Hinweis, nichts ausgeliefert.
 *   4. Die Klasse, frisch bestimmt: gesperrt oder „liegt im Postfach" nie; bei einer Warnung nur mit dem Pflicht-Haken.
 *   5. Höchstens zwei Downloads gleichzeitig je Prozess (ein Inhalt bis 10 MB liegt dabei im Speicher).
 *   6. Der Inhalt, nur mit genau dem bestätigten SHA-256 — hat er sich geändert, nichts.
 *   7. Erst der Nachweis (`anhang_download`, Protokoll `anhang_heruntergeladen`), dann die Antwort.
 *
 * **Bildvorschau (COPI-124):** `GET …/anhang/:anhang/bild` liefert ein Bild **ohne** Warnseite aus — nur wenn der Block
 * `bildvorschau: true` trägt und der Anhang `normal` ist und als PNG, JPEG oder WebP erkannt wurde (Endung und Inhalt
 * passen, `anhang-pruefung.ts`). Gleicher Zugriff wie oben (Schritt 1), gleiche Grenze gleichzeitiger Auslieferungen,
 * Inhalt nur mit dem SHA-256 der eben gelesenen Angaben. Typ aus dem erkannten Inhalt, nie aus der View, dazu `inline`,
 * `nosniff`, `no-store`, dieselbe Sandbox-CSP. Kein Download-Nachweis: angesehen ist nicht heruntergeladen (Entscheidung
 * im PR genannt); alles andere bleibt 404.
 *
 * **Header der Antwort:** immer `attachment` mit bereinigtem Namen (`inhaltsAngabe`), `application/octet-stream`,
 * `nosniff`, `no-store`, eine eigene CSP `sandbox; default-src 'none'` (bleibt auch nach dem Sicherheits-Haken stehen,
 * `sicherheit.ts`) und `Cross-Origin-Resource-Policy: same-origin`.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Zugang, ZugangLesen } from '../../auth/berechtigung.js';
import { bestaetigungAusstellen, bestaetigungPruefen } from '../../auth/bestaetigung.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import { anhangMeta, anhangZeileAnsicht, starkeWarnung } from '../../module/anhang-ansicht.js';
import { inhaltsAngabe } from '../../module/anhang-pruefung.js';
import { anhangDownloadNachweisen, anhangInhaltLesen, anhangLesen, type AnhangMitHash } from '../../module/anhaenge.js';
import { ANSICHT_LISTE_DETAIL } from '../../module/block.js';
import type { AktivesModul } from '../../module/modul-speicher.js';
import { VORGANG_ID_HOECHSTENS } from '../../module/vorgang-sperre.js';
import { navigationFuerZugang } from '../navigation.js';
import { DOWNLOAD_CSP } from '../sicherheit.js';
import { detailPfad, modulHinweisSenden, modulZielFinder, seiteSenden } from './modul-ziel.js';
import { nichtGefunden } from './neutral.js';

export interface ModulAnhangAbhaengigkeiten {
  readonly pool?: pg.Pool;
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
}

/** Der Zweck der signierten Bestätigung: getrennt von Sperre und Freigabe. */
const ANHANG_ZWECK = 'anhang-download';

/** So viele Downloads laufen höchstens gleichzeitig (je Prozess). */
export const DOWNLOADS_GLEICHZEITIG = 2;

/** Hinweise der Warnseite nach einem abgewiesenen Download (`?hinweis=`), nur diese festen Werte. */
const HINWEISE: Readonly<Record<string, string>> = {
  abgelaufen: 'Die Bestätigung war abgelaufen (nach 10 Minuten oder nach einem Neustart). Es wurde nichts heruntergeladen. Bitte noch einmal bestätigen.',
  haken: 'Bitte zuerst bestätigen, dass die Datei erwartet ist. Es wurde nichts heruntergeladen.',
  geaendert: 'Die Datei hat sich inzwischen geändert. Es wurde nichts heruntergeladen; bitte die Angaben unten prüfen.',
};

const FEHLER = {
  herkunft: 'Die Anfrage kam nicht von dieser Seite. Es wurde nichts heruntergeladen.',
  nichtVerfuegbar: 'Dieser Anhang ist gerade nicht verfügbar. Es wurde nichts heruntergeladen.',
  ausgelastet: 'Gerade laufen schon zwei Downloads. Bitte gleich noch einmal versuchen.',
} as const;

type AnhangParams = { kennung: string; id: string; anhang: string };

interface AnhangZiel {
  readonly zugang: Zugang | undefined;
  readonly modul: AktivesModul;
  readonly db: pg.Pool;
  readonly konto: string;
  readonly id: string;
  readonly anhangId: string;
  readonly detail: string;
  readonly warnseite: string;
}

export function anhangPfad(kennung: string, id: string, anhangId: string): string {
  return `${detailPfad(kennung, id)}/anhang/${encodeURIComponent(anhangId)}`;
}

/** Die Bildvorschau eines Anhangs (COPI-124). */
export function bildPfad(kennung: string, id: string, anhangId: string): string {
  return `${anhangPfad(kennung, id, anhangId)}/bild`;
}

function gueltigeId(wert: string): boolean {
  return wert.length > 0 && wert.length <= VORGANG_ID_HOECHSTENS;
}

export function registerModulAnhangRoutes(app: FastifyInstance, abhaengigkeiten: ModulAnhangAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;
  // Nur im Speicher dieses Prozesses (wie bei Sperre und Freigabe): nach einem Neustart gilt keine alte Bestätigung.
  const schluessel = randomBytes(32);
  const modulZiel = modulZielFinder(app, pool, zugangLesen);
  let laufend = 0;

  /** Schritt 1 (siehe Kopf): Modul, Konto, Block mit Anhängen, gültige Längen. `undefined`: die 404 ist gesendet. */
  async function anhangZiel(request: FastifyRequest<{ Params: AnhangParams }>, reply: FastifyReply): Promise<AnhangZiel | undefined> {
    const ziel = await modulZiel(request, reply);
    if (ziel === undefined) {
      return undefined;
    }
    const { zugang, modul, pool: db } = ziel;
    const { id, anhang: anhangId } = request.params;
    const konto = zugang?.benutzerId;
    if (konto === undefined || modul.block.ansicht !== ANSICHT_LISTE_DETAIL || modul.block.anhaenge === undefined || !gueltigeId(id) || !gueltigeId(anhangId)) {
      request.log.warn('Anhang: abgewiesen (Konto, Vorgang oder Modul ohne Anhänge)');
      await nichtGefunden(app, reply);
      return undefined;
    }
    return { zugang, modul, db, konto, id, anhangId, detail: detailPfad(modul.kennung, id), warnseite: anhangPfad(modul.kennung, id, anhangId) };
  }

  /** Der Anhang aus der View; nicht verfügbar: `503`, nicht da: neutrale 404. `undefined`: die Antwort ist gesendet. */
  async function anhangHolen(request: FastifyRequest, reply: FastifyReply, ziel: AnhangZiel): Promise<AnhangMitHash | undefined> {
    const gelesen = await anhangLesen(ziel.db, ziel.modul.kennung, ziel.modul.block, ziel.id, ziel.anhangId, request.log);
    if (!gelesen.ok) {
      await modulHinweisSenden(app, reply, ziel.zugang, 503, FEHLER.nichtVerfuegbar, ziel.detail);
      return undefined;
    }
    if (gelesen.wert === undefined) {
      await nichtGefunden(app, reply);
      return undefined;
    }
    return gelesen.wert;
  }

  function bestaetigungsInhalt(ziel: AnhangZiel, sha256: string): readonly string[] {
    return [ziel.konto, ziel.modul.kennung, ziel.id, ziel.anhangId, sha256];
  }

  app.get<{ Params: AnhangParams; Querystring: { hinweis?: unknown } }>('/module/:kennung/:id/anhang/:anhang', async (request, reply) => {
    const ziel = await anhangZiel(request, reply);
    if (ziel === undefined) {
      return reply;
    }
    const anhang = await anhangHolen(request, reply, ziel);
    if (anhang === undefined) {
      return reply;
    }
    const zeile = anhangZeileAnsicht(anhang, ziel.warnseite);
    const ladbar = (zeile.klasse === 'normal' || zeile.klasse === 'warnung') && anhang.sha256 !== undefined;
    const werte = [
      ...(anhang.typ === undefined ? [] : [{ label: 'Typ laut Absender', wert: anhang.typ, code: false }]),
      // Der SHA-256 nur, wenn es etwas herunterzuladen gibt (Entwurf: eine gesperrte Datei zeigt ihn nicht).
      ...(ladbar && anhang.sha256 !== undefined ? [{ label: 'SHA-256', wert: anhang.sha256, code: true }] : []),
    ];
    const html = await app.render('modul-anhang.eta', {
      titel: 'Anhang herunterladen',
      nav: navigationFuerZugang('module', ziel.zugang, ziel.modul.kennung),
      unterzeile: anhang.vorgangTitel === '' ? ziel.modul.block.menuename : `${ziel.modul.block.menuename} · ${anhang.vorgangTitel}`,
      zurueck: { href: ziel.detail, ziel: 'Vorgang' },
      hinweis: typeof request.query.hinweis === 'string' ? HINWEISE[request.query.hinweis] : undefined,
      datei: { name: zeile.name, meta: anhangMeta(anhang), klasse: zeile.klasse, symbol: zeile.symbol },
      werte,
      stark: zeile.klasse === 'warnung' ? starkeWarnung(anhang) : undefined,
      formular:
        ladbar && anhang.sha256 !== undefined
          ? { action: ziel.warnseite, sha256: anhang.sha256, ...bestaetigungAusstellen(schluessel, ANHANG_ZWECK, bestaetigungsInhalt(ziel, anhang.sha256), jetzt()) }
          : undefined,
    });
    return seiteSenden(reply, html);
  });

  app.get<{ Params: AnhangParams }>('/module/:kennung/:id/anhang/:anhang/bild', async (request, reply) => {
    const ziel = await anhangZiel(request, reply);
    if (ziel === undefined) {
      return reply;
    }
    if (ziel.modul.block.bildvorschau !== true) {
      return nichtGefunden(app, reply);
    }
    const anhang = await anhangHolen(request, reply, ziel);
    if (anhang === undefined) {
      return reply;
    }
    const { klasse, bild } = anhang.einstufung;
    if (klasse !== 'normal' || bild === undefined || anhang.sha256 === undefined) {
      request.log.warn({ klasse }, 'Bildvorschau: kein Bild mit Vorschau');
      return nichtGefunden(app, reply);
    }
    if (laufend >= DOWNLOADS_GLEICHZEITIG) {
      return reply.code(503).header('retry-after', '2').send();
    }
    laufend += 1;
    try {
      const inhalt = await anhangInhaltLesen(ziel.db, ziel.modul.kennung, ziel.modul.block, ziel.id, ziel.anhangId, anhang.sha256, request.log);
      if (!inhalt.ok || inhalt.wert === undefined) {
        return await nichtGefunden(app, reply);
      }
      return await reply
        .type(bild)
        .header('content-disposition', inhaltsAngabe(anhang.dateiname, 'inline'))
        .header('cache-control', 'no-store')
        .header('content-security-policy', DOWNLOAD_CSP)
        .header('cross-origin-resource-policy', 'same-origin')
        .send(inhalt.wert);
    } finally {
      laufend -= 1;
    }
  });

  app.post<{ Params: AnhangParams; Body: { bis?: unknown; token?: unknown; sha256?: unknown; erwartet?: unknown } | undefined }>(
    '/module/:kennung/:id/anhang/:anhang',
    async (request, reply) => {
      const ziel = await anhangZiel(request, reply);
      if (ziel === undefined) {
        return reply;
      }
      const { origin, referer, host } = request.headers;
      if (!herkunftBelegt(origin, referer, host)) {
        request.log.warn('Anhang: Herkunft fehlt oder ist fremd');
        return modulHinweisSenden(app, reply, ziel.zugang, 403, FEHLER.herkunft, ziel.warnseite);
      }
      const body = request.body ?? {};
      const sha256 = typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/.test(body.sha256) ? body.sha256 : '';
      if (sha256 === '' || !bestaetigungPruefen(schluessel, body, ANHANG_ZWECK, bestaetigungsInhalt(ziel, sha256), jetzt())) {
        request.log.warn('Anhang: Bestätigung ungültig oder abgelaufen');
        return reply.redirect(`${ziel.warnseite}?hinweis=abgelaufen`, 303);
      }
      const anhang = await anhangHolen(request, reply, ziel);
      if (anhang === undefined) {
        return reply;
      }
      const { klasse } = anhang.einstufung;
      if (klasse !== 'normal' && klasse !== 'warnung') {
        request.log.warn({ klasse }, 'Anhang: nicht auslieferbar');
        return reply.redirect(ziel.warnseite, 303);
      }
      if (anhang.sha256 !== sha256) {
        return reply.redirect(`${ziel.warnseite}?hinweis=geaendert`, 303);
      }
      if (klasse === 'warnung' && body.erwartet !== 'ja') {
        return reply.redirect(`${ziel.warnseite}?hinweis=haken`, 303);
      }
      if (laufend >= DOWNLOADS_GLEICHZEITIG) {
        request.log.warn('Anhang: zu viele Downloads gleichzeitig');
        return modulHinweisSenden(app, reply, ziel.zugang, 503, FEHLER.ausgelastet, ziel.warnseite);
      }
      laufend += 1;
      try {
        const inhalt = await anhangInhaltLesen(ziel.db, ziel.modul.kennung, ziel.modul.block, ziel.id, ziel.anhangId, sha256, request.log);
        if (!inhalt.ok) {
          return await modulHinweisSenden(app, reply, ziel.zugang, 503, FEHLER.nichtVerfuegbar, ziel.warnseite);
        }
        if (inhalt.wert === undefined) {
          return reply.redirect(`${ziel.warnseite}?hinweis=geaendert`, 303);
        }
        await anhangDownloadNachweisen(ziel.db, {
          modul: ziel.modul.kennung,
          vorgangId: ziel.id,
          anhangId: ziel.anhangId,
          dateiname: anhang.dateiname,
          groesse: inhalt.wert.length,
          sha256,
          klasse,
          konto: ziel.konto,
        });
        request.log.info({ klasse }, 'Anhang heruntergeladen');
        return await reply
          .type('application/octet-stream')
          .header('content-disposition', inhaltsAngabe(anhang.dateiname))
          .header('cache-control', 'no-store')
          .header('content-security-policy', DOWNLOAD_CSP)
          .header('cross-origin-resource-policy', 'same-origin')
          .send(inhalt.wert);
      } finally {
        laufend -= 1;
      }
    },
  );
}
