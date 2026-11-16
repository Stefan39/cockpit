/**
 * Das zentrale Tor als Tabelle Pfad × Zustand (COPI-13).
 *
 * Drei Zustände: anonym, Sitzung ohne zweiten Faktor, Sitzung mit zweitem
 * Faktor. Seit COPI-13 ist das Tor **deny by default**: anonyme Anfragen
 * erreichen nur eine ausdrückliche Allowlist, alles andere landet auf der
 * Anmeldeseite. Das ersetzt die „neutrale Wurzelseite" aus COPI-10.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { torEntscheidung } from '../src/auth/zwei-faktor-tor.js';
import type { SitzungLesen, TorEntscheidung } from '../src/auth/zwei-faktor-tor.js';

const ANONYM: SitzungLesen = () =>
  Promise.resolve({ sitzungVorhanden: false, zweiterFaktorAktiv: false });

const OHNE_ZWEITEN_FAKTOR: SitzungLesen = () =>
  Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: false });

const MIT_ZWEITEM_FAKTOR: SitzungLesen = () =>
  Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

const WEITER: TorEntscheidung = { art: 'weiter' };
const BLOCKIEREN: TorEntscheidung = { art: 'blockieren' };
const ZUR_ANMELDUNG: TorEntscheidung = { art: 'umleiten', ziel: '/anmelden' };
const ZUR_EINRICHTUNG: TorEntscheidung = { art: 'umleiten', ziel: '/zwei-faktor' };

function anonym(pfad: string): TorEntscheidung {
  return torEntscheidung({ pfad, sitzungVorhanden: false, zweiterFaktorAktiv: false });
}

function ohneZweitenFaktor(pfad: string): TorEntscheidung {
  return torEntscheidung({ pfad, sitzungVorhanden: true, zweiterFaktorAktiv: false });
}

function mitZweitemFaktor(pfad: string): TorEntscheidung {
  return torEntscheidung({ pfad, sitzungVorhanden: true, zweiterFaktorAktiv: true });
}

describe('torEntscheidung — anonyme Anfragen', () => {
  it.each([
    '/anmelden',
    '/anmelden/',
    '/anmelden/code',
    // Anmeldung mit Passkey (COPI-27): unter /anmelden, keine eigene Freigabe.
    '/anmelden/passkey/optionen',
    '/anmelden/passkey/pruefen',
    '/anmelden/passkey/skript.js',
    '/erststart/abc',
    '/einladung/ein-token',
    // Zugang wiederherstellen (COPI-28): der Link aus dem Server-Kommando, ohne Sitzung.
    '/zugang-wiederherstellen/ein-token',
    // Neue E-Mail-Adresse bestätigen (COPI-47): der Link aus der Mail, ohne Sitzung.
    '/email-bestaetigen/ein-token',
    '/gesund',
    '/abmelden',
    // Layout (COPI-30): Stylesheet und Schriften, damit auch die Anmeldeseite gestaltet ist.
    '/assets/cockpit.0123456789abcdef.css',
    '/assets/ibm-plex-sans.0123456789abcdef.woff2',
  ])('lässt den Allowlist-Pfad %s durch', (pfad) => {
    expect(anonym(pfad)).toEqual(WEITER);
  });

  it.each([
    '/',
    '/zwei-faktor',
    '/zwei-faktor/pruefen',
    '/zwei-faktor/passkey/optionen',
    '/zwei-faktor/passkey/pruefen',
    '/zwei-faktor/passkey/skript.js',
    '/modul/belegung',
    '/chat',
    '/irgendwas',
  ])('schickt den geschützten Pfad %s zur Anmeldung', (pfad) => {
    expect(anonym(pfad)).toEqual(ZUR_ANMELDUNG);
  });

  it.each(['/zugang-wiederherstellen', '/zugang-wiederherstellen/', '/ZUGANG-WIEDERHERSTELLEN'])(
    'beantwortet die Wiederherstellung ohne Token %s neutral, wie ein fehlendes Einladungsformular',
    (pfad) => {
      expect(anonym(pfad)).toEqual(BLOCKIEREN);
    },
  );

  it.each(['/email-bestaetigen', '/email-bestaetigen/', '/EMAIL-BESTAETIGEN'])(
    'beantwortet die Adressbestätigung ohne Token %s neutral (COPI-47)',
    (pfad) => {
      expect(anonym(pfad)).toEqual(BLOCKIEREN);
    },
  );

  it.each(['/einladung', '/einladung/'])(
    'beantwortet das Einladungsformular %s neutral (Vertrag aus COPI-11)',
    (pfad) => {
      // Kein Redirect: die Antwort darf nicht verraten, dass es die Route gibt.
      expect(anonym(pfad)).toEqual(BLOCKIEREN);
    },
  );

  it.each([
    '/api/auth/sign-in/email',
    '/api/auth/get-session',
    '/api/auth/sign-out',
    '/api/auth/two-factor/verify-totp',
    '/api/auth',
  ])('verbirgt den rohen Endpunkt %s', (pfad) => {
    expect(anonym(pfad)).toEqual(BLOCKIEREN);
  });

  it.each([
    // Andere Schreibweise, gleiche Wirkung: im Zweifel zur Anmeldung.
    '/ANMELDEN',
    '/%61nmelden',
    '//anmelden',
    '/anmelden/../modul',
  ])('behandelt die Pfadvariante %s nicht als Allowlist-Treffer', (pfad) => {
    expect(anonym(pfad)).not.toEqual(WEITER);
  });

  it.each([
    '/gesund/../api/auth/get-session',
    '/anmelden/../einladung',
    '/api/auth/%73ign-in/email',
  ])('greift auch bei der Umweg-Schreibweise %s', (pfad) => {
    expect(anonym(pfad)).toEqual(BLOCKIEREN);
  });
});

/**
 * Rohe Better-Auth-Endpunkte (COPI-20): auch mit Sitzung nur eine feste Liste.
 * Die Pfade stehen hier als Literale — würde der Test die Liste des Produktiv-
 * codes benutzen, rechnete er eine versehentlich erweiterte Freigabe einfach mit.
 */
