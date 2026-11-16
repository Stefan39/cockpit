/**
 * Die Navigation der angemeldeten Seiten (COPI-38, neu gefasst mit COPI-43 nach dem Prototyp): fünf Einträge in
 * Sidebar (Desktop) und Tab-Leiste (mobil) — Übersicht, Chat, Module, Meldungen, Mehr. Module gibt es noch nicht (E5):
 * der Eintrag steht da, ist aber ausgegraut und kein Link — wie der Chat ohne Recht `chat_nutzen` (COPI-53). „Mehr" sammelt Agenten, Zeitplan,
 * Einstellungen und Einladen; auf diesen Seiten ist „Mehr" markiert, wie im Prototyp bei den Einstellungen.
 */
import { describe, expect, it } from 'vitest';
import { OHNE_ZUGANG, type Rolle, type Zugang } from '../src/auth/berechtigung.js';
import { navigation, navigationFuerZugang, type NavSeite } from '../src/server/navigation.js';

function zugang(rolle: Rolle | undefined, zweiterFaktorAktiv = true): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv, benutzerId: 'konto-1' };
}

const texte = (eintraege: readonly { text: string }[]): string[] => eintraege.map((eintrag) => eintrag.text);

describe('navigation — Haupteinträge', () => {
  it('führt die fünf Einträge des Prototyps in dieser Reihenfolge, mit Symbol', () => {
    const { eintraege } = navigation('uebersicht', { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 });

    expect(eintraege).toEqual([
      { text: 'Übersicht', symbol: 'haus', href: '/', aktuell: true, folgt: false, ungelesen: undefined, nurMobil: false, nurDesktop: false, punkt: false },
      { text: 'Nachrichten', symbol: 'chat', href: '/chat', aktuell: false, folgt: false, ungelesen: undefined, nurMobil: false, nurDesktop: false, punkt: false },
      { text: 'Module', symbol: 'module', href: undefined, aktuell: false, folgt: true, ungelesen: undefined, nurMobil: false, nurDesktop: false, punkt: false },
      { text: 'Meldungen', symbol: 'glocke', href: '/meldungen', aktuell: false, folgt: false, ungelesen: undefined, nurMobil: false, nurDesktop: false, punkt: false },
      { text: 'Mehr', symbol: 'mehr', href: '/mehr', aktuell: false, folgt: false, ungelesen: undefined, nurMobil: true, nurDesktop: false, punkt: false },
    ]);
  });

  it('führt „Mehr" nur mobil: am Desktop stehen seine Einträge als Gruppe „Verwaltung" in der Sidebar (COPI-108)', () => {
    const { eintraege } = navigation('agenten', { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 });

    expect(eintraege.filter((eintrag) => eintrag.nurMobil).map((eintrag) => eintrag.text)).toEqual(['Mehr']);
  });

  it('gibt Einträgen, die es noch nicht gibt, keinen Link: ausgegraut, nie eine 404', () => {
    const { eintraege } = navigation('uebersicht', { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 });

    for (const eintrag of eintraege.filter((kandidat) => kandidat.folgt)) {
      expect(eintrag.href, eintrag.text).toBeUndefined();
      expect(eintrag.aktuell, eintrag.text).toBe(false);
    }
  });

  it('führt den Chat nur mit dem Recht als Link, und mit der Zahl ungelesener Nachrichten (COPI-53)', () => {
    const chat = (rechte: { chat: boolean; chatUngelesen: number }) =>
      navigation('uebersicht', { angemeldet: true, einladen: false, benutzerSehen: false, ...rechte }).eintraege[1];

    expect(chat({ chat: true, chatUngelesen: 3 })).toMatchObject({ href: '/chat', folgt: false, ungelesen: 3 });
    expect(chat({ chat: true, chatUngelesen: 0 })).toMatchObject({ href: '/chat', ungelesen: undefined });
    expect(chat({ chat: false, chatUngelesen: 3 })).toMatchObject({ href: undefined, folgt: true, ungelesen: undefined });
  });

  it('übernimmt Recht und Zahl aus dem Zugang; ohne Zugang kein Chat-Link', () => {
    expect(navigationFuerZugang('chat', { ...zugang('betrieb_mitarbeiter'), chatUngelesen: 2 }).eintraege[1]).toMatchObject({
      href: '/chat',
      aktuell: true,
      ungelesen: 2,
    });
    expect(navigationFuerZugang('chat', zugang(undefined)).eintraege[1]).toMatchObject({ href: undefined, folgt: true });
    expect(navigationFuerZugang('chat', undefined).eintraege[1]).toMatchObject({ href: undefined, folgt: true });
  });

  it.each<[NavSeite, string]>([
    ['uebersicht', 'Übersicht'],
    ['chat', 'Nachrichten'],
    ['meldungen', 'Meldungen'],
    ['mehr', 'Mehr'],
    ['agenten', 'Mehr'],
    ['zeitplan', 'Mehr'],
    ['einstellungen', 'Mehr'],
    ['einladung', 'Mehr'],
  ])('markiert auf der Seite %s genau den Eintrag „%s"', (seite, text) => {
    const { eintraege } = navigation(seite, { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 });

    expect(eintraege.filter((eintrag) => eintrag.aktuell).map((eintrag) => eintrag.text)).toEqual([text]);
  });
});

