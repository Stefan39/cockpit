/**
 * Die Tabelle „Route × Zustand" (COPI-29): was jede Route des Cockpits für Anonyme, für ein
 * Konto ohne zweiten Faktor und für ein Konto mit zweitem Faktor tut.
 *
 * Diese Datei ist die **unabhängig geschriebene Erwartung**. Sie rechnet nicht mit
 * `torEntscheidung`, sondern nennt die Antworten als Literale: würde der Test die Weiche
 * mitrechnen, wäre eine versehentlich geöffnete Route in beiden gleich offen und der Test
 * grün. Der Routen-Test (`routen-tor-datenbank.test.ts`) prüft **jede registrierte Route**
 * mit echten Anfragen gegen diese Tabelle und schlägt an, wenn eine Route fehlt (eine neue
 * Route muss sich hier einordnen) oder überzählig ist; der README-Test
 * (`routen-readme.test.ts`) prüft, dass die Tabelle im Handbuch dieselbe ist.
 *
 * Drei Zustände, die das Tor unterscheidet: kein Konto angemeldet, angemeldet ohne aktiven
 * zweiten Faktor, angemeldet mit aktivem zweitem Faktor.
 */

export type Zustand = 'anonym' | 'ohneFaktor' | 'mitFaktor';
export const ZUSTAENDE: readonly Zustand[] = ['anonym', 'ohneFaktor', 'mitFaktor'];

export type Erwartung =
  /** Die Anfrage erreicht den Handler der Route. */
  | { readonly art: 'erreichbar' }
  /** Das Tor antwortet mit `303` auf dieses Ziel; der Handler läuft nicht. */
  | { readonly art: 'umleiten'; readonly ziel: string }
  /** Das Tor antwortet mit der neutralen 404-Seite; der Handler läuft nicht. */
  | { readonly art: 'neutral404' }
  /** Das Tor lässt durch, aber es gibt die Route nicht: Fastifys eigene 404. Kein Handler. */
  | { readonly art: 'unbekannt404' }
  /**
   * Agenten-API (COPI-35): Das Tor lässt ohne Sitzung durch, die Route verlangt ein Bearer-Token und
   * antwortet ohne eines mit `401` und `WWW-Authenticate: Bearer`. Der Handler läuft nicht. Sitzung und
   * zweiter Faktor spielen keine Rolle, deshalb ist die Antwort in allen drei Zuständen dieselbe.
   */
  | { readonly art: 'token401' }
  /**
   * Pipeline-API (COPI-145): wie die Agenten-API, aber die Route verlangt eine HMAC-Signatur und antwortet ohne sie
   * mit `401` und `WWW-Authenticate: HMAC-SHA256`.
   */
  | { readonly art: 'signatur401' };

const ERREICHBAR: Erwartung = { art: 'erreichbar' };
const ZUR_ANMELDUNG: Erwartung = { art: 'umleiten', ziel: '/anmelden' };
const ZUR_EINRICHTUNG: Erwartung = { art: 'umleiten', ziel: '/zwei-faktor' };
const NEUTRAL: Erwartung = { art: 'neutral404' };
const UNBEKANNT: Erwartung = { art: 'unbekannt404' };
const TOKEN_NOETIG: Erwartung = { art: 'token401' };
const SIGNATUR_NOETIG: Erwartung = { art: 'signatur401' };

export interface Kategorie {
  readonly beschreibung: string;
  readonly erwartung: Readonly<Record<Zustand, Erwartung>>;
}

