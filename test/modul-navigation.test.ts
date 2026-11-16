/**
 * Angeheftete Module (COPI-121): das Block-Feld `navigation: haupt`, der Zielpfad der Posteingang-Einträge und das Markup
 * der Navigation — Sidebar mit „Akquise" unter „Nachrichten", mobil statt „Meldungen", Meldungen dann unter „Mehr".
 * Die Regeln der Navigation selbst prüft `navigation.test.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Zugang } from '../src/auth/berechtigung.js';
import { inHauptnavigation, modulBlockPruefen } from '../src/module/block.js';
import { posteingangZielPfad } from '../src/posteingang/posteingang.js';
import { buildApp } from '../src/server/app.js';

const BLOCK = {
  kennung: 'akquise',
  menuename: 'Akquise',
  ansicht: 'liste-detail',
  view: 'v_modul_akquise',
  spalten: [{ name: 'titel', label: 'Titel' }],
  rollen: ['betreuer'],
  eingriffe: [],
};

describe('Block-Feld navigation (COPI-121)', () => {
  it('nimmt „haupt" an; ohne Feld bleibt das Modul nur unter „Module"', () => {
    const mit = modulBlockPruefen({ ...BLOCK, navigation: 'haupt' });
    const ohne = modulBlockPruefen(BLOCK);

    expect(mit.ok && inHauptnavigation(mit.block)).toBe(true);
    expect(ohne.ok && inHauptnavigation(ohne.block)).toBe(false);
  });

  it.each(['Haupt', 'seite', '', true])('lehnt den Wert %j ab', (wert) => {
    const ergebnis = modulBlockPruefen({ ...BLOCK, navigation: wert });

    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.ok ? '' : ergebnis.grund).toContain('navigation');
  });
});

describe('posteingangZielPfad', () => {
  it('führt ins Postfach unter „Nachrichten", bei einem angehefteten Modul auf seine eigene Detailseite', () => {
    expect(posteingangZielPfad('kommunikation', 'a/b', false)).toBe('/module/kommunikation/a%2Fb?von=nachrichten');
    expect(posteingangZielPfad('akquise', 'a/b', true)).toBe('/module/akquise/a%2Fb');
  });
});

describe('Navigation mit angeheftetem Modul (Markup)', () => {
  let app: FastifyInstance;
  const zugang: Zugang = {
    angemeldet: true,
    rolle: 'betreuer',
    zweiterFaktorAktiv: true,
    benutzerId: 'konto-1',
    moduleSichtbar: true,
    moduleAngeheftet: [{ kennung: 'akquise', menuename: 'Akquise' }],
    posteingang: { gesamt: 3, zahlen: { freigabe: 0, chat: 0, postfach: 3, meldung: 0 }, eintraege: [], postfaecher: { akquise: 3 } },
  };

  beforeAll(async () => {
    app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true }), zugangLesen: () => Promise.resolve(zugang) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function hauptnav(url: string): Promise<string> {
    const antwort = await app.inject({ method: 'GET', url });
    expect(antwort.statusCode, url).toBe(200);
    return /<nav class="hauptnav" aria-label="Hauptnavigation">([^]*?)<\/nav>/.exec(antwort.body)?.[1] ?? '';
  }

  it('setzt „Akquise" mit Zahl unter „Nachrichten" und führt „Meldungen" nur am Desktop', async () => {
    const nav = await hauptnav('/mehr');

    expect([...nav.matchAll(/<a href="([^"]+)" class="hauptnav-eintrag"/g)].map((m) => m[1])).toEqual(['/', '/chat', '/module/akquise', '/module', '/meldungen', '/mehr']);
    expect(nav).toMatch(/<a href="\/module\/akquise" class="hauptnav-eintrag">.*<span>Akquise<\/span><span class="hauptnav-zahl"><span aria-hidden="true">3<\/span>/s);
    expect(nav).toMatch(/<li class="hauptnav-nur-desktop">\s*<a href="\/meldungen"/);
  });

  it('führt „Meldungen" auf „Mehr", aber nicht in der Gruppe „Verwaltung" der Sidebar', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/mehr' });
    const verwaltung = /<nav class="verwaltungsnav" aria-label="Verwaltung">([^]*?)<\/nav>/.exec(antwort.body)?.[1] ?? '';
    const liste = /<ul class="liste">([^]*?)<\/ul>/.exec(antwort.body)?.[1] ?? '';

    expect(liste).toContain('href="/meldungen"');
    expect(verwaltung).not.toContain('href="/meldungen"');
  });
});
