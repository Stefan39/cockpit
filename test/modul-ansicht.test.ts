/**
 * Was die Modulseiten aus den Rohdaten machen (COPI-78) — reine Funktionen, ohne Datenbank und ohne Uhr.
 */
import { describe, expect, it } from 'vitest';
import { zeitText } from '../src/chat/ansicht.js';
import {
  langtextBereinigen,
  modulDetailAbschnitte,
  modulDetailAnsicht,
  modulLink,
  modulListeAnsicht,
  modulStatusAnsicht,
  wertFormatieren,
  modulZeilenTitel,
  moduleAnsicht,
  type ModulUebersichtEintrag,
} from '../src/module/ansicht.js';
import type { ModulSpalte } from '../src/module/block.js';
import type { ModulZeileRoh } from '../src/module/liste-detail.js';
import type { AktivesModul } from '../src/module/modul-speicher.js';

const JETZT = new Date('2026-09-27T12:00:00.000Z');

function modul(kennung: string, menuename: string): AktivesModul {
  return {
    kennung,
    version: 1,
    eingespieltAm: new Date('2026-09-01T00:00:00.000Z'),
    betreuerZugriff: 'entscheiden',
    block: {
      kennung,
      menuename,
      ansicht: 'liste-detail',
      view: `v_modul_${kennung.replace(/-/g, '_')}`,
      spalten: [{ name: 'titel', label: 'Titel' }],
      rollen: ['betreuer'],
      eingriffe: [],
    },
  };
}

describe('moduleAnsicht', () => {
  it('bildet Kennung und Menüname ab, sortiert nach Menüname (deutsch), dann nach Kennung', () => {
    const eintraege: ModulUebersichtEintrag[] = [...moduleAnsicht([modul('b', 'Öfen'), modul('a', 'Anlagen')])];

    expect(eintraege).toEqual([
      { kennung: 'a', menuename: 'Anlagen', version: 1 },
      { kennung: 'b', menuename: 'Öfen', version: 1 },
    ]);
  });

  it('liefert eine leere Liste ohne Module', () => {
    expect(moduleAnsicht([])).toEqual([]);
  });
});

describe('modulStatusAnsicht', () => {
  it.each([
    ['gruen', 'Läuft'],
    ['gelb', 'Achtung'],
    ['rot', 'Störung'],
  ] as const)('zeigt %s als Punkt derselben Farbe mit dem Wort „%s"', (status, wort) => {
    expect(modulStatusAnsicht(status)).toEqual({ farbe: status, wort });
  });

  it('zeigt einen unbekannten Wert neutral, mit seinem eigenen Text statt eines geratenen Wortes', () => {
    expect(modulStatusAnsicht('storniert')).toEqual({ farbe: 'unbekannt', wort: 'storniert' });
  });
});

function zeile(werte: Record<string, unknown>): ModulZeileRoh {
  return { werte };
}

describe('modulListeAnsicht', () => {
  it('formatiert Pflichtspalten und baut den Link auf die Detailseite, id und Kennung kodiert', () => {
    const aktualisiertAm = new Date('2026-09-27T11:58:00.000Z');
    const zeilen = [zeile({ id: 'a b', titel: 'Erste Zeile', status: 'rot', aktualisiert_am: aktualisiertAm })];

    const ansicht = modulListeAnsicht('mein modul', zeilen, JETZT);

    expect(ansicht).toEqual([
      {
        id: 'a b',
        titel: 'Erste Zeile',
        status: { farbe: 'rot', wort: 'Störung' },
        aktualisiertAm: zeitText(aktualisiertAm, JETZT),
        href: `/module/${encodeURIComponent('mein modul')}/${encodeURIComponent('a b')}`,
      },
    ]);
  });

  it('liefert eine leere Liste ohne Zeilen', () => {
    expect(modulListeAnsicht('modul', [], JETZT)).toEqual([]);
  });
});

describe('modulZeilenTitel', () => {
  it('liest den Titel als Text', () => {
    expect(modulZeilenTitel(zeile({ titel: 'Ein Titel' }))).toBe('Ein Titel');
  });

  it('liefert einen leeren Text ohne Titel', () => {
    expect(modulZeilenTitel(zeile({}))).toBe('');
  });
});

