/**
 * `GET /intern/vorgaenge/sperre?modul=<kennung>&id=<id>` (COPI-85): Ist dieser Vorgang von einem Menschen übernommen?
 *
 * Die Übernahme-Sperre wirkt nur, wenn die Fachagenten sie beachten. Das Cockpit schickt ihnen nichts (Entscheidung
 * Stefan, 28.09.2026) — sie fragen **vor jedem Senden** an einen Gast oder Kunden hier nach (Pflichtregel,
 * `docs/agenten-api.md`). Bei `gesperrt: true` oder bei jedem Fehler senden sie nicht.
 *
 * **Recht `vorgang_lesen`.** Die Antwort nennt nur, ob gesperrt ist, von wem (Anzeigename aus dem Konto, gelöscht:
 * „ehemaliges Konto") und seit wann — nie eine E-Mail-Adresse, nie eine Konto-ID.
 *
 * **Unbekanntes Modul: `404`, unbekannter Vorgang: `gesperrt: false`.** Ein Modul, das es nicht (aktiv) gibt, ist ein
 * Fehler im Agenten (Tippfehler in der Kennung) — ein stilles `gesperrt: false` darauf ließe ihn senden, obwohl ein
 * Mensch den Vorgang unter der richtigen Kennung übernommen hat. Die 404 zwingt ihn nach der Pflichtregel zu „nicht
 * senden". Den Vorgang selbst prüft der Endpunkt dagegen nicht gegen die View: der Agent kennt seine Vorgänge, eine
 * Existenzprüfung kostete je Anfrage eine Abfrage der Fach-View und sagte ihm nichts Neues. Eine Sperre gilt auch, wenn
 * das Modul den Eingriff `uebernehmen` inzwischen nicht mehr anbietet — im Zweifel für die Sperre.
 *
 * `GET /intern/vorgaenge/freigabe?modul=<kennung>&id=<id>&fassung=<n>&hash=<sha256>` (COPI-90): Ist **genau diese**
 * Fassung mit **genau diesem** Text freigegeben? Der Agent fragt vor dem Senden einer Antwort und sendet nur bei
 * `freigegeben: true` — bei allem anderen (auch jedem Fehler) nicht. Der Hash ist der SHA-256 (Hex, UTF-8) des Texts, den
 * er senden will. Dasselbe Recht `vorgang_lesen`, dieselbe Antwort ohne Adresse oder Konto-ID, unbekanntes Modul `404`.
 * Ist der Vorgang übernommen, gilt nichts als freigegeben (der Mensch antwortet selbst). Ebenso nichts, wenn die genannte
 * Fassung nicht (mehr) die jüngste in der View ist oder schon gesendet wurde — eine alte, nie zurückgezogene Freigabe
 * darf weder eine überholte Fassung noch einen zweiten Versand erlauben. Dafür liest der Endpunkt die View (mit
 * Katalogprüfung); scheitert das, `503`, und der Agent sendet nicht.
 *
 * `GET /intern/vorgaenge/entscheidungen?modul=<kennung>` (COPI-91): die geltenden Entscheidungen eines Moduls mit Eingriff
 * `entscheiden`, jüngste zuerst (höchstens `ENTSCHEIDUNGEN_HOECHSTENS`) — je Vorgang `id`, `wert`, `von` (Anzeigename) und
 * `am`. Der Agent gleicht sie mit seinem eigenen Stand ab (etwa: „interessant" ohne Bewerbungsentwurf → entwerfen) und
 * handelt; das Cockpit schickt ihm nichts. Dasselbe Recht `vorgang_lesen`; unbekanntes Modul oder eines ohne den Eingriff
 * `404`.
 */
import * as z from 'zod';
import { istModulKennung } from '../module/block.js';
import { aktiveModule } from '../module/modul-speicher.js';
import { entscheidenErlaubt, freigabeErlaubt } from '../module/block.js';
import { alleGeltendenEntscheidungen } from '../module/entscheidung.js';
import { entwurfLesen, freigabenLesen, passendeFreigabe } from '../module/freigabe.js';
import { sperreLesen, VORGANG_ID_HOECHSTENS } from '../module/vorgang-sperre.js';
import { antworten } from './antwort.js';
import { abfrageLesen } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

