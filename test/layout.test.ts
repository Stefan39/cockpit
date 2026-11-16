/**
 * Das Basis-Layout (COPI-30): Jede Seite läuft durch `views/layout.eta`; Sprache, Viewport,
 * Titel, Stylesheet und `<main>` stehen an genau einer Stelle. Vier Gruppen:
 *
 *   1. Architektur: keine Seite am Layout vorbei, keine Inline-Stile, keine Inline-Skripte.
 *   2. Smoke: jedes Template wird gerendert und hat, was das Layout verspricht.
 *   3. Keine Fremdanfragen: weder in den Views noch in den gerenderten Seiten ein fremder Host.
 *   4. Bestehende Zusagen der Seiten bleiben (Formularfelder, Beschriftungen, Hinweise).
 *
 * Läuft ohne Datenbank; `app.render` braucht nur die Views und das gebaute Stylesheet
 * (`test/global-setup-assets.ts` baut es einmal je Lauf).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qrCodeSvg } from '../src/auth/qr.js';
import type { ModulBlock } from '../src/module/block.js';
import type { PosteingangAnsicht } from '../src/posteingang/posteingang.js';
import type { ModulZeileRoh } from '../src/module/liste-detail.js';
import { kennzahlenKarte, kennzahlenSeite } from '../src/module/kennzahlen-ansicht.js';
import { kartenSpannen, zeitraumAus } from '../src/module/kennzahlen-zeitraum.js';
import { kachelChips, kachelFilterAus, kachelnAnsicht, kachelnGefiltert } from '../src/module/modul-kacheln.js';
import { zuTunAnsicht } from '../src/posteingang/zu-tun.js';
import { dashboardAnsicht } from '../src/module/uebersicht-karten.js';
import type { VerlaufPunkt } from '../src/module/zeitraster.js';
import { buildApp } from '../src/server/app.js';
import { navigation, type NavSeite } from '../src/server/navigation.js';

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(wurzel, 'views');
const PARTIALS = path.join(VIEWS, 'partials');

const seitenDateien = readdirSync(VIEWS).filter((datei) => datei.endsWith('.eta') && datei !== 'layout.eta');
const partialDateien = readdirSync(PARTIALS).filter((datei) => datei.endsWith('.eta'));
const lesen = (pfad: string): string => readFileSync(pfad, 'utf8');

/** Der echte QR-Code, wie das Cockpit ihn baut: das SVG trägt auch dessen Attribute in die Seite (etwa kein `style`). */
const QR_SVG = qrCodeSvg('otpauth://totp/Cockpit:kunde@example.org?secret=JBSWY3DPEHPK3PXP', 'QR-Code');

/** Die Navigation der angemeldeten Seiten (COPI-38/43), aus der echten reinen Funktion: Test und Modell laufen nie auseinander. */
/** Ein Posteingang mit je einem Eintrag jeder Quelle (COPI-112): jede angemeldete Seite rendert das Badge samt Panel mit. */
const POSTEINGANG_BEISPIEL: PosteingangAnsicht = {
  gesamt: 3,
  zahlen: { freigabe: 0, chat: 1, postfach: 1, meldung: 1 },
  postfaecher: { kommunikation: 1 },
  eintraege: [
    { quelle: 'postfach', herkunft: 'Kommunikation', titel: 'Anfrage', anriss: 'Bitte um Rückruf', zeit: 'vor 2 Min.', href: '/module/kommunikation/m1?von=nachrichten', rot: false },
    { quelle: 'chat', herkunft: 'Chat · Team', titel: 'Bert', anriss: 'Hallo', zeit: 'vor 5 Min.', href: '/chat/team', rot: false },
    { quelle: 'meldung', herkunft: 'Meldung · Rot', titel: 'Zertifikate', anriss: 'Läuft ab.', zeit: 'vor 1 Std.', href: '/meldungen', rot: true },
  ],
};

const navBeispiel = (aktuell: NavSeite, abmelden = true) =>
  navigation(aktuell, { angemeldet: abmelden, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0, ...(abmelden ? { posteingang: POSTEINGANG_BEISPIEL } : {}) });

/** Die Detailseite eines Agenten (COPI-113), Steckbrief in der Betreuersicht: Kennzahlen, Grenzen, Zeitplan, Module, Zuletzt. */
const AGENT_DETAIL = {
  titel: 'Assistent – Akquise',
  nav: navBeispiel('agenten'),
  kennung: 'assistent',
  technik: true,
  initiale: 'S',
  karte: { rolle: 'Assistent – Akquise', grenzen: [{ name: 'Senden', wert: 'nur nach Freigabe' }], href: '/agenten/0123456789abcdef', kennung: 'assistent', version: '2.4.0' },
  stand: { text: 'Im Inventar · gemeldet vor 4 Min.', aktiv: true },
  seitenStand: 'heute, 10:15',
  bereich: 'steckbrief',
  reiter: [
    { text: 'Steckbrief', href: '/agenten/0123456789abcdef', aktuell: true, zahl: undefined },
    { text: 'Mails', href: '/agenten/0123456789abcdef?bereich=mails', aktuell: false, zahl: 4 },
  ],
  zeitplan: [{ name: 'Posteingang prüfen', wann: 'alle 5 Minuten' }],
  module: [{ name: 'Kommunikation', href: '/chat/postfach/kommunikation', ungelesen: 4, postfach: true }],
  kennzahlen: {
    offen: 4,
    nachrichten: 23,
    kosten: '3,42 €',
    monat: 'Oktober',
    fehler: 1,
    fehlerZuletzt: { art: 'ereignis', symbol: 'blitz', ton: 'rot', titel: 'Fehler im Lauf', text: 'pg_dump abgebrochen', zeit: '04:16', typ: 'Ereignis · Fehler', href: undefined },
  },
  zuletzt: [
    { art: 'mail', symbol: 'mail', ton: 'akzent', titel: 'Mail eingegangen', text: 'Anfrage', zeit: '10:21', typ: 'Kommunikation', href: '/module/kommunikation/1?von=nachrichten' },
    { art: 'befund', symbol: 'warnung', ton: 'rot', titel: 'Befund: Mailserver', text: 'IMAP gestört', zeit: '23:05', typ: 'Befund · Rot', href: undefined },
  ],
  mails: [],
};

/** Beispieldaten der Übersicht (COPI-37), Kundensicht: eine Störung, ein Hinweis, ein grüner Bereich. */
/** Ein Kennzahlen-Modul (COPI-98) mit Warnung, Filter-Link und einer Gruppe ohne Wert — alles, was die Vorlage kennt. */
const KENNZAHLEN_BLOCK = {
  kennung: 'ki-verbrauch',
  menuename: 'KI-Verbrauch',
  ansicht: 'kennzahlen',
  view: 'v_modul_ki_verbrauch',
  spalten: [
    { name: 'wert', label: 'Kosten', format: 'euro' },
    { name: 'tokens', label: 'Tokens', format: 'zahl' },
  ],
  aufteilungen: [{ name: 'projekt', label: 'Je Projekt', filter: true }],
  anteile: [{ name: 'ohne_preis', label: 'ohne Preis', format: 'anzahl', text: 'Einsätze ohne Preis' }],
  rollen: ['betreuer'],
  eingriffe: [],
  uebersicht: { titel: 'KI-Verbrauch' },
} satisfies ModulBlock;

const KENNZAHLEN_TAGE = [
  { tag: '2026-09-29', summen: { wert: 12.5, tokens: 1_200_000, ohne_preis: 2 } },
  { tag: '2026-09-30', summen: { wert: 20, tokens: 3_400_000, ohne_preis: 0 } },
];

const KENNZAHLEN_HINWEISE = [{ titel: '2 Einsätze ohne Preis', text: 'Für <b>modell</b> ist kein Preis hinterlegt.' }];

const KENNZAHLEN_KARTE = kennzahlenKarte(
  'ki-verbrauch',
  KENNZAHLEN_BLOCK,
  '2026-09-30',
  kartenSpannen('2026-09-30').verlauf,
  { tage: KENNZAHLEN_TAGE, monat: 32.5, vormonat: 28 },
  KENNZAHLEN_HINWEISE,
  20,
);

const UEBERSICHT_KUNDE = {
  titel: 'Übersicht',
  sicht: 'kunde',
  kennzahlenKarten: [KENNZAHLEN_KARTE],
  kennzahlenStand: 'heute, 16:10',
  letzteMeldungen: [
    { titel: 'Die Buchungen sind gerade nicht erreichbar.', farbe: 'rot', zeit: 'vor 1 Min.', meta: 'vor 1 Min. · Buchungs-Agent', intern: false },
    { titel: 'Reinigungsplan bestätigt.', farbe: 'gruen', zeit: 'vor 3 Std.', meta: 'vor 3 Std. · Reinigung', intern: false },
  ],
  nav: navBeispiel('uebersicht'),
  uebersicht: {
    status: { farbe: 'rot', satz: '1 Sache braucht Ihre Aufmerksamkeit', detail: 'Die Buchungen sind gerade nicht erreichbar.' },
    kacheln: [
      { name: 'Buchungs-Agent', farbe: 'rot', statusWort: 'Störung', text: 'Die Buchungen sind gerade nicht erreichbar.', geprueft: 'vor 1 Min. geprüft', ueberfaellig: false },
      { name: 'Reinigung', farbe: 'gelb', statusWort: 'Achtung', text: 'Alles läuft.', geprueft: 'vor 3 Tagen geprüft', ueberfaellig: true },
      { name: 'Bereich', farbe: 'gruen', statusWort: 'Läuft', text: 'Alles läuft.', geprueft: 'gerade eben geprüft', ueberfaellig: false },
    ],
  },
};

/** Dieselbe Übersicht in der Betreuersicht: mit Kennung, Rohbefund und der Angabe, ob der Kunde ihn sieht. */
const UEBERSICHT_BETREUER = {
  titel: 'Übersicht',
  sicht: 'betreuer',
  letzteMeldungen: [{ titel: 'postgres beendet (Exit 137)', farbe: 'rot', zeit: 'vor 1 Min.', meta: 'vor 1 Min. · container', intern: true }],
  nav: navBeispiel('uebersicht'),
  uebersicht: {
    status: { farbe: 'rot', satz: '1 Sache braucht Ihre Aufmerksamkeit', detail: 'postgres beendet (Exit 137)' },
    kacheln: [
      { name: 'container', kennung: 'container', farbe: 'rot', statusWort: 'Störung', text: 'postgres beendet (Exit 137)', geprueft: 'vor 1 Min. geprüft', ueberfaellig: false, kundensichtbar: false, kundenText: undefined },
      { name: 'Buchungs-Agent', kennung: 'buchung', farbe: 'gruen', statusWort: 'Läuft', text: 'roh', geprueft: 'vor 1 Min. geprüft', ueberfaellig: false, kundensichtbar: true, kundenText: 'Alles läuft.' },
      { name: 'backup', kennung: 'backup', farbe: 'gelb', statusWort: 'Achtung', text: 'Noch kein Befund gemeldet.', geprueft: 'noch nie geprüft', ueberfaellig: true, kundensichtbar: undefined, kundenText: undefined },
    ],
  },
};

