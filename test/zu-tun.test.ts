/**
 * Die Reihe „Zu tun" des Dashboards (COPI-122, `src/posteingang/zu-tun.ts`) — ohne Datenbank: je angeheftetem Modul die
 * offenen Zeilen mit „neu", die ungelesenen Nachrichten ohne die angehefteten Module, die wartenden Freigaben; Zahlen im
 * Kopf, Leerzustände, welche Spalten es überhaupt gibt.
 */
import { describe, expect, it } from 'vitest';
import type { PosteingangAnsicht, PosteingangEintragAnsicht } from '../src/posteingang/posteingang.js';
import type { OffeneFreigabe } from '../src/pipeline/freigaben.js';
import { ZU_TUN_HOECHSTENS, zuTunAnsicht, type ZuTunModul } from '../src/posteingang/zu-tun.js';

const JETZT = new Date('2026-10-08T12:00:00.000Z');
const STUNDE = 3_600_000;

function eintrag(quelle: PosteingangEintragAnsicht['quelle'], titel: string, kennung?: string): PosteingangEintragAnsicht {
  return { quelle, herkunft: `Herkunft ${titel}`, titel, anriss: '', zeit: 'vor 1 Tag', href: `/ziel/${titel}`, rot: false, ...(kennung ? { kennung } : {}) };
}

function posteingang(eintraege: PosteingangEintragAnsicht[], zahlen: Partial<PosteingangAnsicht['zahlen']>, postfaecher: Record<string, number> = {}): PosteingangAnsicht {
  const z = { freigabe: 0, chat: 0, postfach: 0, meldung: 0, ...zahlen };
  return { gesamt: z.freigabe + z.chat + z.postfach + z.meldung, zahlen: z, eintraege, postfaecher };
}

const AKQUISE: ZuTunModul = {
  kennung: 'akquise',
  menuename: 'Akquise',
  statuswoerter: { gelb: 'Offen', gruen: 'Beworben' },
  offen: 7,
  zeilen: [
    { id: '11', titel: 'Backend-Entwicklung', status: 'gelb', anriss: 'portal-b.example.org', zeit: new Date(JETZT.getTime() - 2 * STUNDE), ungelesen: true },
    { id: '12', titel: 'Shop-Migration', status: 'gelb', anriss: 'portal-c.example.org', zeit: new Date(JETZT.getTime() - 48 * STUNDE), ungelesen: false },
  ],
};