const AUTH_FREIGEGEBEN = ['/api/auth/get-session', '/api/auth/sign-out'];

/** Gemessen in COPI-20 (Tabelle im Ticket) plus der Rest der Better-Auth-Endpunkte. */
const AUTH_ZU = [
  '/api/auth/list-sessions',
  '/api/auth/sign-in/email',
  '/api/auth/update-user',
  '/api/auth/change-email',
  '/api/auth/change-password',
  '/api/auth/revoke-sessions',
  '/api/auth/two-factor/get-totp-uri',
  '/api/auth/two-factor/generate-backup-codes',
  '/api/auth/two-factor/verify-totp',
  '/api/auth/two-factor/enable',
  '/api/auth/two-factor/disable',
  // Die Endpunkte des Better-Auth-Passkey-Plugins (COPI-26: bewusst nicht eingesetzt).
  '/api/auth/passkey/generate-register-options',
  '/api/auth/passkey/verify-registration',
  '/api/auth/passkey/list-user-passkeys',
  // Der Sitzungs-Endpunkt aus COPI-27 ist nur im Prozess erreichbar und hier ebenso zu.
  '/api/auth/cockpit/sitzung-nach-zweitem-faktor',
  '/api/auth',
  '/api/auth/',
];

/** Abwandlungen der freigegebenen Pfade: keine davon darf durch. */
const AUTH_ABWANDLUNGEN = [
  // Unterpfade und abschließender Schrägstrich: nur der exakte Pfad ist frei.
  '/api/auth/get-session/x',
  '/api/auth/get-session/',
  '/api/auth/sign-out/x',
  '/api/auth/sign-out/',
  // Groß-/Kleinschreibung und Prozent-Kodierung.
  '/API/AUTH/GET-SESSION',
  '/api/auth/Sign-Out',
  '/api/auth/%67et-session',
  '/api/auth/sign%2Dout',
  // Normalisierungs-Spielereien, auch mit Ziel auf einen gesperrten Endpunkt.
  '/api/auth/./get-session',
  '/api/auth/x/../get-session',
  '/gesund/../api/auth/get-session',
  '/api/auth/get-session/../update-user',
  '/api/auth/get-session%2F..%2Fupdate-user',
];

