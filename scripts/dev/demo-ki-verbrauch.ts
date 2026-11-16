/**
 * Das Modul „KI-Verbrauch" für `./dev demo` (COPI-98): 35 Tage Verbrauch aus drei Quellen, vier Modellen und drei
 * Projekten, dazu die Wechselkurse — damit sich die Kennzahlen-Seite und ihre Karte lokal ansehen lassen
 * (`./dev vorschau --rolle betreuer`, Modul „KI-Verbrauch").
 *
 * **Nur lokal** wie das ganze Demo-Skript (`demo-daten.ts`). Die Views kommen aus `docs/beispiele` (dort legt sie
 * `demo-daten.ts` an), der Block ebenso; gemeldet wird über dieselben Funktionen wie die Agenten-API.
 *
 * **Wiederholbar:** jede Meldung trägt einen festen Schlüssel (`demo:<tag>:<nummer>`) und ersetzt beim zweiten Lauf
 * ihren Eintrag; die Kurse ersetzen sich je Tag. Die Zahlen sind aus dem Tag abgeleitet, nicht gewürfelt — zwei Läufe
 * am selben Tag ergeben dasselbe Bild.
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { modulEinspielen } from '../../src/module/modul-speicher.js';
import { verbrauchMelden, type VerbrauchEintrag } from '../../src/verbrauch/verbrauch-speicher.js';
import { kurseMelden } from '../../src/verbrauch/wechselkurs-speicher.js';

const MODUL_YAML_DATEI = 'docs/beispiele/ki-verbrauch.cockpit.yaml';
const TAGE = 35;
const TAG_MS = 24 * 60 * 60 * 1000;

/**
 * Was an einem Tag läuft: Quelle, Modell, Ticket, die Größe des Einsatzes in Tausend Tokens (Cache-Lesen) und der Agent
 * (COPI-113), soweit einer zugeordnet ist.
 */
const MUSTER = [
  { quelle: 'cowork', modell: 'claude-opus-5-5', ticket: 'WEB-30', gross: 9000, agent: 'koordinator' },
  { quelle: 'claude-code', modell: 'claude-opus-5-5', ticket: 'APP-98', gross: 6000, agent: null },
  { quelle: 'claude-code', modell: 'claude-sonnet-5', ticket: 'SHOP-12', gross: 4000, agent: null },
  { quelle: 'n8n', modell: 'openai/gpt-oss-120b', ticket: null, gross: 1500, agent: 'assistent' },
  { quelle: 'n8n', modell: 'claude-haiku-4-5', ticket: 'WEB-34', gross: 800, agent: 'assistent' },
] as const;

function eintraegeFuer(jetzt: Date): VerbrauchEintrag[] {
  const eintraege: VerbrauchEintrag[] = [];
  for (let zurueck = 0; zurueck < TAGE; zurueck += 1) {
    const zeitpunkt = new Date(jetzt.getTime() - zurueck * TAG_MS - 60 * 60 * 1000);
    const tag = zeitpunkt.toISOString().slice(0, 10);
    // Am Wochenende wird wenig gearbeitet; dazwischen schwankt die Last mit dem Tag im Monat.
    const wochentag = zeitpunkt.getUTCDay();
    const last = wochentag === 0 || wochentag === 6 ? 0.15 : 0.6 + ((zeitpunkt.getUTCDate() * 7) % 10) / 10;
    MUSTER.forEach((muster, nummer) => {
      const lesen = Math.round(muster.gross * 1000 * last);
      eintraege.push({
        schluessel: `demo:${tag}:${String(nummer)}`,
        zeitpunkt: zeitpunkt.toISOString(),
        quelle: muster.quelle,
        modell: muster.modell,
        ticket: muster.ticket,
        jira_projekt: muster.ticket === null ? null : muster.ticket.slice(0, muster.ticket.lastIndexOf('-')),
        sitzung: `demo-${tag}`,
        qualitaet: nummer === 2 && zurueck % 5 === 0 ? 'geschaetzt' : 'gemessen',
        zuordnung: muster.ticket === null ? 'keine' : 'branch',
        subagent: false,
        agent: muster.agent,
        tokens_eingabe: Math.round(lesen / 400),
        tokens_ausgabe: Math.round(lesen / 40),
        tokens_cache_schreiben_5m: 0,
        tokens_cache_schreiben_1h: Math.round(lesen / 30),
        tokens_cache_lesen: lesen,
      });
    });
  }
  return eintraege;
}

/** Meldet Kurse und Verbrauch und spielt den Block ein; liefert eine Zeile für die Konsole. */
export async function kiVerbrauchEinspielen(pool: pg.Pool, jetzt: Date, akteur: string): Promise<string> {
  const kurse = Array.from({ length: TAGE + 1 }, (_, zurueck) => ({
    tag: new Date(jetzt.getTime() - zurueck * TAG_MS).toISOString().slice(0, 10),
    usd_je_eur: 1.17,
    quelle: 'Demo',
  }));
  await kurseMelden(pool, kurse, { von: akteur, jetzt });
  const eintraege = eintraegeFuer(jetzt);
  await verbrauchMelden(pool, eintraege, { von: akteur, jetzt });

  const ergebnis = await modulEinspielen(pool, { rohtext: readFileSync(MODUL_YAML_DATEI, 'utf8'), akteur, herkunft: 'scripts/dev/demo-ki-verbrauch.ts' });
  if (!ergebnis.ok) {
    throw new Error(`Modul „KI-Verbrauch" konnte nicht eingespielt werden: ${ergebnis.grund}`);
  }
  return `Modul ${ergebnis.kennung}: ${ergebnis.status}, Version ${String(ergebnis.version)}; ${String(eintraege.length)} Einsätze über ${String(TAGE)} Tage gemeldet.`;
}
