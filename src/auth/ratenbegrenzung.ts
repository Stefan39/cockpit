/**
 * Eigene Ratenbegrenzung der Anmeldung (COPI-13).
 *
 * Bewusst unabhängig von der Better-Auth-Ratenbegrenzung. Deren Grenzen sind
 * im Quelltext von better-auth 1.7.5 nachgelesen und in
 * `test/better-auth-ratenbegrenzung.test.ts` nachgemessen: sie hängt im
 * Router-Haken (`auth.handler`) und greift daher nicht für die direkten
 * `auth.api.*`-Aufrufe, mit denen die Anmeldeseite arbeitet; sie ist
 * standardmäßig nur in Produktion aktiv; sie hält ihre Zähler im
 * Arbeitsspeicher und verliert sie bei jedem Neustart; und sie kennt nur
 * Burst-Regeln über wenige Sekunden.
 *
 * Diese Begrenzung liegt deshalb in der vorhandenen PostgreSQL:
 *
 *   * **Passwortschritt** — 5 Fehlversuche je normalisierter E-Mail-Adresse
 *     (auch für Adressen, zu denen es kein Konto gibt) innerhalb von 15
 *     Minuten, danach 15 Minuten Sperre. Zusätzlich 20 Fehlversuche je
 *     Client-IP im gleichen Fenster.
 *   * **Codeschritt** — 5 Fehlversuche je Konto im gleichen Fenster.
 *
 * Dass auch unbekannte Adressen gezählt und gesperrt werden, ist Absicht: eine
 * Sperre, die nur bei existierenden Konten greift, wäre selbst die Antwort auf
 * die Frage „gibt es dieses Konto?".
 *
 * Bekannter, bewusst akzeptierter Preis dafür: wer eine Adresse kennt, kann
 * das zugehörige Konto durch Fehlversuche 15 Minuten aussperren. Laufende
 * Sitzungen bleiben davon unberührt.
 *
 * **Reservieren, dann prüfen.** Ein Versuch wird gezählt, *bevor* Passwort oder
 * Code geprüft werden, und die Prüfung läuft nur, wenn die Reservierung
 * innerhalb der Grenze liegt. Andersherum — erst lesen, dann prüfen, dann
 * zählen — hilft die Grenze bei gleichzeitigen Anfragen nicht: alle lesen
 * denselben Stand, bevor der erste Fehlversuch gezählt ist, und laufen
 * gemeinsam durch. Gemessen wurden so 32 ausgeführte Passwortprüfungen bei 40
 * gleichzeitigen Anfragen an eine Adresse, obwohl die Grenze 5 ist.
 *
 * Was bei Erfolg passiert, hängt von der Art ab: der Zähler je Adresse bzw.
 * Konto wird gelöscht, die Reservierung je IP wird **gutgeschrieben** (um eins
 * verringert). Sonst verbrauchten rechtmäßige Anmeldungen das IP-Budget des
 * ganzen Büros.
 *
 * Die Zeit ist überall Parameter, damit Ablauf und Sperrende ohne Warten
 * prüfbar sind.
 */
import type pg from 'pg';
import { tokenHashen } from './einmal-token.js';

/** Länge des Zählfensters. */
export const ANMELDE_FENSTER_MS = 15 * 60 * 1000;

/**
 * Dauer der Sperre. Sie ist bewusst nicht kürzer als das Fenster: sonst liefe
 * die Sperre ab, während der Zähler noch am Anschlag steht, und der erste
 * Versuch danach würde unmittelbar wieder sperren.
 */
export const ANMELDE_SPERRE_MS = 15 * 60 * 1000;

/** Welcher Zähler — gehört mit in den Schlüssel, damit sich Arten nie mischen. */
export type Zaehlerart = 'passwort-email' | 'passwort-ip' | 'code-konto';

const GRENZEN: Record<Zaehlerart, number> = {
  'passwort-email': 5,
  // Deutlich höher als je Adresse: hinter einer IP sitzt oft ein ganzes Büro.
  'passwort-ip': 20,
  'code-konto': 5,
};

