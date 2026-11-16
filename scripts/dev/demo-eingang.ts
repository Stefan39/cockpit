/**
 * Das Demo-Modul „Eingang" für `./dev demo` (COPI-88, neutral seit COPI-249): vier Nachrichten an den Assistenten in
 * verschiedenen Ständen, damit sich Liste, Detailseite, Anhänge, Antwortentwurf und Übernahme lokal ansehen lassen
 * (`./dev vorschau --rolle betreuer`, Modul „Eingang").
 *
 * **Nur lokal** wie das ganze Demo-Skript (`demo-daten.ts`). Fachtabelle und View kommen aus `docs/demo` (dort legt
 * sie `demo-daten.ts` an), der Block ebenso.
 *
 * **Wiederholbar:** jede Mail trägt eine feste Message-ID (`<demo-…@cockpit.invalid>`) und wird beim zweiten Lauf auf
 * den Stand gebracht (Zeiten relativ zu „jetzt").
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { modulEinspielen } from '../../src/module/modul-speicher.js';
import { befundMelden } from '../../src/status/befund-speicher.js';
import { modulVersionsWache } from '../../src/status/versionen.js';

const MODUL_YAML_DATEI = 'docs/demo/eingang.cockpit.yaml';

interface DemoMail {
  readonly messageId: string;
  readonly absenderName: string | null;
  readonly absenderAdresse: string;
  readonly betreff: string;
  readonly kunde: string;
  readonly zusammenfassung: string;
  readonly vorschlag: string | null;
  readonly stand: 'neu' | 'entwurf' | 'freigegeben' | 'gesendet' | 'erledigt';
  readonly anhaenge: string | null;
  /** Der Mailtext (COPI-103); `gekuerzt` wie vom Workflow gemeldet. */
  readonly text: string | null;
  readonly gekuerzt?: boolean;
  /** Minuten vor „jetzt": Eingang der Mail. */
  readonly eingangVorMinuten: number;
  /** Anhänge (COPI-110, Fachmigration 0004): je eine Gefahrenklasse; `inhalt` null: liegt nur im Postfach. */
  readonly dateien?: readonly DemoAnhang[];
  /** Antwortentwurf des Assistenten (COPI-90, Fachmigration 0003); `gesendet`: die Fassung ging schon raus. */
  readonly entwurf?: { readonly an: string; readonly text: string; readonly gesendet?: boolean };
}

interface DemoAnhang {
  readonly name: string;
  readonly typ: string;
  readonly inhalt: Buffer | null;
  /** Nur ohne Inhalt: die Größe laut Absender. */
  readonly groesse?: number;
}

/** Ein kleiner Demo-Inhalt: die echten ersten Bytes der Art, dahinter Text. */
function demoInhalt(kopf: readonly number[], text: string): Buffer {
  return Buffer.concat([Buffer.from(kopf), Buffer.from(text, 'utf8')]);
}

const PDF_KOPF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a];
const ZIP_KOPF = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00];

/** Alle Klassen der Anhangliste an einer Mail (Entwurf „Anhänge"): normal, Archiv, Widerspruch, gesperrt, zu groß. */
const DEMO_ANHAENGE: readonly DemoAnhang[] = [
  { name: 'Anforderungen.pdf', typ: 'application/pdf', inhalt: demoInhalt(PDF_KOPF, 'Demo: Anforderungen an die Anbindung.\n') },
  { name: 'Skizze.jpg', typ: 'image/jpeg', inhalt: demoInhalt([0xff, 0xd8, 0xff, 0xe0], 'Demo-Bild') },
  { name: 'Bestand.zip', typ: 'application/zip', inhalt: demoInhalt(ZIP_KOPF, 'Demo-Archiv') },
  { name: 'Angebot_alt.pdf', typ: 'application/pdf', inhalt: demoInhalt(ZIP_KOPF, 'Demo: ein ZIP hinter einer PDF-Endung') },
  { name: 'Rechnung_Oktober.pdf.exe', typ: 'application/octet-stream', inhalt: demoInhalt([0x4d, 0x5a, 0x90, 0x00], 'Demo: kein echtes Programm') },
  { name: 'Video.mov', typ: 'video/quicktime', inhalt: null, groesse: 48_200_000 },
];

