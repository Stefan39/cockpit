/**
 * Die Abfragen der Seite Benutzer (COPI-45): Konten und offene Einladungen.
 *
 * Gelesen werden **nur die Spalten, die die Seite zeigt** — kein Passwort-Hash, kein TOTP-Geheimnis, kein Ersatzcode,
 * kein Token, keine Sitzung, keine IP. Was nie geladen wurde, kann eine Vorlage nicht versehentlich ausgeben.
 *
 * Der zweite Faktor kommt aus den Funktionen der Datenbank (`zweiter_faktor_aktiv`, `totp_aktiv`, COPI-25): die Spalte
 * des Better-Auth-Plugins liest der Code nie selbst. „Zuletzt angemeldet" kommt aus dem Protokoll
 * (`letzteAnmeldungen` in `protokoll.ts`, die einzige Stelle, die die Tabelle anfasst). Ein eigener Index lohnt sich bei
 * der Größe eines Betriebs nicht; wächst das Protokoll über Jahre, regelt E7 die Aufbewahrung.
 */
import type pg from 'pg';
import type { BenutzerDaten, EinladungDaten, KontoDaten } from './benutzer-liste.js';
import { letzteAnmeldungen } from './protokoll.js';

interface KontoSpalten {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly rolle: string;
  readonly aktiv: boolean;
  readonly passkeys: number;
  readonly totp: boolean;
  readonly angelegt_am: Date;
  readonly aktiviert_am: Date | null;
}

interface EinladungSpalten {
  readonly email: string;
  readonly rolle: string;
  readonly von: string | null;
  readonly ablauf_am: Date;
}

/**
 * Die Konten mit allem, was die Seite zeigt — alle, oder nur das mit dieser Kennung (Bearbeiten, COPI-46). Gibt es die
 * Kennung nicht, ist die Liste leer.
 */
export async function kontenLesen(pool: pg.Pool, nurId?: string): Promise<KontoDaten[]> {
  const [konten, anmeldungen] = await Promise.all([
    pool.query<KontoSpalten>(
      `SELECT u.id, u.name, u.email, u.rolle,
              cockpit.zweiter_faktor_aktiv(u) AS aktiv,
              (SELECT count(*)::int FROM cockpit.passkey p WHERE p.benutzer_id = u.id) AS passkeys,
              cockpit.totp_aktiv(u) AS totp,
              u."createdAt" AS angelegt_am,
              u.aktiviert_am
         FROM cockpit."user" u
        WHERE u.geloescht_am IS NULL AND ($1::text IS NULL OR u.id = $1)`,
      [nurId ?? null],
    ),
    letzteAnmeldungen(pool),
  ]);
  return konten.rows.map(
    (zeile): KontoDaten => ({
      id: zeile.id,
      name: zeile.name,
      email: zeile.email,
      rolle: zeile.rolle,
      zweiterFaktorAktiv: zeile.aktiv,
      passkeys: zeile.passkeys,
      totp: zeile.totp,
      angelegtAm: zeile.angelegt_am,
      aktiviertAm: zeile.aktiviert_am ?? undefined,
      zuletztAngemeldet: anmeldungen.get(zeile.id),
    }),
  );
}

export async function benutzerDatenLesen(pool: pg.Pool, jetzt: Date): Promise<Omit<BenutzerDaten, 'selbstId'>> {
  const [konten, einladungen] = await Promise.all([
    kontenLesen(pool),
    pool.query<EinladungSpalten>(
      `SELECT e.email, e.rolle, v.name AS von, e.ablauf_am
         FROM cockpit.einladung e
         LEFT JOIN cockpit."user" v ON v.id = e.eingeladen_von
        WHERE e.verbraucht_am IS NULL
          AND e.ablauf_am > $1`,
      [jetzt],
    ),
  ]);
  return {
    konten,
    einladungen: einladungen.rows.map(
      (zeile): EinladungDaten => ({
        email: zeile.email,
        rolle: zeile.rolle,
        eingeladenVon: zeile.von ?? undefined,
        ablaufAm: zeile.ablauf_am,
      }),
    ),
  };
}
