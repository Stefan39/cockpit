/**
 * Gemeinsame Hilfen für die datenbankgestützten Tests (COPI-11).
 *
 * Kein Testfall, sondern Werkzeug: Formularkodierung, Cookie-Auslese und das
 * Anlegen eines Kontos samt echtem TOTP-Durchlauf. Letzteres bewusst über die
 * regulären Wege (Better Auth + die Routen aus COPI-10) statt über direkte
 * Schreibzugriffe auf `twoFactorEnabled` — sonst prüfte der Test seine eigene
 * Abkürzung statt den Zustand, den die Anwendung wirklich erzeugt.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { mitBenutzerAnlage } from '../src/auth/benutzer-anlage.js';
import type { CockpitAuth } from '../src/auth/konfiguration.js';
import { betreuerZugriffSetzen, type BetreuerZugriff } from '../src/module/betreuer-zugriff.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import type { EingriffStatus } from '../src/status/eingriff.js';
import { qrAusSeiteLesen } from './qr-lesen.js';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

export const FORMULAR_KOPF = { 'content-type': 'application/x-www-form-urlencoded' };

export function formular(daten: Record<string, string>): string {
  return new URLSearchParams(daten).toString();
}

export function cookieKopf(setCookie: string | string[] | undefined): string {
  const cookies = typeof setCookie === 'string' ? [setCookie] : (setCookie ?? []);
  return cookies.map((eintrag) => eintrag.split(';')[0]).join('; ');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Die `otpauth://`-URI trägt das Geheimnis base32-kodiert; Better Auth prüft
 * intern gegen den unkodierten Wert. Reine Kodierung, kein Krypto.
 */
export function base32Dekodieren(wert: string): string {
  let sammler = 0;
  let bits = 0;
  let ausgabe = '';
  for (const zeichen of wert.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(zeichen);
    if (index < 0) {
      continue;
    }
    sammler = (sammler << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      ausgabe += String.fromCharCode((sammler >> bits) & 0xff);
    }
  }
  return ausgabe;
}

export interface Konto {
  readonly id: string;
  readonly cookie: string;
  /** Base32-Geheimnis des TOTP-Faktors; leer ohne zweiten Faktor. */
  readonly geheimnis: string;
  /** Die einmal angezeigten Ersatzcodes; leer ohne zweiten Faktor. */
  readonly ersatzcodes: readonly string[];
}

/**
 * Liest die Ersatzcodes aus der Einrichtungsseite — wie eine Person, die sie
 * abschreibt. Sie werden nur dort ein einziges Mal angezeigt.
 */
export function ersatzcodesAusSeite(html: string): string[] {
  return [...html.matchAll(/<code>([A-Za-z0-9]{5}-[A-Za-z0-9]{5})<\/code>/g)].map(
    (treffer) => treffer[1] ?? '',
  );
}

export interface KontoWunsch {
  readonly email: string;
  readonly passwort: string;
  readonly name: string;
  readonly mitZweitemFaktor: boolean;
}

/** Legt ein Konto an und richtet auf Wunsch einen echten TOTP-Faktor ein. */
export async function kontoEinrichten(
  app: FastifyInstance,
  auth: CockpitAuth,
  wunsch: KontoWunsch,
): Promise<Konto> {
  const { headers, response } = await mitBenutzerAnlage(() =>
    auth.api.signUpEmail({
      body: { email: wunsch.email, password: wunsch.passwort, name: wunsch.name },
      returnHeaders: true,
    }),
  );
  let cookie = cookieKopf(headers.getSetCookie());
  if (!wunsch.mitZweitemFaktor) {
    return { id: response.user.id, cookie, geheimnis: '', ersatzcodes: [] };
  }

  const einrichten = await app.inject({
    method: 'POST',
    url: '/zwei-faktor/einrichten',
    headers: { ...FORMULAR_KOPF, cookie },
    payload: formular({ passwort: wunsch.passwort }),
  });
  // Wie ein Telefon: das Geheimnis kommt aus dem QR-Code, nicht aus einem Text.
  const geheimnis = geheimnisAusUri(qrAusSeiteLesen(einrichten.body));
  const { code } = await auth.api.generateTOTP({
    body: { secret: base32Dekodieren(geheimnis) },
  });
  const pruefen = await app.inject({
    method: 'POST',
    url: '/zwei-faktor/pruefen',
    headers: { ...FORMULAR_KOPF, cookie },
    payload: formular({ code }),
  });
  cookie = cookieKopf(pruefen.headers['set-cookie']) || cookie;
  return {
    id: response.user.id,
    cookie,
    geheimnis,
    ersatzcodes: ersatzcodesAusSeite(einrichten.body),
  };
}

