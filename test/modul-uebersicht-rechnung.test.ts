/**
 * Die reinen Berechnungen des Dashboards der Übersicht (COPI-81): Stunden-Eimer mit Übernahme, schlimmster Status,
 * leere Eimer, Verfügbarkeit, Kalendertage in Europe/Berlin (inkl. Sommerzeit-Umstellung Ende Oktober und Ende
 * März), das Wochendiagramm und das Dashboard-Modell aus Modulzeilen. Ohne Datenbank, der Zeitpunkt ist immer ein
 * Parameter.
 */
import { describe, expect, it } from 'vitest';
import type { ModulBlock } from '../src/module/block.js';
import type { ModulZeileRoh } from '../src/module/liste-detail.js';
import { dashboardAnsicht, kuerzelAus, wocheAus, type ModulMitKarten } from '../src/module/uebersicht-karten.js';
import {
  berlinTage,
  eimerBelegen,
  mitAktuellem,
  schlimmster,
  stundenGrenzen,
  tagesGrenzen,
  verfuegbarkeitProzent,
  type VerlaufPunkt,
} from '../src/module/zeitraster.js';
import type { BefundStatus } from '../src/status/zustand.js';

const STUNDE = 3_600_000;
const JETZT = new Date('2026-09-28T08:02:00.000Z'); // 10:02 in Berlin (Sommerzeit)

function punkt(iso: string, status: BefundStatus): VerlaufPunkt {
  return { zeitpunkt: new Date(iso), status };
}

function vorStunden(stunden: number, status: BefundStatus, jetzt: Date = JETZT): VerlaufPunkt {
  return { zeitpunkt: new Date(jetzt.getTime() - stunden * STUNDE), status };
}

describe('schlimmster', () => {
  it('ordnet rot > gelb > grün > leer', () => {
    expect(schlimmster('gruen', 'rot')).toBe('rot');
    expect(schlimmster('gelb', 'gruen')).toBe('gelb');
    expect(schlimmster('leer', 'gruen')).toBe('gruen');
    expect(schlimmster('leer', 'leer')).toBe('leer');
  });
});

describe('eimerBelegen', () => {
  const grenzen = [0, 10, 20, 30, 40];
  const bei = (ms: number, status: BefundStatus): VerlaufPunkt => ({ zeitpunkt: new Date(ms), status });

  it('nimmt je Eimer den schlimmsten Status der Punkte darin', () => {
    expect(eimerBelegen([bei(1, 'gruen'), bei(5, 'rot'), bei(8, 'gruen')], grenzen)[0]).toBe('rot');
  });

  it('lässt einen leeren Eimer den zuletzt bekannten Status davor übernehmen (nicht den schlimmsten)', () => {
    expect(eimerBelegen([bei(1, 'rot'), bei(5, 'gruen')], grenzen)).toEqual(['rot', 'gruen', 'gruen', 'gruen']);
  });

  it('übernimmt auch einen Punkt vor dem ersten Eimer', () => {
    expect(eimerBelegen([bei(-100, 'gelb'), bei(25, 'gruen')], grenzen)).toEqual(['gelb', 'gelb', 'gruen', 'gruen']);
  });

  it('bleibt leer, solange nichts bekannt ist', () => {
    expect(eimerBelegen([bei(25, 'gruen')], grenzen)).toEqual(['leer', 'leer', 'gruen', 'gruen']);
    expect(eimerBelegen([], grenzen)).toEqual(['leer', 'leer', 'leer', 'leer']);
  });

  it('zählt einen Punkt genau auf der letzten Grenze zum letzten Eimer, spätere gar nicht', () => {
    expect(eimerBelegen([bei(40, 'rot')], grenzen)).toEqual(['leer', 'leer', 'leer', 'rot']);
    expect(eimerBelegen([bei(41, 'rot')], grenzen)).toEqual(['leer', 'leer', 'leer', 'leer']);
  });

  it('zählt einen Punkt auf einer inneren Grenze nur im späteren Eimer', () => {
    expect(eimerBelegen([bei(0, 'gruen'), bei(10, 'rot')], grenzen)).toEqual(['gruen', 'rot', 'rot', 'rot']);
  });

  it('sortiert unsortierte Punkte selbst', () => {
    expect(eimerBelegen([bei(25, 'gruen'), bei(5, 'rot')], grenzen)).toEqual(['rot', 'rot', 'gruen', 'gruen']);
  });
});

