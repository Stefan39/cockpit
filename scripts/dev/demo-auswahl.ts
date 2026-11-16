/**
 * Das Demo-Modul „Auswahl" für `./dev demo` (COPI-91, neutral seit COPI-249): Vorschläge des Assistenten in allen
 * Ständen (neu, Grenzfall, Entwurf liegt vor, erledigt mit Eintrag im Fremdsystem, aussortiert), damit sich Liste,
 * Detailseite, Links und Statuswörter lokal ansehen lassen (`./dev vorschau --rolle betreuer`, Modul „Auswahl").
 *
 * **Nur lokal** wie das ganze Demo-Skript (`demo-daten.ts`). Fachtabellen und View kommen aus `docs/demo`.
 * **Wiederholbar:** jeder Vorschlag hat eine feste URL; ein zweiter Lauf legt nichts doppelt an (nur einfügen).
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { modulEinspielen } from '../../src/module/modul-speicher.js';

const MODUL_YAML_DATEI = 'docs/demo/auswahl.cockpit.yaml';

type Schritt = { readonly art: 'bewerbung' | 'beworben' | 'aussortiert'; readonly text?: string; readonly lead?: string };

interface DemoVorschlag {
  readonly url: string;
  readonly plattform: string;
  readonly titel: string;
  readonly auftraggeber: string;
  readonly honorar: string;
  readonly umfang: string;
  readonly ort: string;
  readonly einschaetzung: string;
  readonly ausschreibung: string;
  readonly art: 'treffer' | 'grenzfall';
  readonly quelle: 'assistent' | 'manuell';
  readonly vorMinuten: number;
  readonly schritte: readonly Schritt[];
}

const ENTWURF =
  'Guten Tag,\n\ngern übernehmen wir diese Aufgabe: eine eigenständige Schnittstelle mit authentifizierten Endpunkten, ' +
  'idempotenten Aktualisierungen und sauberer Fehlerbehandlung, passend zu Ihrem bestehenden Datenmodell.\n\n' +
  'Viele Grüße\nMax Beispiel';

const VORSCHLAEGE: readonly DemoVorschlag[] = [
  {
    url: 'https://portal-a.example.com/vorschlag/schnittstelle-katalog',
    plattform: 'Portal A',
    titel: 'Schnittstelle für einen Produktkatalog',
    auftraggeber: 'Beispiel Handel GmbH · seit 2026 dabei',
    honorar: '1.400 € Festpreis',
    umfang: '1–3 Monate',
    ort: 'vollständig remote',
    einschaetzung: 'Klar beschrieben, passt gut zum Profil. Budget für den Umfang ordentlich.\n\nDagegen: Anbieter noch ohne Referenzen.',
    ausschreibung: 'Wir stellen unsere Warenwirtschaft um. Der Produktkatalog soll automatisch auf unsere Website übertragen werden. Gewünscht: authentifizierte Endpunkte (anlegen, ändern, entfernen) und ein Abgleich über unsere Artikelnummern.',
    art: 'treffer',
    quelle: 'manuell',
    vorMinuten: 40,
    schritte: [],
  },
  {
    url: 'https://portal-a.example.com/vorschlag/abgleich-buchhaltung',
    plattform: 'Portal A',
    titel: 'Abgleich zwischen Fachsystem und Buchhaltung',
    auftraggeber: 'Muster Praxis · Zahlung bestätigt',
    honorar: '30–100 €/h',
    umfang: '1–3 Monate, 30+ h/Woche',
    ort: 'vollständig remote',
    einschaetzung: 'Anspruchsvoller Abgleich mit mehreren Mandanten.\n\nDagegen: noch keine Historie beim Anbieter, hohe Wochenlast.',
    ausschreibung: 'Mehrmandantenfähiger Abgleich zwischen einem Fachsystem und einer Buchhaltungssoftware, Aufbau und Betrieb.',
    art: 'grenzfall',
    quelle: 'manuell',
    vorMinuten: 90,
    schritte: [],
  },
  {
    url: 'https://portal-b.example.org/vorschlag/backend-seo',
    plattform: 'Portal B',
    titel: 'Backend-Entwicklung mit technischer Suchmaschinen-Erfahrung',
    auftraggeber: 'Beispiel Bildung (Endkunde)',
    honorar: 'nach Absprache',
    umfang: 'ab sofort, mehrere Monate',
    ort: 'vollständig remote',
    einschaetzung: 'Starker Treffer: Backend-Arbeit direkt beim Endkunden.',
    ausschreibung: 'Wir suchen Unterstützung im Backend mit Erfahrung in technischer Suchmaschinenoptimierung.',
    art: 'treffer',
    quelle: 'assistent',
    vorMinuten: 600,
    schritte: [{ art: 'bewerbung', text: ENTWURF }],
  },
  {
    url: 'https://portal-b.example.org/vorschlag/shop-betreuung',
    plattform: 'Portal B',
    titel: 'Betreuung eines Online-Shops',
    auftraggeber: 'Beispiel Versand GmbH (Endkunde)',
    honorar: 'nach Absprache',
    umfang: 'dauerhaft',
    ort: 'vollständig remote',
    einschaetzung: 'Laufende Betreuung und Weiterentwicklung eines bestehenden Shops.',
    ausschreibung: 'Dauerhafte Betreuung und Weiterentwicklung eines Online-Shops.',
    art: 'treffer',
    quelle: 'assistent',
    vorMinuten: 2 * 24 * 60,
    schritte: [{ art: 'bewerbung', text: ENTWURF }, { art: 'beworben', lead: 'https://crm.example.com/eintraege/00000000-0000-4000-8000-000000000091' }],
  },
  {
    url: 'https://portal-a.example.com/vorschlag/bezahlschranke',
    plattform: 'Portal A',
    titel: 'Bezahlschranke für eine Bilderseite',
    auftraggeber: 'Beispiel Fotografie · Ø 100 €/h gezahlt',
    honorar: 'stundenweise',
    umfang: '< 1 Monat',
    ort: 'vollständig remote',
    einschaetzung: 'Kleiner, klar umrissener Auftrag.\n\nDagegen: Technik der Bestandsseite unbekannt.',
    ausschreibung: 'Bezahlschranke für ausgewählte Bilder auf einer bestehenden Download-Seite.',
    art: 'treffer',
    quelle: 'manuell',
    vorMinuten: 3 * 24 * 60,
    schritte: [{ art: 'aussortiert' }],
  },
];

export async function auswahlEinspielen(pool: pg.Pool, jetzt: Date, akteur: string): Promise<string> {
  for (const v of VORSCHLAEGE) {
    const gefundenAm = new Date(jetzt.getTime() - v.vorMinuten * 60_000);
    const neu = await pool.query<{ id: string }>(
      `INSERT INTO auswahl.treffer (url, plattform, titel, auftraggeber, honorar, umfang, ort, einschaetzung, ausschreibung, art, quelle, gefunden_am)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (url) DO NOTHING RETURNING id::text`,
      [v.url, v.plattform, v.titel, v.auftraggeber, v.honorar, v.umfang, v.ort, v.einschaetzung, v.ausschreibung, v.art, v.quelle, gefundenAm],
    );
    const id = neu.rows[0]?.id;
    // Schritte nur beim ersten Anlegen: sonst wüchse die Geschichte mit jedem Lauf.
    for (const schritt of id === undefined ? [] : v.schritte) {
      await pool.query('INSERT INTO auswahl.schritt (treffer_id, art, text, lead_url) VALUES ($1, $2, $3, $4)', [id, schritt.art, schritt.text ?? null, schritt.lead ?? null]);
    }
  }
  const ergebnis = await modulEinspielen(pool, { rohtext: readFileSync(MODUL_YAML_DATEI, 'utf8'), akteur });
  if (!ergebnis.ok) {
    throw new Error(`Modul „Auswahl" konnte nicht eingespielt werden: ${ergebnis.grund}`);
  }
  return `Modul ${ergebnis.kennung}: ${ergebnis.status}, Version ${String(ergebnis.version)}, ${String(VORSCHLAEGE.length)} Vorschläge.`;
}