describe('modulDetailAnsicht', () => {
  const spalten: readonly ModulSpalte[] = [
    { name: 'titel', label: 'Titel' },
    { name: 'anzahl', label: 'Anzahl', format: 'zahl' },
    { name: 'faellig', label: 'Fällig', format: 'zeitpunkt' },
    { name: 'notiz', label: 'Notiz' },
  ];

  it('zeigt jede deklarierte Spalte mit ihrem Label, in der Reihenfolge des Blocks, und stellt die Pflichtspalte status voran, wenn sie nicht deklariert ist', () => {
    const felder = modulDetailAnsicht(
      spalten,
      zeile({ titel: 'Beispiel', status: 'gelb', anzahl: 1234, faellig: new Date('2026-09-27T09:00:00.000Z'), notiz: null }),
      JETZT,
    );

    expect(felder.map((feld) => feld.label)).toEqual(['Status', 'Titel', 'Anzahl', 'Fällig', 'Notiz']);
    expect(felder[0]).toEqual({ label: 'Status', art: 'status', status: { farbe: 'gelb', wort: 'Achtung' } });
    expect(felder[1]).toEqual({ label: 'Titel', art: 'text', wert: 'Beispiel' });
    expect(felder[2]).toEqual({ label: 'Anzahl', art: 'text', wert: '1.234' });
    expect(felder[4]).toEqual({ label: 'Notiz', art: 'text', wert: '—' });
  });

  it('zeigt die deklarierte Pflichtspalte status an ihrer Stelle, mit ihrem eigenen Label, als Punkt + Wort statt als Rohtext (Review COPI-78)', () => {
    const felder = modulDetailAnsicht(
      [
        { name: 'titel', label: 'Titel' },
        { name: 'status', label: 'Zustand' },
      ],
      zeile({ titel: 'Beispiel', status: 'rot' }),
      JETZT,
    );

    expect(felder).toEqual([
      { label: 'Titel', art: 'text', wert: 'Beispiel' },
      { label: 'Zustand', art: 'status', status: { farbe: 'rot', wort: 'Störung' } },
    ]);
  });

  it('zeigt einen Betrag mit dem Format euro als Euro, auch als Text aus numeric (COPI-137)', () => {
    const felder = modulDetailAnsicht(
      [
        { name: 'umsatz', label: 'Umsatz', format: 'euro' },
        { name: 'offen', label: 'Offen', format: 'euro' },
      ],
      zeile({ umsatz: '12345.6', offen: -80, status: 'gruen' }),
      JETZT,
    );

    expect(felder.slice(1).map((feld) => (feld.art === 'text' ? feld.wert : undefined))).toEqual(['12.345,60\u00a0€', '-80,00\u00a0€']);
  });

  it('zeigt eine Zahl aus der Datenbank (als Text geliefert) trotzdem deutsch formatiert', () => {
    const felder = modulDetailAnsicht([{ name: 'anzahl', label: 'Anzahl', format: 'zahl' }], zeile({ anzahl: '2500', status: 'gruen' }), JETZT);

    expect(felder).toEqual([
      { label: 'Status', art: 'status', status: { farbe: 'gruen', wort: 'Läuft' } },
      { label: 'Anzahl', art: 'text', wert: '2.500' },
    ]);
  });

  it('zeigt einen Wert, der keine Zahl ist, unverändert, statt „NaN" zu behaupten', () => {
    const felder = modulDetailAnsicht([{ name: 'anzahl', label: 'Anzahl', format: 'zahl' }], zeile({ anzahl: 'unbekannt', status: 'gruen' }), JETZT);

    expect(felder[1]).toEqual({ label: 'Anzahl', art: 'text', wert: 'unbekannt' });
  });
});

