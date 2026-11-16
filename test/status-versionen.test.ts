/**
 * Der Abschnitt „Versionen" der Einstellungen (COPI-39, ADR 13.1, Prototyp „Einstellungen") — reine Funktionen,
 * der Zeitpunkt ist ein Parameter.
 *
 * Zwei Sichten mit **getrennten Eingaben**:
 *
 *   * **Betreuer:** laufende Version und laufender Digest (Selbstmeldung), Soll-Digest (das Ziel eines offenen
 *     Antrags), verfügbare Version (Text der Versions-Wache, unverändert) und der Stand dieser Wache.
 *   * **Betriebs-Admin und Mitarbeiter:** ein Klartextsatz je Bereich — „Aktuell.", „Update angefragt." oder
 *     „Update fehlgeschlagen, Betreuer ist informiert." **Keine Digests, keine Versionsnummern**: die Eingabe der
 *     Kundensicht kennt nur den Status des jüngsten Antrags.
 */
import { describe, expect, it } from 'vitest';
import {
  betreuerVersionen,
  commitPasst,
  herkunftCommit,
  herkunftUnterModule,
  kundenVersionen,
  modulVersionsWache,
  VERSIONS_WACHE,
  type AntragDaten,
  type AntragStatus,
  type BetreuerVersionenDaten,
  type ModulAntragDaten,
  type ModulVersionDaten,
  type UpdateZiel,
  type WachenDaten,
} from '../src/status/versionen.js';

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);
const LAUFEND = `sha256:${'9f'.repeat(32)}`;
const ZIEL = `sha256:${'e7'.repeat(32)}`;
const WOCHE = 7 * 86_400;

/**
 * Ein Antrag in `status`, mit den Zeitpunkten, die dazu gehören: beantragt vor einer Stunde, freigegeben vor 30,
 * gestartet vor 10 Minuten (also noch nicht hängend), abgeschlossen vor 5.
 */
function antragDaten(status: AntragStatus, teil: Partial<AntragDaten> = {}): AntragDaten {
  const freigegeben = ['freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen'].includes(status);
  const gestartet = ['laeuft', 'erledigt', 'fehlgeschlagen'].includes(status);
  const abgeschlossen = ['erledigt', 'fehlgeschlagen', 'zurueckgezogen'].includes(status);
  return {
    id: 7,
    status,
    zielDigest: ZIEL,
    zielVersion: freigegeben ? '1.5.0' : undefined,
    digestVorher: LAUFEND,
    beantragtAm: vor(3600),
    freigegebenAm: freigegeben ? vor(1800) : undefined,
    laeuftSeit: gestartet ? vor(600) : undefined,
    abgeschlossenAm: abgeschlossen ? vor(300) : undefined,
    ...teil,
  };
}

function daten(teil: Partial<BetreuerVersionenDaten> = {}): BetreuerVersionenDaten {
  return {
    instanz: { version: '1.4.0+0123456', digest: LAUFEND, gestartetAm: vor(3 * 86_400) },
    antrag: undefined,
    wache: { taktSekunden: WOCHE, letzterLauf: vor(2 * 86_400), letzter: { status: 'gruen', text: 'aktuell: 1.4.0' } },
    ...teil,
  };
}

describe('kundenVersionen', () => {
  it.each<[AntragStatus | undefined, string]>([
    [undefined, 'Aktuell.'],
    ['erledigt', 'Aktuell.'],
    ['beantragt', 'Update angefragt.'],
    ['freigegeben', 'Update angefragt.'],
    ['laeuft', 'Update angefragt.'],
    ['fehlgeschlagen', 'Update fehlgeschlagen, Betreuer ist informiert.'],
    ['zurueckgezogen', 'Aktuell.'],
  ])('sagt beim jüngsten Antrag %s: „%s"', (antragStatus, satz) => {
    expect(kundenVersionen({ antragStatus })).toEqual({ bereiche: [{ name: 'Cockpit', satz }] });
  });

  it('gibt jedem Bereich genau die Felder Name und Satz: keins für Digest oder Version', () => {
    const { bereiche } = kundenVersionen({ antragStatus: 'beantragt' });

    expect(bereiche.map((bereich) => Object.keys(bereich).sort())).toEqual([['name', 'satz']]);
  });
});

