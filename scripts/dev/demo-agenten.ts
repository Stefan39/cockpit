/**
 * Demodaten der Agenten-Detailseite (COPI-113): ein kleines Inventar (Koordinator, Assistent, Wache) und je ein Gespräch
 * zwischen zwei Agenten. Die Wachen der Demo gehören der Wache (`demo-daten.ts`), die Demo-Module dem Assistenten
 * (Beispiel-Blöcke), der KI-Verbrauch der Demo trägt Koordinator und Assistent (`demo-ki-verbrauch.ts`).
 *
 * Nachrichten werden nie gelöscht (0025): ein zweiter Lauf schreibt in einen Kanal, der schon Nachrichten hat, nichts.
 */
import type pg from 'pg';
import { agentenKanal, nachrichtAnlegen, verlaufLesen } from '../../src/chat/nachricht-speicher.js';
import { ereignisMelden, type NeuesEreignis } from '../../src/agenten/ereignis-speicher.js';
import { inventarErsetzen } from '../../src/status/agenten-speicher.js';

/** Die Agenten der Demo; die Wachen der Demo gehören `DEMO_WACHEN_AGENT`. */
export const DEMO_WACHEN_AGENT = 'wache';

const INVENTAR = [
  {
    kennung: 'koordinator',
    rolle: 'Koordinator',
    version: '1.8.0',
    grenzen: { 'Antwortet im Chat': 'ja', 'Startet andere Agenten': 'ja' },
    zeitplan: [{ name: 'Tagesdigest', wann: 'täglich 07:45' }],
  },
  {
    kennung: 'assistent',
    rolle: 'Assistent – Eingang & Auswahl',
    version: '2.4.0',
    grenzen: { 'Antwortet selbst auf': 'Terminanfragen, Rückfragen', Senden: 'nur nach Freigabe', 'Mails je Tag': 40 },
    zeitplan: [
      { name: 'Posteingang prüfen', wann: 'alle 5 Minuten' },
      { name: 'Vorschläge sammeln', wann: 'täglich 07:30 und 13:30' },
    ],
  },
  {
    kennung: 'wache',
    rolle: 'Wache – Betrieb & Administration',
    version: '3.1.0',
    grenzen: { 'Updates ausführen': 'nur nach Freigabe', 'Zugriff auf Server': 'nur lesend' },
    zeitplan: [{ name: 'Cockpit-Befunde', wann: 'alle 15 Minuten' }],
  },
] as const;

const GESPRAECHE: readonly { readonly von: string; readonly an: string; readonly texte: readonly string[] }[] = [
  {
    von: 'koordinator',
    an: 'assistent',
    texte: [
      'Bitte prüf, ob heute neue Vorschläge für die Auswahl dabei sind.',
      'Zwei neue Vorschläge, beide vollständig remote. Einer passt sehr gut zum Profil (sechs Monate).',
      'Danke, ich lege sie dem Betreuer im Digest vor.',
    ],
  },
  { von: 'assistent', an: 'wache', texte: ['Der IMAP-Abruf hängt seit 23:00, bitte den Mailserver prüfen.', 'Zeitüberschreitung beim Abruf, Dienst neu gestartet. Läuft wieder.'] },
];

/** Gemeldete Ereignisse der Wache (COPI-114), Minuten vor „jetzt". Nur, wenn er noch keine hat (nie löschen). */
const EREIGNISSE: readonly (Omit<NeuesEreignis, 'zeitpunkt' | 'quelle' | 'agent'> & { readonly vorMinuten: number })[] = [
  {
    stufe: 'fehler',
    titel: 'Fehler im Lauf „Datensicherung"',
    text: 'pg_dump brach nach 4 min ab: Plattenplatz auf /backup erschöpft (98 %). Lauf wird um 05:00 wiederholt.',
    textKunde: 'Die nächtliche Datensicherung ist ausgefallen und wird wiederholt.',
    kundensichtbar: true,
    vorMinuten: 330,
  },
  {
    stufe: 'warnung',
    titel: 'Zertifikat erneuert, mit Warnung',
    text: 'n8n.example.com: neues Zertifikat bis 31.12., der erste Versuch scheiterte am DNS-Timeout.',
    textKunde: undefined,
    kundensichtbar: false,
    vorMinuten: 660,
  },
  {
    stufe: 'info',
    titel: 'Update eingespielt',
    text: 'Cockpit v0.12.0 nach Freigabe ausgerollt, Gesundheitsprüfung grün.',
    textKunde: 'Das Cockpit wurde auf Version 0.12.0 aktualisiert.',
    kundensichtbar: true,
    vorMinuten: 1300,
  },
];

export async function agentenEinspielen(pool: pg.Pool, jetzt: Date): Promise<string> {
  await inventarErsetzen(pool, INVENTAR.map((agent) => ({ ...agent, grenzen: { ...agent.grenzen }, zeitplan: [...agent.zeitplan] })), jetzt);
  let neu = 0;
  for (const gespraech of GESPRAECHE) {
    const kanal = await agentenKanal(pool, gespraech.von, gespraech.an);
    if ((await verlaufLesen(pool, kanal.id, { hoechstens: 1 })).length > 0) {
      continue;
    }
    for (const [nummer, inhalt] of gespraech.texte.entries()) {
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', absenderAgent: nummer % 2 === 0 ? gespraech.von : gespraech.an, inhalt });
      neu += 1;
    }
  }
  const vorhanden = await pool.query(`SELECT 1 FROM cockpit.agent_ereignis WHERE agent = $1 LIMIT 1`, [DEMO_WACHEN_AGENT]);
  if (vorhanden.rowCount === 0) {
    for (const { vorMinuten, ...ereignis } of EREIGNISSE) {
      await ereignisMelden(pool, { ...ereignis, agent: DEMO_WACHEN_AGENT, zeitpunkt: new Date(jetzt.getTime() - vorMinuten * 60_000), quelle: 'demo' });
    }
  }
  return `Agenten: ${String(INVENTAR.length)} im Inventar, ${String(neu)} neue Nachrichten zwischen Agenten.`;
}
