/**
 * Die reinen Berechnungen der Kachel-Darstellung der Modulseite (COPI-82, `src/module/modul-kacheln.ts`): der
 * Filter aus der Adresse, die Filter-Chips mit Anzahl, das Filtern selbst und die Kacheln aus den Zeilen — dazu
 * die verallgemeinerte Eimer-Rechnung, mit der Dashboard-Karte (COPI-81) und Kachel denselben Code nutzen
 * (`src/module/zeitraster.ts`: `gleitendeGrenzen`, `bandFuer`, `bandText`, `verfuegbarkeitText`). Ohne
 * Datenbank, der Zeitpunkt ist immer ein Parameter.
 */
import { describe, expect, it } from 'vitest';
import type { ModulBlock } from '../src/module/block.js';
import type { ModulZeileRoh } from '../src/module/liste-detail.js';
import {
  kachelChips,
  kachelFilterAus,
  kachelnAnsicht,
  kachelnGefiltert,
  KACHEL_BAND_EIMER,
  KACHEL_EIMER_GROESSE_MS,
  type Kachel,
} from '../src/module/modul-kacheln.js';
import { bandFuer, bandText, eimerBelegen, gleitendeGrenzen, stundenGrenzen, STUNDE_MS, verfuegbarkeitText, type VerlaufPunkt } from '../src/module/zeitraster.js';

const JETZT = new Date('2026-09-28T07:50:00.000Z'); // 09:50 in Berlin

function block(spalten: ModulBlock['spalten']): ModulBlock {
  return {
    kennung: 'server-zustand',
    menuename: 'Server & Dienste',
    ansicht: 'liste-detail',
    view: 'v_modul_server_zustand',
    spalten,
    rollen: ['betreuer'],
    eingriffe: [],
    darstellung: 'kacheln',
  };
}

function zeile(id: string, titel: string, status: string, werte: Record<string, unknown> = {}, aktualisiertAm: Date | null = JETZT): ModulZeileRoh {
  return { werte: { id, titel, status, aktualisiert_am: aktualisiertAm, ...werte } };
}

describe('Eimer-Rechnung verallgemeinert (COPI-82: Eimergröße/-anzahl als Parameter)', () => {
  it('gleitendeGrenzen liefert bei anzahl ohne ganze Zahl ab 1 eine leere Liste', () => {
    for (const anzahl of [0, -1, -2, 2.5, Number.NaN]) {
      expect(gleitendeGrenzen(JETZT, anzahl, STUNDE_MS)).toEqual([]);
    }
  });

  it('gleitendeGrenzen mit Eimergröße einer Stunde ist dasselbe wie stundenGrenzen', () => {
    expect(gleitendeGrenzen(JETZT, 24, STUNDE_MS)).toEqual(stundenGrenzen(JETZT, 24));
  });

  it('deckt das 7-Tage-Band der Kachel (28 Eimer zu je sechs Stunden) genau sieben Tage ab', () => {
    const grenzen = gleitendeGrenzen(JETZT, KACHEL_BAND_EIMER, KACHEL_EIMER_GROESSE_MS);
    expect(grenzen).toHaveLength(KACHEL_BAND_EIMER + 1);
    expect(grenzen.at(-1)).toBe(JETZT.getTime());
    expect(JETZT.getTime() - (grenzen[0] ?? 0)).toBe(7 * 24 * STUNDE_MS);
  });

  it('bandFuer bleibt ganz leer ohne Verlauf, gleich welche Eimergröße', () => {
    const eimer = bandFuer(undefined, 'rot', JETZT, KACHEL_BAND_EIMER, KACHEL_EIMER_GROESSE_MS);
    expect(eimer).toHaveLength(KACHEL_BAND_EIMER);
    expect(eimer.every((status) => status === 'leer')).toBe(true);
  });

  it('bandFuer belegt die Eimer aus dem Verlauf und spiegelt den aktuellen Status im jüngsten', () => {
    const punkte: VerlaufPunkt[] = [{ zeitpunkt: new Date(JETZT.getTime() - 5 * KACHEL_EIMER_GROESSE_MS), status: 'gruen' }];
    const eimer = bandFuer(punkte, 'gelb', JETZT, KACHEL_BAND_EIMER, KACHEL_EIMER_GROESSE_MS);
    expect(eimer.at(-1)).toBe('gelb');
    expect(eimer[0]).toBe('leer');
    expect(eimer[KACHEL_BAND_EIMER - 5]).toBe('gruen');
  });

  it('bandText rechnet die Eimer mit stundenJeEimer in Stunden um (Standard eins, wie beim Dashboard)', () => {
    const eimer = eimerBelegen([{ zeitpunkt: new Date(0), status: 'rot' }], [0, 10]);
    expect(bandText('Letzte 24 Stunden', eimer)).toBe('Letzte 24 Stunden: 1 Std. Störung');
    expect(bandText('Letzte 7 Tage', eimer, 6)).toBe('Letzte 7 Tage: 6 Std. Störung');
  });

  it('verfuegbarkeitText: „keine Daten" ohne belegte Eimer, sonst „NN % in Ordnung"', () => {
    expect(verfuegbarkeitText(undefined)).toBe('keine Daten');
    expect(verfuegbarkeitText(96)).toBe('96 % in Ordnung');
  });
});