describe('navigation — Mehr', () => {
  it('sammelt — mit den Rechten — Benutzer, dann Agenten, Zeitplan, Einstellungen und Einladen (Reihenfolge der ADR)', () => {
    expect(navigation('mehr', { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 }).mehr).toEqual([
      { text: 'Benutzer', symbol: 'personen', href: '/benutzer', aktuell: false, nurMobil: false, punkt: false },
      { text: 'Agenten', symbol: 'agenten', href: '/agenten', aktuell: false, nurMobil: false, punkt: false },
      { text: 'Zeitplan', symbol: 'uhr', href: '/zeitplan', aktuell: false, nurMobil: false, punkt: false },
      { text: 'Einstellungen', symbol: 'zahnrad', href: '/einstellungen', aktuell: false, nurMobil: false, punkt: false },
      { text: 'Einladen', symbol: 'person', href: '/einladung', aktuell: false, nurMobil: false, punkt: false },
    ]);
  });

  it('bietet „Einladen" nur mit dem Recht dazu an: kein Link, der auf eine 404 führt', () => {
    expect(texte(navigation('mehr', { angemeldet: true, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 0 }).mehr)).toEqual(['Agenten', 'Zeitplan', 'Einstellungen']);
  });

  it('bietet „Benutzer" nur mit dem Recht dazu an (COPI-45)', () => {
    expect(texte(navigation('mehr', { angemeldet: true, einladen: false, benutzerSehen: true, chat: true, chatUngelesen: 0 }).mehr)).toEqual([
      'Benutzer',
      'Agenten',
      'Zeitplan',
      'Einstellungen',
    ]);
    expect(texte(navigation('mehr', { angemeldet: true, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 0 }).mehr)).not.toContain('Benutzer');
  });

  it('markiert die Unterseite, auf der man ist', () => {
    const { mehr } = navigation('zeitplan', { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 });

    expect(mehr.filter((eintrag) => eintrag.aktuell).map((eintrag) => eintrag.text)).toEqual(['Zeitplan']);
  });
});

describe('navigation — Pfad und Abmelden', () => {
  it.each<[NavSeite, string]>([
    ['uebersicht', '/'],
    ['meldungen', '/meldungen'],
    ['mehr', '/mehr'],
    ['benutzer', '/benutzer'],
    ['agenten', '/agenten'],
    ['zeitplan', '/zeitplan'],
    ['einstellungen', '/einstellungen'],
    ['einladung', '/einladung'],
  ])('kennt für %s den eigenen Pfad %s (Rücksprung des Dark-Mode-Schalters)', (seite, pfad) => {
    expect(navigation(seite, { angemeldet: true, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 0 }).pfad).toBe(pfad);
  });

  it('bietet das Abmelden nur mit einer Sitzung an', () => {
    expect(navigation('uebersicht', { angemeldet: false, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 0 }).abmelden).toBe(false);
    expect(navigation('uebersicht', { angemeldet: true, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 0 }).abmelden).toBe(true);
  });
});