/** Der Leerzustand der Übersicht. */
const UEBERSICHT_LEER = {
  titel: 'Übersicht',
  sicht: 'kunde',
  letzteMeldungen: [],
  nav: navBeispiel('uebersicht'),
  uebersicht: { status: { farbe: 'leer', satz: 'Noch keine Meldungen', detail: 'Sobald der Betrieb meldet, erscheint hier der Stand.' }, kacheln: [] },
};

/** Das Dashboard der Übersicht (COPI-81), aus der echten reinen Funktion: eine Störung, ein Hinweis, ein grüner Dienst. */
const DASHBOARD_JETZT = new Date('2026-09-28T08:02:00.000Z');
const UEBERSICHT_DASHBOARD = {
  kennzahlenKarten: [KENNZAHLEN_KARTE, { ...KENNZAHLEN_KARTE, kennung: 'zweites', verfuegbar: false }],
  titel: 'Übersicht',
  sicht: 'betreuer',
  letzteMeldungen: [],
  nav: navBeispiel('uebersicht'),
  uebersicht: UEBERSICHT_BETREUER.uebersicht,
  dashboard: dashboardAnsicht(
    [
      {
        kennung: 'server-zustand',
        block: {
          kennung: 'server-zustand',
          menuename: 'Server & Dienste',
          ansicht: 'liste-detail',
          view: 'v_modul_server_zustand',
          spalten: [{ name: 'text', label: 'Meldung' }],
          rollen: ['betreuer', 'betriebs_admin'],
          eingriffe: [],
          uebersicht: { kurztext: 'text', verlauf: 'v_modul_server_zustand_verlauf' },
        },
        zeilen: [
          // „web" trägt einen Messwert (COPI-83): Wert, Balken und Kurve kommen so mit in den Smoke-Test (kein `style`).
          {
            werte: { id: 'web', titel: 'Webserver', status: 'rot', text: 'Antwortet nicht.', aktualisiert_am: DASHBOARD_JETZT, wert: '86', einheit: '%', wert_max: '100', wert_warnung: '85' },
          },
          { werte: { id: 'backup', titel: 'Backup', status: 'gelb', text: 'Überfällig.', aktualisiert_am: null } },
          { werte: { id: 'mail', titel: 'Mail', status: 'gruen', text: 'Läuft.', aktualisiert_am: DASHBOARD_JETZT } },
        ],
        verlauf: new Map([
          [
            'web',
            [
              { zeitpunkt: new Date(DASHBOARD_JETZT.getTime() - 3 * 3_600_000), status: 'rot' as const, wert: 80 },
              { zeitpunkt: new Date(DASHBOARD_JETZT.getTime() - 3_600_000), status: 'rot' as const, wert: 86 },
            ],
          ],
        ]),
        // „backup" ist übernommen (COPI-85): die Karte trägt die Marke.
        sperren: new Map([['backup', { id: 1, vorgangId: 'backup', uebernommenVon: 'konto-1', anzeigename: 'Stefan Jacomeit', uebernommenAm: DASHBOARD_JETZT }]]),
      },
      // Eine Team-Liste (COPI-122, `uebersicht.art: liste`): kommt in die Team-Reihe, nicht in den Zustand.
      {
        kennung: 'social',
        block: {
          kennung: 'social',
          menuename: 'Social',
          ansicht: 'liste-detail',
          view: 'v_modul_social',
          spalten: [{ name: 'text', label: 'Stand' }],
          rollen: ['betreuer'],
          eingriffe: [],
          uebersicht: { kurztext: 'text', art: 'liste', titel: 'Social diese Woche' },
        },
        zeilen: [{ werte: { id: 'p1', titel: 'LinkedIn · Di 09:00', status: 'gelb', text: 'Entwurf wartet', aktualisiert_am: DASHBOARD_JETZT } }],
        verlauf: undefined,
      },
    ],
    DASHBOARD_JETZT,
  ),
  // Die Reihe „Zu tun" (COPI-122), aus der echten reinen Funktion.
  zuTun: zuTunAnsicht({
    posteingang: {
      gesamt: 3,
      zahlen: { freigabe: 1, chat: 1, postfach: 1, meldung: 0 },
      eintraege: [
        { quelle: 'freigabe', herkunft: 'Freigabe nötig · Kommunikation', titel: 'Antwort an Jana', anriss: '', zeit: 'vor 1 Tag', href: '/module/kommunikation/1', rot: false, kennung: 'kommunikation' },
        { quelle: 'chat', herkunft: 'Chat · Team', titel: 'Koordinator', anriss: '', zeit: 'vor 2 Tagen', href: '/chat/team', rot: false },
      ],
      postfaecher: { akquise: 1 },
    },
    module: [{ kennung: 'akquise', menuename: 'Akquise', offen: 1, zeilen: [{ id: 't1', titel: 'Backend-Entwicklung', status: 'gelb', anriss: 'portal-a.example.com', zeit: DASHBOARD_JETZT, ungelesen: true }] }],
    nachrichten: true,
    freigaben: true,
    jetzt: DASHBOARD_JETZT,
  }),
};

/**
 * Die Kacheln der Modulseite (COPI-82, `darstellung: kacheln`), aus den echten reinen Funktionen
 * (`kachelnAnsicht`/`kachelChips`/`kachelnGefiltert`): sechs Zeilen wie im freigegebenen Entwurf „Module ›
 * Server & Dienste" — eine Störung, ein Hinweis, vier laufende („Alle · 6", „Störung · 1", „Achtung · 1",
 * „Läuft · 4"). Nur „web" trägt einen Verlauf, damit sowohl eine Kachel mit Band als auch eine ohne (weil ihre
 * `id` im Verlauf fehlt) im Smoke-Test vorkommen.
 */
const KACHELN_JETZT = new Date('2026-09-28T07:50:00.000Z'); // 09:50 in Berlin
const KACHELN_BLOCK: ModulBlock = {
  kennung: 'server-zustand',
  menuename: 'Server & Dienste',
  ansicht: 'liste-detail',
  view: 'v_modul_server_zustand',
  spalten: [{ name: 'text', label: 'Meldung' }],
  rollen: ['betreuer', 'betriebs_admin'],
  eingriffe: [],
  darstellung: 'kacheln',
  uebersicht: { kurztext: 'text', verlauf: 'v_modul_server_zustand_verlauf' },
};
const KACHELN_ZEILEN: ModulZeileRoh[] = [
  { werte: { id: 'web', titel: 'Webserver', status: 'rot', text: 'Antwortet nicht.', aktualisiert_am: KACHELN_JETZT, wert: '86', einheit: '%', wert_max: '100', wert_warnung: '85' } },
  { werte: { id: 'backup', titel: 'Backup', status: 'gelb', text: 'Überfällig.', aktualisiert_am: KACHELN_JETZT } },
  { werte: { id: 'mail', titel: 'Mail', status: 'gruen', text: 'Läuft.', aktualisiert_am: KACHELN_JETZT } },
  { werte: { id: 'dns', titel: 'DNS', status: 'gruen', text: 'Läuft.', aktualisiert_am: KACHELN_JETZT } },
  { werte: { id: 'vpn', titel: 'VPN', status: 'gruen', text: 'Läuft.', aktualisiert_am: null } },
  { werte: { id: 'ftp', titel: 'FTP', status: 'gruen', text: 'Läuft.', aktualisiert_am: KACHELN_JETZT } },
];
const KACHELN_VERLAUF = new Map<string, readonly VerlaufPunkt[]>([
  [
    'web',
    [
      { zeitpunkt: new Date(KACHELN_JETZT.getTime() - 30 * 3_600_000), status: 'rot' as const, wert: 71 },
      { zeitpunkt: new Date(KACHELN_JETZT.getTime() - 3_600_000), status: 'rot' as const, wert: 86 },
    ],
  ],
]);
const KACHELN_ALLE = kachelnAnsicht('server-zustand', KACHELN_BLOCK, KACHELN_ZEILEN, KACHELN_VERLAUF, KACHELN_JETZT);
const KACHELN_FILTER = kachelFilterAus({});
const MODUL_KACHELN = {
  titel: 'Server & Dienste',
  nav: navBeispiel('module'),
  kennung: 'server-zustand',
  versionText: 'Version 1 · eingespielt am 01.09.2026',
  verfuegbar: true,
  darstellung: 'kacheln',
  stand: 'heute, 09:50',
  krume: [{ text: 'Module', href: '/module' }],
  chips: kachelChips('server-zustand', KACHELN_ALLE, KACHELN_FILTER),
  kacheln: kachelnGefiltert(KACHELN_ALLE, KACHELN_FILTER),
  gefiltert: false,
};

/** Die Marke einer übernommenen Zeile (COPI-85), mit einem Namen, der escaped werden muss. */
const SPERRE_MARKE = { name: 'Stefan <b>Jacomeit</b>', vorname: 'Stefan', seit: 'heute, 14:02', seitKurz: '14:02' };

/** Eine Bestätigung, wie sie `bestaetigungAusstellen` liefert (Form genügt, der Test rendert nur). */
const SPERRE_FORMULAR = { bis: '1790000000000', token: 'a'.repeat(43) };

/** Detailseite mit übernommenem Vorgang (COPI-85): Band mit „Zurückgeben", Marke in der Liste, Hinweis nach der Aktion. */
const MODUL_DETAIL_GESPERRT = {
  titel: 'Familie Brandt – Buchungsanfrage',
  nav: navBeispiel('module'),
  kennung: 'anfragen',
  id: 'brandt',
  verfuegbar: true,
  zeilen: [
    { id: 'brandt', titel: 'Familie Brandt – Buchungsanfrage', status: { farbe: 'gelb', wort: 'Achtung' }, aktualisiertAm: '13:48', href: '/module/anfragen/brandt', sperre: SPERRE_MARKE },
    { id: 'vogt', titel: 'Lena Vogt', status: { farbe: 'gruen', wort: 'Läuft' }, aktualisiertAm: '09:30', href: '/module/anfragen/vogt', sperre: undefined },
  ],
  felder: [{ label: 'Gast', art: 'text', wert: 'Familie Brandt' }],
  uebernahme: {
    sperre: SPERRE_MARKE,
    uebernehmen: undefined,
    zurueckgeben: { href: '/module/anfragen/brandt/zurueckgeben', ...SPERRE_FORMULAR },
    hinweis: 'Dieser Vorgang wurde bereits von Stefan <b>Jacomeit</b> übernommen.',
  },
};

/** Dieselbe Seite, Vorgang frei: Knopf „Übernehmen" mit Hinweis. */
const MODUL_DETAIL_FREI = {
  ...MODUL_DETAIL_GESPERRT,
  zeilen: MODUL_DETAIL_GESPERRT.zeilen.map((zeile) => ({ ...zeile, sperre: undefined })),
  uebernahme: { sperre: undefined, uebernehmen: { href: '/module/anfragen/brandt/uebernehmen', ...SPERRE_FORMULAR }, zurueckgeben: undefined, hinweis: undefined },
};