/**
 * Richtet für ein Konto ohne Faktor einen Passkey ein — über die echten Routen aus
 * COPI-26, mit einem Software-Authenticator. Liefert das Gerät und die einmal
 * angezeigten Ersatzcodes.
 */
export async function passkeyEinrichten(
  app: FastifyInstance,
  konto: Konto,
  passwort: string,
  basisUrl: string,
): Promise<{ geraet: SoftwareAuthenticator; ersatzcodes: string[] }> {
  const optionen = await app.inject({
    method: 'POST',
    url: '/zwei-faktor/passkey/optionen',
    headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
    payload: formular({ passwort }),
  });
  const geraet = new SoftwareAuthenticator();
  const antwort = await app.inject({
    method: 'POST',
    url: '/zwei-faktor/passkey/pruefen',
    headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
    payload: formular({
      antwort: JSON.stringify(geraet.registrieren(optionen.json(), basisUrl)),
      name: 'Testgerät',
    }),
  });
  return { geraet, ersatzcodes: ersatzcodesAusSeite(antwort.body) };
}

/** Frischer TOTP-Code zu einem Base32-Geheimnis — von Better Auth selbst erzeugt. */
export async function totpCode(auth: CockpitAuth, geheimnis: string): Promise<string> {
  const { code } = await auth.api.generateTOTP({
    body: { secret: base32Dekodieren(geheimnis) },
  });
  return code;
}

/**
 * Löscht alle Konten, auch einen aktivierten Betreuer.
 *
 * Die Datenbank schützt einen aktivierten Betreuer vor Löschung und
 * Herabstufung (COPI-22, Trigger `user_betreuer_bleibt_bestehen`); nur die
 * Übergabe darf das, und sie sagt es der Datenbank mit der transaktionslokalen
 * Einstellung `cockpit.betreuer_aenderung`. Die Testaufräumung sagt es ebenso:
 * ein zurückgebliebener Betreuer würde sonst jedem folgenden Testlauf das
 * Aufräumen verwehren. Ein einfaches `DELETE FROM cockpit."user"` scheitert
 * in dem Fall — mit Absicht, es ist der Schutz, der hier getestet wird.
 */