describe('torEntscheidung — Sitzung ohne zweiten Faktor', () => {
  it.each([
    '/zwei-faktor',
    '/zwei-faktor/einrichten',
    '/zwei-faktor/pruefen',
    // Passkey einrichten (COPI-26): dieselbe Ausnahme wie TOTP, keine eigene Freigabe.
    '/zwei-faktor/passkey/optionen',
    '/zwei-faktor/passkey/pruefen',
    '/zwei-faktor/passkey/skript.js',
    '/abmelden',
    '/erststart/abc',
    '/gesund',
    // Die Einrichtungsseite braucht ihr Stylesheet, bevor der zweite Faktor da ist (COPI-30).
    '/assets/cockpit.0123456789abcdef.css',
    ...AUTH_FREIGEGEBEN,
  ])('lässt die Ausnahme %s durch', (pfad) => {
    expect(ohneZweitenFaktor(pfad)).toEqual(WEITER);
  });

  it.each(['/', '/modul/belegung'])(
    'leitet den übrigen Pfad %s auf die Einrichtungsseite',
    (pfad) => {
      expect(ohneZweitenFaktor(pfad)).toEqual(ZUR_EINRICHTUNG);
    },
  );

  // COPI-20: kein Umleiten, sondern dieselbe neutrale 404 wie für Anonyme.
  it.each([...AUTH_ZU, ...AUTH_ABWANDLUNGEN])('verbirgt den rohen Endpunkt %s', (pfad) => {
    expect(ohneZweitenFaktor(pfad)).toEqual(BLOCKIEREN);
  });
});

describe('torEntscheidung — Sitzung mit zweitem Faktor', () => {
  it.each(['/', '/einladung', '/modul/belegung', '/anmelden', ...AUTH_FREIGEGEBEN])(
    'lässt %s durch',
    (pfad) => {
      expect(mitZweitemFaktor(pfad)).toEqual(WEITER);
    },
  );

  it.each([
    '/api/auth/sign-up',
    '/api/auth/sign-up/email',
    '/API/AUTH/Sign-Up/email',
    // Umwege über Normalisierung und Prozent-Kodierung greifen ebenfalls nicht.
    '/erststart/../api/auth/sign-up/email',
    '/api/auth/%73ign-up/email',
  ])('sperrt die Selbstregistrierung unter %s', (pfad) => {
    expect(mitZweitemFaktor(pfad)).toEqual(BLOCKIEREN);
  });

  // COPI-20: „Sitzung mit Faktor" öffnet den `/api/auth`-Baum nicht mehr.
  it.each([...AUTH_ZU, ...AUTH_ABWANDLUNGEN])('verbirgt den rohen Endpunkt %s', (pfad) => {
    expect(mitZweitemFaktor(pfad)).toEqual(BLOCKIEREN);
  });
});

describe('torEntscheidung — angemeldet oder nicht, dieselbe Auth-Liste', () => {
  it.each(AUTH_FREIGEGEBEN)('lässt %s nur mit Sitzung durch', (pfad) => {
    expect(anonym(pfad)).toEqual(BLOCKIEREN);
    expect(ohneZweitenFaktor(pfad)).toEqual(WEITER);
    expect(mitZweitemFaktor(pfad)).toEqual(WEITER);
  });

  it.each([...AUTH_ZU, ...AUTH_ABWANDLUNGEN])('verbirgt %s in allen drei Zuständen', (pfad) => {
    expect(anonym(pfad)).toEqual(BLOCKIEREN);
    expect(ohneZweitenFaktor(pfad)).toEqual(BLOCKIEREN);
    expect(mitZweitemFaktor(pfad)).toEqual(BLOCKIEREN);
  });
});

