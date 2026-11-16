/**
 * Das App-Symbol der Instanz ändern (COPI-101), aus dem Abschnitt „Erscheinungsbild" der Einstellungen.
 *
 *   * `POST /einstellungen/app-symbol` — JSON `{ png }` (Base64): das PNG, das das Skript der Einstellungen
 *     (`assets/js/erscheinungsbild.js`) aus dem gewählten Bild zugeschnitten hat, genau 512 × 512 Pixel. Das Cockpit
 *     liest es streng (`pwa/png.ts`), rechnet alle Größen neu und speichert nur, was es selbst kodiert hat (`201`).
 *     Passt die Datei nicht: `400` mit `{ fehler: 'bild' }` — Dateityp, Größe und Lesbarkeit hat das Skript schon
 *     vorher geprüft und dort erklärt; hier kommt nur an, was das Skript umgangen hat.
 *   * `GET /einstellungen/app-symbol/skript.js` — das Skript dazu (hinter dem Tor, wie `/pwa.js`).
 *   * `POST /einstellungen/app-symbol/zuruecksetzen` — Formular, auch ohne Skript: zurück auf das Standard-Symbol,
 *     dann zu den Einstellungen (`303`).
 *
 * **Wer:** Recht `erscheinungsbild_aendern` (Betreuer, Betriebs-Admin); sonst die neutrale 404. **CSRF:** Herkunft
 * Pflicht (`herkunftBelegt`); das Hochladen nimmt dazu nur `application/json` an — das schickt kein fremdes Formular.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import * as z from 'zod';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { PngFehler } from '../../pwa/png.js';
import { symbolSpeichern, symbolZuruecksetzen, type SymbolQuelle } from '../../pwa/symbol-speicher.js';
import { eigenerSymbolSatz } from '../../pwa/symbol.js';
import { EINSTELLUNGEN_PFAD } from './einstellungen.js';
import { kontoMitHerkunft } from './konto-pruefen.js';
import { skriptAusliefern, skriptLesen } from './passkey-skript.js';

export const APP_SYMBOL_PFAD = '/einstellungen/app-symbol';

/**
 * Ein PNG mit 512 × 512 Pixeln ist unkomprimiert gut 1 MB groß; was der Browser kodiert, ist kleiner. 1,5 MB als PNG,
 * als Base64 ein Drittel mehr, dazu der JSON-Rahmen.
 */
const PNG_HOECHSTENS = 1_500_000;
const RUMPF_HOECHSTENS = Math.ceil((PNG_HOECHSTENS * 4) / 3) + 1024;

const HOCHLADEN = z.strictObject({
  png: z
    .string()
    .max(Math.ceil((PNG_HOECHSTENS * 4) / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export interface ErscheinungsbildAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
  readonly symbole: SymbolQuelle;
}

export function registriereErscheinungsbildRouten(app: FastifyInstance, abhaengigkeiten: ErscheinungsbildAbhaengigkeiten): void {
  const { pool, zugangLesen, symbole } = abhaengigkeiten;

  skriptAusliefern(app, `${APP_SYMBOL_PFAD}/skript.js`, skriptLesen('erscheinungsbild.js'));

  /** Das Konto, wenn es das Recht hat und die Anfrage aus dem Cockpit kommt; sonst ist die Antwort schon gesendet. */
  function pruefen(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
    return kontoMitHerkunft(app, request, reply, zugangLesen, (zugang) => (hatRecht(zugang, 'erscheinungsbild_aendern') ? zugang.benutzerId : undefined), 'App-Symbol');
  }

  app.post(APP_SYMBOL_PFAD, { bodyLimit: RUMPF_HOECHSTENS }, async (request, reply) => {
    const konto = await pruefen(request, reply);
    if (konto === undefined) {
      return reply;
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      return reply.code(415).header('cache-control', 'no-store').send({ fehler: 'nur_json' });
    }
    const geprueft = HOCHLADEN.safeParse(request.body);
    if (!geprueft.success) {
      return reply.code(400).header('cache-control', 'no-store').send({ fehler: 'ungueltige_anfrage' });
    }
    let satz;
    try {
      satz = eigenerSymbolSatz(Buffer.from(geprueft.data.png, 'base64'));
    } catch (fehler) {
      if (!(fehler instanceof PngFehler)) {
        throw fehler;
      }
      // Der Grund ist ein fester Text aus `png.ts`, nie ein Inhalt der Datei.
      request.log.warn({ grund: fehler.message }, 'App-Symbol: Bild abgewiesen');
      return reply.code(400).header('cache-control', 'no-store').send({ fehler: 'bild' });
    }
    await symbolSpeichern(pool, satz, konto);
    symbole.vergessen();
    return reply.code(201).header('cache-control', 'no-store').send({ hash: satz.hash });
  });

  app.post(`${APP_SYMBOL_PFAD}/zuruecksetzen`, async (request, reply) => {
    const konto = await pruefen(request, reply);
    if (konto === undefined) {
      return reply;
    }
    await symbolZuruecksetzen(pool, konto);
    symbole.vergessen();
    return reply.code(303).header('location', `${EINSTELLUNGEN_PFAD}?symbol=zurueckgesetzt`).header('cache-control', 'no-store').send();
  });
}