export const KATEGORIEN = {
  immer: {
    beschreibung: 'in jedem Zustand erreichbar (Health, Abmelden, Erststart, Stylesheet und Schriften)',
    erwartung: { anonym: ERREICHBAR, ohneFaktor: ERREICHBAR, mitFaktor: ERREICHBAR },
  },
  oeffentlich: {
    beschreibung: 'ohne Sitzung erreichbar; ein Konto ohne zweiten Faktor wird zur Einrichtung geführt',
    erwartung: { anonym: ERREICHBAR, ohneFaktor: ZUR_EINRICHTUNG, mitFaktor: ERREICHBAR },
  },
  einrichtung: {
    beschreibung: 'die Einrichtung des zweiten Faktors: nur mit Sitzung',
    erwartung: { anonym: ZUR_ANMELDUNG, ohneFaktor: ERREICHBAR, mitFaktor: ERREICHBAR },
  },
  geschuetzt: {
    beschreibung: 'nur mit Sitzung **und** aktivem zweitem Faktor',
    erwartung: { anonym: ZUR_ANMELDUNG, ohneFaktor: ZUR_EINRICHTUNG, mitFaktor: ERREICHBAR },
  },
  verborgen: {
    beschreibung: 'wie geschützt, aber Anonyme bekommen die neutrale 404 statt einer Umleitung',
    erwartung: { anonym: NEUTRAL, ohneFaktor: ZUR_EINRICHTUNG, mitFaktor: ERREICHBAR },
  },
  authFrei: {
    beschreibung: 'rohe Better-Auth-Endpunkte, die mit Sitzung freigegeben sind (COPI-20)',
    erwartung: { anonym: NEUTRAL, ohneFaktor: ERREICHBAR, mitFaktor: ERREICHBAR },
  },
  authZu: {
    beschreibung: 'rohe Better-Auth-Endpunkte: in jedem Zustand zu',
    erwartung: { anonym: NEUTRAL, ohneFaktor: NEUTRAL, mitFaktor: NEUTRAL },
  },
  unbekannt: {
    beschreibung: 'ein Pfad, den es nicht gibt: das Tor schickt Unbefugte weg, bevor die 404 etwas verrät',
    erwartung: { anonym: ZUR_ANMELDUNG, ohneFaktor: ZUR_EINRICHTUNG, mitFaktor: UNBEKANNT },
  },
  unbekanntUnterFreigabe: {
    beschreibung: 'ein Pfad, den es nicht gibt, unter einem für Anonyme freigegebenen Präfix (`/anmelden/…`)',
    erwartung: { anonym: UNBEKANNT, ohneFaktor: ZUR_EINRICHTUNG, mitFaktor: UNBEKANNT },
  },
  maschinell: {
    beschreibung:
      'Agenten-API unter `/intern` (COPI-35): kein Cookie, keine Sitzung, kein zweiter Faktor — ein Bearer-Token, das die Route selbst prüft; ohne Token 401, auch für einen Pfad, den es nicht gibt',
    erwartung: { anonym: TOKEN_NOETIG, ohneFaktor: TOKEN_NOETIG, mitFaktor: TOKEN_NOETIG },
  },
  signiert: {
    beschreibung:
      'Pipeline-API unter `/pipeline` (COPI-145): kein Cookie, keine Sitzung, kein zweiter Faktor — eine HMAC-Signatur, die die Route selbst prüft; ohne sie 401, auch für einen Pfad, den es nicht gibt',
    erwartung: { anonym: SIGNATUR_NOETIG, ohneFaktor: SIGNATUR_NOETIG, mitFaktor: SIGNATUR_NOETIG },
  },
  unbekanntUnterImmerFreigabe: {
    beschreibung: 'ein Pfad, den es nicht gibt, unter einem in **jedem** Zustand freigegebenen Präfix (`/erststart`, `/gesund`, `/abmelden`, `/assets`)',
    erwartung: { anonym: UNBEKANNT, ohneFaktor: UNBEKANNT, mitFaktor: UNBEKANNT },
  },
} as const satisfies Record<string, Kategorie>;

export type KategorieName = keyof typeof KATEGORIEN;