/** Die Seite Agenten (COPI-38), Kundensicht: Rolle und Grenzen, weder Kennung noch Version. */
const AGENTEN_KUNDE = {
  titel: 'Agenten',
  sicht: 'kunde',
  nav: navBeispiel('agenten'),
  agenten: {
    stand: 'gemeldet vor 5 Minuten',
    karten: [
      { rolle: 'Rechnungs-Agent', grenzen: [{ name: 'Betrag je Rechnung', wert: '5.000' }, { name: 'darf löschen', wert: 'Nein' }], href: '/agenten/0000000000000001' },
      { rolle: 'Reinigungs-Agent', grenzen: [], href: '/agenten/0000000000000002' },
    ],
  },
};

/** Dieselbe Seite in der Betreuersicht: dazu Kennung und Version. */
const AGENTEN_BETREUER = {
  titel: 'Agenten',
  sicht: 'betreuer',
  nav: navBeispiel('agenten'),
  agenten: {
    stand: 'gemeldet vor 5 Minuten',
    karten: [
      { rolle: 'Rechnungs-Agent', kennung: 'rechnung', version: '2.3.1', grenzen: [{ name: 'Betrag je Rechnung', wert: '5.000' }], href: '/agenten/0000000000000001' },
      { rolle: 'Reinigungs-Agent', kennung: 'reinigung', version: '1.0.0', grenzen: [], href: '/agenten/0000000000000002' },
    ],
  },
};

/** Kein Inventar gemeldet. */
const AGENTEN_LEER = { titel: 'Agenten', sicht: 'kunde', nav: navBeispiel('agenten'), agenten: { stand: undefined, karten: [] } };

/** Die Seite Zeitplan (COPI-38): alle Takte, je Agent unter seiner Rolle. */
const ZEITPLAN = {
  titel: 'Zeitplan',
  nav: navBeispiel('zeitplan'),
  zeitplan: {
    stand: 'gemeldet vor 5 Minuten',
    gruppen: [
      { agent: 'Buchungs-Agent', takte: [{ name: 'Anfragen prüfen', wann: 'alle 5 Minuten' }] },
      { agent: 'Rechnungs-Agent', takte: [{ name: 'Rechnungslauf', wann: 'täglich 07:00' }, { name: 'Mahnungen', wann: 'montags 09:00' }] },
    ],
  },
};

/** Die Seite Benutzer (COPI-45): ein aktives eigenes Konto, eines mit offener Einrichtung, eine offene Einladung. */
const BENUTZER = {
  titel: 'Benutzer',
  nav: navBeispiel('benutzer'),
  einladen: true,
  liste: {
    konten: [
      {
        name: 'Stefan',
        email: 'stefan@example.org',
        rolle: 'Betreuer',
        stand: { text: 'aktiv', farbe: 'gruen', hinweis: undefined },
        faktor: 'Passkey und Authenticator-App',
        angelegt: 'vor 20 Tagen',
        zuletzt: 'vor 3 Minuten',
        selbst: true,
      },
      {
        name: 'Lena',
        email: 'lena@example.org',
        rolle: 'Mitarbeiter',
        stand: { text: 'Einrichtung offen', farbe: 'gelb', hinweis: 'verfällt in 1 Tag' },
        faktor: 'keiner',
        angelegt: 'vor 1 Tag',
        zuletzt: 'noch nie',
        selbst: false,
      },
    ],
    einladungen: [{ email: 'neu@example.org', rolle: 'Mitarbeiter', von: 'Stefan', ablauf: 'läuft ab in 2 Stunden' }],
  },
};

/** Noch niemand außer … niemandem, keine Einladung, und wer ansieht, darf nicht einladen. */
const BENUTZER_LEER = { titel: 'Benutzer', nav: navBeispiel('benutzer'), einladen: false, liste: { konten: [], einladungen: [] } };

/** Ein Konto bearbeiten (COPI-46): frisch angemeldet, alle vier Aktionen. */
const BENUTZER_BEARBEITEN = {
  titel: 'Konto bearbeiten',
  nav: navBeispiel('benutzer'),
  pfad: '/benutzer/konto-7',
  konto: BENUTZER.liste.konten[1],
  aktionen: ['name', 'email', 'rolle', 'entfernen', 'zuruecksetzen'],
  rollen: [{ wert: 'betriebs_admin', name: 'Betriebs-Admin' }],
  frisch: true,
  erledigt: 'Der Name ist geändert.',
  offeneAdresse: { email: 'lena.neu@example.org', ablauf: 'läuft ab in 23 Stunden' },
};

/** Es gibt ein Inventar, aber keinen einzigen Takt. */
const ZEITPLAN_OHNE_TAKTE = { titel: 'Zeitplan', nav: navBeispiel('zeitplan'), zeitplan: { stand: 'gemeldet vor 5 Minuten', gruppen: [] } };

/** Kein Inventar gemeldet. */
const ZEITPLAN_LEER = { titel: 'Zeitplan', nav: navBeispiel('zeitplan'), zeitplan: { stand: undefined, gruppen: [] } };

/** Einstellungen (COPI-39), Betreuersicht: Version, Digests, Marke, eine ausbleibende Versions-Wache. */
const EINSTELLUNGEN_BETREUER = {
  titel: 'Einstellungen',
  nav: navBeispiel('einstellungen'),
  ansicht: 'Betreuer',
  versionen: {
    sicht: 'betreuer',
    bereiche: [
      {
        name: 'Cockpit',
        marke: { text: 'Update verfügbar', farbe: 'gelb' },
        version: '1.4.0+0123456',
        digest: `sha256:${'9f'.repeat(32)}`,
        gestartet: 'vor 3 Tagen',
        sollDigest: undefined,
        verfuegbar: 'verfügbar: 1.5.0',
        wache: { text: 'zuletzt geprüft vor 12 Tagen', ueberfaellig: true },
        antrag: { art: 'beantragen' },
      },
    ],
    // Je ein Modul in jedem Zweig der Karte (COPI-106): beantragen nach Fehlschlag, zurückziehen, ohne Herkunft.
    module: [
      {
        kennung: 'kommunikation',
        name: 'Modul · Kommunikation',
        marke: { text: 'Update fehlgeschlagen', farbe: 'rot' },
        version: '4 · aktiv seit vor 2 Tagen',
        herkunft: 'bibliothek@3f2a9c1:agents/assistent.yaml',
        sollCommit: undefined,
        verfuegbar: 'Commit 8d41e07 · Block und View geändert',
        wache: { text: 'zuletzt geprüft vor 12 Minuten', ueberfaellig: false },
        antrag: { art: 'beantragen' },
        letzterAntrag: {
          nummer: 13,
          stand: 'fehlgeschlagen',
          haengt: false,
          zielCommit: '8d41e07',
          herkunftVorher: 'bibliothek@3f2a9c1:agents/assistent.yaml',
          grund: 'Fachmigration 0005 fehlt',
          stufen: [{ name: 'Beantragt', wann: 'vor 1 Stunde' }],
        },
      },
      {
        kennung: 'ki-verbrauch',
        name: 'Modul · KI-Verbrauch',
        marke: { text: 'Update angefragt', farbe: 'info' },
        version: '2 · aktiv seit vor 3 Tagen',
        herkunft: 'bibliothek@b71e0d2:module/ki-verbrauch.cockpit.yaml',
        sollCommit: 'c0ffee1',
        verfuegbar: 'Commit c0ffee1',
        wache: { text: 'zuletzt geprüft vor 12 Minuten', ueberfaellig: false },
        antrag: { art: 'zurueckziehen', id: 14, satz: 'Antrag Nr. 14 wartet auf die Freigabe.' },
        letzterAntrag: undefined,
      },
      {
        kennung: 'server-zustand',
        name: 'Modul · Server-Zustand',
        marke: undefined,
        version: '1 · aktiv seit vor 6 Tagen',
        herkunft: undefined,
        sollCommit: undefined,
        verfuegbar: undefined,
        wache: { text: 'noch nicht gemeldet', ueberfaellig: false },
        antrag: { art: 'ohne-herkunft' },
        letzterAntrag: undefined,
      },
    ],
  },
  antrag: { moeglich: true, fehler: 'Bitte den vollständigen Digest angeben.', eingabe: 'latest' },
  // Freigabe von Updates (COPI-141): Cockpit direkt, Module mit Rückfrage.
  freigabe: {
    hinweis: { art: 'ok', text: 'Gespeichert.' },
    modi: [
      { wert: 'rueckfrage', text: 'Rückfrage in Slack' },
      { wert: 'direkt', text: 'Direkt installieren' },
    ],
    bereiche: [
      { bereich: 'cockpit', name: 'Cockpit', modus: 'direkt', text: 'Direkt installieren', herkunft: 'von Stefan, heute 10:15' },
      { bereich: 'module', name: 'Module', modus: 'rueckfrage', text: 'Rückfrage in Slack', herkunft: undefined },
    ],
  },
  // Web Push eingerichtet, ein Gerät (COPI-59).
  push: {
    eingerichtet: true,
    oeffentlich: 'B'.repeat(87),
    geraete: [{ id: 3, name: 'Chrome, Edge oder Android', seit: '10:15', erreicht: 'noch nie erreicht' }],
    hinweis: undefined,
  },
};

/** Einstellungen, Kundensicht: ein Satz je Bereich. */
const EINSTELLUNGEN_KUNDE = {
  titel: 'Einstellungen',
  nav: navBeispiel('einstellungen'),
  ansicht: 'Betriebs-Admin',
  versionen: { sicht: 'kunde', bereiche: [{ name: 'Cockpit', satz: 'Aktuell.' }] },
  antrag: { moeglich: false },
  // Ohne VAPID-Paar auf der Instanz (COPI-59).
  push: { eingerichtet: false, oeffentlich: undefined, geraete: [], hinweis: undefined },
};

/** Die Bestätigung des Update-Antrags (COPI-40): beide Digests vollständig, dazu die signierte Bestätigung. */
const UPDATE_BESTAETIGEN = {
  titel: 'Update beantragen',
  nav: navBeispiel('einstellungen'),
  vorher: `sha256:${'9f'.repeat(32)}`,
  ziel: `sha256:${'e7'.repeat(32)}`,
  bis: '1790000000000',
  token: 'A'.repeat(43),
};

/** Die Bestätigung vor „Direkt installieren" (COPI-141). */
const FREIGABE_BESTAETIGEN = {
  titel: 'Direkt installieren',
  nav: navBeispiel('einstellungen'),
  bereich: 'module',
  name: 'Module',
};

/** Die Bestätigung eines Modul-Antrags (COPI-106): Herkunft davor und Ziel-Commit, dazu die signierte Bestätigung. */
const MODUL_UPDATE_BESTAETIGEN = {
  titel: 'Modul-Update beantragen',
  nav: navBeispiel('einstellungen'),
  modul: { kennung: 'kommunikation', name: 'Kommunikation', version: 4 },
  vorher: 'bibliothek@3f2a9c1:agents/assistent.yaml',
  ziel: '8d41e07',
  bis: '1790000000000',
  token: 'A'.repeat(43),
};

