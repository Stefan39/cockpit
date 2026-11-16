/**
 * Die Demodaten der Wachen für `./dev demo` (COPI-80) — reine Definitionen und die Berechnung des
 * 7-Tage-Verlaufs, ohne Datenbank und ohne Uhr: jeder Punkt trägt nur einen Versatz in Sekunden vor
 * „jetzt", die absolute Zeit setzt erst `demo-daten.ts` beim Schreiben. So bleibt dieses Modul rein
 * und ohne Postgres testbar (`test/demo-wachen.test.ts`).
 *
 * Sechs Wachen, wie im Betrieb: fünf mit kundensichtbaren Befunden (Container, Plattenplatz,
 * Erreichbarkeit, Zertifikat, Datensicherung) und eine rein interne, deren Befunde nie
 * kundensichtbar sind (ADR: Rohbefunde gehen nie direkt an den Kunden, `kundensichtbar` ist per
 * Default `false`). Jede Kennung trägt das Präfix `demo-`: `./dev demo` erkennt daran beim nächsten
 * Lauf **nur seine eigenen** Zeilen und räumt ausschließlich die ab.
 *
 * Aktueller Stand (der jüngste Punkt je Wache): Erreichbarkeit ist rot, Zertifikat ist überfällig
 * (seit Tagen ohne Meldung), Plattenplatz gelb (über der Warnschwelle), der Rest grün — dazwischen,
 * über die letzten 7 Tage, ein paar gelbe bzw. rote Episoden, damit der Verlauf keine gerade Linie ist.
 *
 * **Messwerte (COPI-83):** Plattenplatz steigt von 71 auf 86 % (max 100, Warnschwelle 85 — ab dort gelb),
 * das Zertifikat fällt von 70 auf 64 Tage (max 90, Warnschwelle 14), die Erreichbarkeit liegt um 180 ms mit
 * einem Ausreißer von 410 ms (ohne Obergrenze, Warnschwelle 1000; während der Timeouts ohne Messwert — eine
 * Lücke der Kurve —, zuletzt 1.240 ms über der Schwelle), Container 5 von 5 mit einem kurzen Einbruch auf 4. Die Datensicherung meldet keinen
 * Messwert. Die interne Wache meldet einen (9.173 Log-Zeilen), den ein Kunde nie sehen darf.
 */
import type { Messwert } from '../../src/status/messwert.js';
import { type BefundStatus } from '../../src/status/zustand.js';

/** Präfix jeder Demo-Kennung — erlaubt nach `wache_kennung_form` (Migration 0015). */
export const DEMO_PRAEFIX = 'demo-';

/** Der Messwert der internen Wache: unverwechselbar, damit sich prüfen lässt, dass er nie beim Kunden erscheint. */
export const INTERNER_MESSWERT: Messwert = { wert: 9173, einheit: 'Log-Zeilen' };

export interface DemoBefundPunkt {
  /** Sekunden vor „jetzt", nie negativ. */
  readonly versatzSekunden: number;
  readonly status: BefundStatus;
  readonly textIntern: string;
  /** Nur gesetzt, wenn die Wache überhaupt kundensichtbare Befunde hat. */
  readonly textKunde?: string;
  /** Der Hauptmesswert (COPI-83); ohne Angabe meldet der Punkt keinen. */
  readonly messwert?: Messwert;
}

export interface DemoWache {
  readonly kennung: string;
  readonly anzeigename: string;
  readonly taktSekunden: number;
  /** `false`: keiner ihrer Befunde wird kundensichtbar — die rein interne Wache. */
  readonly kundensichtbar: boolean;
  readonly verlauf: readonly DemoBefundPunkt[];
}

const SIEBEN_TAGE_SEKUNDEN = 7 * 24 * 3600;
const SIEBEN_TAGE_STUNDEN = 7 * 24;

interface Grundzustand {
  readonly status: BefundStatus;
  readonly textIntern: string;
  readonly textKunde?: string;
}

interface Episode extends Grundzustand {
  /** Ältere Grenze der Episode, in Stunden vor „jetzt" (größerer Wert). */
  readonly vonStundenVorJetzt: number;
  /** Jüngere Grenze, exklusiv (kleinerer Wert): der Punkt genau darauf zählt schon nicht mehr dazu. */
  readonly bisStundenVorJetzt: number;
}

/**
 * Ein Verlauf über 7 Tage im angegebenen Takt, chronologisch (ältester Punkt zuerst): überwiegend
 * der Grundzustand, mit `episoden` darübergelegt. `keineMeldungSeitStunden` lässt die jüngsten
 * Punkte weg — für eine Wache, die seit einer Weile nicht mehr gemeldet hat (überfällig).
 */