describe('navigationFuerZugang', () => {
  it.each([
    ['betreuer', true],
    ['betriebs_admin', true],
    ['betrieb_mitarbeiter', false],
  ] as const)('gibt der Rolle %s „Einladen": %s', (rolle, einladen) => {
    const nav = navigationFuerZugang('mehr', zugang(rolle));

    expect(texte(nav.mehr).includes('Einladen')).toBe(einladen);
    expect(nav.abmelden).toBe(true);
  });

  it.each([
    ['betreuer', true],
    ['betriebs_admin', true],
    ['betrieb_mitarbeiter', false],
  ] as const)('gibt der Rolle %s „Benutzer": %s (COPI-45)', (rolle, sichtbar) => {
    expect(texte(navigationFuerZugang('mehr', zugang(rolle)).mehr).includes('Benutzer')).toBe(sichtbar);
  });

  it('zeigt einem Konto ohne aktiven zweiten Faktor kein „Einladen": dieselbe Regel wie die Route', () => {
    expect(texte(navigationFuerZugang('mehr', zugang('betreuer', false)).mehr)).not.toContain('Einladen');
  });

  it('zeigt einer unbekannten Rolle alles ohne Recht, mit Abmelden', () => {
    const nav = navigationFuerZugang('mehr', zugang(undefined));

    expect(texte(nav.mehr)).toEqual(['Agenten', 'Zeitplan', 'Einstellungen']);
    expect(nav.abmelden).toBe(true);
  });

  it.each([
    ['ohne Zugangsleser (keine Anmeldung eingerichtet)', undefined],
    ['ohne Sitzung', OHNE_ZUGANG],
  ] as const)('bietet %s kein Abmelden an', (_name, ohne) => {
    const nav = navigationFuerZugang('uebersicht', ohne);

    expect(nav.abmelden).toBe(false);
    expect(texte(nav.mehr)).toEqual(['Agenten', 'Zeitplan', 'Einstellungen']);
  });
});

describe('navigation — Hinweis „Update verfügbar" (COPI-84)', () => {
  const rechte = { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 };

  it('reicht den Hinweis mit dem Text der Wache durch', () => {
    expect(navigation('mehr', { ...rechte, updateVerfuegbar: { text: 'verfügbar: 0.7.0' } }).updateHinweis).toEqual({ text: 'verfügbar: 0.7.0' });
  });

  it('hat ohne Angabe keinen Hinweis', () => {
    expect(navigation('mehr', rechte).updateHinweis).toBeUndefined();
  });

  it('zeigt den Hinweis dem Betreuer, aber nie einer Kundenrolle — auch nicht, wenn der Zugang ihn trägt', () => {
    const mitHinweis = (rolle: Rolle) => navigationFuerZugang('mehr', { ...zugang(rolle), updateVerfuegbar: { text: 'x' } }).updateHinweis;

    expect(mitHinweis('betreuer')).toEqual({ text: 'x' });
    expect(mitHinweis('betriebs_admin')).toBeUndefined();
    expect(mitHinweis('betrieb_mitarbeiter')).toBeUndefined();
    expect(navigationFuerZugang('mehr', undefined).updateHinweis).toBeUndefined();
  });
});