/** Die Warnseite vor einem Anhang (COPI-110), im Zweig mit starker Warnung, Pflicht-Haken und Hinweis. */
const MODUL_ANHANG = {
  titel: 'Anhang herunterladen',
  nav: navBeispiel('module'),
  unterzeile: 'Kommunikation · Relaunch unserer Website',
  zurueck: { href: '/module/kommunikation/1', ziel: 'Vorgang' },
  hinweis: 'Die Bestätigung war abgelaufen.',
  datei: { name: 'Angebot_alt.pdf', meta: 'Inhalt: ZIP-Archiv · 88 KB', klasse: 'warnung', symbol: 'archiv' },
  werte: [
    { label: 'Typ laut Absender', wert: 'application/pdf', code: false },
    { label: 'SHA-256', wert: '0'.repeat(64), code: true },
  ],
  stark: { titel: 'Die Endung passt nicht zum Inhalt.', text: 'Der Name sagt „PDF“, der Inhalt ist aber „ZIP-Archiv“.' },
  formular: { action: '/module/kommunikation/1/anhang/4', bis: '1790000000000', token: 'A'.repeat(43), sha256: '0'.repeat(64) },
};

/**
 * Pro Seite Beispieldaten, mit denen möglichst viele Zweige rendern (Fehler, Passkey, Rollen).
 * Wer ein Template ergänzt, muss es hier eintragen — der Test unten schlägt sonst an.
 */
const DATEN: Readonly<Record<string, Record<string, unknown>>> = {
  'agenten.eta': AGENTEN_KUNDE,
  'agent-detail.eta': AGENT_DETAIL,
  'benutzer.eta': BENUTZER,
  'benutzer-bearbeiten.eta': BENUTZER_BEARBEITEN,
  'benutzer-bestaetigen.eta': {
    titel: 'Bitte bestätigen',
    nav: navBeispiel('benutzer'),
    pfad: '/benutzer/konto-7',
    aktion: 'rolle',
    wert: 'betriebs_admin',
    konto: { name: 'Lena', email: 'lena@example.org', rolle: 'Mitarbeiter' },
    neueRolle: 'Betriebs-Admin',
    bis: '1790000000000',
    token: 'A'.repeat(43),
  },
  'benutzer-zurueckgesetzt.eta': {
    titel: 'Zweiter Faktor zurückgesetzt',
    nav: navBeispiel('benutzer'),
    pfad: '/benutzer/konto-7',
    name: 'Lena',
    link: `https://fewotest.example.com/zugang-wiederherstellen/${'B'.repeat(43)}`,
    gueltigStunden: 3,
  },
  'email-bestaetigen.eta': { titel: 'E-Mail-Adresse bestätigen', token: 'A'.repeat(43), email: 'lena.neu@example.org', fehler: 'Diese Adresse gehört inzwischen zu einem anderen Konto.' },
  'email-bestaetigt.eta': { titel: 'E-Mail-Adresse bestätigen', email: 'lena.neu@example.org' },
  'benutzer-hinweis.eta': { titel: 'Nicht geändert', nav: navBeispiel('benutzer'), text: 'Es wurde nichts geändert.', zurueck: '/benutzer/konto-7' },
  'anmelden.eta': { titel: 'Anmelden', fehler: 'Anmeldung nicht möglich.' },
  'anmelden-code.eta': { titel: 'Zweiter Faktor', fehler: 'Code falsch.', passkeyAngeboten: true },
  'einladung.eta': {
    titel: 'Nutzer einladen',
    nav: navBeispiel('einladung'),
    fehler: 'Adresse ungültig.',
    erfolgFuer: 'kunde@example.org',
    erfolgRolle: 'Betriebs-Admin',
    gueltigStunden: 3,
    rollen: [
      { wert: 'admin', name: 'Betriebs-Admin', vorgabe: true },
      { wert: 'mitarbeiter', name: 'Mitarbeiter', vorgabe: false },
    ],
  },
  'einladung-einloesen.eta': {
    titel: 'Zugang einrichten',
    fehler: 'Passwörter stimmen nicht überein.',
    email: 'kunde@example.org',
    name: 'Kunde',
    mindestlaenge: 12,
    token: 'beispiel-token',
  },
  'einladung-fehler.eta': { titel: 'Einrichtung fehlgeschlagen' },
  'einstellungen.eta': EINSTELLUNGEN_BETREUER,
  'erststart.eta': {
    titel: 'Cockpit einrichten',
    fehler: 'Passwort zu kurz.',
    mindestlaenge: 12,
    token: 'beispiel-token',
  },
  'erststart-fehler.eta': { titel: 'Einrichtung fehlgeschlagen' },
  'meldungen.eta': {
    titel: 'Meldungen',
    nav: navBeispiel('meldungen'),
    filter: { art: 'gelb', suche: 'Zustellung', artWert: 'warnung' },
    chips: [
      { text: 'Alle', href: '/meldungen?q=Zustellung', aktuell: false },
      { text: 'Warnung', href: '/meldungen?art=warnung&q=Zustellung', aktuell: true },
    ],
    gefiltert: true,
    meldungen: [
      { titel: 'Zustellung fehlgeschlagen.', farbe: 'gelb', zeit: 'vor 2 Std.', meta: 'vor 2 Std. · Rechnungs-Agent', intern: false },
      { titel: 'postgres beendet', farbe: 'rot', zeit: 'vor 3 Min.', meta: 'vor 3 Min. · container', intern: true },
    ],
  },
  'mehr.eta': { titel: 'Mehr', nav: navBeispiel('mehr') },
  // Freigabe-Inbox (COPI-139)
  'freigaben.eta': {
    titel: 'Freigaben',
    nav: navBeispiel('freigaben'),
    stand: 'heute, 09:50',
    hinweis: undefined,
    kennzahlen: [
      { repo: 'beispiel/projekt', beitraege: '12', beantwortet: '9', unbeantwortet: '3', median: '4,3', maximum: '30,0', stars: '1.234', forks: '56', stand: '29.10.26, 07:00' },
    ],
    zeilen: [
      { id: 'e1', href: '/freigaben/e1', quelleTyp: 'GitHub', quelle: 'beispiel/projekt#42', titel: 'Absturz', einordnung: 'Fehlermeldung', alter: 'vor 2 Std.', agent: 'Repo-Wache', status: 'offen', offen: true, adresseText: undefined, adresseLink: undefined },
    ],
  },
  'freigabe-detail.eta': {
    titel: 'Freigabe',
    nav: navBeispiel('freigaben'),
    zurueck: { href: '/freigaben', ziel: 'Freigaben' },
    hinweis: undefined,
    detail: {
      id: 'e1', href: '/freigaben/e1', quelleTyp: 'GitHub', quelle: 'beispiel/projekt#42', titel: 'Absturz', einordnung: 'Fehlermeldung', alter: 'vor 2 Std.', agent: 'Repo-Wache', status: 'offen', offen: true,
      // Ohne Link: die Wache gegen Fremdverweise prüft das Beispiel; den ausdrücklich geöffneten Link der Quelle prüft `freigaben.test.ts`.
      adresseText: 'https://github.com/beispiel/projekt/issues/42', adresseLink: undefined,
      deutsch: 'App stürzt ab', deutschIstOriginal: false, original: 'App crashes', entwurf: 'Thanks', entwurfDe: 'Danke',
    },
  },
  'module.eta': {
    titel: 'Module',
    nav: navBeispiel('module'),
    module: [
      { kennung: 'buchungen', menuename: 'Buchungen', version: 2 },
      { kennung: 'server-zustand', menuename: 'Server & Dienste', version: 1 },
    ],
  },
  'modul.eta': {
    titel: 'Buchungen',
    nav: navBeispiel('module'),
    kennung: 'buchungen',
    verfuegbar: true,
    zeilen: [
      { id: '1', titel: 'Familie Brandt', status: { farbe: 'rot', wort: 'Störung' }, aktualisiertAm: '13:58', href: '/module/buchungen/1' },
      { id: '2', titel: 'Lena Vogt', status: { farbe: 'unbekannt', wort: 'Storniert' }, aktualisiertAm: 'vor 2 Tagen', href: '/module/buchungen/2' },
    ],
  },
  'modul-kennzahlen.eta': {
    titel: 'KI-Verbrauch',
    nav: navBeispiel('module'),
    versionText: 'Version 1 · eingespielt am 30.09.2026',
    stand: 'heute, 16:10',
    krume: [{ text: 'Module', href: '/module' }],
    verfuegbar: true,
    seite: kennzahlenSeite(
      'ki-verbrauch',
      KENNZAHLEN_BLOCK,
      zeitraumAus('7', '2026-09-30'),
      undefined,
      {
        tage: KENNZAHLEN_TAGE,
        vergleich: 18,
        ungefiltert: null,
        aufteilungen: [
          {
            spalte: 'projekt',
            label: 'Je Projekt',
            verlinkt: true,
            gruppen: [
              { schluessel: 'JAC', wert: 22.5 },
              { schluessel: null, wert: 10 },
            ],
          },
        ],
      },
      KENNZAHLEN_HINWEISE,
    ),
  },
  'modul-detail.eta': {
    titel: 'Familie Brandt',
    nav: navBeispiel('module'),
    kennung: 'buchungen',
    id: '1',
    verfuegbar: true,
    zeilen: [
      { id: '1', titel: 'Familie Brandt', status: { farbe: 'rot', wort: 'Störung' }, aktualisiertAm: '13:58', href: '/module/buchungen/1' },
      { id: '2', titel: 'Lena Vogt', status: { farbe: 'unbekannt', wort: 'Storniert' }, aktualisiertAm: 'vor 2 Tagen', href: '/module/buchungen/2' },
    ],
    felder: [
      { label: 'Status', art: 'status', status: { farbe: 'rot', wort: 'Störung' } },
      { label: 'Zeitraum', art: 'text', wert: '12.–19. Oktober 2026' },
      { label: 'Objekt', art: 'text', wert: 'Ferienhaus Dünenblick' },
      { label: 'Notiz', art: 'text', wert: '—' },
    ],
    // Entscheiden (COPI-91): geltende Entscheidung, Entwurf zum Kopieren, Optionen und Zurücknehmen.
    entscheidung: {
      titel: 'Deine Entscheidung',
      hinweis: 'Jede Entscheidung wird protokolliert.',
      geltend: { kurz: 'Interessant', von: 'Stefan Jacomeit', am: '14:02', wert: 'interessant' },
      entwurf: { titel: 'Bewerbungsentwurf', text: 'Hallo,\nich bewerbe mich.', fassung: 1, hinweis: 'Assistent schickt nichts selbst ab.' },
      optionen: [{ label: 'Beworben', primaer: true, wert: 'beworben', erwartet: 'interessant', href: '/module/buchungen/1/entscheiden', bis: '1790000000000', token: 'A'.repeat(43) }],
      zuruecknehmen: { entscheidung: '7', href: '/module/buchungen/1/entscheidung-zuruecknehmen', bis: '1790000000000', token: 'A'.repeat(43) },
      meldung: undefined,
    },
    // Anhänge (COPI-110): jede Klasse einmal, ladbare als Link auf die Warnseite.
    anhaenge: [
      { id: '1', name: 'Anforderungen.pdf', klasse: 'normal', meta: 'PDF · 412 KB', grund: undefined, href: '/module/buchungen/1/anhang/1', symbol: 'datei' },
      { id: '2', name: 'Bestand.zip', klasse: 'warnung', meta: 'ZIP-Archiv · 6,8 MB', grund: 'Archiv, Inhalt nicht geprüft', href: '/module/buchungen/1/anhang/2', symbol: 'archiv' },
      { id: '3', name: 'Rechnung.pdf.exe', klasse: 'gesperrt', meta: 'Programm (Windows) · 1,3 MB', grund: 'Gesperrt, liegt im Postfach', href: undefined, symbol: 'schloss' },
      { id: '4', name: 'Video.mov', klasse: 'postfach', meta: 'Video · 48,2 MB', grund: 'Zu groß fürs Cockpit, liegt im Postfach', href: undefined, symbol: 'posteingang' },
    ],
  },
  'chat.eta': {
    titel: 'Assistent',
    nav: navBeispiel('chat'),
    pfad: '/chat',
    ki: true,
    angebunden: true,
    antwort: 'ueberfaellig',
    strom: '/chat/ereignisse?seit=3',
    kanaele: [
      { name: 'Assistent', href: '/chat', aktuell: true, vorschau: 'Verstanden.', ungelesen: 0 },
      { name: 'Team', href: '/chat/team', aktuell: false, vorschau: undefined, ungelesen: 2 },
    ],
    postfaecher: [{ name: 'Kommunikation', kurz: 'Mails', href: '/chat/postfach/kommunikation', aktuell: false, ungelesen: 1 }],
    nachrichten: [
      { id: 1, eigen: true, absender: 'Du', ki: false, zeit: '10:15', zeitIso: '2026-09-23T08:15:00.000Z', inhalt: 'Frage', dringend: false },
      { id: 2, eigen: false, absender: 'Koordinator', ki: true, zeit: '10:16', zeitIso: '2026-09-23T08:16:00.000Z', inhalt: 'Antwort', dringend: true },
      { id: 3, eigen: false, absender: 'Bert', ki: false, zeit: '10:17', zeitIso: '2026-09-23T08:17:00.000Z', inhalt: undefined, dringend: false },
    ],
    aeltere: '/chat?vor=1',
    neuere: undefined,
    fehler: 'Bitte eine Nachricht eingeben.',
    eingabe: '',
    hoechstens: 4000,
  },
  'nicht-gefunden.eta': { titel: 'Nicht gefunden' },
  'update-bestaetigen.eta': UPDATE_BESTAETIGEN,
  'modul-update-bestaetigen.eta': MODUL_UPDATE_BESTAETIGEN,
  'freigabe-bestaetigen.eta': FREIGABE_BESTAETIGEN,
  'modul-anhang.eta': MODUL_ANHANG,
  'update-hinweis.eta': { titel: 'Nicht erlaubt', nav: navBeispiel('einstellungen'), text: 'Diese Aktion ist für dieses Konto nicht erlaubt.' },
  'passkey-fertig.eta': { titel: 'Passkey eingerichtet', ersatzcodes: ['abcde-fghij', 'klmno-pqrst'] },
  // Anmeldung & Sicherheit (COPI-94).
  'sicherheit.eta': {
    titel: 'Anmeldung & Sicherheit',
    nav: navBeispiel('sicherheit'),
    bestaetigt: 'Bestätigt mit einem Ersatzcode. Änderungen sind bis 14:42 Uhr möglich, danach fragt das Cockpit erneut.',
    hinweis: 'Passkey hinzugefügt. An Ihre E-Mail-Adresse ging ein Hinweis.',
    passkeys: [
      { id: 'cGFzc2tleS0x', name: 'iMac', angelegt: '21.09.2026' },
      { id: 'cGFzc2tleS0y', name: 'iPhone', angelegt: '03.10.2026' },
    ],
    passkeyMoeglich: true,
    einziger: false,
    totp: false,
    ersatzcodes: 6,
    verlauf: [{ zeit: '14:34', text: 'Passkey hinzugefügt' }],
  },
  'sicherheit-bestaetigen.eta': {
    titel: 'Bestätigen',
    nav: navBeispiel('sicherheit'),
    weiter: '/sicherheit/passkey',
    anlass: 'Sie möchten einen Passkey hinzufügen.',
    passkeyMoeglich: true,
    fehler: 'Die Bestätigung ist nicht gelungen.',
  },
  'sicherheit-passkey.eta': { titel: 'Passkey hinzufügen', nav: navBeispiel('sicherheit'), bestaetigt: 'Bestätigt mit einem Passkey.', fehler: 'Der Passkey konnte nicht angelegt werden.' },
  'sicherheit-frage.eta': {
    titel: 'Entfernen',
    nav: navBeispiel('sicherheit'),
    bestaetigt: 'Bestätigt mit einem Passkey.',
    frage: 'Passkey „iMac“ entfernen?',
    saetze: ['Danach meldet sich dieses Gerät nicht mehr mit diesem Passkey an.'],
    aktion: '/sicherheit/passkey/cGFzc2tleS0x/entfernen',
    knopf: 'Entfernen',
    gefahr: true,
  },
  'sicherheit-codes.eta': { titel: 'Neue Ersatzcodes', nav: navBeispiel('sicherheit'), ersatzcodes: ['abcde-fghij', 'klmno-pqrst'] },
  'sicherheit-totp.eta': { titel: 'Authenticator-App einrichten', nav: navBeispiel('sicherheit'), bestaetigt: 'Bestätigt mit einem Passkey.', fehler: 'Das Passwort ist nicht korrekt.' },
  'uebersicht.eta': UEBERSICHT_KUNDE,
  'zeitplan.eta': ZEITPLAN,
  'zugang-wiederherstellen.eta': {
    titel: 'Zugang wiederherstellen',
    fehler: 'Passwort zu kurz.',
    email: 'kunde@example.org',
    mindestlaenge: 12,
    token: 'beispiel-token',
  },
  'zwei-faktor.eta': { titel: 'Zweiten Faktor einrichten', fehler: 'Passwort falsch.', passkeyAngeboten: true },
  'zwei-faktor-code.eta': {
    titel: 'Zweiten Faktor bestätigen',
    qrSvg: QR_SVG,
    geheimnis: 'JBSWY3DPEHPK3PXP',
    totpUri: 'otpauth://totp/Cockpit:kunde@example.org?secret=JBSWY3DPEHPK3PXP',
    ersatzcodes: ['abcde-fghij', 'klmno-pqrst'],
  },
};