export async function kontenLoeschen(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('cockpit.betreuer_aenderung', 'ja', true)");
    // Hochgeladene App-Symbole (COPI-101) verweisen auf ihr Konto.
    await client.query('DELETE FROM cockpit.app_symbol');
    // Ebenso der Lesestand des Posteingangs (COPI-112): ihn legt jede angemeldete Seite an.
    await client.query('DELETE FROM cockpit.posteingang_stand');
    await client.query('DELETE FROM cockpit.modul_gelesen');
    // Und der Stand des Posteingang-Push (COPI-116).
    await client.query('DELETE FROM cockpit.posteingang_push');
    // Und die Nachweise heruntergeladener Anhänge (COPI-110).
    await client.query('DELETE FROM cockpit.anhang_download');
    // Und Entscheidungen an Vorgängen (COPI-91).
    await client.query('DELETE FROM cockpit.entscheidung');
    // Und Betreuer-Zugriffe, die ein Konto in der Oberfläche gesetzt hat (COPI-134); die per Server-Kommando bleiben.
    await client.query('DELETE FROM cockpit.modul_betreuer_zugriff WHERE gesetzt_von IS NOT NULL');
    // Und der Freigabemodus für Updates (COPI-141): ihn setzt immer ein Konto.
    await client.query('DELETE FROM cockpit.update_freigabemodus');
    await client.query('DELETE FROM cockpit."user"');
    await client.query('COMMIT');
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

export interface ProtokollZeile {
  readonly art: string;
  readonly akteur: string;
  readonly ziel: string | null;
  readonly einzelheiten: Record<string, unknown>;
}

/**
 * Die höchste Nummer im Protokoll. Das Protokoll lässt sich nicht abräumen
 * (COPI-23), also zählen Tests nicht „alle Einträge", sondern die seit einer
 * Marke: `const marke = await protokollMarke(pool)`, Ablauf, dann
 * `protokollSeit(pool, marke)`.
 */
export async function protokollMarke(pool: pg.Pool): Promise<number> {
  const ergebnis = await pool.query<{ marke: string }>(
    'SELECT coalesce(max(id), 0)::text AS marke FROM cockpit.protokoll',
  );
  return Number(ergebnis.rows[0]?.marke ?? '0');
}

/** Alle Einträge nach einer Marke, in der Reihenfolge, in der sie entstanden sind. */
export async function protokollSeit(pool: pg.Pool, marke: number): Promise<ProtokollZeile[]> {
  const ergebnis = await pool.query<ProtokollZeile>(
    'SELECT art, akteur, ziel, einzelheiten FROM cockpit.protokoll WHERE id > $1 ORDER BY id',
    [marke],
  );
  return ergebnis.rows;
}

/**
 * Lässt das Schreiben einer Protokollart absichtlich scheitern — für Tests, die
 * zeigen, dass die Änderung und ihr Eintrag zu **einer** Transaktion gehören:
 * scheitert der Eintrag, darf die Änderung nicht bestehen bleiben.
 *
 * Legt einen Trigger auf `INSERT` mit Bedingung auf die Art an und liefert die
 * Funktion, die ihn wieder entfernt — im `finally` aufrufen. `art` steht nur als
 * Literal aus dem Test selbst hier ein (`einladung_erzeugt` und ähnlich).
 */
export async function protokollSchreibenScheitern(
  pool: pg.Pool,
  art: string,
): Promise<() => Promise<void>> {
  const name = `test_protokoll_scheitert_${art}`;
  await pool.query(`
    CREATE FUNCTION cockpit.${name}() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION '${name}'; END $$`);
  await pool.query(`
    CREATE TRIGGER ${name} BEFORE INSERT ON cockpit.protokoll
    FOR EACH ROW WHEN (NEW.art = '${art}') EXECUTE FUNCTION cockpit.${name}()`);
  return async () => {
    await pool.query(`DROP TRIGGER ${name} ON cockpit.protokoll`);
    await pool.query(`DROP FUNCTION cockpit.${name}()`);
  };
}

/**
 * Lässt jedes `INSERT` in eine Tabelle absichtlich scheitern — für Tests, die zeigen, dass mehrere
 * Schritte zu **einer** Transaktion gehören: scheitert der letzte, darf keiner der vorherigen
 * bestehen bleiben, und die Fehlermeldung der Datenbank darf nirgends nach außen gelangen
 * (`meldung` steht in der Ausnahme und lässt sich so in Antwort und Log suchen).
 *
 * `tabelle` und `meldung` stehen nur als Literale aus dem Test selbst hier ein. Liefert die Funktion,
 * die den Trigger wieder entfernt — im `finally` aufrufen.
 */
export async function einfuegenScheitern(
  pool: pg.Pool,
  tabelle: 'befund' | 'wache' | 'agent',
  meldung: string,
): Promise<() => Promise<void>> {
  const name = `test_${tabelle}_scheitert`;
  await pool.query(`
    CREATE OR REPLACE FUNCTION cockpit.${name}() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION '${meldung}'; END $$`);
  await pool.query(`DROP TRIGGER IF EXISTS ${name} ON cockpit.${tabelle}`);
  await pool.query(`
    CREATE TRIGGER ${name} BEFORE INSERT ON cockpit.${tabelle}
    FOR EACH ROW EXECUTE FUNCTION cockpit.${name}()`);
  return async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON cockpit.${tabelle}`);
    await pool.query(`DROP FUNCTION IF EXISTS cockpit.${name}()`);
  };
}

/**
 * Leert die Übernahme-Sperren (COPI-85, Migration 0030). Die Tabelle weist DELETE ab (nie löschen), deshalb TRUNCATE.
 * Vor `kontenLoeschen` aufrufen: eine Sperre hält ihr Konto (Fremdschlüssel ohne CASCADE).
 */
export async function sperrenLeeren(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE cockpit.vorgang_sperre RESTART IDENTITY');
}

/** Die Tabellen des Chats (Migration 0024). */
export const CHAT_TABELLEN = ['kanal', 'nachricht', 'nachricht_lesestand', 'push_abo', 'chat_verbrauch', 'chat_mail'] as const;

/**
 * Leert den Chat. Die Tabellen weisen DELETE ab (nie löschen), deshalb TRUNCATE; danach steht der Team-Kanal der
 * Migration wieder da. Vor `kontenLoeschen` aufrufen: Nachrichten halten ihre Konten (Fremdschlüssel ohne CASCADE).
 */
export async function chatLeeren(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE ${CHAT_TABELLEN.map((tabelle) => `cockpit.${tabelle}`).join(', ')} RESTART IDENTITY`);
  await pool.query(`INSERT INTO cockpit.kanal (art) VALUES ('team')`);
}

/**
 * Führt `sql` so aus, wie es eine Kundeninstanz täte: **ohne** die Ausnahme der Testdatenbanken für `nie_loeschen()`
 * (0025). In einer eigenen Transaktion, die immer zurückgenommen wird — ein unerwartet gelungenes DELETE hinterlässt
 * also nichts. Für die Nachweise, dass die Datenbank Löschen abweist.
 */