describe('zuTunAnsicht', () => {
  it('zeigt je angeheftetem Modul die offenen Zeilen mit „neu", Status und Rückweg zur Übersicht', () => {
    const [spalte] = zuTunAnsicht({ posteingang: posteingang([], {}, { akquise: 3 }), module: [AKQUISE], nachrichten: false, freigaben: false, jetzt: JETZT });

    expect(spalte).toMatchObject({ art: 'modul', titel: 'Akquise', symbol: 'koffer', zahl: '3 neu', fuss: { text: 'Alle 7 offenen', href: '/module/akquise?von=uebersicht' } });
    expect(spalte?.zeilen).toEqual([
      { titel: 'Backend-Entwicklung', meta: 'portal-b.example.org', zeit: 'vor 2 Std.', href: '/module/akquise/11?von=uebersicht', neu: true, status: { farbe: 'gelb', wort: 'Offen' } },
      { titel: 'Shop-Migration', meta: 'portal-c.example.org', zeit: 'vor 2 Tagen', href: '/module/akquise/12?von=uebersicht', neu: false, status: { farbe: 'gelb', wort: 'Offen' } },
    ]);
  });

  it('zeigt ohne Ungelesenes keine Zahl und ohne Offenes einen Leerzustand mit Link aufs Modul', () => {
    const [spalte] = zuTunAnsicht({ posteingang: posteingang([], {}), module: [{ ...AKQUISE, offen: 0, zeilen: [] }], nachrichten: false, freigaben: false, jetzt: JETZT });

    expect(spalte).toMatchObject({ zahl: undefined, zeilen: [], leer: 'Nichts offen.', fuss: { text: 'Zum Modul', href: '/module/akquise?von=uebersicht' } });
  });

  it('nimmt in „Nachrichten" Chat und Postfächer, aber nicht die angehefteten Module — und zählt sie auch nicht', () => {
    const eingang = posteingang(
      [eintrag('freigabe', 'F1', 'kommunikation'), eintrag('postfach', 'Treffer', 'akquise'), eintrag('postfach', 'Mail', 'kommunikation'), eintrag('chat', 'Chat'), eintrag('meldung', 'Meldung')],
      { freigabe: 1, chat: 1, postfach: 4, meldung: 1 },
      { akquise: 3, kommunikation: 1 },
    );
    const spalten = zuTunAnsicht({ posteingang: eingang, module: [AKQUISE], nachrichten: true, freigaben: true, jetzt: JETZT });
    const nachrichten = spalten.find((spalte) => spalte.art === 'nachrichten');

    expect(spalten.map((spalte) => spalte.art)).toEqual(['modul', 'nachrichten', 'freigaben']);
    expect(nachrichten?.zahl).toBe('2 neu');
    expect(nachrichten?.zeilen.map((zeile) => zeile.titel)).toEqual(['Mail', 'Chat']);
    expect(nachrichten?.zeilen[0]).toMatchObject({ meta: 'Herkunft Mail', zeit: 'vor 1 Tag', href: '/ziel/Mail', neu: true });
    expect(nachrichten?.fuss).toEqual({ text: 'Zu den Nachrichten', href: '/chat' });
  });

  it('zeigt in „Freigaben" die wartenden Entwürfe mit ihrer Zahl, ohne Fuß', () => {
    const eingang = posteingang([eintrag('freigabe', 'Antwort an Jana'), eintrag('freigabe', 'Antwort an Nordlicht')], { freigabe: 2 });
    const [freigaben] = zuTunAnsicht({ posteingang: eingang, module: [], nachrichten: false, freigaben: true, jetzt: JETZT });

    expect(freigaben).toMatchObject({ art: 'freigaben', titel: 'Freigaben', zahl: '2', fuss: undefined });
    expect(freigaben?.zeilen.map((zeile) => zeile.titel)).toEqual(['Antwort an Jana', 'Antwort an Nordlicht']);
    expect(freigaben?.zeilen[0]?.neu).toBe(false);
  });

  it('zeigt höchstens vier Einträge je Spalte', () => {
    const eingang = posteingang(
      Array.from({ length: 6 }, (_, i) => eintrag('chat', `C${String(i)}`)),
      { chat: 6 },
    );
    const [nachrichten] = zuTunAnsicht({ posteingang: eingang, module: [], nachrichten: true, freigaben: false, jetzt: JETZT });

    expect(nachrichten?.zeilen).toHaveLength(4);
    expect(nachrichten?.zahl).toBe('6 neu');
  });

  it('lässt Spalten weg, die es für den Zugang nicht gibt; ohne Posteingang gibt es keine Reihe', () => {
    expect(zuTunAnsicht({ posteingang: posteingang([], {}), module: [], nachrichten: false, freigaben: false, jetzt: JETZT })).toEqual([]);
    expect(zuTunAnsicht({ posteingang: undefined, module: [AKQUISE], nachrichten: true, freigaben: true, jetzt: JETZT })).toEqual([]);
  });

  describe('PR-Freigaben (COPI-183)', () => {
    function pr(teil: Partial<OffeneFreigabe> = {}): OffeneFreigabe {
      return {
        jobId: 'j1',
        ticketKey: 'COPI-1',
        repo: 'Stefan39/cockpit',
        titel: 'Ein Titel',
        pr: 7,
        prUrl: 'https://evil.invalid/x',
        headSha: 'abc',
        runden: 2,
        angefragtAm: new Date(JETZT.getTime() - 3 * STUNDE),
        ...teil,
      };
    }
    const ansicht = (pipelineFreigaben: readonly OffeneFreigabe[] | undefined, freigaben = false) =>
      zuTunAnsicht({ posteingang: posteingang([], {}), module: [], nachrichten: false, freigaben, pipelineFreigaben, jetzt: JETZT });

    it('zeigt die Spalte mit Link zum PR, Runden und Wartezeit', () => {
      const [spalte] = ansicht([pr()]);
      expect(spalte).toMatchObject({ art: 'pipeline', titel: 'PR-Freigaben', symbol: 'haken', zahl: '1', fuss: undefined });
      expect(spalte?.zeilen).toEqual([
        { titel: 'COPI-1 · Ein Titel', meta: 'Stefan39/cockpit · PR #7 · 2 Review-Runden', zeit: 'vor 3 Std.', href: 'https://github.com/Stefan39/cockpit/pull/7', neu: false },
      ]);
    });

    it('zeigt höchstens so viele Zeilen, zählt aber alle', () => {
      const viele = Array.from({ length: ZU_TUN_HOECHSTENS + 2 }, (_, i) => pr({ jobId: `j${String(i)}`, ticketKey: `COPI-${String(i)}` }));
      const [spalte] = ansicht(viele);
      expect(spalte?.zahl).toBe(String(ZU_TUN_HOECHSTENS + 2));
      expect(spalte?.zeilen.map((z) => z.titel.slice(0, 6))).toEqual(['COPI-0', 'COPI-1', 'COPI-2', 'COPI-3']);
    });

    it('nennt ohne Titel nur den Ticket-Key und ohne Runden „unbekannt"; kürzt lange Titel', () => {
      const [spalte] = ansicht([pr({ titel: null, runden: null }), pr({ titel: 'x'.repeat(200) })]);
      expect(spalte?.zeilen[0]).toMatchObject({ titel: 'COPI-1', meta: 'Stefan39/cockpit · PR #7 · Review-Runden unbekannt' });
      expect(Array.from(spalte?.zeilen[1]?.titel ?? '').length).toBe(80);
    });

    it('übernimmt prUrl nie als Link', () => {
      expect(ansicht([pr({ prUrl: 'javascript:alert(1)' })])[0]?.zeilen[0]?.href).toBe('https://github.com/Stefan39/cockpit/pull/7');
    });

    it.each([0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1])('fällt bei ungültiger PR-Nummer %j auf die PR-Liste zurück', (nummer) => {
      expect(ansicht([pr({ pr: nummer })])[0]?.zeilen[0]?.href).toBe('https://github.com/Stefan39/cockpit/pulls');
    });

    it('fällt bei ungültigem repo auf „/" zurück', () => {
      expect(ansicht([pr({ repo: 'a/b/../c' })])[0]?.zeilen[0]?.href).toBe('/');
      expect(ansicht([pr({ repo: 'a/b"c' })])[0]?.zeilen[0]?.href).toBe('/');
    });

    it('fehlt bei leerer Liste, undefined und ohne Posteingang', () => {
      expect(ansicht([])).toEqual([]);
      expect(ansicht(undefined)).toEqual([]);
      expect(zuTunAnsicht({ posteingang: undefined, module: [], nachrichten: false, freigaben: false, pipelineFreigaben: [pr()], jetzt: JETZT })).toEqual([]);
    });

    it('steht nach „Freigaben"', () => {
      expect(ansicht([pr()], true).map((s) => s.art)).toEqual(['freigaben', 'pipeline']);
    });
  });
});