/**
 * Jede registrierte Route, `METHODE Muster` (so, wie Fastify sie kennt; HEAD ist die
 * automatische Ergänzung jeder GET-Route und steht hier nicht). Reihenfolge = Reihenfolge
 * der Tabelle im Handbuch.
 */
export const ROUTEN: Readonly<Record<string, KategorieName>> = {
  'GET /gesund': 'immer',
  'GET /assets/:datei': 'immer',
  'GET /manifest.webmanifest': 'immer',
  'GET /sw.js': 'immer',
  'GET /icons/:datei': 'immer',
  'GET /favicon.ico': 'immer',
  'GET /pwa.js': 'geschuetzt',
  'POST /push/abo': 'geschuetzt',
  'POST /push/abmelden': 'geschuetzt',
  'POST /push/geraete/:id/entfernen': 'geschuetzt',
  'POST /push/test': 'geschuetzt',
  'GET /': 'geschuetzt',
  'GET /agenten': 'geschuetzt',
  'GET /agenten/:schluessel': 'geschuetzt',
  'GET /benutzer': 'geschuetzt',
  'GET /benutzer/:id': 'geschuetzt',
  'POST /benutzer/:id/aendern': 'geschuetzt',
  'POST /benutzer/:id/bestaetigen': 'geschuetzt',
  'GET /zeitplan': 'geschuetzt',
  'GET /module': 'geschuetzt',
  'GET /module/:kennung': 'geschuetzt',
  'GET /module/:kennung/:id': 'geschuetzt',
  'POST /module/:kennung/:id/uebernehmen': 'geschuetzt',
  'POST /module/:kennung/:id/zurueckgeben': 'geschuetzt',
  'POST /module/:kennung/:id/freigeben': 'geschuetzt',
  'POST /module/:kennung/:id/freigabe-zurueckziehen': 'geschuetzt',
  'GET /module/:kennung/:id/anhang/:anhang': 'geschuetzt',
  'POST /module/:kennung/:id/anhang/:anhang': 'geschuetzt',
  // Bildvorschau (COPI-124): dieselben Prüfungen wie der Download.
  'GET /module/:kennung/:id/anhang/:anhang/bild': 'geschuetzt',
  'POST /module/:kennung/:id/entscheiden': 'geschuetzt',
  'POST /module/:kennung/:id/entscheidung-zuruecknehmen': 'geschuetzt',
  'GET /einstellungen': 'geschuetzt',
  'POST /einstellungen/update': 'geschuetzt',
  'POST /einstellungen/update/bestaetigen': 'geschuetzt',
  'POST /einstellungen/update/zurueckziehen': 'geschuetzt',
  'POST /einstellungen/modul-update': 'geschuetzt',
  'POST /einstellungen/modul-update/bestaetigen': 'geschuetzt',
  'GET /einstellungen/app-symbol/skript.js': 'geschuetzt',
  'POST /einstellungen/app-symbol': 'geschuetzt',
  'POST /einstellungen/app-symbol/zuruecksetzen': 'geschuetzt',
  'POST /einstellungen/betreuer-zugriff': 'geschuetzt',
  'POST /einstellungen/freigabe': 'geschuetzt',
  // Anmeldung & Sicherheit (COPI-94): hinter dem Tor wie alle Seiten; jede Änderung verlangt zusätzlich die frische
  // Bestätigung durch einen vorhandenen Faktor (das prüft die Route, nicht das Tor).
  'GET /sicherheit': 'geschuetzt',
  'GET /sicherheit/bestaetigen': 'geschuetzt',
  'POST /sicherheit/bestaetigen/code': 'geschuetzt',
  'POST /sicherheit/bestaetigen/passkey/optionen': 'geschuetzt',
  'POST /sicherheit/bestaetigen/passkey': 'geschuetzt',
  'GET /sicherheit/skript.js': 'geschuetzt',
  'GET /sicherheit/passkey': 'geschuetzt',
  'POST /sicherheit/passkey/optionen': 'geschuetzt',
  'POST /sicherheit/passkey/pruefen': 'geschuetzt',
  'GET /sicherheit/passkey/:id/entfernen': 'geschuetzt',
  'POST /sicherheit/passkey/:id/entfernen': 'geschuetzt',
  'GET /sicherheit/totp/entfernen': 'geschuetzt',
  'POST /sicherheit/totp/entfernen': 'geschuetzt',
  'GET /sicherheit/totp': 'geschuetzt',
  'POST /sicherheit/totp': 'geschuetzt',
  'POST /sicherheit/totp/pruefen': 'geschuetzt',
  'GET /sicherheit/ersatzcodes': 'geschuetzt',
  'POST /sicherheit/ersatzcodes': 'geschuetzt',
  'POST /darstellung': 'geschuetzt',
  'GET /mehr': 'geschuetzt',
  'GET /meldungen': 'geschuetzt',
  'GET /chat': 'geschuetzt',
  'POST /chat': 'geschuetzt',
  'GET /chat/team': 'geschuetzt',
  'POST /chat/team': 'geschuetzt',
  'GET /chat/ereignisse': 'geschuetzt',
  'GET /chat/team/ereignisse': 'geschuetzt',
  'GET /chat/skript.js': 'geschuetzt',
  'GET /chat/postfach/:kennung': 'geschuetzt',
  'GET /posteingang': 'geschuetzt',
  'POST /posteingang/gelesen': 'geschuetzt',
  'GET /anmelden': 'oeffentlich',
  'POST /anmelden': 'oeffentlich',
  'GET /anmelden/code': 'oeffentlich',
  'POST /anmelden/code': 'oeffentlich',
  'GET /anmelden/passkey/skript.js': 'oeffentlich',
  'POST /anmelden/passkey/optionen': 'oeffentlich',
  'POST /anmelden/passkey/pruefen': 'oeffentlich',
  'POST /abmelden': 'immer',
  'GET /erststart/:token': 'immer',
  'POST /erststart/:token': 'immer',
  'GET /einladung/:token': 'oeffentlich',
  'POST /einladung/:token': 'oeffentlich',
  'GET /zugang-wiederherstellen/:token': 'oeffentlich',
  'POST /zugang-wiederherstellen/:token': 'oeffentlich',
  'GET /email-bestaetigen/:token': 'oeffentlich',
  'POST /email-bestaetigen/:token': 'oeffentlich',
  'GET /einladung': 'verborgen',
  'POST /einladung': 'verborgen',
  'GET /zwei-faktor': 'einrichtung',
  'POST /zwei-faktor/einrichten': 'einrichtung',
  'POST /zwei-faktor/pruefen': 'einrichtung',
  'GET /zwei-faktor/passkey/skript.js': 'einrichtung',
  'POST /zwei-faktor/passkey/optionen': 'einrichtung',
  'POST /zwei-faktor/passkey/pruefen': 'einrichtung',
  'GET /intern/ping': 'maschinell',
  'POST /intern/befund': 'maschinell',
  'PUT /intern/agenten': 'maschinell',
  'GET /intern/eingriffe': 'maschinell',
  'GET /intern/eingriffe/:id': 'maschinell',
  'POST /intern/eingriffe/:id/status': 'maschinell',
  'POST /intern/chat/antwort': 'maschinell',
  'POST /intern/chat/agenten': 'maschinell',
  'POST /intern/agenten/ereignis': 'maschinell',
  'GET /intern/zustand': 'maschinell',
  'GET /intern/chat/verbrauch': 'maschinell',
  'GET /intern/vorgaenge/sperre': 'maschinell',
  'GET /intern/vorgaenge/freigabe': 'maschinell',
  'GET /intern/vorgaenge/entscheidungen': 'maschinell',
  'POST /intern/verbrauch': 'maschinell',
  'GET /intern/verbrauch/tickets': 'maschinell',
  'POST /intern/wechselkurs': 'maschinell',
  'POST /intern/pipeline/jobs': 'maschinell',
  'GET /intern/pipeline/jobs': 'maschinell',
  'GET /intern/pipeline/jobs/:id': 'maschinell',
  'GET /intern/pipeline/freigaben': 'maschinell',
  'POST /intern/pipeline/jobs/:id/freigabe-erledigt': 'maschinell',
  'POST /intern/pipeline/aufraeumen': 'maschinell',
  'GET /intern/pipeline/verbrauch': 'maschinell',
  'POST /pipeline/claim': 'signiert',
  'POST /pipeline/heartbeat': 'signiert',
  'POST /pipeline/event': 'signiert',
  'POST /pipeline/complete': 'signiert',
  'GET /api/auth/*': 'authZu',
  'POST /api/auth/*': 'authZu',
};