describe('navigation — angeheftete Module (COPI-121)', () => {
  const rechte = { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0, module: true };
  const akquise = { kennung: 'akquise', menuename: 'Akquise' };
  const posteingang = (postfaecher: Record<string, number>, chat = 0) => ({
    gesamt: 0,
    zahlen: { freigabe: 0, chat, postfach: Object.values(postfaecher).reduce((a, b) => a + b, 0), meldung: 0 },
    eintraege: [],
    postfaecher,
  });

  it('setzt ein angeheftetes Modul direkt unter „Nachrichten", mit Link auf die Modulseite', () => {
    const { eintraege } = navigation('uebersicht', { ...rechte, angeheftet: [akquise] });

    expect(texte(eintraege)).toEqual(['Übersicht', 'Nachrichten', 'Akquise', 'Module', 'Meldungen', 'Mehr']);
    expect(eintraege[2]).toEqual({ text: 'Akquise', symbol: 'koffer', href: '/module/akquise', aktuell: false, folgt: false, ungelesen: undefined, nurMobil: false, nurDesktop: false, punkt: false });
  });

  it('trägt die ungelesenen Zeilen seines Postfachs — und „Nachrichten" zählt sie nicht mehr mit', () => {
    const { eintraege } = navigation('uebersicht', { ...rechte, angeheftet: [akquise], posteingang: posteingang({ akquise: 3, kommunikation: 2 }, 1) });

    expect(eintraege[1]).toMatchObject({ text: 'Nachrichten', ungelesen: 3 });
    expect(eintraege[2]).toMatchObject({ text: 'Akquise', ungelesen: 3 });
  });

  it('zeigt ohne Ungelesenes keine Zahl; „Nachrichten" ohne übrige Zeilen ebenfalls keine', () => {
    const { eintraege } = navigation('uebersicht', { ...rechte, angeheftet: [akquise], posteingang: posteingang({ akquise: 0 }) });

    expect(eintraege[1]?.ungelesen).toBeUndefined();
    expect(eintraege[2]?.ungelesen).toBeUndefined();
  });

  it('nimmt mobil den Platz von „Meldungen" ein: Meldungen nur am Desktop, dafür unter „Mehr" (nur mobil)', () => {
    const nav = navigation('uebersicht', { ...rechte, angeheftet: [akquise] });

    expect(nav.eintraege.find((eintrag) => eintrag.text === 'Meldungen')).toMatchObject({ nurDesktop: true, nurMobil: false, punkt: false });
    expect(nav.mehr[0]).toEqual({ text: 'Meldungen', symbol: 'glocke', href: '/meldungen', aktuell: false, nurMobil: true, punkt: false });
  });

  it('lässt ohne angeheftetes Modul alles wie bisher: Meldungen in der Tab-Leiste, nicht unter „Mehr"', () => {
    const nav = navigation('uebersicht', rechte);

    expect(nav.eintraege.every((eintrag) => !eintrag.nurDesktop)).toBe(true);
    expect(texte(nav.mehr)).not.toContain('Meldungen');
  });

  it('führt mobil höchstens ein angeheftetes Modul: weitere stehen nur in der Sidebar', () => {
    const { eintraege } = navigation('uebersicht', { ...rechte, angeheftet: [akquise, { kennung: 'social', menuename: 'Social' }] });

    expect(eintraege.filter((eintrag) => !eintrag.nurDesktop).map((eintrag) => eintrag.text)).toEqual(['Übersicht', 'Nachrichten', 'Akquise', 'Module', 'Mehr']);
  });

  it('markiert auf der Modulseite das angeheftete Modul statt „Module"', () => {
    const { eintraege } = navigation('module', { ...rechte, angeheftet: [akquise] }, 'akquise');

    expect(eintraege.filter((eintrag) => eintrag.aktuell).map((eintrag) => eintrag.text)).toEqual(['Akquise']);
    expect(navigation('module', { ...rechte, angeheftet: [akquise] }, 'kommunikation').eintraege.filter((eintrag) => eintrag.aktuell).map((eintrag) => eintrag.text)).toEqual(['Module']);
  });

  it('markiert auf „Meldungen" mobil „Mehr" mit, weil Meldungen dort liegt', () => {
    const { eintraege, mehr } = navigation('meldungen', { ...rechte, angeheftet: [akquise] });

    expect(eintraege.filter((eintrag) => eintrag.aktuell).map((eintrag) => eintrag.text)).toEqual(['Meldungen', 'Mehr']);
    expect(mehr.filter((eintrag) => eintrag.aktuell).map((eintrag) => eintrag.text)).toEqual(['Meldungen']);
  });

  it('übernimmt die angehefteten Module aus dem Zugang', () => {
    const nav = navigationFuerZugang('module', { ...zugang('betreuer'), moduleSichtbar: true, moduleAngeheftet: [akquise] }, 'akquise');

    expect(nav.eintraege[2]).toMatchObject({ text: 'Akquise', aktuell: true });
    expect(texte(navigationFuerZugang('uebersicht', zugang('betreuer')).eintraege)).not.toContain('Akquise');
  });
});
