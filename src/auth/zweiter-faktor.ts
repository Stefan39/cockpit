/**
 * Hat ein Konto einen aktiven zweiten Faktor? Genau eine Antwort (COPI-25).
 *
 * Die Antwort steht in der Datenbank: `cockpit.zweiter_faktor_aktiv` (Migration
 * 0011). Der Trigger, der `aktiviert_am` setzt, läuft dort und muss dieselbe Frage
 * stellen wie Tor, Rechteprüfung, Einrichtungsseite und Übergabe. Heute liefert sie
 * die Spalte `twoFactorEnabled` des Better-Auth-Plugins (TOTP) **oder** einen
 * eingerichteten Passkey (COPI-26, Migration 0012); keine der Stellen hat sich dafür
 * geändert.
 *
 * Deshalb liest im Code **niemand** die Spalte selbst, auch nicht aus einer
 * Better-Auth-Sitzung: `test/zweiter-faktor.test.ts` prüft das per Quelltext-Scan.
 * Der Wert kommt aus der Datenbank, nicht aus dem Sitzungsobjekt — eine Änderung
 * wirkt damit sofort, auch bei einer laufenden Sitzung.
 */
import type pg from 'pg';

/** Ein Pool oder der Client einer laufenden Transaktion. */
type Abfrager = Pick<pg.Pool, 'query'>;

/** Wahr, wenn das Konto einen aktiven zweiten Faktor hat; für ein unbekanntes Konto falsch. */
export async function zweiterFaktorAktiv(db: Abfrager, benutzerId: string): Promise<boolean> {
  const ergebnis = await db.query<{ aktiv: boolean }>(
    'SELECT cockpit.zweiter_faktor_aktiv(u) AS aktiv FROM cockpit."user" u WHERE u.id = $1',
    [benutzerId],
  );
  return ergebnis.rows[0]?.aktiv === true;
}