describe('betreuerVersionen — der Bereich Cockpit', () => {
  it('zeigt Version, laufenden Digest und seit wann das Cockpit läuft', () => {
    const [cockpit] = betreuerVersionen(daten(), JETZT).bereiche;

    expect(cockpit).toMatchObject({
      name: 'Cockpit',
      version: '1.4.0+0123456',
      digest: LAUFEND,
      gestartet: 'vor 3 Tagen',
    });
  });

  it('nimmt als Soll-Digest das Ziel eines offenen Antrags', () => {
    for (const status of ['beantragt', 'freigegeben', 'laeuft'] as const) {
      const [cockpit] = betreuerVersionen(daten({ antrag: antragDaten(status) }), JETZT).bereiche;

      expect(cockpit?.sollDigest, status).toBe(ZIEL);
    }
  });

  it('hat ohne offenen Antrag keinen Soll-Digest: ein erledigter oder gescheiterter ist kein Soll mehr', () => {
    for (const antrag of [undefined, antragDaten('erledigt'), antragDaten('fehlgeschlagen'), antragDaten('zurueckgezogen')]) {
      expect(betreuerVersionen(daten({ antrag }), JETZT).bereiche[0]?.sollDigest).toBeUndefined();
    }
  });

  it('zeigt die verfügbare Version als Text der Versions-Wache, unverändert, und ihren Stand', () => {
    const [cockpit] = betreuerVersionen(
      daten({ wache: { taktSekunden: WOCHE, letzterLauf: vor(2 * 86_400), letzter: { status: 'gelb', text: 'verfügbar: 1.5.0 (sha256:e77b40…)' } } }),
      JETZT,
    ).bereiche;

    expect(cockpit?.verfuegbar).toBe('verfügbar: 1.5.0 (sha256:e77b40…)');
    expect(cockpit?.wache).toEqual({ text: 'zuletzt geprüft vor 2 Tagen', ueberfaellig: false });
  });

  it('markiert eine Versions-Wache, die ausbleibt: länger als eine Woche und die Toleranz', () => {
    const [cockpit] = betreuerVersionen(
      daten({ wache: { taktSekunden: WOCHE, letzterLauf: vor(12 * 86_400), letzter: { status: 'gruen', text: 'aktuell' } } }),
      JETZT,
    ).bereiche;

    expect(cockpit?.wache).toEqual({ text: 'zuletzt geprüft vor 12 Tagen', ueberfaellig: true });
  });

  it('sagt ohne Versions-Wache, dass sie noch nicht gemeldet hat, statt einen Stand zu erfinden', () => {
    const [cockpit] = betreuerVersionen(daten({ wache: undefined }), JETZT).bereiche;

    expect(cockpit?.verfuegbar).toBeUndefined();
    expect(cockpit?.wache).toEqual({ text: 'noch nicht gemeldet', ueberfaellig: false });
  });

  it('lässt Version und Digest leer, solange sich das Cockpit nicht gemeldet hat', () => {
    const [cockpit] = betreuerVersionen(daten({ instanz: undefined }), JETZT).bereiche;

    expect(cockpit?.version).toBeUndefined();
    expect(cockpit?.digest).toBeUndefined();
    expect(cockpit?.gestartet).toBeUndefined();
  });

  it('lässt den Digest leer, wenn die Instanz keinen kennt (lokal oder nicht gesetzt)', () => {
    const [cockpit] = betreuerVersionen(daten({ instanz: { version: '0.1.0+lokal', digest: undefined, gestartetAm: vor(60) } }), JETZT).bereiche;

    expect(cockpit?.digest).toBeUndefined();
    expect(cockpit?.gestartet).toBe('vor 1 Minute');
  });

  it('sagt „gerade eben", wenn die Uhr zurückgesprungen ist', () => {
    const [cockpit] = betreuerVersionen(daten({ instanz: { version: '1', digest: undefined, gestartetAm: new Date(JETZT.getTime() + 60_000) } }), JETZT).bereiche;

    expect(cockpit?.gestartet).toBe('gerade eben');
  });
});