/**
 * Was hinter den Joker-Routen steckt: ein Muster mit `*` steht für viele Pfade, die das Tor
 * unterschiedlich behandelt. Jeder Pfad hier wird mit beiden Methoden geprüft. Die Kategorie
 * der Route selbst (`authZu`) ist der Regelfall; die Ausnahmen stehen einzeln.
 */
export const AUTH_PFADE: readonly { readonly pfad: string; readonly kategorie: KategorieName }[] = [
  { pfad: '/api/auth/get-session', kategorie: 'authFrei' },
  { pfad: '/api/auth/sign-out', kategorie: 'authFrei' },
  { pfad: '/api/auth/sign-in/email', kategorie: 'authZu' },
  { pfad: '/api/auth/sign-up/email', kategorie: 'authZu' },
  { pfad: '/api/auth/two-factor/enable', kategorie: 'authZu' },
  { pfad: '/api/auth/two-factor/disable', kategorie: 'authZu' },
  { pfad: '/api/auth/passkey/generate-register-options', kategorie: 'authZu' },
  { pfad: '/api/auth/cockpit/sitzung-nach-zweitem-faktor', kategorie: 'authZu' },
  { pfad: '/api/auth/gibt-es-nicht', kategorie: 'authZu' },
  { pfad: '/api/auth', kategorie: 'authZu' },
];