describe('Langtext (COPI-103)', () => {
  const NACHRICHT: ModulSpalte = {
    name: 'text',
    label: 'Nachricht',
    format: 'langtext',
    gekuerzt: { spalte: 'text_gekuerzt', hinweis: 'Gekürzt auf 10.000 Zeichen. Der vollständige Text liegt im Postfach.' },
  };
  const SPALTEN: readonly ModulSpalte[] = [{ name: 'absender', label: 'Absender' }, NACHRICHT];

  it('steht nicht in den Feldern der Wertliste, sondern als eigener Abschnitt', () => {
    const roh = zeile({ id: '1', titel: 'T', status: 'gelb', absender: 'A', text: 'Hallo\n\nWelt', text_gekuerzt: false });

    expect(modulDetailAnsicht(SPALTEN, roh, JETZT).map((feld) => feld.label)).toEqual(['Status', 'Absender']);
    expect(modulDetailAbschnitte(SPALTEN, roh)).toEqual([{ label: 'Nachricht', text: 'Hallo\n\nWelt', hinweisGekuerzt: undefined }]);
  });

  it('nennt den Kürzungshinweis des Blocks, wenn die View die Zeile als gekürzt meldet', () => {
    const roh = zeile({ id: '1', text: 'lang', text_gekuerzt: true });
    expect(modulDetailAbschnitte(SPALTEN, roh)[0]?.hinweisGekuerzt).toBe('Gekürzt auf 10.000 Zeichen. Der vollständige Text liegt im Postfach.');
  });

  it.each([null, undefined, '', '   \n  '])('lässt den Abschnitt bei %j weg', (text) => {
    expect(modulDetailAbschnitte(SPALTEN, zeile({ id: '1', text }))).toEqual([]);
  });

  it('liefert mit formatierung: einfach zusätzlich Blöcke mit fett und kursiv, ohne nur den Text (COPI-131)', () => {
    const roh = zeile({ id: '1', text: '## Befunde\n- **A** ist *neu*' });
    const [einfach] = modulDetailAbschnitte([{ ...NACHRICHT, formatierung: 'einfach' }], roh);
    expect(einfach?.bloecke).toEqual([
      { art: 'ueberschrift', text: [{ text: 'Befunde', fett: false, kursiv: false }] },
      {
        art: 'liste',
        punkte: [
          [
            { text: 'A', fett: true, kursiv: false },
            { text: ' ist ', fett: false, kursiv: false },
            { text: 'neu', fett: false, kursiv: true },
          ],
        ],
      },
    ]);
    expect(modulDetailAbschnitte([NACHRICHT], roh)[0]).not.toHaveProperty('bloecke');
  });

  it('kürzt selbst auf 10.000 Zeichen, falls die View mehr liefert, und meldet das', () => {
    const [abschnitt] = modulDetailAbschnitte([{ name: 'text', label: 'N', format: 'langtext' }], zeile({ id: '1', text: 'x'.repeat(12_000) }));
    expect(abschnitt?.text).toHaveLength(10_000);
    expect(abschnitt?.hinweisGekuerzt).toBe('Gekürzt auf 10.000 Zeichen.');
  });
});

describe('langtextBereinigen (COPI-103)', () => {
  it('behält Zeilenumbrüche und Tabs, vereinheitlicht CRLF', () => {
    expect(langtextBereinigen('a\r\nb\rc\n\td')).toBe('a\nb\nc\n\td');
  });

  it.each([
    ['Bidi-Umkehrung (Dateiname-Trick)', 'rechnung‮fdp.exe', 'rechnungfdp.exe'],
    ['Bidi-Isolate', 'a⁦b⁩c', 'abc'],
    ['unsichtbare Breiten', 'a​b‍c﻿d', 'abcd'],
    ['Steuerzeichen', 'a\u0000b\u0007c\u001Bd\u007Fe', 'abcde'],
    ['Richtungsmarken', 'a‎b‏c؜d', 'abcd'],
  ])('entfernt %s', (_fall, roh, erwartet) => {
    expect(langtextBereinigen(roh)).toBe(erwartet);
  });

  it('lässt Umlaute, Emoji und HTML-Zeichen unverändert (maskiert wird beim Ausgeben)', () => {
    expect(langtextBereinigen('Grüße 👋 <b>&amp;</b>')).toBe('Grüße 👋 <b>&amp;</b>');
  });
});