describe('betreuerVersionen — die Marke', () => {
  it.each<[string, Partial<BetreuerVersionenDaten>, { text: string; farbe: string } | undefined]>([
    ['ein offener Antrag geht allem vor', { antrag: antragDaten('laeuft') }, { text: 'Update angefragt', farbe: 'info' }],
    ['ein gescheiterter Antrag', { antrag: antragDaten('fehlgeschlagen') }, { text: 'Update fehlgeschlagen', farbe: 'rot' }],
    [
      'die Wache meldet Gelb: es gibt eine neuere Version',
      { wache: { taktSekunden: WOCHE, letzterLauf: vor(60), letzter: { status: 'gelb', text: 'x' } } },
      { text: 'Update verfügbar', farbe: 'gelb' },
    ],
    [
      'die Wache meldet Grün',
      { wache: { taktSekunden: WOCHE, letzterLauf: vor(60), letzter: { status: 'gruen', text: 'x' } } },
      { text: 'Aktuell', farbe: 'gruen' },
    ],
    [
      'die Wache meldet Rot: die Prüfung selbst ist gestört',
      { wache: { taktSekunden: WOCHE, letzterLauf: vor(60), letzter: { status: 'rot', text: 'x' } } },
      { text: 'Prüfung gestört', farbe: 'rot' },
    ],
    [
      'ein erledigter Antrag: dann zählt wieder die Wache',
      { antrag: antragDaten('erledigt'), wache: { taktSekunden: WOCHE, letzterLauf: vor(60), letzter: { status: 'gruen', text: 'x' } } },
      { text: 'Aktuell', farbe: 'gruen' },
    ],
    [
      'ein zurückgezogener Antrag: dann zählt wieder die Wache',
      { antrag: antragDaten('zurueckgezogen'), wache: { taktSekunden: WOCHE, letzterLauf: vor(60), letzter: { status: 'gelb', text: 'x' } } },
      { text: 'Update verfügbar', farbe: 'gelb' },
    ],
    ['weder Antrag noch Wache: keine Marke', { wache: undefined }, undefined],
  ])('%s', (_name, teil, marke) => {
    expect(betreuerVersionen(daten(teil), JETZT).bereiche[0]?.marke).toEqual(marke);
  });
});

/**
 * Was sich im Bereich beantragen lässt (COPI-40). Höchstens ein offener Antrag zur Zeit; einen, der noch nicht
 * freigegeben ist, zieht der Betreuer zurück. Ohne laufenden Digest gibt es keinen Antrag: der Antrag trägt den Weg
 * zurück (`digest_vorher`), und den kennt dann niemand.
 */