describe('24-Stunden-Band', () => {
  it('hat 24 gleitende Stunden bis jetzt', () => {
    const grenzen = stundenGrenzen(JETZT, 24);
    expect(grenzen).toHaveLength(25);
    expect(grenzen[24]).toBe(JETZT.getTime());
    expect(grenzen[0]).toBe(JETZT.getTime() - 24 * STUNDE);
  });

  it('spiegelt den aktuellen Status im jüngsten Eimer (ein überfälliges Gelb wird sichtbar)', () => {
    const eimer = eimerBelegen([vorStunden(30, 'gruen')], stundenGrenzen(JETZT, 24));
    expect(eimer.every((status) => status === 'gruen')).toBe(true);
    const mit = mitAktuellem(eimer, 'gelb');
    expect(mit[23]).toBe('gelb');
    expect(mit[22]).toBe('gruen');
  });

  it('lässt ein Rot im jüngsten Eimer nicht durch ein aktuelles Grün verschwinden', () => {
    expect(mitAktuellem(['gruen', 'rot'], 'gruen')).toEqual(['gruen', 'rot']);
  });
});

describe('verfuegbarkeitProzent', () => {
  it('ist der Anteil grüner unter den nicht-leeren Eimern, abgerundet', () => {
    expect(verfuegbarkeitProzent({ gruen: 22, gelb: 1, rot: 0, leer: 1 })).toBe(95);
    expect(verfuegbarkeitProzent({ gruen: 23, gelb: 0, rot: 1, leer: 0 })).toBe(95);
    expect(verfuegbarkeitProzent({ gruen: 24, gelb: 0, rot: 0, leer: 0 })).toBe(100);
  });

  it('meldet ohne Daten nichts', () => {
    expect(verfuegbarkeitProzent({ gruen: 0, gelb: 0, rot: 0, leer: 24 })).toBeUndefined();
  });
});