export function grenzeFuer(art: Zaehlerart): number {
  return GRENZEN[art];
}

export interface ZaehlerStand {
  readonly fehlversuche: number;
  /** Gesetzt, sobald die Grenze erreicht wurde — sonst `undefined`. */
  readonly gesperrtBis: Date | undefined;
}

export interface Reservierung extends ZaehlerStand {
  /**
   * Darf die eigentliche Prüfung (Passwort bzw. Code) jetzt laufen? Wahr für
   * die ersten `grenzeFuer(art)` Reservierungen eines Fensters.
   */
  readonly erlaubt: boolean;
  /**
   * Diese Reservierung hat die Sperre gesetzt. Genau einmal je Sperre wahr —
   * der Zähler ist atomar, also bekommt jede Reservierung einen eigenen Stand.
   * Gedacht als Auslöser für seltene Nebenarbeiten wie das Aufräumen.
   */
  readonly neuGesperrt: boolean;
}

export function istGesperrt(gesperrtBis: Date | undefined, jetzt: Date): boolean {
  return gesperrtBis !== undefined && gesperrtBis.getTime() > jetzt.getTime();
}

/**
 * Der gespeicherte Schlüssel. Die Kennung geht nur als Hash in die Datenbank —
 * gesucht wird immer über den vollständigen Schlüssel, und so sammelt die
 * Tabelle keine E-Mail-Adressen und keine IP-Adressen im Klartext.
 *
 * Öffentlich, damit Tests und Werkzeuge eine Zeile ansprechen können, ohne das
 * Verfahren nachzubauen — eine Kopie würde bei einer Änderung stillschweigend
 * auseinanderlaufen.
 */
export function kennungHash(art: Zaehlerart, kennung: string): string {
  return tokenHashen(`${art}:${kennung}`);
}

/** Läuft für diese Kennung gerade eine Sperre? */
export async function sperrePruefen(
  pool: pg.Pool,
  art: Zaehlerart,
  kennung: string,
  jetzt: Date,
): Promise<boolean> {
  const ergebnis = await pool.query<{ gesperrt_bis: Date | null }>(
    'SELECT gesperrt_bis FROM cockpit.anmeldeversuch WHERE art = $1 AND kennung_hash = $2',
    [art, kennungHash(art, kennung)],
  );
  return istGesperrt(ergebnis.rows[0]?.gesperrt_bis ?? undefined, jetzt);
}

/**
 * Reserviert einen Versuch, **bevor** geprüft wird: zählt hoch, setzt bei
 * Erreichen der Grenze die Sperre und sagt zurück, ob die Prüfung laufen darf.
 *
 * Eine einzelne Anweisung: `INSERT … ON CONFLICT DO UPDATE` sperrt die Zeile
 * für die Dauer der Aktualisierung, deshalb bekommt jede gleichzeitige Anfrage
 * einen eigenen Stand und keine geht verloren. Genau das macht die Grenze auch
 * unter Parallelität wirksam — die Entscheidung „darf geprüft werden" fällt
 * zusammen mit dem Zählen, nicht danach.
 *
 * Ein abgelaufenes Fenster beginnt im selben Schritt von vorn, eine schon
 * laufende Sperre wird nicht verlängert.
 */