describe('betreuerVersionen — der Antrag', () => {
  const antrag = (status: AntragStatus): BetreuerVersionenDaten['antrag'] => antragDaten(status);

  it('bietet ohne offenen Antrag das Beantragen an', () => {
    for (const teil of [{}, { antrag: antrag('erledigt') }, { antrag: antrag('fehlgeschlagen') }, { antrag: antrag('zurueckgezogen') }]) {
      expect(betreuerVersionen(daten(teil), JETZT).bereiche[0]?.antrag).toEqual({ art: 'beantragen' });
    }
  });

  it('bietet ohne laufenden Digest keinen Antrag an: es gäbe keinen Weg zurück', () => {
    for (const instanz of [undefined, { version: '0.1.0+lokal', digest: undefined, gestartetAm: vor(60) }]) {
      expect(betreuerVersionen(daten({ instanz }), JETZT).bereiche[0]?.antrag).toEqual({ art: 'ohne-digest' });
    }
  });

  it('bietet einen beantragten, noch nicht freigegebenen Antrag zum Zurückziehen an, mit seiner Nummer', () => {
    expect(betreuerVersionen(daten({ antrag: antrag('beantragt') }), JETZT).bereiche[0]?.antrag).toEqual({
      art: 'zurueckziehen',
      id: 7,
      satz: 'Antrag Nr. 7 wartet auf die Freigabe.',
    });
  });

  it.each<[AntragStatus, string]>([
    ['freigegeben', 'Antrag Nr. 7 ist freigegeben: der Admin-Agent spielt das Update ein.'],
    ['laeuft', 'Antrag Nr. 7 läuft: das Update wird gerade eingespielt.'],
  ])('lässt einen Antrag im Status %s stehen: zurückziehen geht nur vor der Freigabe', (status, satz) => {
    expect(betreuerVersionen(daten({ antrag: antrag(status) }), JETZT).bereiche[0]?.antrag).toEqual({ art: 'unterwegs', satz });
  });

  it('bietet einen direkt freigegebenen Antrag zum Zurückziehen an, bis der Agent beginnt (COPI-141)', () => {
    const direkt = (status: AntragStatus) => betreuerVersionen(daten({ antrag: antragDaten(status, { freigabeModus: 'direkt' }) }), JETZT).bereiche[0];

    expect(direkt('freigegeben')?.antrag).toEqual({
      art: 'zurueckziehen',
      id: 7,
      satz: 'Antrag Nr. 7 ist direkt freigegeben: der Admin-Agent spielt das Update ohne Rückfrage ein. Bis er beginnt, lässt er sich zurückziehen.',
    });
    expect(direkt('freigegeben')?.letzterAntrag?.freigabe).toBe('direkt im Cockpit');
    expect(direkt('laeuft')?.antrag.art).toBe('unterwegs');
  });
});

/**
 * Hängt ein Antrag (COPI-41, ADR 13.1: länger als 15 Minuten in `laeuft`), geht das jeder anderen Marke vor, und der
 * Betreuer liest es im Bereich. Die Kundensicht bleibt bei „Update angefragt.".
 */
describe('betreuerVersionen — ein hängender Antrag', () => {
  const haengend = antragDaten('laeuft', { laeuftSeit: vor(15 * 60 + 1) });

  it('trägt die rote Marke „Update hängt", auch vor einer Wache, die Rot meldet', () => {
    const [cockpit] = betreuerVersionen(
      daten({ antrag: haengend, wache: { taktSekunden: WOCHE, letzterLauf: vor(60), letzter: { status: 'rot', text: 'x' } } }),
      JETZT,
    ).bereiche;

    expect(cockpit?.marke).toEqual({ text: 'Update hängt', farbe: 'rot' });
  });

  it('sagt, dass er hängt, statt „läuft"', () => {
    expect(betreuerVersionen(daten({ antrag: haengend }), JETZT).bereiche[0]?.antrag).toEqual({
      art: 'unterwegs',
      satz: 'Antrag Nr. 7 hängt: er läuft seit über 15 Minuten, ohne dass sich das neue Cockpit gemeldet hat.',
    });
  });

  it('hängt nach genau 15 Minuten noch nicht', () => {
    const [cockpit] = betreuerVersionen(daten({ antrag: antragDaten('laeuft', { laeuftSeit: vor(15 * 60) }) }), JETZT).bereiche;

    expect(cockpit?.marke).toEqual({ text: 'Update angefragt', farbe: 'info' });
    expect(cockpit?.letzterAntrag?.haengt).toBe(false);
  });

  it('lässt die Kundensicht bei „Update angefragt.": ihre Eingabe kennt nur den Status', () => {
    expect(kundenVersionen({ antragStatus: 'laeuft' }).bereiche[0]?.satz).toBe('Update angefragt.');
  });
});

/**
 * Der letzte Antrag in der Betreuersicht (COPI-41): Stand, Ziel, Ziel-Version, der Weg zurück und die erreichten
 * Stufen — auch nach dem Abschluss, denn dann braucht der Betreuer den Weg zurück.
 */
