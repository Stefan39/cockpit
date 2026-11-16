/**
 * Das Demo-Modul „Anfragen" für `./dev demo` (COPI-85): vier Gästeanfragen wie im freigegebenen Entwurf „Übernahme",
 * damit sich die Übernahme-Sperre lokal durchspielen lässt (`./dev vorschau`, Detailseite → „Übernehmen").
 *
 * **Nur lokal, nie im Image, nie in einer Migration.** Die Fachtabelle liegt in einem eigenen Schema `demo`, das nur
 * dieses Skript anlegt; `scripts/` steht in `.dockerignore`, `db/migrations` kennt weder das Schema noch die View. Eine
 * Kundeninstanz bekommt ihre Fach-Views vom Einrichter.
 *
 * **Wie ein echtes Fachmodul:** eine Tabelle, darüber die View `cockpit.v_modul_demo_anfragen` direkt auf der Tabelle
 * (die Katalogprüfung verlangt das für Kundenrollen, `registry.ts`), eingespielt über dieselbe Funktion wie das
 * Server-Kommando (`modulEinspielen`), mit `eingriffe: [uebernehmen]` und allen drei Rollen.
 *
 * **Wiederholbar:** Tabelle und View werden angelegt, falls sie fehlen, die vier Zeilen per `ON CONFLICT` auf den Stand
 * gebracht (Zeiten relativ zu „jetzt"). Die Sperren des Moduls räumt `demo-daten.ts` mit den übrigen Demodaten ab
 * (Präfix `demo-`).
 */
import type pg from 'pg';
import { modulEinspielen } from '../../src/module/modul-speicher.js';
import type { BefundStatus } from '../../src/status/zustand.js';

/** Die Kennung des Demo-Moduls — mit dem Präfix `demo-`, an dem `demo-daten.ts` seine eigenen Zeilen erkennt. */
export const DEMO_ANFRAGEN_KENNUNG = 'demo-anfragen';

export interface DemoAnfrage {
  readonly id: string;
  readonly titel: string;
  readonly status: BefundStatus;
  readonly gast: string;
  readonly zeitraum: string;
  readonly objekt: string;
  readonly letzteNachricht: string;
  /** Minuten vor „jetzt": Eingang der Anfrage. */
  readonly eingangVorMinuten: number;
}

/** Die vier Anfragen des Entwurfs, in dessen Reihenfolge. */
export const DEMO_ANFRAGEN: readonly DemoAnfrage[] = [
  {
    id: 'demo-okafor',
    titel: 'Herr Okafor – Stornierung',
    status: 'rot',
    gast: 'Herr Okafor',
    zeitraum: '03.10. – 06.10.2026',
    objekt: 'Ferienwohnung B',
    letzteNachricht: 'Gast möchte kurzfristig stornieren und fragt nach der Erstattung.',
    eingangVorMinuten: 110,
  },
  {
    id: 'demo-brandt',
    titel: 'Familie Brandt – Buchungsanfrage',
    status: 'gelb',
    gast: 'Familie Brandt (2 Erwachsene, 1 Kind)',
    zeitraum: '12.10. – 19.10.2026',
    objekt: 'Ferienhaus A',
    letzteNachricht: 'Gast fragt nach einem Hochstuhl für das Kinderzimmer.',
    eingangVorMinuten: 12,
  },
  {
    id: 'demo-vogt',
    titel: 'Lena Vogt – Frage zu Haustieren',
    status: 'gruen',
    gast: 'Lena Vogt',
    zeitraum: '24.10. – 27.10.2026',
    objekt: 'Ferienwohnung B',
    letzteNachricht: 'Hund ist erlaubt, Antwort ist raus.',
    eingangVorMinuten: 270,
  },
  {
    id: 'demo-nguyen',
    titel: 'Paar Nguyen – Anreisezeit',
    status: 'gruen',
    gast: 'Paar Nguyen',
    zeitraum: '30.09. – 02.10.2026',
    objekt: 'Ferienhaus A',
    letzteNachricht: 'Anreise gegen 20 Uhr bestätigt.',
    eingangVorMinuten: 1200,
  },
];

/** Der `cockpit:`-Block des Demo-Moduls, wie er in einer Agent-Blueprint-YAML stünde. */
export const DEMO_ANFRAGEN_BLOCK = `cockpit:
  kennung: ${DEMO_ANFRAGEN_KENNUNG}
  menuename: "Anfragen"
  ansicht: liste-detail
  view: v_modul_demo_anfragen
  spalten:
    - { name: gast, label: "Gast" }
    - { name: zeitraum, label: "Zeitraum" }
    - { name: objekt, label: "Objekt" }
    - { name: letzte_nachricht, label: "Letzte Nachricht" }
    - { name: eingang, label: "Eingang", format: zeitpunkt }
  rollen: [betreuer, betriebs_admin, betrieb_mitarbeiter]
  eingriffe: [uebernehmen]
`;

const SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS demo;
  CREATE TABLE IF NOT EXISTS demo.anfrage (
    id               text        PRIMARY KEY,
    titel            text        NOT NULL,
    status           text        NOT NULL,
    gast             text        NOT NULL,
    zeitraum         text        NOT NULL,
    objekt           text        NOT NULL,
    letzte_nachricht text        NOT NULL,
    eingang          timestamptz NOT NULL
  );
  CREATE OR REPLACE VIEW cockpit.v_modul_demo_anfragen AS
    SELECT id, titel, status, eingang AS aktualisiert_am, gast, zeitraum, objekt, letzte_nachricht, eingang
      FROM demo.anfrage;
`;

/** Legt Schema, Tabelle und View an (falls nötig), bringt die vier Anfragen auf den Stand und spielt das Modul ein. */
export async function anfragenEinspielen(pool: pg.Pool, jetzt: Date, akteur: string): Promise<string> {
  await pool.query(SCHEMA_SQL);
  for (const anfrage of DEMO_ANFRAGEN) {
    await pool.query(
      `INSERT INTO demo.anfrage (id, titel, status, gast, zeitraum, objekt, letzte_nachricht, eingang)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET titel = EXCLUDED.titel, status = EXCLUDED.status, gast = EXCLUDED.gast,
         zeitraum = EXCLUDED.zeitraum, objekt = EXCLUDED.objekt, letzte_nachricht = EXCLUDED.letzte_nachricht, eingang = EXCLUDED.eingang`,
      [
        anfrage.id,
        anfrage.titel,
        anfrage.status,
        anfrage.gast,
        anfrage.zeitraum,
        anfrage.objekt,
        anfrage.letzteNachricht,
        new Date(jetzt.getTime() - anfrage.eingangVorMinuten * 60_000),
      ],
    );
  }
  const ergebnis = await modulEinspielen(pool, { rohtext: DEMO_ANFRAGEN_BLOCK, akteur, herkunft: 'scripts/dev/demo-anfragen.ts' });
  if (!ergebnis.ok) {
    throw new Error(`Modul „Anfragen" konnte nicht eingespielt werden: ${ergebnis.grund}`);
  }
  return `Modul ${ergebnis.kennung}: ${ergebnis.status}, Version ${String(ergebnis.version)}, ${String(DEMO_ANFRAGEN.length)} Anfragen.`;
}
