/**
 * Sitzungsabfrage für die zentrale 2FA-Weiche.
 *
 * Ohne Sitzungs-Cookie wird gar nicht erst die Datenbank gefragt — das hält
 * anonyme Anfragen (Health-Check, Übersicht) frei von Datenbanklast.
 */
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { SITZUNGS_COOKIE_NAME, type CockpitAuth } from './konfiguration.js';
import { zweiterFaktorAktiv } from './zweiter-faktor.js';
import type { SitzungLesen, SitzungsZustand } from './zwei-faktor-tor.js';

const OHNE_SITZUNG: SitzungsZustand = {
  sitzungVorhanden: false,
  zweiterFaktorAktiv: false,
};

export function sitzungLeserBauen(auth: CockpitAuth, pool: pg.Pool): SitzungLesen {
  return async (request: FastifyRequest): Promise<SitzungsZustand> => {
    if (!request.headers.cookie?.includes(SITZUNGS_COOKIE_NAME)) {
      return OHNE_SITZUNG;
    }
    const sitzung = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!sitzung) {
      return OHNE_SITZUNG;
    }
    return {
      sitzungVorhanden: true,
      // Aus der einen Quelle (COPI-25), nicht aus dem Sitzungsobjekt: eine Änderung
      // wirkt sofort, und ein Passkey zählt mit, sobald er die Funktion kennt.
      zweiterFaktorAktiv: await zweiterFaktorAktiv(pool, sitzung.user.id),
    };
  };
}