const MAILS: readonly DemoMail[] = [
  {
    messageId: '<demo-umzug@cockpit.invalid>',
    absenderName: 'Erika Muster',
    absenderAdresse: 'e.muster@example.org',
    betreff: 'Frage zum Umzug unserer Filiale',
    kunde: 'Interessentin: Muster Haustechnik (neu)',
    zusammenfassung: 'Muster Haustechnik zieht im Dezember um und fragt nach einem Termin für ein Erstgespräch.',
    vorschlag: 'Vorschlag: zwei Termine in der nächsten Woche anbieten.',
    stand: 'neu',
    anhaenge: 'Anforderungen.pdf (application/pdf)',
    text: 'Guten Tag,\n\nunsere Filiale zieht im Dezember um. Wir möchten die Anbindung unserer Systeme dort neu planen und hätten dazu gern ein erstes Gespräch, nächste oder übernächste Woche.\n\nViele Grüße\nErika Muster',
    eingangVorMinuten: 25,
    dateien: DEMO_ANHAENGE,
    entwurf: {
      an: 'Erika Muster <e.muster@example.org>',
      text: 'Guten Tag Frau Muster,\n\nvielen Dank für Ihre Nachricht. Gern besprechen wir die Anbindung in einem ersten Gespräch.\n\nIch kann Ihnen zwei Termine anbieten:\n– Dienstag, 7. Oktober, 10:00 Uhr\n– Donnerstag, 9. Oktober, 14:00 Uhr\n\nViele Grüße\nMax Beispiel',
    },
  },
  {
    messageId: '<demo-rechnung@cockpit.invalid>',
    absenderName: 'Buchhaltung Beispiel GmbH',
    absenderAdresse: 'buchhaltung@example.com',
    betreff: 'Rückfrage zur Rechnung 2026-041',
    kunde: 'Kunde: Beispiel GmbH, Projekt Anbindung (laufend)',
    zusammenfassung: 'Die Buchhaltung fragt, ob die Stunden aus dem September schon enthalten sind.',
    vorschlag: 'Vorschlag: Stundenaufstellung als Anhang schicken.',
    stand: 'entwurf',
    anhaenge: null,
    text: `Guten Tag,\n\nin der Rechnung 2026-041 sind 38 Stunden abgerechnet. Sind darin die Stunden aus dem September schon enthalten?\n\n${'Zur Übersicht unten die vollständige Korrespondenz der letzten Wochen.\n'.repeat(3)}…`,
    gekuerzt: true,
    eingangVorMinuten: 190,
    entwurf: { an: 'Buchhaltung Beispiel GmbH <buchhaltung@example.com>', text: 'Guten Tag,\n\nja, die 38 Stunden enthalten den September vollständig. Die Aufstellung liegt bei.\n\nViele Grüße\nMax Beispiel' },
  },
  {
    messageId: '<demo-einladung@cockpit.invalid>',
    absenderName: null,
    absenderAdresse: 'info@example.net',
    betreff: 'Einladung: Branchentreffen',
    kunde: 'unbekannter Absender (kein Treffer im Adressbuch)',
    zusammenfassung: 'Einladung zum nächsten Branchentreffen am 15.10.',
    vorschlag: null,
    stand: 'erledigt',
    anhaenge: null,
    text: null,
    eingangVorMinuten: 1500,
  },
  {
    messageId: '<demo-angebot@cockpit.invalid>',
    absenderName: 'Tom Beispiel',
    absenderAdresse: 'tom@example.de',
    betreff: 'Angebot Wartungsvertrag',
    kunde: 'Kunde: Beispiel & Söhne, Projekt Wartung (angeboten)',
    zusammenfassung: 'Herr Beispiel nimmt das Angebot an und bittet um den Vertrag.',
    vorschlag: 'Vorschlag: Vertrag schicken und Start zum 01.11. bestätigen.',
    stand: 'gesendet',
    anhaenge: null,
    text: 'Guten Tag,\n\ndas Angebot passt so, bitte schicken Sie uns den Vertrag.\n\nTom Beispiel',
    eingangVorMinuten: 3000,
    entwurf: { an: 'Tom Beispiel <tom@example.de>', text: 'Guten Tag Herr Beispiel,\n\nvielen Dank! Den Vertrag finden Sie im Anhang; Start ist der 01.11.\n\nViele Grüße\nMax Beispiel', gesendet: true },
  },
];

/** Bringt die vier Mails auf den Stand und spielt das Modul ein. Fachtabelle und View legt `demo-daten.ts` an. */
const DEMO_HERKUNFT = 'bibliothek@3f2a9c1e0b7d44c2a9f1c0de5b6a7d8e9f0a1b2c:module/eingang.cockpit.yaml';

