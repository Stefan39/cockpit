/**
 * Die Detailseite eines Agenten (COPI-113) ohne Datenbank: Schlüssel in der Adresse, Bereiche je Recht, Verbrauch,
 * Protokoll und der Abschnitt `agent` im Modul-Block.
 */
import { describe, expect, it } from 'vitest';
import {
  agentenEreignis,
  agentPfad,
  agentSchluessel,
  bereichAus,
  initiale,
  protokollAnsicht,
  protokollArtAus,
  protokollChips,
  reiter,
  standText,
  uebernahmeEreignisse,
  verbrauchAb,
  verbrauchAnsicht,
  type ProtokollEreignis,
} from '../src/agenten/detail.js';
import { modulBlockPruefen } from '../src/module/block.js';
import { euroText } from '../src/module/kennzahlen-ansicht.js';

const JETZT = new Date('2026-10-02T10:00:00.000Z');

describe('Schlüssel und Adresse', () => {
  it('führt nie über die Kennung, sondern über 16 Hex-Zeichen, stabil je Kennung', () => {
    expect(agentSchluessel('assistent')).toMatch(/^[0-9a-f]{16}$/);
    expect(agentSchluessel('assistent')).toBe(agentSchluessel('assistent'));
    expect(agentSchluessel('assistent')).not.toBe(agentSchluessel('koordinator'));
    expect(agentPfad('assistent')).toBe(`/agenten/${agentSchluessel('assistent')}`);
    expect(agentPfad('assistent', 'mails')).toBe(`/agenten/${agentSchluessel('assistent')}?bereich=mails`);
    expect(agentPfad('assistent')).not.toContain('assistent');
  });
});

describe('Bereiche je Recht', () => {
  it('nimmt einen unbekannten Bereich als Steckbrief, und Verbrauch nur mit technik_sehen', () => {
    expect(bereichAus('chats', false)).toBe('chats');
    expect(bereichAus('gibt-es-nicht', true)).toBe('steckbrief');
    expect(bereichAus(['chats'], true)).toBe('steckbrief');
    expect(bereichAus('verbrauch', false)).toBe('steckbrief');
    expect(bereichAus('verbrauch', true)).toBe('verbrauch');
  });

  it('zeigt den Reiter Verbrauch nur mit technik_sehen und eine Zahl nur über null', () => {
    expect(reiter('assistent', 'steckbrief', false, { mails: 0 }).map((r) => r.text)).toEqual(['Steckbrief', 'Chats', 'Mails', 'Protokoll']);
    const mitTechnik = reiter('assistent', 'mails', true, { mails: 3 });
    expect(mitTechnik.map((r) => r.text)).toContain('Verbrauch');
    expect(mitTechnik.find((r) => r.text === 'Mails')).toMatchObject({ aktuell: true, zahl: 3 });
    expect(mitTechnik.find((r) => r.text === 'Chats')?.zahl).toBeUndefined();
  });

  it('nimmt den Anfangsbuchstaben der Rolle, sonst der Kennung', () => {
    expect(initiale('assistent – Eingang', 'assistent')).toBe('A');
    expect(initiale('  ', 'wache')).toBe('W');
  });
});

describe('verbrauchAnsicht', () => {
  const zeile = (tag: string, modell: string, eur: number | undefined, einsaetze = 1) => ({
    tag,
    modell,
    einsaetze,
    mitSubagent: 0,
    tokens: 1000,
    tokensCacheLesen: 800,
    eur,
  });

  it('summiert den laufenden Monat, teilt nach Modell und zeichnet 30 Tage', () => {
    const ansicht = verbrauchAnsicht(
      [zeile('2026-09-30', 'haiku', 5), zeile('2026-10-01', 'haiku', 1.5), zeile('2026-10-02', 'sonnet', 0.5, 2), zeile('2026-10-02', 'haiku', undefined)],
      JETZT,
    );
    expect(ansicht.monatName).toBe('Oktober');
    expect(ansicht.monat).toBe(euroText(2));
    expect(ansicht.einsaetze).toBe('4');
    expect(ansicht.cacheAnteil).toBe(80);
    expect(ansicht.ohnePreis).toBe(true);
    expect(ansicht.modelle).toEqual([
      { modell: 'haiku', eur: euroText(1.5), anteil: 75 },
      { modell: 'sonnet', eur: euroText(0.5), anteil: 25 },
    ]);
    // Der September zählt im Diagramm (letzte 30 Tage), nicht im Monat.
    expect(ansicht.diagramm.balken).toHaveLength(3);
    expect(ansicht.leer).toBe(false);
  });

  it('ist ohne Einsätze leer', () => {
    expect(verbrauchAnsicht([], JETZT)).toMatchObject({ leer: true, monat: euroText(0), modelle: [] });
  });

  it('liest ab dem früheren von Monatsanfang und vor 29 Tagen', () => {
    expect(verbrauchAb(JETZT)).toBe('2026-09-03');
    expect(verbrauchAb(new Date('2026-10-31T10:00:00.000Z'))).toBe('2026-10-01');
  });
});