describe('Tor in der Anwendung', () => {
  it('schickt eine geschützte Route ohne Sitzung zur Anmeldung', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: ANONYM });

    const antwort = await app.inject({ method: 'GET', url: '/' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden');

    await app.close();
  });

  it('antwortet auf das Einladungsformular ohne Sitzung mit derselben neutralen Seite wie COPI-11', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: ANONYM });

    const antwort = await app.inject({ method: 'GET', url: '/einladung' });

    expect(antwort.statusCode).toBe(404);
    expect(antwort.headers['content-type']).toContain('text/html');
    expect(antwort.body).toContain('Nicht gefunden');
    expect(antwort.body).not.toContain('Nutzer einladen');

    await app.close();
  });

  it('verbirgt die rohen Better-Auth-Endpunkte ohne Sitzung', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: ANONYM });

    const antwort = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'wer@example.org', password: 'lang-genug-1234' },
    });

    expect(antwort.statusCode).toBe(404);

    await app.close();
  });

  it.each([
    ['ohne Sitzung', ANONYM],
    ['mit Sitzung ohne zweiten Faktor', OHNE_ZWEITEN_FAKTOR],
    ['mit Sitzung und zweitem Faktor', MIT_ZWEITEM_FAKTOR],
  ])('verbirgt einen nicht freigegebenen Better-Auth-Endpunkt %s mit der neutralen Seite', async (_, lesen) => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: lesen });

    const antwort = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/disable',
      payload: { password: 'lang-genug-1234' },
    });

    // Die neutrale HTML-Seite des Tors, nicht Fastifys JSON-404 einer fehlenden Route.
    expect(antwort.statusCode).toBe(404);
    expect(antwort.headers['content-type']).toContain('text/html');
    expect(antwort.body).toContain('Nicht gefunden');

    await app.close();
  });

  it('lässt den Health-Endpunkt ohne Sitzung durch', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: ANONYM });

    const antwort = await app.inject({ method: 'GET', url: '/gesund' });

    expect(antwort.statusCode).toBe(200);

    await app.close();
  });

  it('leitet eine geschützte Route ohne zweiten Faktor um', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: OHNE_ZWEITEN_FAKTOR });

    const antwort = await app.inject({ method: 'GET', url: '/' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/zwei-faktor');

    await app.close();
  });

  it('lässt dieselbe Route mit zweitem Faktor durch', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_ZWEITEM_FAKTOR });

    const antwort = await app.inject({ method: 'GET', url: '/' });

    expect(antwort.statusCode).toBe(200);

    await app.close();
  });

  it('beantwortet die Selbstregistrierung mit 404', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_ZWEITEM_FAKTOR });

    const antwort = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'wer@example.org', password: 'lang-genug-1234', name: 'Wer' },
    });

    expect(antwort.statusCode).toBe(404);

    await app.close();
  });
});

/**
 * Die Agenten-API unter `/intern` (COPI-35). Das Tor lässt den Präfix ohne Sitzung und ohne zweiten
 * Faktor durch — dort prüft die Route selbst ein Bearer-Token (`src/intern/zugang.ts`). Das ist die
 * **einzige** Ausnahme von „Sitzung und zweiter Faktor vor jeder Route", deshalb ist sie eng:
 * freigegeben nur, wenn **jede** Schreibweise des Pfades auf `/intern` zeigt, wie bei den
 * Freigaben für Anonyme. Was nur in einer Schreibweise nach `/intern` aussieht, bleibt zu.
 */
