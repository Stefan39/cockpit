/**
 * Ein Konto entwerten und als gelöscht markieren (COPI-62, Migration 0025) — nie physisch löschen.
 *
 * `zugangEntwerten` ist der gemeinsame Kern von Entsperren (COPI-28) und Löschen: alle zweiten Faktoren weg (die
 * Datenbank archiviert sie ohne Geheimnis), alle Sitzungen und offenen Anmeldungen beendet, das Passwort durch einen
 * Hash ohne Urbild ersetzt, ein offener Wiederherstellungs-Link entwertet. Danach öffnet nichts von vorher das Konto.
 *
 * `kontoAlsGeloeschtMarkieren` entwertet den Zugang und markiert das Konto: die Adresse wird durch einen Platzhalter
 * ersetzt und in `geloescht_email` festgehalten. Anmeldung, Einladung und Adressprüfung suchen über die Adresse und
 * finden das Konto nicht mehr; die Adresse ist wieder frei. Name, Rolle und alles, was auf das Konto verweist
 * (Nachrichten, Protokoll, Anträge), bleiben im Bestand.
 *
 * Beide laufen im Client einer Transaktion, die der Aufrufer hält — zusammen mit seinem Protokolleintrag.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { passwortHashen } from './passwort.js';

/**
 * Ein Passwort-Hash, den niemand mehr kennt: gültig im Format, ohne Urbild. Kein Marker, den Argon2 auf einen Blick
 * verwirft — sonst scheiterte die Anmeldung eines solchen Kontos messbar schneller als jeder andere Fehlversuch (siehe
 * `entsperrung.ts`). Vor der Transaktion rechnen: Argon2id braucht Zeit, die Zeile soll so kurz wie möglich gesperrt sein.
 */
export async function unbrauchbarerPasswortHash(): Promise<string> {
  return passwortHashen(randomBytes(32).toString('base64url'));
}

/** Entwertet jeden Zugang des Kontos. Liefert, wie viele Passwörter entwertet wurden (0 oder 1). */
export async function zugangEntwerten(client: pg.PoolClient, benutzerId: string, passwortHash: string): Promise<number> {
  // Alle Faktoren: TOTP, Passkeys, Ersatzcodes, die offene Zeremonie. Die Funktion in der Datenbank (0014) ist die
  // Gegenstelle zu `zweiter_faktor_aktiv` und die einzige, die weiß, was ein Faktor ist (COPI-25).
  await client.query('SELECT cockpit.zweite_faktoren_entfernen($1)', [benutzerId]);
  // Kurzzeitdaten, ausdrücklich ausgenommen vom „nie löschen" (Stefan, 23.09.2026): offene Anmeldungen zwischen den
  // Schritten und die Sitzungen. Die `2fa-`-Zeilen sind Better Auths Zwischenzustand.
  await client.query('DELETE FROM cockpit.anmeldevorgang WHERE benutzer_id = $1', [benutzerId]);
  await client.query('DELETE FROM cockpit.session WHERE "userId" = $1', [benutzerId]);
  await client.query(`DELETE FROM cockpit.verification WHERE value = $1 AND identifier LIKE '2fa-%'`, [benutzerId]);
  // Das Passwort. Ohne diesen Schritt wäre das Konto nach dem Entfernen der Faktoren für jeden offen, der es kennt.
  const passwort = await client.query(
    `UPDATE cockpit.account SET password = $2, "updatedAt" = now()
      WHERE "userId" = $1 AND "providerId" = 'credential'`,
    [benutzerId, passwortHash],
  );
  // Je Konto höchstens ein offener Link: wer ihn noch hat, kommt damit nicht mehr hinein.
  await client.query(
    'UPDATE cockpit.zugang_wiederherstellung SET verbraucht_am = now() WHERE benutzer_id = $1 AND verbraucht_am IS NULL',
    [benutzerId],
  );
  return passwort.rowCount ?? 0;
}

/**
 * Entwertet den Zugang und markiert das Konto als gelöscht. `von` ist die Kennung dessen, der löscht (Konto-ID oder
 * ein fester Begriff wie `system`). Liefert `false`, wenn das Konto nicht (mehr) da ist — dann ändert sich nichts.
 *
 * Den Betreuer weist die Datenbank ab (`konto_betreuer_nicht_loeschen`, 0025); ihn löst nur die Übergabe ab.
 */
export async function kontoAlsGeloeschtMarkieren(
  client: pg.PoolClient,
  benutzerId: string,
  von: string,
  passwortHash: string,
): Promise<boolean> {
  const konto = await client.query('SELECT 1 FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NULL FOR UPDATE', [benutzerId]);
  if ((konto.rowCount ?? 0) === 0) {
    return false;
  }
  await zugangEntwerten(client, benutzerId, passwortHash);
  // Eine offene Adressänderung würde das Konto sonst später wieder auf eine echte Adresse setzen.
  await client.query('UPDATE cockpit.email_aenderung SET verbraucht_am = now() WHERE benutzer_id = $1 AND verbraucht_am IS NULL', [
    benutzerId,
  ]);
  await client.query(
    `UPDATE cockpit."user"
        SET geloescht_am = now(), geloescht_von = $2, geloescht_email = email,
            email = 'geloescht-' || id || '@geloescht.invalid', "updatedAt" = now()
      WHERE id = $1`,
    [benutzerId, von],
  );
  return true;
}