describe('betreuerVersionen — der letzte Antrag', () => {
  it('gibt es ohne Antrag nicht', () => {
    expect(betreuerVersionen(daten(), JETZT).bereiche[0]?.letzterAntrag).toBeUndefined();
  });

  it('zeigt einen erledigten Antrag mit Ziel, Version, Weg zurück und allen vier Stufen', () => {
    expect(betreuerVersionen(daten({ antrag: antragDaten('erledigt') }), JETZT).bereiche[0]?.letzterAntrag).toEqual({
      nummer: 7,
      stand: 'erledigt',
      haengt: false,
      freigabe: 'Rückfrage in Slack',
      zielDigest: ZIEL,
      zielVersion: '1.5.0',
      digestVorher: LAUFEND,
      stufen: [
        { name: 'Beantragt', wann: 'vor 1 Stunde' },
        { name: 'Freigegeben', wann: 'vor 30 Minuten' },
        { name: 'Gestartet', wann: 'vor 10 Minuten' },
        { name: 'Erledigt', wann: 'vor 5 Minuten' },
      ],
    });
  });

  it.each<[AntragStatus, string, readonly string[]]>([
    ['beantragt', 'wartet auf Freigabe', ['Beantragt']],
    ['freigegeben', 'freigegeben', ['Beantragt', 'Freigegeben']],
    ['laeuft', 'läuft', ['Beantragt', 'Freigegeben', 'Gestartet']],
    ['fehlgeschlagen', 'fehlgeschlagen', ['Beantragt', 'Freigegeben', 'Gestartet', 'Fehlgeschlagen']],
    ['zurueckgezogen', 'zurückgezogen', ['Beantragt', 'Zurückgezogen']],
  ])('nennt beim Status %s den Stand „%s" und nur die erreichten Stufen', (status, stand, stufen) => {
    const letzter = betreuerVersionen(daten({ antrag: antragDaten(status) }), JETZT).bereiche[0]?.letzterAntrag;

    expect(letzter?.stand).toBe(stand);
    expect(letzter?.stufen.map((stufe) => stufe.name)).toEqual(stufen);
    expect(letzter?.digestVorher).toBe(LAUFEND);
  });

  it('nennt einen hängenden Antrag „hängt"', () => {
    const letzter = betreuerVersionen(daten({ antrag: antragDaten('laeuft', { laeuftSeit: vor(20 * 60) }) }), JETZT).bereiche[0]
      ?.letzterAntrag;

    expect(letzter).toMatchObject({ stand: 'hängt', haengt: true });
  });

  it('sagt „gerade eben", wenn die Uhr zurückgesprungen ist', () => {
    const letzter = betreuerVersionen(daten({ antrag: antragDaten('beantragt', { beantragtAm: new Date(JETZT.getTime() + 60_000) }) }), JETZT)
      .bereiche[0]?.letzterAntrag;

    expect(letzter?.stufen).toEqual([{ name: 'Beantragt', wann: 'gerade eben' }]);
  });
});

describe('Versions-Wache', () => {
  it('heißt version-cockpit: je Bereich eine Wache, das Cockpit-Image ist der erste', () => {
    expect(VERSIONS_WACHE).toBe('version-cockpit');
  });
});