describe('kachelFilterAus', () => {
  it.each(['rot', 'gelb', 'gruen'] as const)('nimmt den Wert „%s" an', (status) => {
    expect(kachelFilterAus({ status })).toEqual({ status });
  });

  it.each([undefined, '', 'blau', 42, null])('heißt „Alle" bei %j (fehlend oder unbekannt)', (status) => {
    expect(kachelFilterAus({ status })).toEqual({ status: undefined });
  });

  it('heißt „Alle" ganz ohne das Feld', () => {
    expect(kachelFilterAus({})).toEqual({ status: undefined });
  });
});

describe('kachelnGefiltert', () => {
  const kacheln = kachelnAnsicht(
    'dienste',
    block([{ name: 'text', label: 'Meldung' }]),
    [zeile('1', 'A', 'rot'), zeile('2', 'B', 'gelb'), zeile('3', 'C', 'gruen'), zeile('4', 'D', 'sonstwas')],
    undefined,
    JETZT,
  );

  it('lässt ohne Filter alle Kacheln unverändert', () => {
    expect(kachelnGefiltert(kacheln, { status: undefined })).toEqual(kacheln);
  });

  it.each(['rot', 'gelb', 'gruen'] as const)('zeigt mit dem Filter „%s" nur die passenden Kacheln', (status) => {
    const gefiltert = kachelnGefiltert(kacheln, { status });
    expect(gefiltert.every((kachel) => kachel.status.farbe === status)).toBe(true);
    expect(gefiltert).toHaveLength(1);
  });

  it('zeigt für einen unbekannten Status (Fehler in der Fach-View) mit keinem der drei Filter etwas', () => {
    for (const status of ['rot', 'gelb', 'gruen'] as const) {
      expect(kachelnGefiltert(kacheln, { status }).some((kachel) => kachel.id === '4')).toBe(false);
    }
  });
});

describe('kachelChips', () => {
  const kacheln = kachelnAnsicht(
    'dienste',
    block([{ name: 'text', label: 'Meldung' }]),
    [zeile('1', 'A', 'rot'), zeile('2', 'B', 'gelb'), zeile('3', 'C', 'gruen'), zeile('4', 'D', 'gruen'), zeile('5', 'E', 'gruen'), zeile('6', 'F', 'gruen')],
    undefined,
    JETZT,
  );

  it('zählt „Alle" und je Zustand — wie im freigegebenen Entwurf: Alle · 6, Störung · 1, Achtung · 1, Läuft · 4', () => {
    const chips = kachelChips('dienste', kacheln, { status: undefined });
    expect(chips.map((chip) => chip.text)).toEqual(['Alle · 6', 'Störung · 1', 'Achtung · 1', 'Läuft · 4']);
    expect(chips.map((chip) => chip.farbe)).toEqual([undefined, 'rot', 'gelb', 'gruen']);
    expect(chips[0]?.aktuell).toBe(true);
    expect(chips.slice(1).every((chip) => chip.aktuell === false)).toBe(true);
  });

  it('zeigt einen Chip mit Anzahl 0, wenn kein Zustand dieser Farbe vorkommt', () => {
    const nurGruen = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('1', 'A', 'gruen')], undefined, JETZT);
    const chips = kachelChips('dienste', nurGruen, { status: undefined });
    expect(chips.map((chip) => chip.text)).toEqual(['Alle · 1', 'Störung · 0', 'Achtung · 0', 'Läuft · 1']);
  });

  it('zählt weiterhin alle Kacheln, auch wenn ein Filter aktiv ist — sonst verschwände der Chip beim Filtern', () => {
    const chips = kachelChips('dienste', kacheln, { status: 'rot' });
    expect(chips.map((chip) => chip.text)).toEqual(['Alle · 6', 'Störung · 1', 'Achtung · 1', 'Läuft · 4']);
    expect(chips.find((chip) => chip.farbe === 'rot')?.aktuell).toBe(true);
    expect(chips[0]?.aktuell).toBe(false);
  });

  it('verlinkt „Alle" ohne Query, jeden Zustand mit ?status=', () => {
    const chips = kachelChips('dienste', kacheln, { status: undefined });
    expect(chips[0]?.href).toBe('/module/dienste');
    expect(chips.find((chip) => chip.farbe === 'rot')?.href).toBe('/module/dienste?status=rot');
  });
});