function verlaufBauen(
  taktSekunden: number,
  grundzustand: Grundzustand,
  episoden: readonly Episode[] = [],
  keineMeldungSeitStunden = 0,
): DemoBefundPunkt[] {
  const keineMeldungSeitSekunden = keineMeldungSeitStunden * 3600;
  const punkte: DemoBefundPunkt[] = [];
  for (let versatzSekunden = SIEBEN_TAGE_SEKUNDEN; versatzSekunden >= 0; versatzSekunden -= taktSekunden) {
    if (versatzSekunden < keineMeldungSeitSekunden) {
      continue;
    }
    const stundenVorJetzt = versatzSekunden / 3600;
    const episode = episoden.find(
      (kandidat) => stundenVorJetzt <= kandidat.vonStundenVorJetzt && stundenVorJetzt > kandidat.bisStundenVorJetzt,
    );
    const quelle: Grundzustand = episode ?? grundzustand;
    punkte.push({
      versatzSekunden,
      status: quelle.status,
      textIntern: quelle.textIntern,
      ...(quelle.textKunde === undefined ? {} : { textKunde: quelle.textKunde }),
    });
  }
  return punkte;
}

/**
 * Hängt jedem Punkt einen Messwert an (COPI-83). `messung` bekommt die Stunden vor „jetzt" und den Punkt und liefert
 * den Messwert — `undefined` für „kein Messwert" — und optional einen anderen Zustand (etwa gelb über der Schwelle).
 */
function mitMessung(
  punkte: readonly DemoBefundPunkt[],
  messung: (stundenVorJetzt: number, punkt: DemoBefundPunkt) => { readonly messwert: Messwert | undefined; readonly zustand?: Grundzustand },
): DemoBefundPunkt[] {
  return punkte.map((punkt) => {
    const { messwert, zustand } = messung(punkt.versatzSekunden / 3600, punkt);
    const basis: DemoBefundPunkt = zustand === undefined ? punkt : { versatzSekunden: punkt.versatzSekunden, ...zustand };
    return messwert === undefined ? basis : { ...basis, messwert };
  });
}

const STUENDLICH = 3600;
const TAEGLICH = 24 * 3600;

/** Plattenplatz in ganzen Prozent: gleichmäßig von 71 % (vor 7 Tagen) auf 86 % (jetzt). */
function plattenplatzProzent(stundenVorJetzt: number): number {
  return Math.round(71 + (15 * (SIEBEN_TAGE_STUNDEN - stundenVorJetzt)) / SIEBEN_TAGE_STUNDEN);
}

/** Antwortzeit um 180 ms mit festem Zittern (±15 ms) und einem Ausreißer vor 30 Stunden — deterministisch. */
function antwortzeitMs(stundenVorJetzt: number): number {
  const stunde = Math.round(stundenVorJetzt);
  return stunde === 30 ? 410 : 180 + ((stunde * 37) % 31) - 15;
}