/** Die Versions-Wache des Moduls (COPI-106): einmal gelb, „neuerer Commit", nur wenn sie noch nichts gemeldet hat. */
async function versionsWacheEinspielen(pool: pg.Pool, jetzt: Date, akteur: string): Promise<void> {
  const wache = modulVersionsWache('eingang');
  const vorhanden = await pool.query('SELECT 1 FROM cockpit.befund WHERE wache = $1 LIMIT 1', [wache]);
  if ((vorhanden.rowCount ?? 0) > 0) {
    return;
  }
  const ergebnis = await befundMelden(pool, {
    wache,
    status: 'gelb',
    textIntern: 'Commit 8d41e07 · Block und View geändert',
    textKunde: undefined,
    kundensichtbar: false,
    taktSekunden: 3600,
    anzeigename: 'Version Eingang',
    agent: 'wache',
    messwert: undefined,
    quelle: akteur,
    jetzt: new Date(jetzt.getTime() - 12 * 60_000),
  });
  if (!ergebnis.ok) {
    throw new Error(`Versions-Wache konnte nicht geschrieben werden (${ergebnis.grund}).`);
  }
}

export async function eingangEinspielen(pool: pg.Pool, jetzt: Date, akteur: string): Promise<string> {
  for (const m of MAILS) {
    const eingang = new Date(jetzt.getTime() - m.eingangVorMinuten * 60_000);
    await pool.query(
      `INSERT INTO eingang.vorgang (message_id, postfach, absender_name, absender_adresse, betreff, eingang, kunde,
                                          zusammenfassung, vorschlag, anhaenge, stand, stand_seit, text, text_gekuerzt)
       VALUES ($1, 'assistent@example.com', $2, $3, $4, $5, $6, $7, $8, $9, $10, $5, $11, $12)
       ON CONFLICT (message_id) DO UPDATE SET absender_name = EXCLUDED.absender_name,
         absender_adresse = EXCLUDED.absender_adresse, betreff = EXCLUDED.betreff, eingang = EXCLUDED.eingang,
         kunde = EXCLUDED.kunde, zusammenfassung = EXCLUDED.zusammenfassung, vorschlag = EXCLUDED.vorschlag,
         anhaenge = EXCLUDED.anhaenge, stand = EXCLUDED.stand, stand_seit = EXCLUDED.stand_seit,
         text = EXCLUDED.text, text_gekuerzt = EXCLUDED.text_gekuerzt`,
      [m.messageId, m.absenderName, m.absenderAdresse, m.betreff, eingang, m.kunde, m.zusammenfassung, m.vorschlag, m.anhaenge, m.stand, m.text, m.gekuerzt ?? false],
    );
  }
  // Anhänge (COPI-110): wie Entwürfe nur einfügen; ein zweiter Lauf lässt Vorhandenes stehen.
  for (const m of MAILS) {
    for (const [stelle, datei] of (m.dateien ?? []).entries()) {
      await pool.query(
        `INSERT INTO eingang.anhang (message_id, position, dateiname, typ, groesse, inhalt)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (message_id, position) DO NOTHING`,
        [m.messageId, stelle + 1, datei.name, datei.typ, datei.inhalt?.length ?? datei.groesse ?? 0, datei.inhalt],
      );
    }
  }
  // Entwürfe und Versand (COPI-90): nur einfügen, nie ändern (nie löschen) — ein zweiter Lauf lässt Vorhandenes stehen.
  for (const m of MAILS) {
    if (m.entwurf === undefined) {
      continue;
    }
    await pool.query(
      `INSERT INTO eingang.entwurf (vorgang_id, fassung, an, betreff, text)
       SELECT id, 1, $2, 'Re: ' || betreff, $3 FROM eingang.vorgang WHERE message_id = $1
       ON CONFLICT (vorgang_id, fassung) DO NOTHING`,
      [m.messageId, m.entwurf.an, m.entwurf.text],
    );
    if (m.entwurf.gesendet === true) {
      await pool.query(
        `INSERT INTO eingang.versand (vorgang_id, fassung)
         SELECT id, 1 FROM eingang.vorgang WHERE message_id = $1
         ON CONFLICT (vorgang_id, fassung) DO NOTHING`,
        [m.messageId],
      );
    }
  }
  const ergebnis = await modulEinspielen(pool, {
    rohtext: readFileSync(MODUL_YAML_DATEI, 'utf8'),
    akteur,
    // Eine erfundene Herkunft (Commit einer Modulbibliothek), damit die Einstellungen den Modul-Antrag zeigen (COPI-106).
    herkunft: DEMO_HERKUNFT,
  });
  if (!ergebnis.ok) {
    throw new Error(`Modul „Eingang" konnte nicht eingespielt werden: ${ergebnis.grund}`);
  }
  await versionsWacheEinspielen(pool, jetzt, akteur);
  return `Modul ${ergebnis.kennung}: ${ergebnis.status}, Version ${String(ergebnis.version)}, ${String(MAILS.length)} Mails.`;
}
