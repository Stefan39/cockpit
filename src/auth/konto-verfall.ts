/**
 * Verfallsfrist für halbfertige Konten ohne aktivierten zweiten Faktor (COPI-17).
 *
 * Ein Konto kann mit Passwort allein die Einrichtungsseite des zweiten Faktors
 * erreichen, sich aber nicht anmelden. Wer Passwort und Adresse kennt, kann
 * einen eigenen Authenticator binden — sofern das Konto noch existiert. Die
 * Frist begrenzt die Explosion unnützlicher Konten aus abgefangenen Einladungen.
 *
 * **Verfallskriterium: „nie aktiviert", nicht „aktuell kein zweiter Faktor".**
 * `aktiviert_am` wird bei der ersten Aktivierung des zweiten Faktors gesetzt und
 * nie mehr zurückgesetzt. Ein aktives Konto, dessen Faktor später abgeschaltet
 * wird (die rohe Better-Auth-Route `/api/auth/two-factor/disable` ist seit
 * COPI-20 am Tor zu, der Zustand bleibt aber denkbar, etwa durch einen Eingriff
 * in der Datenbank), hat weiterhin `aktiviert_am` gesetzt und wird nicht gelöscht —
 * das ist die richtige Abkürzung für „das Konto war je mal legitim in Benutzung".
 *
 * **Gesetzt wird der Marker von der Datenbank, nicht von der Anwendung** (COPI-19):
 * der Trigger `user_aktivierung_markieren` (Migration 0007) greift bei jedem Update,
 * das `twoFactorEnabled` einschaltet. Eine Markierung in einer einzelnen Route hätte
 * jeden Weg verfehlt, der an ihr vorbeiläuft, und das Konto wäre trotz
 * funktionierendem Faktor gelöscht worden.
 *
 * Der Cleanup läuft beim Start und danach alle 15 Minuten (kein eigener Dienst,
 * kein Cron-Abhängigkeit). Zeitpunkt und Frist sind Parameter, damit Tests nicht
 * warten müssen.
 */
import type pg from 'pg';
import { emailNormalisieren } from './einladung-speicher.js';
import { kontoAlsGeloeschtMarkieren, unbrauchbarerPasswortHash } from './konto-loeschen.js';
import { protokollSchreiben } from './protokoll.js';

/** 72 Stunden. */
export const KONTO_VERFALL_FRIST_MS = 72 * 60 * 60 * 1000;

/**
 * Existiert ein Konto zur normalisierten Adresse, das nie aktiviert wurde und
 * älter als die Verfallsfrist ist? True → das Konto verfällt gerade.
 *
 * Benutzt **nicht** die `twoFactorEnabled`-Spalte, sondern `aktiviert_am`,
 * um die Abkürzung oben zu wahren.
 *
 * Zeit wird als Parameter übergeben, damit Tests — ohne zu warten — die Frist
 * mit `jetzt` verschieben können.
 */
export async function kontoVerfallen(
  pool: pg.Pool,
  email: string,
  jetzt: Date = new Date(),
): Promise<boolean> {
  const normalisiert = emailNormalisieren(email);
  const fristGrenze = new Date(jetzt.getTime() - KONTO_VERFALL_FRIST_MS);
  const ergebnis = await pool.query<{ vorhanden: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM cockpit."user"
         WHERE lower(email) = $1
           AND "aktiviert_am" IS NULL
           AND "createdAt" <= $2
      ) AS vorhanden`,
    [normalisiert, fristGrenze],
  );
  return ergebnis.rows[0]?.vorhanden === true;
}

/**
 * Markiert alle halbfertigen Konten, deren Verfallsfrist abgelaufen ist, als gelöscht — **nie physisch** (COPI-62):
 * Zugang entwertet, Adresse durch einen Platzhalter ersetzt und damit wieder einladbar (`konto-loeschen.ts`).
 *
 * Je Konto ein Protokolleintrag **in derselben Transaktion**: ein Konto verfällt nie ohne Eintrag. Zwei gleichzeitige
 * Aufrufe sind von selbst sicher: das Markieren sperrt die Zeile und greift nur bei einem noch nicht markierten Konto,
 * der zweite Aufruf überspringt es — jedes Konto steht genau einmal im Protokoll.
 *
 * Liefert die Zahl der markierten Konten zurück (Log-relevant).
 */
export async function verfalleneKontenMarkieren(
  pool: pg.Pool,
  jetzt: Date,
): Promise<number> {
  const fristGrenze = new Date(jetzt.getTime() - KONTO_VERFALL_FRIST_MS);
  const kandidaten = await pool.query<{ id: string }>(
    `SELECT id FROM cockpit."user"
      WHERE "aktiviert_am" IS NULL AND "createdAt" <= $1 AND geloescht_am IS NULL`,
    [fristGrenze],
  );
  if (kandidaten.rows.length === 0) {
    return 0;
  }
  // Argon2id rechnet vor der Transaktion; ein Hash ohne Urbild genügt für alle.
  const passwortHash = await unbrauchbarerPasswortHash();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let markiert = 0;
    for (const { id } of kandidaten.rows) {
      if (await kontoAlsGeloeschtMarkieren(client, id, 'system', passwortHash)) {
        await protokollSchreiben(client, { art: 'konto_verfallen', akteur: 'system', ziel: id });
        markiert++;
      }
    }
    await client.query('COMMIT');
    return markiert;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