export async function versuchReservieren(
  pool: pg.Pool,
  art: Zaehlerart,
  kennung: string,
  jetzt: Date,
): Promise<Reservierung> {
  const fensterGrenze = new Date(jetzt.getTime() - ANMELDE_FENSTER_MS);
  const ergebnis = await pool.query<{ fehlversuche: number; gesperrt_bis: Date | null }>(
    `INSERT INTO cockpit.anmeldeversuch AS v (art, kennung_hash, fehlversuche, fenster_beginn)
          VALUES ($1, $2, 1, $3)
     ON CONFLICT (art, kennung_hash) DO UPDATE
            SET fehlversuche = CASE WHEN v.fenster_beginn <= $4 THEN 1
                                    ELSE v.fehlversuche + 1 END,
                fenster_beginn = CASE WHEN v.fenster_beginn <= $4 THEN $3
                                      ELSE v.fenster_beginn END,
                gesperrt_bis = CASE
                    WHEN v.gesperrt_bis > $3 THEN v.gesperrt_bis
                    WHEN v.fenster_beginn > $4 AND v.fehlversuche + 1 >= $5 THEN $6
                    ELSE NULL END
      RETURNING fehlversuche, gesperrt_bis`,
    [
      art,
      kennungHash(art, kennung),
      jetzt,
      fensterGrenze,
      grenzeFuer(art),
      new Date(jetzt.getTime() + ANMELDE_SPERRE_MS),
    ],
  );
  const zeile = ergebnis.rows[0];
  const fehlversuche = zeile?.fehlversuche ?? 1;
  const gesperrtBis = zeile?.gesperrt_bis ?? undefined;
  return {
    fehlversuche,
    gesperrtBis,
    erlaubt: fehlversuche <= grenzeFuer(art),
    neuGesperrt: gesperrtBis !== undefined && fehlversuche === grenzeFuer(art),
  };
}

/**
 * Schreibt eine Reservierung wieder gut — um eins, nie unter null.
 *
 * Zwei Fälle: die Anmeldung war erfolgreich (dann soll sie das IP-Budget nicht
 * verbrauchen), oder es wurde gar nicht geprüft, weil ein zweiter Zähler
 * abgewiesen hat. Fällt der Stand dadurch unter die Grenze, wird eine gerade
 * gesetzte Sperre wieder aufgehoben: sie würde sonst auf einem Versuch beruhen,
 * der nie stattgefunden hat.
 *
 * Eine Zeile mit Stand null bleibt bewusst stehen und verschwindet erst beim
 * Aufräumen. Sie hier zu löschen wäre eine zweite Anweisung, und zwischen
 * beiden könnte eine gleichzeitige Reservierung verloren gehen.
 */
export async function zaehlerGutschreiben(
  pool: pg.Pool,
  art: Zaehlerart,
  kennung: string,
): Promise<void> {
  await pool.query(
    `UPDATE cockpit.anmeldeversuch AS v
        SET fehlversuche = GREATEST(v.fehlversuche - 1, 0),
            gesperrt_bis = CASE WHEN GREATEST(v.fehlversuche - 1, 0) >= $3
                                THEN v.gesperrt_bis ELSE NULL END
      WHERE v.art = $1 AND v.kennung_hash = $2`,
    [art, kennungHash(art, kennung), grenzeFuer(art)],
  );
}

/**
 * Löscht den Zähler nach einem erfolgreichen Schritt.
 *
 * Bewusst nur für Adresse und Konto, nicht für die IP: sonst könnte, wer ein
 * einziges gültiges Kennwort besitzt, mit jeder erfolgreichen Anmeldung sein
 * IP-Budget zurücksetzen.
 */
export async function zaehlerZuruecksetzen(
  pool: pg.Pool,
  art: Exclude<Zaehlerart, 'passwort-ip'>,
  kennung: string,
): Promise<void> {
  await pool.query(
    'DELETE FROM cockpit.anmeldeversuch WHERE art = $1 AND kennung_hash = $2',
    [art, kennungHash(art, kennung)],
  );
}

/**
 * Entfernt Zähler, deren Fenster abgelaufen ist und die keine laufende Sperre
 * mehr tragen. Liegengebliebene Zeilen wären harmlos (der nächste Fehlversuch
 * setzt sie zurück), sollen sich aber nicht unbegrenzt ansammeln.
 */
export async function zaehlerAufraeumen(pool: pg.Pool, jetzt: Date): Promise<number> {
  const ergebnis = await pool.query(
    `DELETE FROM cockpit.anmeldeversuch
      WHERE fenster_beginn <= $1
        AND (gesperrt_bis IS NULL OR gesperrt_bis <= $2)`,
    [new Date(jetzt.getTime() - ANMELDE_FENSTER_MS), jetzt],
  );
  return ergebnis.rowCount ?? 0;
}