describe('Architektur: keine Seite am Layout vorbei', () => {
  it('kennt zu jedem Template Beispieldaten für den Smoke-Test (und keine überzähligen)', () => {
    expect(Object.keys(DATEN).sort()).toEqual([...seitenDateien].sort());
  });

  it.each(seitenDateien)('%s ruft das Layout auf und schreibt kein eigenes Dokument', (datei) => {
    const quelle = lesen(path.join(VIEWS, datei));

    expect(quelle, 'Layout-Aufruf als Erstes').toMatch(/^\s*<%\s*layout\(\s*'layout'/);
    for (const verboten of [/<!doctype/i, /<html[\s>]/i, /<head[\s>]/i, /<body[\s>]/i, /<title[\s>]/i, /<meta[\s>]/i, /<main[\s>]/i, /<link[\s>]/i]) {
      expect(quelle, `${datei} enthält ${String(verboten)}`).not.toMatch(verboten);
    }
  });

  it.each([...seitenDateien.map((d) => path.join(VIEWS, d)), ...partialDateien.map((d) => path.join(PARTIALS, d))])(
    '%s enthält keine Inline-Stile und keine Inline-Skripte',
    (pfad) => {
      const quelle = lesen(pfad);

      expect(quelle).not.toMatch(/\sstyle\s*=/i);
      expect(quelle).not.toMatch(/<style[\s>]/i);
      expect(quelle).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(quelle).not.toMatch(/\son[a-z]+\s*=\s*["']/i); // onclick=… und Verwandte
      expect(quelle).not.toMatch(/javascript:/i);
    },
  );

  it('hat Partials für Kopf, Hinweisbox und Formularfeld', () => {
    expect(partialDateien).toEqual(expect.arrayContaining(['kopf.eta', 'hinweis.eta', 'feld.eta']));
    for (const datei of partialDateien) {
      const quelle = lesen(path.join(PARTIALS, datei));
      expect(quelle, `${datei} ist ein Baustein, kein Dokument`).not.toMatch(/<html[\s>]|<head[\s>]|<body[\s>]|<main[\s>]/i);
    }
  });

  it('hat im Layout genau einmal: lang="de", Viewport, Titel, Stylesheet, <main>', () => {
    const layout = lesen(path.join(VIEWS, 'layout.eta'));
    const zaehle = (muster: RegExp): number => (layout.match(muster) ?? []).length;

    expect(zaehle(/<html lang="de"/g)).toBe(1);
    // Wörtlich so: der Dark-Mode-Schalter setzt `data-theme` genau hier ein (src/server/darstellung.ts, COPI-43).
    expect(layout).toContain('<html lang="de">');
    expect(zaehle(/<meta name="viewport" content="width=device-width, initial-scale=1"/g)).toBe(1);
    expect(zaehle(/<title>/g)).toBe(1);
    // Zwei Zweige, je ein <main>: mit App-Rahmen (angemeldet) und mit Karte (ohne Konto). Pro Seite prüft der Smoke-Test genau eins.
    expect(zaehle(/<main[\s>]/g)).toBe(2);
    expect(zaehle(/<link rel="stylesheet" href="<%= it\.stylesheet %>"/g)).toBe(1);
    expect(layout).toMatch(/<meta name="color-scheme" content="light dark"/);
    expect(zaehle(/<%~ it\.body %>/g)).toBe(2); // der Seiteninhalt kommt ungeprüft aus dem Template, nicht aus Nutzereingaben
  });
});

describe('Smoke: jedes Template rendert mit dem Layout', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({ nodeEnv: 'test' });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(seitenDateien)('%s: Sprache, Viewport, Titel, Stylesheet, genau ein <main>', async (datei) => {
    const daten = DATEN[datei] ?? {};
    const html = await app.render(datei, daten);

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="de"');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"');
    // Der Titel steht maskiert im HTML („Anmeldung & Sicherheit", COPI-94).
    expect(html).toContain(`<title>${String(daten.titel).replaceAll('&', '&amp;')} · Cockpit</title>`);
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/cockpit\.[0-9a-f]{16}\.css"/);
    expect((html.match(/<main[\s>]/g) ?? []).length).toBe(1);
    expect((html.match(/<h1[\s>]/g) ?? []).length, 'genau eine Hauptüberschrift').toBe(1);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });

  it.each([
    ['Betreuersicht', UEBERSICHT_BETREUER],
    ['Leerzustand', UEBERSICHT_LEER],
    ['Dashboard (COPI-81)', UEBERSICHT_DASHBOARD],
  ])('uebersicht.eta rendert auch als %s mit dem Layout, ohne Inline-Stil und ohne Skript', async (_name, daten) => {
    const html = await app.render('uebersicht.eta', daten);

    expect(html).toMatch(/^<!doctype html>/i);
    expect((html.match(/<main[\s>]/g) ?? []).length).toBe(1);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });

  it('modul-detail.eta zeigt eine Übernahme als Band mit Schloss, „Zurückgeben" und Marke — escaped, ohne Inline-Stil (COPI-85)', async () => {
    const html = await app.render('modul-detail.eta', MODUL_DETAIL_GESPERRT);

    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).toMatch(/<div class="vorgang-band" role="status">/);
    expect(html).toContain('Von Stefan &lt;b&gt;Jacomeit&lt;/b&gt; übernommen seit heute, 14:02');
    expect(html).not.toContain('<b>Jacomeit</b>');
    expect(html).toContain('Agenten antworten in diesem Vorgang nicht, bis er zurückgegeben wird.');
    expect(html).toMatch(/<form method="post" action="\/module\/anfragen\/brandt\/zurueckgeben" class="vorgang-band-form">/);
    expect(html).toContain(`<input type="hidden" name="token" value="${'a'.repeat(43)}">`);
    expect(html).toMatch(/<button type="submit" class="knopf knopf-sekundaer">Zurückgeben<\/button>/);
    expect(html).not.toContain('/uebernehmen');
    // Marke in der Liste, nur an der übernommenen Zeile.
    expect((html.match(/class="sperr-marke"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<span class="sperr-marke"><svg class="symbol"[^>]*>.*?<\/svg>\s*übernommen · Stefan<\/span>/);
    expect(html).toContain('bereits von Stefan &lt;b&gt;Jacomeit&lt;/b&gt; übernommen.');
  });

  it('modul-detail.eta zeigt ohne Recht zum Zurückgeben das Band, aber keinen Knopf (COPI-85)', async () => {
    const html = await app.render('modul-detail.eta', { ...MODUL_DETAIL_GESPERRT, uebernahme: { ...MODUL_DETAIL_GESPERRT.uebernahme, zurueckgeben: undefined, hinweis: undefined } });

    expect(html).toContain('class="vorgang-band"');
    expect(html).not.toContain('vorgang-band-form');
    expect(html).not.toContain('Zurückgeben</button>');
  });

  it('modul-detail.eta bietet einen freien Vorgang mit „Übernehmen" und Hinweis an, ohne Band und ohne Marke (COPI-85)', async () => {
    const html = await app.render('modul-detail.eta', MODUL_DETAIL_FREI);

    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toContain('vorgang-band');
    expect(html).not.toContain('sperr-marke');
    expect(html).toMatch(/<form method="post" action="\/module\/anfragen\/brandt\/uebernehmen" class="vorgang-uebernahme-form">/);
    expect(html).toMatch(/<button type="submit" class="knopf knopf-primaer knopf-mit-symbol"><svg class="symbol"[^>]*>.*?<\/svg>\s*Übernehmen<\/button>/);
    expect(html).toContain('Diesen Vorgang bearbeiten gerade die Agenten des Moduls. Mit „Übernehmen“ antworten Agenten hier nicht mehr, bis Sie ihn zurückgeben. Die Übernahme wird protokolliert.');
    expect(html).not.toContain('Buchungs-Agent');
  });

  it('uebersicht.eta zeigt die Marke auf der übernommenen Dashboard-Karte, nur dort (COPI-85)', async () => {
    const html = await app.render('uebersicht.eta', UEBERSICHT_DASHBOARD);

    expect((html.match(/class="sperr-marke"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<\/svg>\s*übernommen · Stefan<\/span>/);
  });

  it('modul.eta zeigt die Marke auf der Kachel mit Zeit (COPI-85)', async () => {
    const [erste, ...rest] = KACHELN_ALLE;
    const kacheln = erste === undefined ? [] : [{ ...erste, sperre: SPERRE_MARKE }, ...rest];
    const html = await app.render('modul.eta', { ...MODUL_KACHELN, kacheln });

    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect((html.match(/class="sperr-marke"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<\/svg>\s*übernommen · Stefan · seit 14:02<\/span>/);
  });

  it('modul.eta rendert die Kacheln (COPI-82): Pfad, Chips mit Anzahl, Kürzel, Punkt + Wort, Band, Fußzeile', async () => {
    const html = await app.render('modul.eta', MODUL_KACHELN);

    expect(html).toMatch(/^<!doctype html>/i);
    expect((html.match(/<main[\s>]/g) ?? []).length).toBe(1);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    // Pfad über dem Titel, „Module" verlinkt.
    expect(html).toMatch(/<p class="seiten-krume">\s*<a href="\/module">Module<\/a>/);
    expect(html).toContain('Stand: heute, 09:50');
    // Chips mit Anzahl, der aktive („Alle") mit aria-current.
    expect(html).toMatch(/<a href="\/module\/server-zustand" class="modul-chip" aria-current="true">Alle · 6<\/a>/);
    expect(html).toContain('Störung · 1');
    expect(html).toContain('Achtung · 1');
    expect(html).toContain('Läuft · 4');
    expect(html).toContain('href="/module/server-zustand?status=rot"');
    // Eine Kachel: Kürzel, Titel, Punkt + Wort, das deklarierte Feld „Meldung", Band und Fußzeile.
    expect((html.match(/<li class="min-w-0">/g) ?? []).length).toBe(6);
    expect(html).toContain('<span class="dienst-kuerzel dienst-kuerzel-rot dienst-kuerzel-gross" aria-hidden="true">WE</span>');
    expect(html).toContain('<span class="dienst-status-wort dienst-status-wort-rot">');
    expect(html).toContain('<dt class="dienst-feld-label">Meldung</dt><dd class="dienst-feld-wert">Antwortet nicht.</dd>');
    expect(html).toContain('Letzte 7 Tage');
    expect(html).toContain('class="band band-kachel"');
    expect(html).toContain('Zuletzt gemeldet: 09:50');
    expect(html).toContain('<span class="dienst-fuss-details">Details</span>');
    expect(html).toContain('href="/module/server-zustand/web"');
  });

  it('gibt jeder angemeldeten Seite den App-Rahmen und jeder anderen die schmale Karte (COPI-43)', async () => {
    for (const datei of seitenDateien) {
      const html = await app.render(datei, DATEN[datei] ?? {});
      const angemeldet = 'nav' in (DATEN[datei] ?? {});

      expect(html, datei).toContain(`<main id="inhalt" class="${angemeldet ? 'app-inhalt' : 'karte'}">`);
      expect(html.includes('<aside class="rahmen">'), datei).toBe(angemeldet);
    }
  });

  describe('Agenten und Zeitplan (COPI-38)', () => {
    // Die Karten der Seite Agenten sind seit COPI-113 Links (`agent-verlinkt`), die des Zeitplans nicht.
    const karten = (html: string): number => (html.match(/<li class="agent( agent-verlinkt)?">/g) ?? []).length;

    it('zeigt in der Kundensicht Rolle und Grenzen, aber weder Kennung noch Version', async () => {
      const html = await app.render('agenten.eta', AGENTEN_KUNDE);

      expect(karten(html)).toBe(2);
      expect(html).toContain('<a href="/agenten/0000000000000001" class="agent-link">Rechnungs-Agent</a>');
      expect(html).toContain('<dt>Betrag je Rechnung</dt>');
      expect(html).toContain('<dd>5.000</dd>');
      expect(html).toContain('gemeldet vor 5 Minuten');
      expect(html).not.toContain('<code>');
      expect(html).not.toContain('Version');
    });

    it('zeigt in der Betreuersicht zusätzlich Kennung und Version', async () => {
      const html = await app.render('agenten.eta', AGENTEN_BETREUER);

      expect(html).toContain('<code>rechnung</code>');
      expect(html).toContain('Version 2.3.1');
      expect(karten(html)).toBe(2);
    });

    it('sagt bei einem Agenten ohne Grenzen, dass keine gemeldet sind, statt eine leere Liste zu zeigen', async () => {
      const html = await app.render('agenten.eta', AGENTEN_KUNDE);

      expect(html).toContain('Keine Grenzen gemeldet.');
      expect((html.match(/<dl class="werte">/g) ?? []).length).toBe(1);
    });

    it('zeigt ohne Inventar einen Leerzustand und keine Karten', async () => {
      const html = await app.render('agenten.eta', AGENTEN_LEER);

      expect(karten(html)).toBe(0);
      expect(html).toContain('Noch kein Inventar gemeldet');
      expect(html).not.toContain('gemeldet vor');
    });

    it('zeigt auf der Seite Benutzer je Konto eine Karte, „Sie" nur am eigenen, und den Knopf zum Einladen (COPI-45)', async () => {
      const html = await app.render('benutzer.eta', BENUTZER);

      expect((html.match(/<li class="konto">/g) ?? []).length).toBe(3);
      expect((html.match(/<span class="marke">Sie<\/span>/g) ?? []).length).toBe(1);
      expect(html).toContain('<dd class="wert-warn">verfällt in 1 Tag</dd>');
      expect(html).toContain('<a href="/einladung" class="knopf knopf-akzent">Jemanden einladen</a>');
    });

    it('zeigt ohne frische Anmeldung kein Formular zum Bearbeiten, nur den Weg zum neuen Anmelden (COPI-46)', async () => {
      const frisch = await app.render('benutzer-bearbeiten.eta', BENUTZER_BEARBEITEN);
      const alt = await app.render('benutzer-bearbeiten.eta', { ...BENUTZER_BEARBEITEN, frisch: false });

      expect((frisch.match(/action="\/benutzer\/konto-7\/aendern"/g) ?? []).length).toBe(5);
      expect(alt).not.toContain('/aendern');
      expect(alt).toContain('Abmelden und neu anmelden');
    });

    it('sagt auf der Seite Benutzer ohne Konten und Einladungen, dass es keine gibt, und bietet ohne Recht kein Einladen an', async () => {
      const html = await app.render('benutzer.eta', BENUTZER_LEER);

      expect(html).toContain('Noch kein Konto angelegt.');
      expect(html).toContain('Keine offenen Einladungen.');
      expect(html).not.toContain('Jemanden einladen');
    });

    it('zeigt den Zeitplan je Agent unter seiner Rolle, mit dem Takt in der Reihenfolge der Meldung', async () => {
      const html = await app.render('zeitplan.eta', ZEITPLAN);

      expect(karten(html)).toBe(2);
      expect(html.indexOf('Buchungs-Agent')).toBeLessThan(html.indexOf('Rechnungs-Agent'));
      expect(html).toContain('<dt>Rechnungslauf</dt>');
      expect(html).toContain('<dd>täglich 07:00</dd>');
      expect(html.indexOf('Rechnungslauf')).toBeLessThan(html.indexOf('Mahnungen'));
    });

    it('unterscheidet beim Zeitplan „kein Inventar" von „Inventar ohne Takt"', async () => {
      const leer = await app.render('zeitplan.eta', ZEITPLAN_LEER);
      const ohneTakte = await app.render('zeitplan.eta', ZEITPLAN_OHNE_TAKTE);

      expect(leer).toContain('Noch kein Inventar gemeldet');
      expect(ohneTakte).toContain('Keine Zeitpläne gemeldet');
      expect(ohneTakte).not.toContain('Noch kein Inventar gemeldet');
      expect(karten(leer)).toBe(0);
      expect(karten(ohneTakte)).toBe(0);
    });

    it.each([
      ['agenten.eta', AGENTEN_KUNDE],
      ['agenten.eta', AGENTEN_BETREUER],
      ['agenten.eta', AGENTEN_LEER],
      ['zeitplan.eta', ZEITPLAN],
      ['zeitplan.eta', ZEITPLAN_OHNE_TAKTE],
      ['zeitplan.eta', ZEITPLAN_LEER],
    ])('%s rendert mit dem Layout, ohne Inline-Stil und ohne Skript', async (datei, daten) => {
      const html = await app.render(datei, daten);

      expect((html.match(/<main[\s>]/g) ?? []).length).toBe(1);
      expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    });

    it('maskiert Fremdtext aus dem Inventar und verlinkt ihn nie', async () => {
      const fremd = '<img src=x onerror=alert(1)> https://boese.example';
      const agenten = await app.render('agenten.eta', {
        ...AGENTEN_BETREUER,
        agenten: { stand: 'gemeldet gerade eben', karten: [{ rolle: fremd, kennung: fremd, version: fremd, grenzen: [{ name: fremd, wert: fremd }] }] },
      });
      const zeitplan = await app.render('zeitplan.eta', {
        ...ZEITPLAN,
        zeitplan: { stand: 'gemeldet gerade eben', gruppen: [{ agent: fremd, takte: [{ name: fremd, wann: fremd }] }] },
      });

      for (const html of [agenten, zeitplan]) {
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('href="https://boese.example');
      }
    });
  });

  describe('Einstellungen (COPI-39)', () => {
    it('zeigt in der Kundensicht nur den Satz: kein Digest, keine Version, keine Marke „Nur Betreuer"', async () => {
      const html = await app.render('einstellungen.eta', EINSTELLUNGEN_KUNDE);

      expect(html).toContain('<p class="bereich-satz">Aktuell.</p>');
      expect(html).toContain('Ansicht: Betriebs-Admin');
      expect(html).not.toContain('sha256');
      expect(html).not.toContain('<dl');
      expect(html).not.toContain('Nur Betreuer');
    });

    it('zeigt in der Betreuersicht Marke, Werte und eine ausbleibende Wache in Warnfarbe', async () => {
      const html = await app.render('einstellungen.eta', EINSTELLUNGEN_BETREUER);

      expect(html).toContain('<span class="nur-betreuer">Nur Betreuer</span>');
      expect(html).toContain('<span class="plakette plakette-gelb">Update verfügbar</span>');
      expect(html).toContain(`<code class="digest">sha256:${'9f'.repeat(32)}</code>`);
      expect(html).toContain('<dd class="wert-warn">zuletzt geprüft vor 12 Tagen</dd>');
      expect(html).toContain('kein Update beantragt');
    });

    it('bietet dem Betreuer den Antrag an: Feld mit der falschen Eingabe (maskiert), Fehler, Knopf wie im Prototyp', async () => {
      const html = await app.render('einstellungen.eta', {
        ...EINSTELLUNGEN_BETREUER,
        antrag: { moeglich: true, fehler: 'Bitte den vollständigen Digest angeben.', eingabe: '"><img src=x>' },
      });

      // Nach einer falschen Eingabe ist der Notweg „Bestimmten Stand wählen" offen (COPI-140).
      expect(html).toContain('<details class="notweg" open>');
      expect(html).toContain('<form method="post" action="/einstellungen/update" class="formular notweg-inhalt">');
      expect(html).toContain('value="&quot;&gt;&lt;img src=x&gt;"');
      expect(html).toContain('role="alert"');
      expect(html).toContain('<button type="submit" class="knopf knopf-sekundaer">Diesen Stand beantragen</button>');
    });

    describe('Update mit einem Klick (COPI-140)', () => {
      const ZEILE = 'Update verfügbar: 1.5.0 · <b>neu</b> · seit 12.10.2026';
      const mitUpdate = {
        ...EINSTELLUNGEN_BETREUER,
        versionen: {
          ...EINSTELLUNGEN_BETREUER.versionen,
          bereiche: [{ ...EINSTELLUNGEN_BETREUER.versionen.bereiche[0], update: { zeile: ZEILE, ziel: `sha256:${'ab'.repeat(32)}` } }],
          module: [{ ...EINSTELLUNGEN_BETREUER.versionen.module[0], update: { zeile: 'Update verfügbar: 8d41e07 · seit 13.10.2026', ziel: '8d41e07'.padEnd(40, '0') } }],
        },
        antrag: { moeglich: true },
      };

      /** Der Kasten „Update verfügbar" samt Formular, als Text. */
      function angebote(html: string): string[] {
        return [...html.matchAll(/<div class="update-angebot">[\s\S]*?<\/form>/g)].map((treffer) => treffer[0]);
      }

      it('zeigt das gemeldete Ziel mit „Update installieren": das Formular trägt nur quelle=wache, nie ein Ziel', async () => {
        const html = await app.render('einstellungen.eta', mitUpdate);
        const [cockpit, modul] = angebote(html);

        expect(cockpit).toContain('Update verfügbar: 1.5.0 · &lt;b&gt;neu&lt;/b&gt; · seit 12.10.2026');
        expect(cockpit).toContain('action="/einstellungen/update"');
        expect(modul).toContain('action="/einstellungen/modul-update"');
        expect(modul).toContain('<input type="hidden" name="modul" value="kommunikation" />');
        for (const angebot of [cockpit, modul]) {
          expect(angebot).toContain('<input type="hidden" name="quelle" value="wache" />');
          expect(angebot).toContain('<button type="submit" class="knopf knopf-primaer">Update installieren</button>');
          expect(angebot).not.toContain('name="ziel"');
        }
      });

      it('klappt den Notweg „Bestimmten Stand wählen" ohne falsche Eingabe ein', async () => {
        const html = await app.render('einstellungen.eta', mitUpdate);

        expect(html).toContain('<details class="notweg">');
        expect(html).not.toContain('<details class="notweg" open>');
        expect(html).toContain('Bestimmten Stand wählen');
      });

      it('bietet ohne gemeldetes Ziel keinen Knopf an, nur den Notweg', async () => {
        const html = await app.render('einstellungen.eta', { ...EINSTELLUNGEN_BETREUER, antrag: { moeglich: true } });

        expect(angebote(html)).toEqual([]);
        expect(html).not.toContain('Update installieren');
        expect(html).toContain('Bestimmten Stand wählen');
      });

      it('verweist bei einer Herkunft außerhalb von module/ auf die Server-Konsole: kein Knopf, kein Feld', async () => {
        const modul = { ...EINSTELLUNGEN_BETREUER.versionen.module[0], antrag: { art: 'nur-konsole' }, letzterAntrag: undefined };
        const html = await app.render('partials/modul-version', { modul, antrag: { moeglich: true } });

        expect(html).toContain('Herkunft nicht unter module/: Update nur per Server-Konsole');
        expect(html).toContain('einspielen kommunikation &lt;commit&gt;');
        expect(html).not.toContain('Update installieren');
        expect(html).not.toContain('name="ziel"');
      });

      it('setzt den Hinweispunkt an „Mehr" und „Einstellungen", mit Klartext — ohne Update keinen', async () => {
        const rechte = { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 };
        const mit = await app.render('mehr.eta', { titel: 'Mehr', nav: navigation('mehr', { ...rechte, updateInstallierbar: true }) });
        const ohne = await app.render('mehr.eta', { titel: 'Mehr', nav: navigation('mehr', rechte) });

        // Rahmen: „Mehr" (Tab-Leiste) und „Einstellungen" (Verwaltung); dazu die Liste der Mehr-Seite.
        expect(mit.match(/class="nav-punkt"/g)).toHaveLength(3);
        expect(mit).toContain('<span class="sr-only">, Update verfügbar</span>');
        expect(ohne).not.toContain('nav-punkt');
      });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['ohne laufenden Digest', { art: 'ohne-digest' }, 'Ein Update lässt sich erst beantragen, wenn das Cockpit seinen laufenden Digest meldet.'],
      ['mit wartendem Antrag', { art: 'zurueckziehen', id: 7, satz: 'Antrag Nr. 7 wartet auf die Freigabe.' }, 'Antrag zurückziehen'],
      ['mit freigegebenem Antrag', { art: 'unterwegs', satz: 'Antrag Nr. 7 ist freigegeben.' }, 'Antrag Nr. 7 ist freigegeben.'],
    ])('zeigt dem Betreuer %s kein Formular für einen neuen Antrag', async (_name, antrag, text) => {
      const [bereich] = EINSTELLUNGEN_BETREUER.versionen.bereiche;
      const html = await app.render('einstellungen.eta', {
        ...EINSTELLUNGEN_BETREUER,
        versionen: { sicht: 'betreuer', bereiche: [{ ...bereich, antrag }] },
        antrag: { moeglich: true, hinweis: 'Antrag gestellt.' },
      });

      expect(html).toContain(text);
      expect(html).toContain('role="status"');
      expect(html).not.toContain('action="/einstellungen/update" ');
    });

    it('zeigt ohne das Recht zum Antrag keinen Antrag, auch nicht in der Betreuersicht', async () => {
      const html = await app.render('einstellungen.eta', { ...EINSTELLUNGEN_BETREUER, antrag: { moeglich: false } });

      expect(html).not.toContain('/einstellungen/update');
      expect(html).not.toContain('Update beantragen');
    });

    it('lässt „Ansicht" weg, wenn die Rolle unbekannt ist', async () => {
      const html = await app.render('einstellungen.eta', { ...EINSTELLUNGEN_KUNDE, ansicht: undefined });

      expect(html).not.toContain('Ansicht:');
    });

    it.each<[string, Record<string, unknown>]>([
      ['einstellungen.eta', EINSTELLUNGEN_KUNDE],
      ['einstellungen.eta', EINSTELLUNGEN_BETREUER],
      ['update-bestaetigen.eta', UPDATE_BESTAETIGEN],
      ['modul-update-bestaetigen.eta', MODUL_UPDATE_BESTAETIGEN],
      ['freigabe-bestaetigen.eta', FREIGABE_BESTAETIGEN],
    ])('rendert %s mit dem Layout, ohne Inline-Stil und ohne Skript', async (datei, daten) => {
      const html = await app.render(datei, daten);

      expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    });
  });

  describe('App-Rahmen, Navigation und Abmelden (COPI-38, COPI-43)', () => {
    const mitNav = seitenDateien.filter((datei) => 'nav' in (DATEN[datei] ?? {}));
    const ohneNav = seitenDateien.filter((datei) => !('nav' in (DATEN[datei] ?? {})));
    const uebersicht = (): Promise<string> => app.render('uebersicht.eta', DATEN['uebersicht.eta'] ?? {});

    it('gibt es auf allen angemeldeten Seiten', () => {
      expect(mitNav.sort()).toEqual([
        'agent-detail.eta',
        'agenten.eta',
        'benutzer-bearbeiten.eta',
        'benutzer-bestaetigen.eta',
        'benutzer-hinweis.eta',
        'benutzer-zurueckgesetzt.eta',
        'benutzer.eta',
        'chat.eta',
        'einladung.eta',
        'einstellungen.eta',
        'freigabe-bestaetigen.eta',
        'freigabe-detail.eta',
        'freigaben.eta',
        'mehr.eta',
        'meldungen.eta',
        'modul-anhang.eta',
        'modul-detail.eta',
        'modul-kennzahlen.eta',
        'modul-update-bestaetigen.eta',
        'modul.eta',
        'module.eta',
        'sicherheit-bestaetigen.eta',
        'sicherheit-codes.eta',
        'sicherheit-frage.eta',
        'sicherheit-passkey.eta',
        'sicherheit-totp.eta',
        'sicherheit.eta',
        'uebersicht.eta',
        'update-bestaetigen.eta',
        'update-hinweis.eta',
        'zeitplan.eta',
      ]);
    });

    it('führt die fünf Einträge des Prototyps, markiert genau einen und verlinkt die, die es gibt', async () => {
      const html = await uebersicht();

      expect((html.match(/<nav class="hauptnav" aria-label="Hauptnavigation"/g) ?? []).length, 'eine Navigation für Sidebar und Tab-Leiste').toBe(1);
      expect(html).toMatch(/<a href="\/" class="hauptnav-eintrag" aria-current="page"><svg[^]*?<span>Übersicht<\/span><\/a>/);
      expect(html).toMatch(/<a href="\/meldungen" class="hauptnav-eintrag"><svg[^]*?<span>Meldungen<\/span><\/a>/);
      expect(html).toMatch(/<a href="\/mehr" class="hauptnav-eintrag"><svg[^]*?<span>Mehr<\/span><\/a>/);
      expect((html.match(/aria-current="page"/g) ?? []).length, 'genau eine aktuelle Seite').toBe(1);
    });

    it('graut Module aus: kein Link, nicht fokussierbar, für Screenreader „folgt"', async () => {
      const html = await uebersicht();

      expect(html).toMatch(/<span class="hauptnav-eintrag hauptnav-folgt" aria-disabled="true"><svg[^]*?<span>Module<\/span><span class="sr-only"> \(folgt\)<\/span><\/span>/);
      expect(html).not.toMatch(/href="\/module"/);
      expect(html).toContain('<a href="/chat" class="hauptnav-eintrag">');
    });

    it('zeigt am Chat die Zahl ungelesener Nachrichten, mit Klartext für Screenreader (COPI-53)', async () => {
      const nav = navigation('uebersicht', { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 3 });
      const html = await app.render('uebersicht.eta', { ...(DATEN['uebersicht.eta'] ?? {}), nav });

      expect(html).toContain('<span class="hauptnav-zahl"><span aria-hidden="true">3</span><span class="sr-only">, 3 ungelesen</span></span>');
    });

    it('markiert auf den Seiten unter „Mehr" den Eintrag „Mehr"', async () => {
      const html = await app.render('zeitplan.eta', DATEN['zeitplan.eta'] ?? {});

      expect(html).toContain('<a href="/mehr" class="hauptnav-eintrag" aria-current="page">');
    });

    it('bietet in der Sidebar Dark Mode und Abmelden an, beides als Formular (ein GET dürfte nichts ändern)', async () => {
      const html = await uebersicht();
      const fuss = html.slice(html.indexOf('<div class="rahmen-fuss">'), html.indexOf('</aside>'));

      expect(fuss).toContain('<form method="post" action="/darstellung" class="darstellung darstellung-breit">');
      expect(fuss).toContain('<input type="hidden" name="zurueck" value="/" />');
      expect(fuss).toMatch(/<button type="submit" name="darstellung" value="dunkel" class="darstellung-knopf nur-hell">[^]*?Dark Mode/);
      expect(fuss).toMatch(/<button type="submit" name="darstellung" value="hell" class="darstellung-knopf nur-dunkel">[^]*?Light Mode/);
      expect(fuss).toMatch(/<button type="submit" name="darstellung" value="auto" class="darstellung-knopf nur-gewaehlt">[^]*?Wie System/);
      expect(fuss).toMatch(/<form method="post" action="\/abmelden">\s*<button type="submit" class="rahmen-knopf">[^]*?<span>Abmelden<\/span>/);
    });

    it('hat im Kopf jeder angemeldeten Seite den runden Dark-Mode-Knopf, der zur eigenen Seite zurückkehrt', async () => {
      for (const datei of mitNav) {
        const daten = DATEN[datei] ?? {};
        const html = await app.render(datei, daten);
        const pfad = (daten.nav as { pfad: string }).pfad;

        expect(html, datei).toContain('<form method="post" action="/darstellung" class="darstellung darstellung-rund">');
        expect(html, datei).toContain(`<input type="hidden" name="zurueck" value="${pfad}" />`);
        expect(html, datei).toContain('<button type="submit" name="darstellung" value="auto" class="darstellung-knopf nur-gewaehlt">');
      }
    });

    it('lässt das Abmelden weg, wenn es keine Sitzung gibt, und behält die Navigation', async () => {
      const html = await app.render('uebersicht.eta', { ...UEBERSICHT_KUNDE, nav: navBeispiel('uebersicht', false) });

      expect(html).toContain('<nav class="hauptnav" aria-label="Hauptnavigation"');
      expect(html).not.toContain('action="/abmelden"');
    });

    it('bietet unter „Mehr" die Unterseiten und das Abmelden an', async () => {
      const html = await app.render('mehr.eta', DATEN['mehr.eta'] ?? {});

      for (const [href, text] of [['/agenten', 'Agenten'], ['/zeitplan', 'Zeitplan'], ['/einstellungen', 'Einstellungen'], ['/einladung', 'Einladen']]) {
        expect(html, text).toMatch(new RegExp(`<a href="${href}" class="liste-zeile">[^]*?<span class="liste-text">${text}</span>`));
      }
      expect(html).toMatch(/<form method="post" action="\/abmelden">\s*<button type="submit" class="liste-zeile">[^]*?Abmelden/);
    });

    it.each(ohneNav)('%s hat keinen App-Rahmen: Anmelden, Erststart und Einlösen sind noch ohne Konto', async (datei) => {
      const html = await app.render(datei, DATEN[datei] ?? {});

      expect(html).not.toContain('<nav');
      expect(html).not.toContain('action="/darstellung"');
    });

    it('zeigt den Instanznamen unter der Wortmarke und mobil über dem Titel, wenn er eingestellt ist', async () => {
      const mitName = buildApp({ nodeEnv: 'test' }, { instanzName: 'Fewotest' });
      try {
        const html = await mitName.render('uebersicht.eta', DATEN['uebersicht.eta'] ?? {});

        expect(html).toContain('<span class="rahmen-instanz">Fewotest</span>');
        expect(html).toContain('<p class="seiten-instanz">Fewotest</p>');
      } finally {
        await mitName.close();
      }
      const ohneName = await uebersicht();
      expect(ohneName).not.toContain('rahmen-instanz');
      expect(ohneName).not.toContain('seiten-instanz');
    });
  });

  it('macht aus einem Titel mit Sonderzeichen keinen Markup-Einschub', async () => {
    const html = await app.render('nicht-gefunden.eta', { titel: '<script>alert(1)</script>' });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('Keine Fremdanfragen', () => {
  const FREMD_ATTRIBUT = /\b(?:src|href|action|srcset|poster|data)\s*=\s*["']\s*(?:https?:)?\/\//i;
  const FREMD_CSS = /(?:url\(\s*["']?\s*|@import\s+(?:url\(\s*)?["']?\s*)(?:https?:)?\/\//i;
  const FREMDE_DIENSTE = /googleapis|gstatic|cloudflare|jsdelivr|unpkg|cdnjs|bootstrapcdn|typekit|fontawesome/i;

  it.each([...seitenDateien.map((d) => path.join(VIEWS, d)), path.join(VIEWS, 'layout.eta'), ...partialDateien.map((d) => path.join(PARTIALS, d))])(
    '%s verweist auf keinen fremden Host',
    (pfad) => {
      const quelle = lesen(pfad);

      expect(quelle).not.toMatch(FREMD_ATTRIBUT);
      expect(quelle).not.toMatch(FREMDE_DIENSTE);
    },
  );

  it('rendert Seiten ohne fremde Verweise (Layout eingerechnet)', async () => {
    const app = buildApp({ nodeEnv: 'test' });
    try {
      for (const datei of seitenDateien) {
        const html = await app.render(datei, DATEN[datei] ?? {});
        // Der SVG-Namensraum des QR-Codes ist keine Anfrage; er steht in einem Attribut `xmlns`, nicht in einem der oben geprüften.
        expect(html, datei).not.toMatch(FREMD_ATTRIBUT);
        expect(html, datei).not.toMatch(FREMD_CSS);
        expect(html, datei).not.toMatch(FREMDE_DIENSTE);
      }
    } finally {
      await app.close();
    }
  });
});

describe('Bestehende Zusagen der Seiten bleiben', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({ nodeEnv: 'test' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('zeigt einen Fehler als Hinweis mit role="alert"', async () => {
    const html = await app.render('anmelden.eta', DATEN['anmelden.eta']);

    expect(html).toMatch(/role="alert"[^>]*>[\s\S]*Anmeldung nicht möglich\./);
  });

  it('lässt den Hinweis weg, wenn es keinen Fehler gibt', async () => {
    const html = await app.render('anmelden.eta', { titel: 'Anmelden' });

    expect(html).not.toContain('role="alert"');
  });

  it('hat für jedes Formularfeld ein Label mit passender for/id-Verbindung', async () => {
    for (const datei of seitenDateien) {
      const html = await app.render(datei, DATEN[datei] ?? {});
      const felder = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)]
        .filter((treffer) => !/type="(?:hidden|submit)"/i.test(treffer[2] ?? ''));
      for (const feld of felder) {
        const id = /\bid="([^"]+)"/.exec(feld[2] ?? '')?.[1];
        expect(id, `${datei}: Feld ohne id: ${feld[0]}`).toBeTruthy();
        expect(html, `${datei}: Label für ${String(id)}`).toMatch(new RegExp(`<label[^>]*\\bfor="${String(id)}"`));
      }
    }
  });

  it('vergibt jede id nur einmal je Seite — sonst zeigt ein Label oder ein Sprunglink auf das falsche Element (COPI-64)', async () => {
    for (const datei of seitenDateien) {
      const html = await app.render(datei, DATEN[datei] ?? {});
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((treffer) => treffer[1] ?? '');
      const doppelt = ids.filter((id, stelle) => ids.indexOf(id) !== stelle);
      expect(doppelt, datei).toEqual([]);
    }
  });

  it('gibt jedem Formular eine Absende-Schaltfläche vom Typ submit', async () => {
    for (const datei of seitenDateien) {
      const html = await app.render(datei, DATEN[datei] ?? {});
      const formulare = [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)];
      for (const formular of formulare) {
        expect(formular[0], `${datei}: Formular ohne submit`).toMatch(/<button[^>]*type="submit"/);
      }
    }
  });

  it('bettet den QR-Code unverändert und ohne Stilattribut ein', async () => {
    const html = await app.render('zwei-faktor-code.eta', DATEN['zwei-faktor-code.eta']);

    expect(html).toContain(QR_SVG);
    expect(html).toMatch(/<svg[\s\S]*?<\/svg>/);
  });
});