describe('Protokoll', () => {
  const ereignis = (art: ProtokollEreignis['art'], minuten: number, ton: ProtokollEreignis['ton'] = 'akzent'): ProtokollEreignis => ({
    art,
    titel: `${art} ${String(minuten)}`,
    text: 'Text',
    am: new Date(JETZT.getTime() - minuten * 60_000),
    ton,
    typ: art,
  });

  it('sortiert neueste zuerst, filtert nach Art und begrenzt', () => {
    const alle = [ereignis('mail', 30), ereignis('befund', 5, 'rot'), ereignis('agent', 10), ereignis('befund', 60, 'gruen')];
    expect(protokollAnsicht(alle, JETZT).map((z) => z.titel)).toEqual(['befund 5', 'agent 10', 'mail 30', 'befund 60']);
    expect(protokollAnsicht(alle, JETZT, 'befund').map((z) => [z.titel, z.symbol])).toEqual([
      ['befund 5', 'warnung'],
      ['befund 60', 'ok'],
    ]);
    expect(protokollAnsicht(alle, JETZT, undefined, 2)).toHaveLength(2);
  });

  it('kennt nur die festen Arten im Filter, und „Agent ↔ Agent" nur mit technik_sehen', () => {
    expect(protokollArtAus('mail')).toBe('mail');
    expect(protokollArtAus('evil')).toBeUndefined();
    const kunde = protokollChips('assistent', undefined, false);
    expect(kunde.map((c) => c.text)).toEqual(['Alle', 'Mails', 'Übernahmen', 'Befunde', 'Ereignisse']);
    expect(kunde[0]?.aktuell).toBe(true);
    expect(protokollChips('assistent', 'mail', true).find((c) => c.text === 'Mails')).toMatchObject({ aktuell: true, href: `${agentPfad('assistent', 'protokoll')}&art=mail` });
  });

  it('macht aus einer Übernahme mit Rückgabe zwei Ereignisse', () => {
    const ereignisse = uebernahmeEreignisse(
      { modul: 'kommunikation', vorgangId: '7', von: 'Carla Conrad', am: new Date('2026-10-02T08:00:00Z'), zurueckAm: new Date('2026-10-02T09:00:00Z') },
      'Kommunikation',
      'Rückfrage zur Rechnung',
      '/module/kommunikation/7',
    );
    expect(ereignisse.map((e) => e.titel)).toEqual(['Vorgang übernommen', 'Vorgang zurückgegeben']);
    expect(ereignisse[0]?.text).toContain('Carla Conrad hat „Rückfrage zur Rechnung" übernommen.');
  });

  it('nennt eine Nachricht zwischen Agenten aus Sicht des Agenten der Seite', () => {
    const basis = { kanalId: 3, von: 'assistent', an: 'koordinator', inhalt: 'Hallo', am: JETZT };
    expect(agentenEreignis(basis, 'assistent', '/x').titel).toBe('Nachricht an koordinator');
    expect(agentenEreignis(basis, 'koordinator', '/x').titel).toBe('Nachricht von assistent');
    expect(agentenEreignis({ ...basis, inhalt: undefined }, 'assistent', '/x').text).toBe('Nachricht gelöscht');
  });

  it('nennt den Stand des Inventars, oder seit wann der Agent fehlt', () => {
    expect(standText(new Date(JETZT.getTime() - 4 * 60_000), undefined, JETZT)).toEqual({ text: 'Im Inventar · gemeldet vor 4 Min.', aktiv: true });
    expect(standText(JETZT, new Date('2026-09-30T08:00:00Z'), JETZT).aktiv).toBe(false);
  });
});

describe('modulBlockPruefen — agent (COPI-113)', () => {
  const BLOCK = {
    kennung: 'kommunikation',
    menuename: 'Kommunikation',
    ansicht: 'liste-detail',
    view: 'v_modul_kommunikation',
    spalten: [{ name: 'zusammenfassung', label: 'Worum es geht' }],
    rollen: ['betreuer'],
    eingriffe: [],
  };

  it('nimmt eine Kennung in der Form des Inventars an', () => {
    for (const agent of ['assistent', 'admin.agent', 'koordinator_1']) {
      const ergebnis = modulBlockPruefen({ ...BLOCK, agent });
      expect(ergebnis.ok && ergebnis.block.agent).toBe(agent);
    }
  });

  it('weist eine ungültige Kennung ab', () => {
    for (const agent of ['Assistent', '-assistent', 'assi stent', '']) {
      const ergebnis = modulBlockPruefen({ ...BLOCK, agent });
      expect(ergebnis.ok === false && ergebnis.grund).toContain('agent');
    }
  });
});

describe('gemeldete Ereignisse (COPI-114)', () => {
  it('färbt nach Stufe, nennt ohne Titel des Agenten einen neutralen und filtert nach Stufe', async () => {
    const { agentEreignisZeile, stufeAus, stufenChips } = await import('../src/agenten/detail.js');
    const fehler = agentEreignisZeile({ stufe: 'fehler', titel: 'Lauf gescheitert', text: 'x', zeitpunkt: JETZT });
    const info = agentEreignisZeile({ stufe: 'info', titel: undefined, text: 'y', zeitpunkt: new Date(JETZT.getTime() - 60_000) });
    expect(fehler).toMatchObject({ art: 'ereignis', titel: 'Lauf gescheitert', ton: 'rot', typ: 'Ereignis · Fehler', stufe: 'fehler' });
    expect(info).toMatchObject({ titel: 'Ereignis gemeldet', ton: 'akzent', typ: 'Ereignis · Info' });
    expect(agentEreignisZeile({ stufe: 'warnung', titel: undefined, text: 'z', zeitpunkt: JETZT }).titel).toBe('Warnung gemeldet');

    expect(protokollAnsicht([fehler, info], JETZT, 'ereignis', 50, 'fehler').map((z) => [z.titel, z.symbol])).toEqual([['Lauf gescheitert', 'blitz']]);
    expect(protokollAnsicht([fehler, info], JETZT, 'ereignis')).toHaveLength(2);
    expect(stufeAus('fehler')).toBe('fehler');
    expect(stufeAus('alles')).toBeUndefined();
    expect(stufenChips('assistent', 'warnung').find((chip) => chip.aktuell)?.text).toBe('Warnungen');
    expect(protokollChips('assistent', undefined, false).map((c) => c.text)).toContain('Ereignisse');
  });
});