describe('Module im Abschnitt „Versionen" (COPI-106)', () => {
  const HERKUNFT = 'agent-blueprints@3f2a9c1e0b:module/eingang.cockpit.yaml';

  function modul(teil: Partial<ModulVersionDaten> = {}): ModulVersionDaten {
    return {
      kennung: 'eingang',
      menuename: 'Eingang',
      version: 4,
      aktivSeit: new Date(JETZT.getTime() - 2 * 86_400_000),
      herkunft: HERKUNFT,
      antrag: undefined,
      wache: undefined,
      ...teil,
    };
  }

  function modulAntrag(status: AntragStatus, teil: Partial<ModulAntragDaten> = {}): ModulAntragDaten {
    return {
      id: 13,
      status,
      zielCommit: '8d41e07',
      herkunftVorher: HERKUNFT,
      fehlerGrund: undefined,
      beantragtAm: new Date(JETZT.getTime() - 3_600_000),
      freigegebenAm: status === 'beantragt' ? undefined : new Date(JETZT.getTime() - 1_800_000),
      laeuftSeit: ['laeuft', 'erledigt', 'fehlgeschlagen'].includes(status) ? new Date(JETZT.getTime() - 20 * 60_000) : undefined,
      abgeschlossenAm: ['erledigt', 'fehlgeschlagen'].includes(status) ? new Date(JETZT.getTime() - 60_000) : undefined,
      ...teil,
    };
  }

  function bereich(daten: ModulVersionDaten) {
    const [ergebnis] = betreuerVersionen({ instanz: undefined, antrag: undefined, wache: undefined, module: [daten] }, JETZT).module;
    if (ergebnis === undefined) {
      throw new Error('kein Modul');
    }
    return ergebnis;
  }

  it('bietet einen direkt freigegebenen Modul-Antrag zum Zurückziehen an (COPI-141)', () => {
    const ergebnis = bereich(modul({ antrag: modulAntrag('freigegeben', { freigabeModus: 'direkt' }) }));

    expect(ergebnis.antrag).toMatchObject({ art: 'zurueckziehen', id: 13 });
    expect(ergebnis.letzterAntrag?.freigabe).toBe('direkt im Cockpit');
    expect(bereich(modul({ antrag: modulAntrag('freigegeben') })).antrag.art).toBe('unterwegs');
  });

  it('liest den Commit nur aus einer Herkunft aus agent-blueprints', () => {
    expect(herkunftCommit(HERKUNFT)).toBe('3f2a9c1e0b');
    expect(herkunftCommit('agent-blueprints@3F2A9C1:agents/x.yaml')).toBeUndefined();
    expect(herkunftCommit('agent-blueprints@3f2a9c1')).toBeUndefined();
    expect(herkunftCommit('scripts/dev/demo.ts')).toBeUndefined();
    expect(herkunftCommit(undefined)).toBeUndefined();
  });

  it('hält zwei Commits für gleich, wenn einer ein Präfix des anderen ist', () => {
    expect(commitPasst('8d41e07', '8d41e07b2c')).toBe(true);
    expect(commitPasst('8d41e07b2c', '8d41e07')).toBe(true);
    expect(commitPasst('8d41e07', '8d41e08')).toBe(false);
    expect(commitPasst(undefined, '8d41e07')).toBe(false);
  });

  it('heißt die Wache version-modul-<kennung>', () => {
    expect(modulVersionsWache('eingang')).toBe('version-modul-eingang');
  });

  it('bietet den Antrag nur mit Herkunft an, sonst „ohne-herkunft"', () => {
    expect(bereich(modul()).antrag).toEqual({ art: 'beantragen' });
    expect(bereich(modul({ herkunft: undefined })).antrag).toEqual({ art: 'ohne-herkunft' });
    expect(bereich(modul({ herkunft: 'scripts/dev/demo-eingang.ts' })).antrag).toEqual({ art: 'ohne-herkunft' });
  });

  it('zeigt Name, Version und die Marke der Wache', () => {
    const ergebnis = bereich(modul({ wache: { taktSekunden: 3600, letzterLauf: JETZT, letzter: { status: 'gelb', text: 'Commit 8d41e07' } } }));

    expect(ergebnis).toMatchObject({
      name: 'Modul · Eingang',
      version: '4 · aktiv seit vor 2 Tagen',
      marke: { text: 'Update verfügbar', farbe: 'gelb' },
      verfuegbar: 'Commit 8d41e07',
      sollCommit: undefined,
    });
  });

  it('lässt einen wartenden Antrag zurückziehen und nennt das Ziel', () => {
    const ergebnis = bereich(modul({ antrag: modulAntrag('beantragt') }));

    expect(ergebnis.antrag).toMatchObject({ art: 'zurueckziehen', id: 13 });
    expect(ergebnis.sollCommit).toBe('8d41e07');
    expect(ergebnis.marke).toEqual({ text: 'Update angefragt', farbe: 'info' });
  });

  it('meldet einen Antrag, der über 15 Minuten läuft, als hängend', () => {
    const ergebnis = bereich(modul({ antrag: modulAntrag('laeuft') }));

    expect(ergebnis.marke).toEqual({ text: 'Update hängt', farbe: 'rot' });
    expect(ergebnis.antrag).toMatchObject({ art: 'unterwegs' });
    expect(ergebnis.letzterAntrag?.stand).toBe('hängt');
  });

  it('zeigt nach einem Fehlschlag Grund und Weg zurück und bietet einen neuen Antrag an', () => {
    const ergebnis = bereich(modul({ antrag: modulAntrag('fehlgeschlagen', { fehlerGrund: 'Fachmigration 0005 fehlt' }) }));

    expect(ergebnis.marke).toEqual({ text: 'Update fehlgeschlagen', farbe: 'rot' });
    expect(ergebnis.antrag).toEqual({ art: 'beantragen' });
    expect(ergebnis.letzterAntrag).toMatchObject({
      nummer: 13,
      stand: 'fehlgeschlagen',
      grund: 'Fachmigration 0005 fehlt',
      zielCommit: '8d41e07',
      herkunftVorher: HERKUNFT,
    });
    expect(ergebnis.letzterAntrag?.stufen.map((stufe) => stufe.name)).toEqual(['Beantragt', 'Freigegeben', 'Gestartet', 'Fehlgeschlagen']);
  });

  it('ohne Module keine Modul-Bereiche', () => {
    expect(betreuerVersionen({ instanz: undefined, antrag: undefined, wache: undefined }, JETZT).module).toEqual([]);
  });
});