describe('torEntscheidung — die Pipeline-API unter /pipeline (COPI-145)', () => {
  it.each(['/pipeline', '/pipeline/', '/pipeline/claim', '/pipeline/complete'])('lässt %s in jedem Zustand durch: die Route prüft die Signatur', (pfad) => {
    expect(anonym(pfad)).toEqual(WEITER);
    expect(ohneZweitenFaktor(pfad)).toEqual(WEITER);
    expect(mitZweitemFaktor(pfad)).toEqual(WEITER);
  });

  it.each(['/PIPELINE/claim', '/%70ipeline/claim', '/pipeline%2Fclaim', '/pipelines/claim', '/x/pipeline/claim', '/pipeline/../admin'])(
    'lässt die Schreibweise %s für Anonyme nicht als Pipeline-API durch',
    (pfad) => {
      expect(anonym(pfad)).not.toEqual(WEITER);
    },
  );

  it('öffnet über /pipeline/.. keinen rohen Better-Auth-Endpunkt', () => {
    expect(anonym('/pipeline/../api/auth/sign-in/email')).toEqual(BLOCKIEREN);
  });
});

describe('torEntscheidung — die Agenten-API unter /intern', () => {
  const INTERN_PFADE = ['/intern', '/intern/', '/intern/befund', '/intern/eingriffe/7', '/intern/ping'];

  it.each(INTERN_PFADE)('lässt %s in jedem Zustand durch: die Route prüft das Token', (pfad) => {
    expect(anonym(pfad)).toEqual(WEITER);
    expect(ohneZweitenFaktor(pfad)).toEqual(WEITER);
    expect(mitZweitemFaktor(pfad)).toEqual(WEITER);
  });

  it.each([
    '/INTERN/befund',
    '/Intern/befund',
    '/%69ntern/befund',
    '/intern%2Fbefund',
    '/internal',
    '/interne/befund',
    '/intern-alt/befund',
    '/x/intern/befund',
    '//intern/befund',
    '/anmelden/../intern/befund',
    '/intern/../anmelden',
    '/intern/../zwei-faktor',
    '/intern/..%2F..%2Fadmin',
  ])('lässt die Schreibweise %s für Anonyme nicht als Agenten-API durch', (pfad) => {
    // Eine Schreibweise, die nicht in jeder Auslegung `/intern` ist, öffnet nichts: Anonyme werden weggeschickt.
    expect(anonym(pfad)).not.toEqual(WEITER);
  });

  it.each(['/intern/../api/auth/get-session', '/intern/../api/auth/sign-in/email', '/intern/../api/auth/sign-up/email'])(
    'öffnet über %s keinen rohen Better-Auth-Endpunkt',
    (pfad) => {
      expect(anonym(pfad)).toEqual(BLOCKIEREN);
      expect(ohneZweitenFaktor(pfad)).toEqual(BLOCKIEREN);
      expect(mitZweitemFaktor(pfad)).toEqual(BLOCKIEREN);
    },
  );

  it('ändert nichts an den übrigen Pfaden: ohne Sitzung bleibt alles andere zu', () => {
    expect(anonym('/')).toEqual(ZUR_ANMELDUNG);
    expect(anonym('/modul/belegung')).toEqual(ZUR_ANMELDUNG);
    expect(ohneZweitenFaktor('/')).toEqual(ZUR_EINRICHTUNG);
  });
});

describe('Tor in der Anwendung — die Agenten-API', () => {
  it('liest für /intern nie eine Sitzung: ein Cookie schaltet dort nichts frei und kostet keine Abfrage', async () => {
    let gelesen = 0;
    const zaehlend: SitzungLesen = () => {
      gelesen += 1;
      return Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
    };
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: zaehlend });

    await app.inject({ method: 'GET', url: '/intern/befund', headers: { cookie: 'better-auth.session=x' } });
    await app.inject({ method: 'POST', url: '/intern/befund', headers: { cookie: 'better-auth.session=x' } });

    expect(gelesen).toBe(0);
    await app.close();
  });

  it('liest für jeden anderen Pfad weiterhin die Sitzung', async () => {
    let gelesen = 0;
    const zaehlend: SitzungLesen = () => {
      gelesen += 1;
      return Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
    };
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: zaehlend });

    await app.inject({ method: 'GET', url: '/' });
    await app.inject({ method: 'GET', url: '/INTERN/befund' });

    expect(gelesen).toBe(2);
    await app.close();
  });
});