/** Pfade ohne Route: das Tor entscheidet, bevor Fastify „nicht gefunden" sagt. */
export const UNBEKANNTE_PFADE: readonly { readonly pfad: string; readonly kategorie: KategorieName }[] = [
  { pfad: '/unbekannt', kategorie: 'unbekannt' },
  { pfad: '/modul/belegung', kategorie: 'unbekannt' },
  { pfad: '/chat/unbekannt', kategorie: 'unbekannt' },
  { pfad: '/admin', kategorie: 'unbekannt' },
  { pfad: '/.env', kategorie: 'unbekannt' },
  { pfad: '/anmelden/unbekannt', kategorie: 'unbekanntUnterFreigabe' },
  // Die Freigaben des Tors sind Präfixe: `/erststart` ohne Token, `/gesund/…` und `/abmelden/…` gehören dazu.
  { pfad: '/erststart', kategorie: 'unbekanntUnterImmerFreigabe' },
  { pfad: '/gesund/unbekannt', kategorie: 'unbekanntUnterImmerFreigabe' },
  { pfad: '/abmelden/unbekannt', kategorie: 'unbekanntUnterImmerFreigabe' },
  // Stylesheet und Schriften (COPI-30): `/assets` ohne Namen gibt es nicht. Ein Name unter `/assets/…`
  // erreicht die Route (`GET /assets/:datei`), die selbst 404 sagt, wenn er nicht im Manifest steht;
  // das prüft `assets.test.ts`, denn dieser Test misst nur, ob das Tor einen Handler durchlässt.
  { pfad: '/assets', kategorie: 'unbekanntUnterImmerFreigabe' },
  // Agenten-API (COPI-35): auch ein Pfad, den es nicht gibt, verlangt zuerst das Token — sonst ließe sich
  // an 401 gegen 404 ablesen, welche Routen es gibt.
  { pfad: '/intern', kategorie: 'maschinell' },
  { pfad: '/intern/', kategorie: 'maschinell' },
  { pfad: '/intern/unbekannt', kategorie: 'maschinell' },
  { pfad: '/intern/unbekannt/tiefer', kategorie: 'maschinell' },
  // Pipeline-API (COPI-145): ebenso — ohne Signatur 401, auch für einen Pfad, den es nicht gibt.
  { pfad: '/pipeline', kategorie: 'signiert' },
  { pfad: '/pipeline/unbekannt', kategorie: 'signiert' },
];