describe('kachelnAnsicht', () => {
  it('zeigt die deklarierten Spalten außer titel/status/aktualisiert_am als Felder, in Reihenfolge des Blocks', () => {
    const b = block([
      { name: 'titel', label: 'Titel' },
      { name: 'text', label: 'Meldung' },
      { name: 'status', label: 'Zustand' },
      { name: 'aktualisiert_am', label: 'Zuletzt', format: 'zeitpunkt' },
      { name: 'zahl', label: 'Menge', format: 'zahl' },
    ]);
    const [kachel] = kachelnAnsicht('dienste', b, [zeile('1', 'A', 'gruen', { text: 'Läuft.', zahl: 5000 })], undefined, JETZT);
    expect(kachel?.felder).toEqual([
      { label: 'Meldung', wert: 'Läuft.' },
      { label: 'Menge', wert: '5.000' },
    ]);
  });

  it('berechnet Kürzel, Href, Status als Punkt + Wort und „Zuletzt gemeldet" aus aktualisiert_am', () => {
    const [kachel] = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('web-1', 'Webserver', 'rot')], undefined, JETZT);
    expect(kachel).toMatchObject({
      id: 'web-1',
      titel: 'Webserver',
      kuerzel: 'WE',
      status: { farbe: 'rot', wort: 'Störung' },
      href: '/module/dienste/web-1',
      geprueft: 'Zuletzt gemeldet: 09:50',
    });
  });

  it('zeigt „—" bei aktualisiert_am NULL', () => {
    const [kachel] = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('1', 'A', 'gruen', {}, null)], undefined, JETZT);
    expect(kachel?.geprueft).toBe('Zuletzt gemeldet: —');
  });

  it('lässt Band und Verfügbarkeit ganz weg, wenn für das Modul kein Verlauf bekannt ist (anders als das Dashboard)', () => {
    const [kachel] = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('1', 'A', 'rot')], undefined, JETZT);
    expect(kachel?.band).toBeUndefined();
    expect(kachel?.verfuegbarkeit).toBeUndefined();
  });

  it('zeigt ein (ggf. neutrales) Band, sobald für das Modul ein Verlauf bekannt ist — auch ohne Punkte für diese id', () => {
    const verlauf = new Map<string, readonly VerlaufPunkt[]>([['bekannt', [{ zeitpunkt: new Date(JETZT.getTime() - 5 * STUNDE_MS), status: 'gruen' }]]]);
    const [kachel] = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('ohne-punkte', 'A', 'rot')], verlauf, JETZT);
    expect(kachel?.band?.segmente).toHaveLength(KACHEL_BAND_EIMER);
    // Ohne eigene Punkte, aber der aktuelle Status (rot) spiegelt im jüngsten Eimer — der zählt als „belegt".
    expect(kachel?.band?.segmente.at(-1)).toBe('rot');
    expect(kachel?.verfuegbarkeit).toBe('0 % in Ordnung');
  });

  it('nimmt die Punkte der eigenen id aus dem Verlauf für das Band', () => {
    const verlauf = new Map<string, readonly VerlaufPunkt[]>([
      ['web', Array.from({ length: KACHEL_BAND_EIMER - 1 }, (_, i) => ({ zeitpunkt: new Date(JETZT.getTime() - (KACHEL_BAND_EIMER - 1 - i) * KACHEL_EIMER_GROESSE_MS), status: 'gruen' as const }))],
    ]);
    const [kachel] = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('web', 'Webserver', 'gruen')], verlauf, JETZT);
    expect(kachel?.verfuegbarkeit).toBe('100 % in Ordnung');
  });

  it('behält für einen unbekannten Status (Fehler in der Fach-View) sein eigenes Wort — kein „im Zweifel gelb" wie im Dashboard', () => {
    const [kachel] = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('1', 'A', 'kaputt')], undefined, JETZT);
    expect(kachel?.status).toEqual({ farbe: 'unbekannt', wort: 'kaputt' });
  });

  it('berechnet trotzdem ein Band für einen unbekannten Status, ohne zu scheitern', () => {
    const verlauf = new Map<string, readonly VerlaufPunkt[]>();
    const kacheln: readonly Kachel[] = kachelnAnsicht('dienste', block([{ name: 'text', label: 'Meldung' }]), [zeile('1', 'A', 'kaputt')], verlauf, JETZT);
    expect(kacheln[0]?.band?.segmente).toHaveLength(KACHEL_BAND_EIMER);
  });

  it('gibt für mehrere Zeilen Kacheln in derselben Reihenfolge zurück (die Abfrage sortiert schon)', () => {
    const kacheln = kachelnAnsicht(
      'dienste',
      block([{ name: 'text', label: 'Meldung' }]),
      [zeile('1', 'A rot', 'rot'), zeile('2', 'B gelb', 'gelb'), zeile('3', 'C gruen', 'gruen')],
      undefined,
      JETZT,
    );
    expect(kacheln.map((kachel) => kachel.titel)).toEqual(['A rot', 'B gelb', 'C gruen']);
  });
});