export async function wieImBetrieb(pool: pg.Pool, sql: string, werte: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL cockpit.testdaten_loeschen = 'nein'");
    await client.query(sql, werte);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Die Wege durch die Kette (ADR 13.1), nur über erlaubte Kanten. */
const EINGRIFF_WEG: Readonly<Record<EingriffStatus, readonly EingriffStatus[]>> = {
  beantragt: [],
  freigegeben: ['freigegeben'],
  laeuft: ['freigegeben', 'laeuft'],
  erledigt: ['freigegeben', 'laeuft', 'erledigt'],
  fehlgeschlagen: ['freigegeben', 'laeuft', 'fehlgeschlagen'],
  zurueckgezogen: ['zurueckgezogen'],
};

export interface EingriffWerte {
  /** Ziel-Digest; ohne Angabe `sha256:bbb…`. */
  readonly ziel?: string;
  /** Der Weg zurück; ohne Angabe `sha256:aaa…`. */
  readonly vorher?: string;
  /** Die Version, die die Freigabe nennt; ohne Angabe `1.4.0`. */
  readonly zielVersion?: string;
}

/**
 * Legt einen Antrag an und bringt ihn per SQL in `status` — nur über erlaubte Kanten und so, wie Agent und Cockpit es
 * täten (COPI-41): die Freigabe nennt die Ziel-Version, und vor `erledigt` meldet sich ein Cockpit mit Ziel-Digest und
 * Ziel-Version. Diese Selbstmeldung bleibt danach stehen, wie nach einem echten Update. Gibt die Nummer zurück.
 */
export async function eingriffIn(pool: pg.Pool, status: EingriffStatus, werte: EingriffWerte = {}): Promise<number> {
  const ziel = werte.ziel ?? `sha256:${'b'.repeat(64)}`;
  const version = werte.zielVersion ?? '1.4.0';
  const zeile = await pool.query<{ id: number }>(
    `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
     VALUES ('cockpit-image', $1, $2, 'konto-1') RETURNING id::int AS id`,
    [ziel, werte.vorher ?? `sha256:${'a'.repeat(64)}`],
  );
  const id = zeile.rows[0]?.id;
  if (id === undefined) {
    throw new Error('Kein Antrag angelegt');
  }
  for (const schritt of EINGRIFF_WEG[status]) {
    if (schritt === 'freigegeben') {
      await pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_version = $2 WHERE id = $1`, [id, version]);
      continue;
    }
    if (schritt === 'erledigt') {
      await pool.query(
        `INSERT INTO cockpit.instanz (id, version, digest) VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, digest = EXCLUDED.digest`,
        [`${version}+0123456`, ziel],
      );
    }
    await pool.query('UPDATE cockpit.eingriff SET status = $2 WHERE id = $1', [id, schritt]);
  }
  return id;
}

/**
 * Die Rückwege einer Seite (COPI-100): jeder runde Zurück-Knopf im Seitenkopf als `{ href, ziel }`. Eine Unterseite hat
 * genau einen; eine Hauptseite (Übersicht, Chat, Module, Meldungen, Mehr) keinen.
 */
export function rueckwege(html: string): { href: string; ziel: string }[] {
  return [...html.matchAll(/<a href="([^"]*)" class="seiten-zurueck" aria-label="Zurück zu ([^"]*)">/g)].map((m) => ({
    href: m[1] ?? '',
    ziel: m[2] ?? '',
  }));
}

/** Die Views des Demo-Moduls Eingang (`docs/demo`): die Modul-View und seit COPI-110 die Anhang-View. */
const EINGANG_VIEWS = ['docs/demo/v_modul_eingang.sql', 'docs/demo/v_modul_eingang_anhaenge.sql'].map((datei) => readFileSync(datei, 'utf8'));

/** Legt die Views des Beispiel-Moduls Eingang an; die Fachmigrationen müssen schon eingespielt sein. */
export async function eingangViewsAnlegen(pool: pg.Pool): Promise<void> {
  for (const sql of EINGANG_VIEWS) {
    await pool.query(sql);
  }
}

/**
 * Gibt dem Betreuer ein eingespieltes Fachmodul frei (COPI-134) — über denselben Weg wie das Server-Kommando. Für Tests,
 * die ein Modul als Betreuer aufrufen; ohne Freigabe sieht er ein Fachmodul nicht.
 */
export async function betreuerDarf(pool: pg.Pool, kennung: string, stufe: BetreuerZugriff = 'entscheiden'): Promise<void> {
  const ergebnis = await betreuerZugriffSetzen(pool, { kennung, stufe });
  if (!ergebnis.ok) {
    throw new Error(`Betreuer-Zugriff für ${kennung} nicht gesetzt: ${ergebnis.grund}`);
  }
}
