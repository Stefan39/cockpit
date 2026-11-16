/**
 * Der Posteingang (COPI-112) ohne Datenbank: der Abschnitt `posteingang:` im Block, das Zusammenführen der Quellen, die
 * Zahl an „Nachrichten", der Rücksprung nach „Alle als gelesen" und die Vorlage des Badges (Escaping, „99+", Filter erst
 * mit Skript).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modulBlockPruefen } from '../src/module/block.js';
import {
  anrissKuerzen,
  postfachAnsicht,
  postfachDetailPfad,
  posteingangAnsicht,
  POSTEINGANG_HOECHSTENS,
  type PosteingangAnsicht,
  type PosteingangEintrag,
} from '../src/posteingang/posteingang.js';
import { navigation } from '../src/server/navigation.js';
import { buildApp } from '../src/server/app.js';
import { zurueckZu } from '../src/server/routes/posteingang.js';

const BLOCK = {
  kennung: 'kommunikation',
  menuename: 'Kommunikation',
  ansicht: 'liste-detail',
  view: 'v_modul_kommunikation',
  spalten: [
    { name: 'zusammenfassung', label: 'Worum es geht' },
    { name: 'eingang', label: 'Eingang', format: 'zeitpunkt' },
    { name: 'text', label: 'Nachricht', format: 'langtext' },
  ],
  rollen: ['betreuer', 'betriebs_admin'],
  eingriffe: [],
};

function grund(daten: unknown): string {
  const ergebnis = modulBlockPruefen(daten);
  expect(ergebnis.ok).toBe(false);
  return ergebnis.ok ? '' : ergebnis.grund;
}

describe('modulBlockPruefen — der Abschnitt posteingang: (COPI-112)', () => {
  it('nimmt Anriss und Zeit aus deklarierten Spalten an', () => {
    const ergebnis = modulBlockPruefen({ ...BLOCK, posteingang: { anriss: 'zusammenfassung', zeit: 'eingang' } });
    expect(ergebnis.ok && ergebnis.block.posteingang).toEqual({ anriss: 'zusammenfassung', zeit: 'eingang' });
  });

  it('bleibt ohne den Abschnitt wie bisher', () => {
    const ergebnis = modulBlockPruefen(BLOCK);
    expect(ergebnis.ok && ergebnis.block.posteingang).toBeUndefined();
  });

  it.each([
    ['eine nicht deklarierte Anriss-Spalte', { anriss: 'betreff', zeit: 'eingang' }, 'posteingang.anriss: Die Spalte „betreff" ist nicht in spalten deklariert.'],
    ['einen Langtext als Anriss', { anriss: 'text', zeit: 'eingang' }, 'posteingang.anriss: Ein Langtext oder Link gehört nicht in den Posteingang (COPI-103, COPI-91).'],
    ['eine nicht deklarierte Zeit', { anriss: 'zusammenfassung', zeit: 'empfangen' }, 'posteingang.zeit: Die Spalte „empfangen" ist nicht in spalten deklariert.'],
    ['eine Zeit, die kein Zeitpunkt ist', { anriss: 'zusammenfassung', zeit: 'zusammenfassung' }, 'posteingang.zeit: muss eine Spalte im Format „zeitpunkt" sein.'],
  ])('weist %s ab', (_fall, posteingang, meldung) => {
    expect(grund({ ...BLOCK, posteingang })).toContain(meldung);
  });

  it('weist unbekannte Felder und ungültige Bezeichner ab', () => {
    expect(grund({ ...BLOCK, posteingang: { anriss: 'zusammenfassung', zeit: 'eingang', titel: 'x' } })).toContain('posteingang.titel: unbekanntes Feld');
    expect(grund({ ...BLOCK, posteingang: { anriss: 'Zusammen fassung', zeit: 'eingang' } })).toContain('posteingang.anriss');
  });

  it('gibt es nur bei Liste+Detail', () => {
    const kennzahlen = {
      ...BLOCK,
      ansicht: 'kennzahlen',
      view: 'v_modul_ki_verbrauch',
      spalten: [{ name: 'wert', label: 'Kosten', format: 'euro' }],
      posteingang: { anriss: 'wert', zeit: 'wert' },
    };
    expect(grund(kennzahlen)).toContain('posteingang: nur für den Ansichtstyp „liste-detail" möglich.');
  });
});

const JETZT = new Date('2026-10-02T10:00:00.000Z');

function eintrag(quelle: PosteingangEintrag['quelle'], minutenVorher: number, titel = 'Titel'): PosteingangEintrag {
  return { quelle, herkunft: quelle, titel, anriss: 'Text', zeit: new Date(JETZT.getTime() - minutenVorher * 60_000), href: `/${quelle}` };
}

describe('posteingangAnsicht', () => {
  it('führt die Quellen zusammen, jüngste zuerst, und zählt je Quelle', () => {
    const ansicht = posteingangAnsicht(
      {
        chat: { anzahl: 5, eintraege: [eintrag('chat', 40, 'Chat')] },
        postfach: { anzahl: 2, eintraege: [eintrag('postfach', 12, 'Mail')], je: { kommunikation: 2 } },
        meldung: { anzahl: 1, eintraege: [{ ...eintrag('meldung', 120, 'Meldung'), rot: true }] },
      },
      JETZT,
    );

    expect(ansicht.gesamt).toBe(8);
    expect(ansicht.zahlen).toEqual({ freigabe: 0, chat: 5, postfach: 2, meldung: 1 });
    expect(ansicht.postfaecher).toEqual({ kommunikation: 2 });
    expect(ansicht.eintraege.map((e) => [e.titel, e.zeit, e.rot])).toEqual([
      ['Mail', 'vor 12 Min.', false],
      ['Chat', 'vor 40 Min.', false],
      ['Meldung', 'vor 2 Std.', true],
    ]);
  });

  it('zeigt höchstens zwanzig Einträge, zählt aber alle', () => {
    const viele = Array.from({ length: 30 }, (_, i) => eintrag('chat', i));
    const ansicht = posteingangAnsicht({ chat: { anzahl: 30, eintraege: viele } }, JETZT);
    expect(ansicht.eintraege).toHaveLength(POSTEINGANG_HOECHSTENS);
    expect(ansicht.gesamt).toBe(30);
  });

  it('ist ohne Quellen leer, und eine Zeit in der Zukunft gilt als „gerade eben"', () => {
    expect(posteingangAnsicht({}, JETZT)).toEqual({ gesamt: 0, zahlen: { freigabe: 0, chat: 0, postfach: 0, meldung: 0 }, eintraege: [], postfaecher: {} });
    expect(posteingangAnsicht({ chat: { anzahl: 1, eintraege: [eintrag('chat', -5)] } }, JETZT).eintraege[0]?.zeit).toBe('gerade eben');
  });
});

describe('anrissKuerzen', () => {
  it('zieht Leerraum zusammen und kürzt mit „…" auf die Zeichenzahl', () => {
    expect(anrissKuerzen('  Hallo\n\n  Welt  ')).toBe('Hallo Welt');
    expect(anrissKuerzen('a'.repeat(200))).toBe(`${'a'.repeat(139)}…`);
    expect(Array.from(anrissKuerzen('ä'.repeat(200), 10))).toHaveLength(10);
  });
});

describe('postfachAnsicht', () => {
  it('verlinkt jede Zeile mit der Herkunft Nachrichten, mit Status als Wort, und ersetzt Leeres', () => {
    const [zeile] = postfachAnsicht(
      'kommunikation',
      [{ id: 'a/b', titel: '', status: 'gelb', anriss: 'Text', zeit: undefined, ungelesen: true }],
      JETZT,
    );
    expect(zeile).toMatchObject({ href: '/module/kommunikation/a%2Fb?von=nachrichten', titel: '—', zeit: '—', ungelesen: true });
    expect(zeile?.status.farbe).toBe('gelb');
    expect(postfachDetailPfad('kommunikation', 'x')).toBe('/module/kommunikation/x?von=nachrichten');
  });
});

describe('navigation — „Nachrichten" und Posteingang (COPI-112)', () => {
  const rechte = { angemeldet: true, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 7 };
  const posteingang: PosteingangAnsicht = { gesamt: 6, zahlen: { freigabe: 0, chat: 2, postfach: 3, meldung: 1 }, eintraege: [], postfaecher: {} };

  it('zählt an „Nachrichten" Chats und Postfächer aus dem Posteingang, nicht die Meldungen', () => {
    const nav = navigation('uebersicht', { ...rechte, posteingang });
    expect(nav.eintraege[1]).toMatchObject({ text: 'Nachrichten', href: '/chat', ungelesen: 5 });
    expect(nav.posteingang).toBe(posteingang);
  });

  it('nimmt ohne Posteingang die Zahl des Chats, und ohne Recht gibt es keine', () => {
    expect(navigation('uebersicht', rechte).eintraege[1]?.ungelesen).toBe(7);
    expect(navigation('uebersicht', rechte).posteingang).toBeUndefined();
    expect(navigation('uebersicht', { ...rechte, chat: false, posteingang }).eintraege[1]?.ungelesen).toBeUndefined();
  });
});

describe('zurueckZu — nach „Alle als gelesen"', () => {
  it.each([
    ['https://cockpit.example.org/chat/team?vor=3', '/chat/team?vor=3'],
    ['https://fremd.example.org/chat', '/'],
    ['kein url', '/'],
    [undefined, '/'],
  ])('%s → %s', (referer, ziel) => {
    expect(zurueckZu(referer, 'cockpit.example.org')).toBe(ziel);
  });
});

describe('Vorlage des Badges', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({ nodeEnv: 'test' });
  });
  afterAll(async () => {
    await app.close();
  });

  const POSTEINGANG: PosteingangAnsicht = {
    gesamt: 120,
    zahlen: { freigabe: 0, chat: 0, postfach: 120, meldung: 0 },
    postfaecher: {},
    eintraege: [
      { quelle: 'postfach', herkunft: 'Kommunikation', titel: '<img src=x onerror=alert(1)>', anriss: 'Siehe https://boese.example.org', zeit: 'vor 2 Min.', href: '/module/kommunikation/m1?von=nachrichten', rot: false },
    ],
  };

  it('escaped Fremdtexte, verlinkt nichts darin und zeigt „99+"', async () => {
    const html = await app.render('partials/posteingang.eta', { posteingang: POSTEINGANG });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="https://boese.example.org"');
    expect(html).toContain('>99+</span>');
    expect(html).toContain('aria-label="Posteingang, 120 ungelesen"');
    expect(html).toContain('1 von 120');
  });

  it('blendet die Filter erst mit Skript ein und bietet nur Quellen mit Ungelesenem an', async () => {
    const html = await app.render('partials/posteingang.eta', { posteingang: POSTEINGANG });
    expect(html).toMatch(/data-posteingang-filter hidden/);
    expect(html).toContain('Mails · 99+');
    expect(html).not.toContain('Chat · 0');
    expect(html).not.toContain('Meldungen · ');
  });

  it('zeigt ohne Ungelesenes keinen Zähler und kein „Alle als gelesen"', async () => {
    const html = await app.render('partials/posteingang.eta', { posteingang: { gesamt: 0, zahlen: { freigabe: 0, chat: 0, postfach: 0, meldung: 0 }, eintraege: [], postfaecher: {} } });
    expect(html).toContain('aria-label="Posteingang, nichts ungelesen"');
    expect(html).not.toContain('posteingang-zahl');
    expect(html).not.toContain('/posteingang/gelesen');
    expect(html).toContain('Alles gelesen.');
  });
});
