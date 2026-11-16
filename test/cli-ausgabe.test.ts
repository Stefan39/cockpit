/**
 * Ausgabeblöcke des Server-Kommandos (`src/cli/ausgabe.ts`, COPI-24).
 * Reine Textfunktionen, kein Datenbankzugriff. Kernregel: Link bzw. Token steht genau einmal im Block.
 */
import { describe, expect, it } from 'vitest';
import { ROLLEN_NAMEN } from '../src/auth/berechtigung.js';
import {
  apiTokenBlockBauen,
  einladungBlockBauen,
  entsperrungBlockBauen,
  modulEinspielenBlockBauen,
  type ApiTokenAusgabe,
  type EinladungAusgabe,
  type EntsperrungAusgabe,
  type ModulEinspielenAusgabe,
} from '../src/cli/ausgabe.js';

const RAHMEN = '='.repeat(72);
const URL_EINLADUNG = 'https://cockpit.example.test/einladung/Einladung_abc-123';
const URL_ENTSPERRUNG = 'https://cockpit.example.test/entsperren/Entsperr_xyz-789';
const API_TOKEN = 'Apitoken_qrs-456';

const EINLADUNG: EinladungAusgabe = {
  email: 'neu@example.test',
  rolle: 'betriebs_admin',
  url: URL_EINLADUNG,
  gueltigStunden: 3,
};
const ENTSPERRUNG: EntsperrungAusgabe = {
  email: 'konto@example.test',
  url: URL_ENTSPERRUNG,
  gueltigStunden: 2,
};
const API_ZUGANG: ApiTokenAusgabe = {
  id: 17,
  name: 'admin-agent',
  scopes: ['befund_schreiben', 'zustand_lesen'],
  token: API_TOKEN,
};
const MODUL: ModulEinspielenAusgabe = {
  status: 'neu',
  kennung: 'beispiel-modul',
  version: 4,
  pruefsumme: 'f'.repeat(64),
};

function vorkommen(text: string, teil: string): number {
  return text.split(teil).length - 1;
}

const BLOECKE: readonly (readonly [string, string, string])[] = [
  ['einladungBlockBauen', einladungBlockBauen(EINLADUNG), 'COCKPIT — EINLADUNG (ohne Mail)'],
  ['entsperrungBlockBauen', entsperrungBlockBauen(ENTSPERRUNG), 'COCKPIT — ZUGANG WIEDERHERSTELLEN'],
  ['apiTokenBlockBauen', apiTokenBlockBauen(API_ZUGANG), 'COCKPIT — ZUGANG DER AGENTEN-API'],
  ['modulEinspielenBlockBauen', modulEinspielenBlockBauen(MODUL), 'COCKPIT — MODUL EINGESPIELT'],
];

describe.each(BLOECKE)('%s', (_name, block, ueberschrift) => {
  const zeilen = block.split('\n');

  it('beginnt und endet mit einer Leerzeile', () => {
    expect(zeilen[0]).toBe('');
    expect(zeilen[zeilen.length - 1]).toBe('');
  });

  it('rahmt den Text oben und unten mit 72 Gleichheitszeichen', () => {
    expect(zeilen[1]).toBe(RAHMEN);
    expect(zeilen[zeilen.length - 2]).toBe(RAHMEN);
    expect(vorkommen(block, RAHMEN)).toBe(2);
  });

  it('enthält die Überschrift', () => {
    expect(block).toContain(`  ${ueberschrift}`);
  });
});

describe('einladungBlockBauen', () => {
  it('enthält den Link genau einmal', () => {
    expect(vorkommen(einladungBlockBauen(EINLADUNG), URL_EINLADUNG)).toBe(1);
  });

  it('setzt E-Mail, Gültigkeit und Rollenname ein', () => {
    const block = einladungBlockBauen(EINLADUNG);

    expect(block).toContain('neu@example.test');
    expect(block).toContain('Gültig 3 Stunden.');
    expect(block).toContain(`Rolle „${ROLLEN_NAMEN.betriebs_admin}"`);
  });

  it('nennt den Rollennamen statt des Datenbankwerts', () => {
    const block = einladungBlockBauen({ ...EINLADUNG, rolle: 'betrieb_mitarbeiter' });

    expect(block).toContain(`Rolle „${ROLLEN_NAMEN.betrieb_mitarbeiter}"`);
    expect(block).not.toContain('betrieb_mitarbeiter');
  });
});

describe('entsperrungBlockBauen', () => {
  it('enthält den Link genau einmal', () => {
    expect(vorkommen(entsperrungBlockBauen(ENTSPERRUNG), URL_ENTSPERRUNG)).toBe(1);
  });

  it('setzt E-Mail und Gültigkeit ein', () => {
    const block = entsperrungBlockBauen(ENTSPERRUNG);

    expect(block).toContain('Konto: konto@example.test');
    expect(block).toContain('Gültig 2 Stunden.');
  });
});

describe('apiTokenBlockBauen', () => {
  it('enthält das Token genau einmal, im Hinweis nur den Platzhalter', () => {
    const block = apiTokenBlockBauen(API_ZUGANG);

    expect(vorkommen(block, API_TOKEN)).toBe(1);
    expect(block).toContain('Authorization: Bearer <token>');
  });

  it('nennt Nummer, Name und Rechte', () => {
    const block = apiTokenBlockBauen(API_ZUGANG);

    expect(block).toContain('Nummer:  17');
    expect(block).toContain('Name:    admin-agent');
    expect(block).toContain('Rechte:  befund_schreiben, zustand_lesen');
  });

  it('nennt die Nummer im Widerruf-Hinweis', () => {
    expect(apiTokenBlockBauen(API_ZUGANG)).toContain('api-token-widerrufen --id 17');
  });
});

describe('modulEinspielenBlockBauen', () => {
  it('nennt Kennung, Version und Prüfsumme genau einmal', () => {
    const block = modulEinspielenBlockBauen(MODUL);

    expect(vorkommen(block, 'beispiel-modul')).toBe(1);
    expect(block).toContain('Version:    4');
    expect(vorkommen(block, MODUL.pruefsumme)).toBe(1);
  });

  it('meldet eine neue Version als aktiv', () => {
    const block = modulEinspielenBlockBauen(MODUL);

    expect(block).toContain('COCKPIT — MODUL EINGESPIELT');
    expect(block).toContain('Diese Version ist ab sofort aktiv.');
  });

  it('meldet einen unveränderten Block ohne neue Version', () => {
    const block = modulEinspielenBlockBauen({ ...MODUL, status: 'unveraendert' });

    expect(block).toContain('COCKPIT — MODUL UNVERÄNDERT');
    expect(block).toContain('keine neue Version angelegt.');
    expect(block).not.toContain('ab sofort aktiv');
  });

  it('nennt den erledigten Modul-Antrag nur, wenn einer belegt ist', () => {
    expect(modulEinspielenBlockBauen(MODUL)).not.toContain('Modul-Antrag');
    expect(modulEinspielenBlockBauen({ ...MODUL, erledigt: 9 })).toContain('Modul-Antrag Nr. 9 ist damit erledigt.');
  });
});