/** Aus einem Fastify-Muster einen Pfad machen, den man anfragen kann. */
export function beispielPfad(muster: string): string {
  return muster
    // Die Symbole (COPI-101): das Tor lässt unter `/icons/` nur die vier Namen durch.
    .replace('/icons/:datei', '/icons/icon-512.png')
    .replace(':token', 'beispiel-token')
    .replace(':datei', 'beispiel.css')
    .replace(':kennung', 'beispiel-kennung')
    .replace(':id', 'beispiel-id')
    .replace('*', 'beispiel');
}

function zelle(erwartung: Erwartung): string {
  switch (erwartung.art) {
    case 'erreichbar':
      return 'erreichbar';
    case 'umleiten':
      return `→ \`${erwartung.ziel}\``;
    case 'neutral404':
      return '404 (neutral)';
    case 'unbekannt404':
      return '404';
    case 'token401':
      return '401 (Bearer-Token nötig)';
    case 'signatur401':
      return '401 (Signatur nötig)';
  }
}

/**
 * Die Tabelle fürs README, Markdown, aus den Daten oben. Der README-Test vergleicht sie
 * Zeichen für Zeichen mit dem Abschnitt zwischen den Markierungen.
 */
export function tabelleBauen(): string {
  const zeilen: string[] = [
    '| Route | anonym | Sitzung ohne zweiten Faktor | Sitzung mit zweitem Faktor |',
    '| --- | --- | --- | --- |',
  ];
  const zeile = (name: string, kategorie: KategorieName): string => {
    const { erwartung } = KATEGORIEN[kategorie];
    return `| ${name} | ${zelle(erwartung.anonym)} | ${zelle(erwartung.ohneFaktor)} | ${zelle(erwartung.mitFaktor)} |`;
  };
  for (const [route, kategorie] of Object.entries(ROUTEN)) {
    if (route.endsWith('/api/auth/*')) {
      continue; // steht unten einzeln, weil das Tor die Pfade darunter verschieden behandelt
    }
    zeilen.push(zeile(`\`${route}\``, kategorie));
  }
  for (const eintrag of AUTH_PFADE.filter((pfad) => pfad.kategorie === 'authFrei')) {
    zeilen.push(zeile(`\`GET\`/\`POST\` \`${eintrag.pfad}\``, eintrag.kategorie));
  }
  zeilen.push(zeile('`GET`/`POST` jeder andere Pfad unter `/api/auth`', 'authZu'));
  zeilen.push(zeile('jeder Pfad, den es nicht gibt', 'unbekannt'));
  zeilen.push(zeile('jeder Pfad, den es nicht gibt, unter `/anmelden/…`', 'unbekanntUnterFreigabe'));
  zeilen.push(zeile('jeder Pfad, den es nicht gibt, unter `/erststart`, `/gesund/…`, `/abmelden/…`, `/assets`', 'unbekanntUnterImmerFreigabe'));
  zeilen.push(zeile('jeder Pfad, den es nicht gibt, unter `/intern`', 'maschinell'));
  zeilen.push(zeile('jeder Pfad, den es nicht gibt, unter `/pipeline`', 'signiert'));
  return zeilen.join('\n');
}