describe('Kalendertage in Europe/Berlin', () => {
  it('liefert sieben Tage bis heute, den ältesten zuerst, mit Wochentag; heute endet bei jetzt', () => {
    const tage = berlinTage(JETZT, 7);
    expect(tage.map((tag) => tag.kuerzel)).toEqual(['Di', 'Mi', 'Do', 'Fr', 'Sa', 'So', 'Mo']);
    expect(new Date(tage[6]?.beginn ?? 0).toISOString()).toBe('2026-09-27T22:00:00.000Z');
    expect(tage[6]?.ende).toBe(JETZT.getTime());
    expect(new Date(tage[0]?.beginn ?? 0).toISOString()).toBe('2026-09-21T22:00:00.000Z');
  });

  it('gibt dem Tag der Umstellung auf Winterzeit (25.10.2026) 25 Stunden', () => {
    const jetzt = new Date('2026-10-26T12:00:00.000Z');
    const [sonntag, montag] = berlinTage(jetzt, 2);
    expect(sonntag?.kuerzel).toBe('So');
    expect(new Date(sonntag?.beginn ?? 0).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(new Date(montag?.beginn ?? 0).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(sonntag && tagesGrenzen(sonntag)).toHaveLength(26);
  });

  it('gibt dem Tag der Umstellung auf Sommerzeit (29.03.2026) 23 Stunden', () => {
    const [sonntag] = berlinTage(new Date('2026-03-30T12:00:00.000Z'), 2);
    expect(new Date(sonntag?.beginn ?? 0).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(sonntag && tagesGrenzen(sonntag)).toHaveLength(24);
  });

  it('teilt den heutigen Tag nur bis jetzt in Stunden (die letzte angebrochen)', () => {
    const heute = berlinTage(JETZT, 1)[0];
    const grenzen = heute ? tagesGrenzen(heute) : [];
    // 00:00 bis 10:02 Ortszeit: zehn volle Stunden und eine angebrochene.
    expect(grenzen).toHaveLength(12);
    expect(grenzen.at(-1)).toBe(JETZT.getTime());
  });
});

describe('wocheAus', () => {
  it('zählt je Kalendertag die Stunden nach dem schlimmsten Status über alle Karten', () => {
    const woche = wocheAus(
      [
        { punkte: [punkt('2026-09-27T21:30:00.000Z', 'gruen')], aktuell: 'gruen' },
        { punkte: [punkt('2026-09-27T22:30:00.000Z', 'rot'), punkt('2026-09-28T00:10:00.000Z', 'gruen')], aktuell: 'gruen' },
      ],
      JETZT,
    );
    const [sonntag, montag] = woche.tage.slice(-2);
    // Sonntag: bis 23:00 Ortszeit leer, 23–24 Uhr grün (Karte 1).
    expect(sonntag?.zaehlung).toEqual({ rot: 0, gelb: 0, gruen: 1, leer: 23 });
    // Montag 00–01 und 01–02 Uhr rot (Karte 2 bis 02:10), dann grün bis jetzt.
    expect(montag?.zaehlung).toEqual({ rot: 2, gelb: 0, gruen: 9, leer: 0 });
    expect(woche.tage[0]?.zaehlung).toEqual({ rot: 0, gelb: 0, gruen: 0, leer: 24 });
  });

  it('zählt einen Punkt genau auf Mitternacht nur im neuen Tag', () => {
    const woche = wocheAus([{ punkte: [punkt('2026-09-27T22:00:00.000Z', 'rot')], aktuell: 'rot' }], JETZT);
    expect(woche.tage[5]?.zaehlung.rot).toBe(0);
    expect(woche.tage[6]?.zaehlung.rot).toBe(11);
  });

  it('lässt ohne bekannten Verlauf alles leer, auch den jüngsten Eimer', () => {
    const woche = wocheAus([{ punkte: undefined, aktuell: 'rot' }], JETZT);
    expect(woche.tage.every((tag) => tag.zaehlung.rot === 0 && tag.zaehlung.gruen === 0)).toBe(true);
  });

  it('stapelt die Säule von oben: ohne Daten, rot, gelb, grün — zusammen 100', () => {
    const woche = wocheAus([{ punkte: [punkt('2026-09-27T22:30:00.000Z', 'rot'), punkt('2026-09-28T01:30:00.000Z', 'gruen')], aktuell: 'gelb' }], JETZT);
    const stuecke = woche.tage[6]?.stuecke ?? [];
    expect(stuecke.map((stueck) => stueck.status)).toEqual(['rot', 'gelb', 'gruen']);
    expect(stuecke[0]?.y).toBe(0);
    expect(stuecke.reduce((summe, stueck) => summe + stueck.hoehe, 0)).toBeCloseTo(100, 1);
  });

  it('beschreibt jeden Tag in Worten (Textalternative)', () => {
    const woche = wocheAus([{ punkte: [vorStunden(2, 'gruen')], aktuell: 'gruen' }], JETZT);
    expect(woche.text).toContain('Mo: 3 Std. Läuft, 8 Std. ohne Daten');
    expect(woche.text).toContain('Di: 24 Std. ohne Daten');
  });
});

describe('kuerzelAus', () => {
  it.each([
    ['Webserver', 'WE'],
    ['Server & Dienste', 'SD'],
    ['backup nacht', 'BN'],
    ['ölwanne', 'ÖL'],
    ['   ', '?'],
  ])('„%s" → %s', (titel, erwartet) => {
    expect(kuerzelAus(titel)).toBe(erwartet);
  });
});

function block(kennung: string, menuename: string, uebersicht: ModulBlock['uebersicht']): ModulBlock {
  return {
    kennung,
    menuename,
    ansicht: 'liste-detail',
    view: 'v_modul_test',
    spalten: [{ name: 'text', label: 'Text' }],
    rollen: ['betreuer'],
    eingriffe: [],
    uebersicht,
  };
}

function zeile(id: string, titel: string, status: string, text = `${titel} Text`, aktualisiertAm: Date | null = new Date(JETZT.getTime() - 12 * 60_000)): ModulZeileRoh {
  return { werte: { id, titel, status, text, aktualisiert_am: aktualisiertAm } };
}

function modul(kennung: string, zeilen: readonly ModulZeileRoh[] | undefined, verlauf?: ReadonlyMap<string, readonly VerlaufPunkt[]>, reihenfolge?: number): ModulMitKarten {
  return {
    kennung,
    block: block(kennung, `Menü ${kennung}`, { kurztext: 'text', ...(reihenfolge === undefined ? {} : { reihenfolge }) }),
    zeilen,
    verlauf,
  };
}

describe('dashboardAnsicht', () => {
  it('sortiert Karten rot → gelb → grün, dann nach Titel, und verlinkt jede auf ihre Detailseite', () => {
    const d = dashboardAnsicht([modul('dienste', [zeile('1', 'B grün', 'gruen'), zeile('2', 'Z rot', 'rot'), zeile('3', 'A gelb', 'gelb'), zeile('4', 'A rot', 'rot')], new Map())], JETZT);
    const karten = d.abschnitte[0]?.karten ?? [];
    expect(karten.map((karte) => karte.titel)).toEqual(['A rot', 'Z rot', 'A gelb', 'B grün']);
    expect(karten[0]?.href).toBe('/module/dienste/4?von=uebersicht');
    expect(karten[0]?.status).toEqual({ farbe: 'rot', wort: 'Störung' });
    expect(karten[0]?.geprueft).toBe('Zuletzt geprüft vor 12 Min.');
    expect(karten[0]?.kurztext).toBe('A rot Text');
  });

  it('zeigt höchstens 24 Karten (die schlimmsten) und zählt den Rest', () => {
    const zeilen = Array.from({ length: 30 }, (_, i) => zeile(String(i), `Dienst ${String(i).padStart(2, '0')}`, i === 29 ? 'rot' : 'gruen'));
    const abschnitt = dashboardAnsicht([modul('viele', zeilen, new Map())], JETZT).abschnitte[0];
    expect(abschnitt?.karten).toHaveLength(24);
    expect(abschnitt?.weitere).toBe(6);
    expect(abschnitt?.karten[0]?.titel).toBe('Dienst 29');
  });

  it('fasst Störungen und Hinweise im Zustandsband zusammen, mit den Kurztexten', () => {
    const d = dashboardAnsicht([modul('dienste', [zeile('1', 'Web', 'rot', 'Antwortet nicht.'), zeile('2', 'Backup', 'gelb', 'Überfällig.'), zeile('3', 'Mail', 'gruen')], new Map())], JETZT);
    expect(d.zustand.farbe).toBe('rot');
    expect(d.zustand.satz).toBe('1 Störung, 1 Hinweis');
    expect(d.zustand.detail).toBe('Web: Antwortet nicht. · Backup: Überfällig.');
    expect(d.zustand.ziel).toBe('/module/dienste/1?von=uebersicht');
  });

  it('führt „Jetzt ansehen" zum Modul, wenn mehrere Karten gleich schlimm sind', () => {
    const d = dashboardAnsicht([modul('dienste', [zeile('1', 'A', 'rot'), zeile('2', 'B', 'rot')], new Map())], JETZT);
    expect(d.zustand.satz).toBe('2 Störungen');
    expect(d.zustand.ziel).toBe('/module/dienste?von=uebersicht');
  });

  it('meldet „Alles in Ordnung" ohne Ziel, wenn alles grün ist', () => {
    const d = dashboardAnsicht([modul('dienste', [zeile('1', 'A', 'gruen')], new Map())], JETZT);
    expect(d.zustand).toMatchObject({ farbe: 'gruen', satz: 'Alles in Ordnung', ziel: undefined });
  });

  it('rechnet die Kennzahlen aus den Karten', () => {
    const verlauf = new Map([
      ['1', [vorStunden(30, 'gruen')]],
      ['2', [vorStunden(30, 'gruen'), vorStunden(5.5, 'rot')]],
    ]);
    const d = dashboardAnsicht(
      [modul('dienste', [zeile('1', 'A', 'gruen', 'a', new Date(JETZT.getTime() - 4 * 60_000)), zeile('2', 'B', 'rot'), zeile('3', 'C', 'gelb', 'c', null)], verlauf)],
      JETZT,
    );
    expect(d.kennzahlen.dienste).toBe('1 von 3');
    expect(d.kennzahlen.offen).toBe(2);
    expect(d.kennzahlen.offenZusatz).toBe('1 davon Störung');
    expect(d.kennzahlen.letztePruefung).toBe('vor 4 Min.');
    // A: 24 grün; B: 18 grün + 6 rot; C: nur der jüngste Eimer gelb (aktueller Status) → 42 von 49.
    expect(d.kennzahlen.verfuegbarkeit).toBe('85 %');
    expect(d.kennzahlen.verfuegbarkeitBand.segmente).toHaveLength(24);
    expect(d.kennzahlen.verfuegbarkeitBand.segmente.at(-1)).toBe('rot');
    expect(d.abschnitte[0]?.karten.find((karte) => karte.id === '3')?.geprueft).toBe('Noch nie geprüft');
  });

  it('lässt die Bänder ganz neutral, wenn der Verlauf unbekannt ist', () => {
    const d = dashboardAnsicht([modul('dienste', [zeile('1', 'A', 'rot')], undefined)], JETZT);
    const karte = d.abschnitte[0]?.karten[0];
    expect(karte?.band.segmente.every((status) => status === 'leer')).toBe(true);
    expect(karte?.verfuegbarkeit).toBe('keine Daten');
    expect(d.kennzahlen.verfuegbarkeit).toBe('–');
    expect(karte?.band.text).toBe('Letzte 24 Stunden: 24 Std. ohne Daten');
  });

  it('zeigt einen unbekannten Status neutral mit seinem Wort, zählt ihn aber als gelb', () => {
    const d = dashboardAnsicht([modul('dienste', [zeile('1', 'A', 'kaputt'), zeile('2', 'B', 'gruen')], new Map())], JETZT);
    const karte = d.abschnitte[0]?.karten[0];
    expect(karte?.status).toEqual({ farbe: 'unbekannt', wort: 'kaputt' });
    expect(karte?.wertung).toBe('gelb');
    expect(d.zustand.satz).toBe('1 Hinweis');
  });

  it('sortiert Abschnitte nach reihenfolge (Standard 100), dann nach Menüname, und nimmt uebersicht.titel', () => {
    const erster: ModulMitKarten = { ...modul('b', [], new Map()), block: block('b', 'Buchungen', { kurztext: 'text', titel: 'Alle Buchungen', reihenfolge: 10 }) };
    const d = dashboardAnsicht([modul('z', [], new Map()), modul('a', [], new Map()), erster], JETZT);
    expect(d.abschnitte.map((abschnitt) => abschnitt.titel)).toEqual(['Alle Buchungen', 'Menü a', 'Menü z']);
  });

  it('meldet einen nicht lesbaren Abschnitt als nicht verfügbar und ohne Karten', () => {
    const d = dashboardAnsicht([modul('kaputt', undefined)], JETZT);
    expect(d.abschnitte[0]).toMatchObject({ verfuegbar: false, karten: [], weitere: 0 });
    expect(d.zustand.farbe).toBe('leer');
    expect(d.kennzahlen.dienste).toBe('0 von 0');
  });

  it('nennt den Stand als „heute, HH:MM" in Berliner Zeit', () => {
    expect(dashboardAnsicht([], JETZT).stand).toBe('heute, 10:02');
  });
});

describe('dashboardAnsicht — Statuszeile, Bereiche, Team-Listen (COPI-122)', () => {
  it('nennt in der Statuszeile jeden offenen Punkt einzeln, rot vor gelb, mit Kurztext', () => {
    const d = dashboardAnsicht(
      [modul('dienste', [zeile('1', 'Mail', 'gruen'), zeile('2', 'Backup', 'gelb', 'Überfällig.'), zeile('3', 'Web', 'rot', 'Antwortet nicht.'), zeile('4', 'Platte', 'gelb', '')], new Map())],
      JETZT,
    );
    expect(d.zustand.punkte).toEqual([
      { titel: 'Web', wertung: 'rot', wort: 'Störung', text: 'Antwortet nicht.', href: '/module/dienste/3?von=uebersicht' },
      { titel: 'Backup', wertung: 'gelb', wort: 'Achtung', text: 'Überfällig.', href: '/module/dienste/2?von=uebersicht' },
      { titel: 'Platte', wertung: 'gelb', wort: 'Achtung', text: '', href: '/module/dienste/4?von=uebersicht' },
    ]);
  });

  it('zählt je Bereich rot, gelb und grün und klappt ihn nur auf, wenn etwas nicht grün ist', () => {
    const offen = dashboardAnsicht([modul('dienste', [zeile('1', 'A', 'rot'), zeile('2', 'B', 'gelb'), zeile('3', 'C', 'gruen'), zeile('4', 'D', 'gruen')], new Map())], JETZT).abschnitte[0];
    expect(offen).toMatchObject({ zaehlung: { rot: 1, gelb: 1, gruen: 2 }, offen: true });

    const gruen = dashboardAnsicht([modul('dienste', [zeile('1', 'A', 'gruen', 'a', new Date(JETZT.getTime() - 4 * 60_000)), zeile('2', 'B', 'gruen')], new Map())], JETZT).abschnitte[0];
    expect(gruen).toMatchObject({ zaehlung: { rot: 0, gelb: 0, gruen: 2 }, offen: false, geprueft: 'vor 4 Min.' });
  });

  it('klappt einen nicht lesbaren Bereich auf: der Hinweis darf nicht versteckt sein', () => {
    expect(dashboardAnsicht([modul('kaputt', undefined)], JETZT).abschnitte[0]?.offen).toBe(true);
  });

  it('führt Module mit art „liste" als Team-Liste, nicht als Bereich — sie zählen nicht in Zustand und Kennzahlen', () => {
    const social: ModulMitKarten = {
      kennung: 'social',
      block: block('social', 'Social', { kurztext: 'text', art: 'liste', titel: 'Social diese Woche' }),
      zeilen: [
        zeile('1', 'Post Facebook', 'gelb', 'Entwurf wartet', new Date(JETZT.getTime() - 3 * STUNDE)),
        zeile('2', 'Post LinkedIn', 'gruen', 'Freigegeben', new Date(JETZT.getTime() - STUNDE)),
        zeile('3', 'Alt', 'gruen', 'Veröffentlicht', new Date(JETZT.getTime() - 48 * STUNDE)),
        zeile('4', 'Älter', 'gruen', 'Veröffentlicht', new Date(JETZT.getTime() - 72 * STUNDE)),
        zeile('5', 'Am ältesten', 'gruen', 'Veröffentlicht', new Date(JETZT.getTime() - 96 * STUNDE)),
      ],
      verlauf: undefined,
    };
    const d = dashboardAnsicht([modul('dienste', [zeile('1', 'A', 'gruen')], new Map()), social], JETZT);

    expect(d.abschnitte.map((abschnitt) => abschnitt.kennung)).toEqual(['dienste']);
    expect(d.kennzahlen.dienste).toBe('1 von 1');
    expect(d.zustand.farbe).toBe('gruen');
    expect(d.listen).toHaveLength(1);
    const liste = d.listen[0];
    expect(liste).toMatchObject({ kennung: 'social', titel: 'Social diese Woche', href: '/module/social?von=uebersicht', offen: 1, verfuegbar: true });
    // Offenes zuerst, dann die jüngsten; höchstens vier.
    expect(liste?.zeilen.map((z) => z.titel)).toEqual(['Post Facebook', 'Post LinkedIn', 'Alt', 'Älter']);
    expect(liste?.zeilen[0]).toMatchObject({ text: 'Entwurf wartet', status: { farbe: 'gelb', wort: 'Achtung' }, href: '/module/social/1?von=uebersicht' });
  });
});

describe('dashboardAnsicht — Team-Listen zählen nur Rot und Gelb (COPI-125)', () => {
  it('zählt ein eigenes Wort ohne Farbe („Nicht gewählt") nicht als offen und sortiert es hinter die offenen', () => {
    const blog: ModulMitKarten = {
      kennung: 'blog',
      block: block('blog', 'Blog', { kurztext: 'text', art: 'liste' }),
      zeilen: [
        zeile('1', 'Nicht gewählt', 'Nicht gewählt', 'Vorschlag', new Date(JETZT.getTime() - STUNDE)),
        zeile('2', 'Wählen', 'gelb', 'Vorschlag', new Date(JETZT.getTime() - 2 * STUNDE)),
      ],
      verlauf: undefined,
    };
    const liste = dashboardAnsicht([blog], JETZT).listen[0];
    expect(liste?.offen).toBe(1);
    expect(liste?.zeilen.map((z) => z.titel)).toEqual(['Wählen', 'Nicht gewählt']);
  });
});