describe('Links nach außen (COPI-91)', () => {
  const DOMAINS = ['portal-a.example.com', 'example.com'];

  it.each([
    ['https://www.portal-a.example.com/jobs/~1', { href: 'https://www.portal-a.example.com/jobs/~1', text: 'portal-a.example.com' }],
    ['https://portal-a.example.com/x', { href: 'https://portal-a.example.com/x', text: 'portal-a.example.com' }],
    ['https://www.example.com/portal/adm/leads/abc', { href: 'https://www.example.com/portal/adm/leads/abc', text: 'example.com' }],
  ])('verlinkt %s', (url, link) => {
    expect(modulLink(url, DOMAINS)).toEqual(link);
  });

  it.each([
    ['http (kein https)', 'http://www.portal-a.example.com/jobs/~1'],
    ['javascript:', 'javascript:alert(1)//portal-a.example.com'],
    ['fremde Domain', 'https://evil.example/portal-a.example.com'],
    ['ähnlicher Host', 'https://evilportal-a.com/x'],
    ['Domain als Subdomain einer fremden', 'https://portal-a.example.com.evil.example/x'],
    ['Zugangsdaten in der URL', 'https://user:pw@www.portal-a.example.com/x'],
    ['Port', 'https://www.portal-a.example.com:8443/x'],
    ['keine URL', 'portal-a.example.com/jobs'],
    ['kein Text', 42],
    ['zu lang', `https://www.portal-a.example.com/${'a'.repeat(2001)}`],
  ])('verlinkt nicht: %s', (_fall, wert) => {
    expect(modulLink(wert, DOMAINS)).toBeUndefined();
  });

  it('zeigt einen erlaubten Link auf der Detailseite als Link, einen fremden als Text', () => {
    const spalten: ModulSpalte[] = [
      { name: 'url', label: 'Ausschreibung', format: 'link', domains: ['portal-a.example.com'] },
      { name: 'lead', label: 'Lead', format: 'link', domains: ['example.com'] },
    ];
    const felder = modulDetailAnsicht(spalten, { werte: { status: 'gelb', url: 'https://www.portal-a.example.com/jobs/~1', lead: 'https://evil.example/x' } }, JETZT);
    expect(felder).toEqual([
      { label: 'Status', art: 'status', status: { farbe: 'gelb', wort: 'Achtung' } },
      { label: 'Ausschreibung', art: 'link', link: { href: 'https://www.portal-a.example.com/jobs/~1', text: 'portal-a.example.com' } },
      { label: 'Lead', art: 'text', wert: 'https://evil.example/x' },
    ]);
  });

  it('zeigt einen Link außerhalb der Detailseite nur als Host', () => {
    expect(wertFormatieren('https://www.portal-a.example.com/jobs/~1', 'link', JETZT)).toBe('portal-a.example.com');
    expect(wertFormatieren('kaputt', 'link', JETZT)).toBe('kaputt');
  });
});

describe('Statuswörter und Marke (COPI-91)', () => {
  it('ersetzt das Wort einer Farbe, nie die Farbe', () => {
    expect(modulStatusAnsicht('gelb', { gelb: 'Offen' })).toEqual({ farbe: 'gelb', wort: 'Offen' });
    expect(modulStatusAnsicht('rot', { gelb: 'Offen' })).toEqual({ farbe: 'rot', wort: 'Störung' });
    expect(modulStatusAnsicht('Passt nicht', { gelb: 'Offen' })).toEqual({ farbe: 'unbekannt', wort: 'Passt nicht' });
  });

  it('nimmt die Statuswörter in Liste und Detailseite, und die Marke aus der View', () => {
    const zeile = { werte: { id: '1', titel: 'Treffer', status: 'gruen', aktualisiert_am: null, marke: '  Grenzfall ' } };
    const [listenZeile] = modulListeAnsicht('akquise', [zeile], JETZT, undefined, { gruen: 'Beworben' });
    expect(listenZeile).toMatchObject({ status: { farbe: 'gruen', wort: 'Beworben' }, marke: 'Grenzfall' });
    expect(modulDetailAnsicht([], zeile, JETZT, { gruen: 'Beworben' })).toEqual([{ label: 'Status', art: 'status', status: { farbe: 'gruen', wort: 'Beworben' } }]);
    expect(modulListeAnsicht('akquise', [{ werte: { ...zeile.werte, marke: null } }], JETZT)[0]?.marke).toBeUndefined();
  });
});