describe('Update mit einem Klick (COPI-140)', () => {
  const SEIT = new Date('2026-09-20T02:25:00.000Z');
  const MODUL_ZIEL = 'bac99d0935870496c9c5cd867ed849d7e06ab91c';
  const MODUL_HERKUNFT = 'agent-blueprints@f573bb1:module/blog.cockpit.yaml';

  function gelb(update: UpdateZiel): WachenDaten {
    return { taktSekunden: WOCHE, letzterLauf: vor(600), letzter: { status: 'gelb', text: 'Update da', update } };
  }

  const COCKPIT_UPDATE: UpdateZiel = { art: 'cockpit', ziel: ZIEL, version: '1.5.0', hinweis: 'Updates mit einem Klick', seit: SEIT };
  const MODUL_UPDATE: UpdateZiel = { art: 'modul', ziel: MODUL_ZIEL, version: undefined, hinweis: undefined, seit: SEIT };

  function modulBereich(teil: Partial<ModulVersionDaten> = {}) {
    const modul: ModulVersionDaten = {
      kennung: 'blog',
      menuename: 'Blog',
      version: 2,
      aktivSeit: vor(86_400),
      herkunft: MODUL_HERKUNFT,
      antrag: undefined,
      wache: gelb(MODUL_UPDATE),
      ...teil,
    };
    const [ergebnis] = betreuerVersionen({ instanz: undefined, antrag: undefined, wache: undefined, module: [modul] }, JETZT).module;
    if (ergebnis === undefined) {
      throw new Error('kein Modul');
    }
    return ergebnis;
  }

  it('zeigt beim Cockpit Version, Hinweis und Datum, mit dem gemeldeten Ziel für den Knopf', () => {
    const [cockpit] = betreuerVersionen(daten({ wache: gelb(COCKPIT_UPDATE) }), JETZT).bereiche;

    expect(cockpit?.update).toEqual({ zeile: 'Update verfügbar: 1.5.0 · Updates mit einem Klick · seit 20.09.2026', ziel: ZIEL });
  });

  it('zeigt beim Modul den Kurz-Commit; ohne Hinweis und ohne lesbares Datum fehlen diese Teile', () => {
    expect(modulBereich().update).toEqual({ zeile: 'Update verfügbar: bac99d0 · seit 20.09.2026', ziel: MODUL_ZIEL });
    expect(modulBereich({ wache: gelb({ ...MODUL_UPDATE, seit: undefined }) }).update?.zeile).toBe('Update verfügbar: bac99d0');
  });

  it('bietet keinen Knopf an, solange ein Antrag offen ist — die Karte zeigt dann dessen Stand', () => {
    const [cockpit] = betreuerVersionen(daten({ wache: gelb(COCKPIT_UPDATE), antrag: antragDaten('beantragt') }), JETZT).bereiche;
    const modul = modulBereich({
      antrag: {
        id: 3,
        status: 'freigegeben',
        zielCommit: MODUL_ZIEL,
        herkunftVorher: MODUL_HERKUNFT,
        fehlerGrund: undefined,
        beantragtAm: vor(3600),
        freigegebenAm: vor(1800),
        laeuftSeit: undefined,
        abgeschlossenAm: undefined,
      },
    });

    expect(cockpit?.update).toBeUndefined();
    expect(cockpit?.antrag.art).toBe('zurueckziehen');
    expect(modul.update).toBeUndefined();
    expect(modul.antrag.art).toBe('unterwegs');
  });

  it('bietet ein Ziel, das schon läuft, nicht als Update an (die Wache ist noch nicht wieder gelaufen)', () => {
    const [cockpit] = betreuerVersionen(daten({ wache: gelb({ ...COCKPIT_UPDATE, ziel: LAUFEND }) }), JETZT).bereiche;

    expect(cockpit?.update).toBeUndefined();
    expect(modulBereich({ herkunft: `agent-blueprints@${MODUL_ZIEL}:module/blog.cockpit.yaml` }).update).toBeUndefined();
  });

  it('ohne gemeldetes Ziel keinen Knopf, auch bei gelber Wache', () => {
    const wache: WachenDaten = { taktSekunden: WOCHE, letzterLauf: vor(600), letzter: { status: 'gelb', text: 'Commit bac99d0' } };

    expect(modulBereich({ wache }).update).toBeUndefined();
  });

  it('nimmt keinen Antrag an, wenn die Herkunft nicht unter module/<kennung>.cockpit.yaml liegt: nur Server-Konsole', () => {
    const fremd = modulBereich({ herkunft: 'agent-blueprints@f573bb1:agents/agent-admin.yaml' });
    const falscheKennung = modulBereich({ herkunft: 'agent-blueprints@f573bb1:module/social.cockpit.yaml' });

    expect(fremd.antrag).toEqual({ art: 'nur-konsole' });
    expect(fremd.update).toBeUndefined();
    expect(falscheKennung.antrag).toEqual({ art: 'nur-konsole' });
    expect(herkunftUnterModule(MODUL_HERKUNFT, 'blog')).toBe(true);
    expect(herkunftUnterModule('module/blog.cockpit.yaml', 'blog')).toBe(false);
    expect(herkunftUnterModule(undefined, 'blog')).toBe(false);
  });

  it('sagt im Modus automatisch, was die Automatik tut (COPI-142): beim Cockpit mit Wartungsfenster', () => {
    const cockpit = (automatik: BetreuerVersionenDaten['automatik']) =>
      betreuerVersionen(daten({ wache: gelb(COCKPIT_UPDATE), automatik }), JETZT).bereiche[0]?.update?.automatik;

    expect(cockpit(undefined)).toBeUndefined();
    expect(cockpit('bereit')).toBe('Wird automatisch installiert, im nächsten Wartungsfenster (dienstags 7–9 Uhr).');
    expect(cockpit('heute')).toBe('Wird automatisch installiert, frühestens morgen: heute gab es schon einen automatischen Antrag.');
    expect(cockpit('ziel')).toContain('Automatik für dieses Ziel gesperrt');
    expect(modulBereich({ automatik: 'bereit' }).update?.automatik).toBe('Wird automatisch installiert.');
  });

  it('nennt einen automatisch gestellten Antrag so', () => {
    const [cockpit] = betreuerVersionen(daten({ antrag: antragDaten('freigegeben', { freigabeModus: 'direkt', automatisch: true }) }), JETZT).bereiche;

    expect(cockpit?.letzterAntrag?.freigabe).toBe('automatisch, ohne Klick');
  });
});