const ABFRAGE = z.strictObject({
  modul: z.string().refine(istModulKennung),
  id: z.string().min(1).max(VORGANG_ID_HOECHSTENS),
});

const FREIGABE_ABFRAGE = z.strictObject({
  modul: z.string().refine(istModulKennung),
  id: z.string().min(1).max(VORGANG_ID_HOECHSTENS),
  fassung: z.string().regex(/^[1-9][0-9]{0,8}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const ENTSCHEIDUNGEN_ABFRAGE = z.strictObject({
  modul: z.string().refine(istModulKennung),
});

export function registriereVorgangRoute(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool } = abhaengigkeiten;

  router.route({
    methode: 'GET',
    url: '/vorgaenge/sperre',
    scope: 'vorgang_lesen',
    handler: async (request, reply) => {
      const abfrage = abfrageLesen(ABFRAGE, request.query, reply);
      if (abfrage === undefined) {
        return reply;
      }
      const { modul, id } = abfrage;
      if (!(await aktiveModule(pool)).some((eintrag) => eintrag.kennung === modul)) {
        return antworten(reply, 404, 'nicht_gefunden');
      }
      const sperre = await sperreLesen(pool, { modul, vorgangId: id });
      return sperre === undefined ? { gesperrt: false } : { gesperrt: true, von: sperre.anzeigename, seit: sperre.uebernommenAm.toISOString() };
    },
  });

  router.route({
    methode: 'GET',
    url: '/vorgaenge/freigabe',
    scope: 'vorgang_lesen',
    handler: async (request, reply) => {
      const abfrage = abfrageLesen(FREIGABE_ABFRAGE, request.query, reply);
      if (abfrage === undefined) {
        return reply;
      }
      const { modul, id, fassung, hash } = abfrage;
      const aktiv = (await aktiveModule(pool)).find((eintrag) => eintrag.kennung === modul);
      if (aktiv === undefined || !freigabeErlaubt(aktiv.block)) {
        return antworten(reply, 404, 'nicht_gefunden');
      }
      if ((await sperreLesen(pool, { modul, vorgangId: id })) !== undefined) {
        return { freigegeben: false, grund: 'uebernommen' };
      }
      const entwurf = await entwurfLesen(pool, modul, aktiv.block, id, request.log);
      if (!entwurf.ok) {
        return antworten(reply, 503, 'nicht_verfuegbar');
      }
      if (entwurf.wert === undefined || String(entwurf.wert.fassung) !== fassung || entwurf.wert.hash !== hash) {
        return { freigegeben: false, grund: 'nicht_aktuell' };
      }
      if (entwurf.wert.gesendetAm !== undefined) {
        return { freigegeben: false, grund: 'gesendet' };
      }
      const freigabe = passendeFreigabe(await freigabenLesen(pool, modul, id), Number(fassung), hash);
      return freigabe === undefined ? { freigegeben: false } : { freigegeben: true, fassung: freigabe.fassung, von: freigabe.von, am: freigabe.am.toISOString() };
    },
  });

  router.route({
    methode: 'GET',
    url: '/vorgaenge/entscheidungen',
    scope: 'vorgang_lesen',
    handler: async (request, reply) => {
      const abfrage = abfrageLesen(ENTSCHEIDUNGEN_ABFRAGE, request.query, reply);
      if (abfrage === undefined) {
        return reply;
      }
      const aktiv = (await aktiveModule(pool)).find((eintrag) => eintrag.kennung === abfrage.modul);
      if (aktiv === undefined || !entscheidenErlaubt(aktiv.block)) {
        return antworten(reply, 404, 'nicht_gefunden');
      }
      const entscheidungen = await alleGeltendenEntscheidungen(pool, abfrage.modul);
      return { entscheidungen: entscheidungen.map((e) => ({ id: e.vorgangId, wert: e.wert, von: e.von, am: e.am.toISOString() })) };
    },
  });
}