/** Sechs Wachen mit 7-Tage-Verlauf — deterministisch, ohne Bezug zur echten Uhr. */
export function wachenDefinitionen(): readonly DemoWache[] {
  return [
    {
      kennung: `${DEMO_PRAEFIX}container`,
      anzeigename: 'Container',
      taktSekunden: STUENDLICH,
      kundensichtbar: true,
      verlauf: mitMessung(
        verlaufBauen(
          STUENDLICH,
          { status: 'gruen', textIntern: 'Health-Check erfolgreich, alle Container laufen.', textKunde: 'Alle Dienste laufen.' },
          [
            {
              vonStundenVorJetzt: 100,
              bisStundenVorJetzt: 98,
              status: 'gelb',
              textIntern: 'Ein Container wurde nach OOM neu gestartet, läuft seitdem wieder normal.',
              textKunde: 'Kurze Störung, seitdem behoben.',
            },
          ],
        ),
        // Während des Neustarts lief einer der fünf Container nicht.
        (_stunden, punkt) => ({ messwert: { wert: punkt.status === 'gelb' ? 4 : 5, einheit: 'von 5', max: 5 } }),
      ),
    },
    {
      kennung: `${DEMO_PRAEFIX}plattenplatz`,
      anzeigename: 'Plattenplatz',
      taktSekunden: STUENDLICH,
      kundensichtbar: true,
      verlauf: mitMessung(
        verlaufBauen(STUENDLICH, { status: 'gruen', textIntern: 'Plattenplatz ausreichend.', textKunde: 'Genug Plattenplatz frei.' }),
        (stunden) => {
          const prozent = plattenplatzProzent(stunden);
          const knapp = prozent >= 85;
          return {
            messwert: { wert: prozent, einheit: '%', max: 100, warnung: 85 },
            zustand: {
              status: knapp ? 'gelb' : 'gruen',
              textIntern: `Plattenplatz: ${String(prozent)} % belegt${knapp ? ', über der Warnschwelle 85 %' : ''}.`,
              textKunde: knapp ? `Plattenplatz wird knapp: ${String(prozent)} % belegt.` : 'Genug Plattenplatz frei.',
            },
          };
        },
      ),
    },
    {
      kennung: `${DEMO_PRAEFIX}erreichbarkeit`,
      anzeigename: 'Erreichbarkeit',
      taktSekunden: STUENDLICH,
      kundensichtbar: true,
      verlauf: mitMessung(
        verlaufBauen(
          STUENDLICH,
          { status: 'gruen', textIntern: 'Health-Check /gesund antwortet mit 200.', textKunde: 'Alle Dienste laufen.' },
          [
            {
              // Bis -1 h, damit auch der jüngste Punkt (0 h vor jetzt) noch in der Episode liegt.
              vonStundenVorJetzt: 4,
              bisStundenVorJetzt: -1,
              status: 'rot',
              textIntern: 'Health-Check /gesund liefert seit vier Stunden keine Antwort (Timeout).',
              textKunde: 'Erreichbarkeit gestört: Health-Check schlägt fehl.',
            },
          ],
        ),
        // Ohne Antwort keine Antwortzeit: während der Timeouts meldet die Wache keinen Messwert (Lücke der Kurve).
        // Die jüngste Prüfung bekommt wieder eine Antwort, aber weit über der Warnschwelle — weiterhin rot.
        (stunden, punkt) =>
          stunden === 0
            ? {
                messwert: { wert: 1240, einheit: 'ms', warnung: 1000 },
                zustand: {
                  status: 'rot',
                  textIntern: 'Health-Check /gesund antwortet nach Timeouts wieder, aber erst nach 1240 ms.',
                  textKunde: 'Erreichbarkeit gestört: Antworten sehr langsam.',
                },
              }
            : { messwert: punkt.status === 'rot' ? undefined : { wert: antwortzeitMs(stunden), einheit: 'ms', warnung: 1000 } },
      ),
    },
    {
      kennung: `${DEMO_PRAEFIX}zertifikat`,
      anzeigename: 'Zertifikat',
      taktSekunden: TAEGLICH,
      kundensichtbar: true,
      // Seit 48 Stunden ohne Meldung — mehr als Takt (24 h) + Toleranz (12 h) = überfällig (gelb).
      verlauf: mitMessung(
        verlaufBauen(TAEGLICH, { status: 'gruen', textIntern: 'Zertifikat gültig.', textKunde: 'Zertifikat gültig.' }, [], 48),
        // Restlaufzeit von 70 Tagen (vor 7 Tagen) auf 64 Tage (letzte Meldung vor 48 Stunden).
        (stunden) => ({ messwert: { wert: 64 + Math.round(((stunden - 48) * 6) / 120), einheit: 'Tage', max: 90, warnung: 14 } }),
      ),
    },
    {
      kennung: `${DEMO_PRAEFIX}datensicherung`,
      anzeigename: 'Datensicherung',
      taktSekunden: TAEGLICH,
      kundensichtbar: true,
      verlauf: verlaufBauen(
        TAEGLICH,
        { status: 'gruen', textIntern: 'Backup erfolgreich, Dauer 12 Minuten.', textKunde: 'Datensicherung erfolgreich.' },
        [
          {
            // Trifft genau den Tages-Punkt bei 96 h (vor 4 Tagen), keinen anderen.
            vonStundenVorJetzt: 97,
            bisStundenVorJetzt: 95,
            status: 'rot',
            textIntern: 'Backup-Job abgebrochen: Zielspeicher nicht erreichbar.',
            textKunde: 'Datensicherung fehlgeschlagen: Backup-Job abgebrochen.',
          },
        ],
      ),
    },
    {
      kennung: `${DEMO_PRAEFIX}intern`,
      anzeigename: 'Interne Diagnose',
      taktSekunden: STUENDLICH,
      // Nie kundensichtbar (ADR): der Betriebs-Admin und der Mitarbeiter bekommen diese Wache nie zu sehen.
      kundensichtbar: false,
      verlauf: mitMessung(
        verlaufBauen(
          STUENDLICH,
          { status: 'gruen', textIntern: 'Interne Selbstdiagnose unauffällig.' },
          [
            {
              vonStundenVorJetzt: 50,
              bisStundenVorJetzt: 47,
              status: 'gelb',
              textIntern: 'Log-Verzeichnis bei 92 % Auslastung (nur intern beobachtet, kein Kundenbezug).',
            },
          ],
        ),
        () => ({ messwert: INTERNER_MESSWERT }),
      ),
    },
  ];
}
