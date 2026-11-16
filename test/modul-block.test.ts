/**
 * Der `cockpit:`-Block einer Blueprint-YAML (COPI-77, `src/module/block.ts`) — ohne Datenbank, ohne
 * Dateisystem. Geprüft werden: ein gültiger Block, jede verletzte Regel einzeln, die strikte Ablehnung
 * unbekannter Felder, die Wrapper-Regel (`cockpit:`) und das Lesen aus echtem YAML-Text.
 *
 * Die erwarteten Werte stehen als Literale: der Test soll nicht mitrechnen, wenn `block.ts` sie ändert.
 */
import { describe, expect, it } from 'vitest';
import {
  ANSICHTSTYPEN,
  entscheidenErlaubt,
  entscheidungAlsAufgabe,
  entscheidungSpalten,
  freigabeErlaubt,
  freigabeSpalten,
  inHauptnavigation,
  istBetriebsmodul,
  istModulKennung,
  kundenrolleFehlt,
  modulBlockAusText,
  modulBlockEntpacken,
  modulBlockPruefen,
  uebernehmenErlaubt,
  type ModulBlock,
  type ModulEntscheidung,
  type ModulFreigabe,
} from '../src/module/block.js';

/** Wie das Beispiel aus dem Ticket, als Objekt statt YAML. */
const GUELTIGER_BLOCK = {
  kennung: 'server-zustand',
  menuename: 'Server & Dienste',
  ansicht: 'liste-detail',
  view: 'v_modul_server_zustand',
  spalten: [
    { name: 'titel', label: 'Bereich' },
    { name: 'status', label: 'Zustand' },
    { name: 'text', label: 'Meldung' },
    { name: 'aktualisiert_am', label: 'Zuletzt geprüft', format: 'zeitpunkt' },
  ],
  rollen: ['betreuer', 'betriebs_admin'],
  eingriffe: [],
};

function mit(aenderung: Record<string, unknown>): unknown {
  return { ...GUELTIGER_BLOCK, ...aenderung };
}

describe('modulBlockPruefen — gültiger Block', () => {
  it('nimmt den Block aus dem Ticket-Beispiel an und liefert ihn unverändert zurück', () => {
    const ergebnis = modulBlockPruefen(GUELTIGER_BLOCK);

    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block).toEqual(GUELTIGER_BLOCK);
  });

  it('lässt mehrere Spalten und mehrere Rollen zu', () => {
    expect(
      modulBlockPruefen(
        mit({
          spalten: [{ name: 'id', label: 'ID' }],
          rollen: ['betreuer', 'betriebs_admin', 'betrieb_mitarbeiter'],
        }),
      ).ok,
    ).toBe(true);
  });

  it.each(['text', 'zeitpunkt', 'zahl'] as const)('kennt das Format %s', (format) => {
    expect(modulBlockPruefen(mit({ spalten: [{ name: 'x', label: 'X', format }] })).ok).toBe(true);
  });

  it('lässt eine Spalte ohne format zu', () => {
    expect(modulBlockPruefen(mit({ spalten: [{ name: 'x', label: 'X' }] })).ok).toBe(true);
  });
});

describe('modulBlockPruefen — jede Regel einzeln verletzt', () => {
  it.each(['', 'Server-Zustand', '-server', 'server_zustand', 'a'.repeat(64), 'umlaut-ä'])(
    'lehnt die Kennung „%s" ab',
    (kennung) => {
      const ergebnis = modulBlockPruefen(mit({ kennung }));
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('kennung');
    },
  );

  it.each(['', '   ', 'x'.repeat(41)])('lehnt den Menünamen %j ab', (menuename) => {
    const ergebnis = modulBlockPruefen(mit({ menuename }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('menuename');
  });

  it('lehnt einen unbekannten Ansichtstyp ab (kein Wert aus der Liste)', () => {
    const ergebnis = modulBlockPruefen(mit({ ansicht: 'liste' }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('ansicht');
  });

  it.each(ANSICHTSTYPEN.filter((typ) => typ !== 'liste-detail' && typ !== 'kennzahlen'))(
    'kennt den Ansichtstyp %s, weist ihn aber mit einer eigenen Meldung ab: noch nicht umgesetzt',
    (ansicht) => {
      const ergebnis = modulBlockPruefen(mit({ ansicht }));
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('noch nicht umgesetzt');
    },
  );

  it.each(['server_zustand', 'v_server_zustand', 'v_modul_', 'V_MODUL_X', 'v_modul_' + 'x'.repeat(56)])(
    'lehnt den View-Namen „%s" ab: er muss mit v_modul_ beginnen und ein gültiger Bezeichner sein',
    (view) => {
      const ergebnis = modulBlockPruefen(mit({ view }));
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('view');
    },
  );

  it('lehnt eine leere Spaltenliste ab: mindestens eine Spalte', () => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('spalten');
  });

  it.each(['Titel', 'titel-spalte', '1titel', ''])('lehnt den Spaltennamen „%s" ab', (name) => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [{ name, label: 'Titel' }] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('spalten');
  });

  it.each(['', '  ', 'x'.repeat(81)])('lehnt das Spalten-Label %j ab', (label) => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [{ name: 'titel', label }] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('spalten');
  });

  it('lehnt ein unbekanntes Spaltenformat ab', () => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [{ name: 'titel', label: 'Titel', format: 'datum' }] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('spalten');
  });

  it('lehnt eine leere Rollenliste ab: mindestens eine Rolle', () => {
    const ergebnis = modulBlockPruefen(mit({ rollen: [] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('rollen');
  });

  it.each(['admin', 'Betreuer', 'kunde', ''])('lehnt die Rolle „%s" ab: nur bekannte Rollen', (rolle) => {
    const ergebnis = modulBlockPruefen(mit({ rollen: [rolle] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('rollen');
  });

  it('nimmt den Eingriff uebernehmen an (COPI-85)', () => {
    const ergebnis = modulBlockPruefen(mit({ eingriffe: ['uebernehmen'] }));
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block.eingriffe).toEqual(['uebernehmen']);
    expect(ergebnis.ok && uebernehmenErlaubt(ergebnis.block)).toBe(true);
  });

  it('ohne Eingriffe bietet der Block keine Übernahme an', () => {
    const ergebnis = modulBlockPruefen(GUELTIGER_BLOCK);
    expect(ergebnis.ok && uebernehmenErlaubt(ergebnis.block)).toBe(false);
  });

  it.each(['antwort-freigeben', 'Uebernehmen', 'loeschen', ''])('lehnt den Eingriff „%s" ab: noch nicht umgesetzt', (eingriff) => {
    const ergebnis = modulBlockPruefen(mit({ eingriffe: ['uebernehmen', eingriff] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('eingriffe: Eingriff');
    expect(!ergebnis.ok && ergebnis.grund).toContain('noch nicht umgesetzt (bisher nur „uebernehmen", „antwort_freigeben", „entscheiden")');
  });

  it('lehnt einen Eingriff ab, der kein Name ist (Objekt statt Text)', () => {
    const ergebnis = modulBlockPruefen(mit({ eingriffe: [{ irgendwas: true }] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('eingriffe');
  });

  it('lehnt ein unbekanntes Feld auf oberster Ebene ab (strict)', () => {
    const ergebnis = modulBlockPruefen(mit({ ueberfluessig: 'x' }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('ueberfluessig');
  });

  it('lehnt ein unbekanntes Feld einer Spalte ab (strict)', () => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [{ name: 'titel', label: 'Titel', breite: 10 }] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('breite');
  });

  it.each(['kennung', 'menuename', 'ansicht', 'view', 'spalten', 'rollen', 'eingriffe'] as const)(
    'lehnt einen fehlenden Pflichtwert %s ab',
    (feld) => {
      const ohne = { ...GUELTIGER_BLOCK };
      delete (ohne as Record<string, unknown>)[feld];
      const ergebnis = modulBlockPruefen(ohne);
      expect(ergebnis.ok).toBe(false);
    },
  );
});

describe('modulBlockPruefen — Format langtext (COPI-103)', () => {
  // Eigener Name: der Beispielblock hat schon eine gewöhnliche Spalte `text`.
  const NACHRICHT = { name: 'nachricht', label: 'Nachricht', format: 'langtext', gekuerzt: { spalte: 'nachricht_gekuerzt', hinweis: 'Gekürzt.' } };

  it('nimmt eine Langtext-Spalte mit Kürzungshinweis an', () => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [...GUELTIGER_BLOCK.spalten, NACHRICHT] }));
    expect(ergebnis.ok, !ergebnis.ok ? ergebnis.grund : undefined).toBe(true);
  });

  it('nimmt formatierung: einfach bei einem Langtext an und lehnt sie bei einem anderen Format ab (COPI-131)', () => {
    const einfach = { ...NACHRICHT, formatierung: 'einfach' };
    const angenommen = modulBlockPruefen(mit({ spalten: [...GUELTIGER_BLOCK.spalten, einfach] }));
    expect(angenommen.ok, !angenommen.ok ? angenommen.grund : undefined).toBe(true);

    const anderesFormat = modulBlockPruefen(mit({ spalten: [...GUELTIGER_BLOCK.spalten, { name: 'notiz', label: 'Notiz', formatierung: 'einfach' }] }));
    expect(anderesFormat.ok).toBe(false);
    expect(!anderesFormat.ok && anderesFormat.grund).toContain('formatierung');
    expect(modulBlockPruefen(mit({ spalten: [...GUELTIGER_BLOCK.spalten, { ...NACHRICHT, formatierung: 'markdown' }] })).ok).toBe(false);
  });

  it('lehnt gekuerzt bei einem anderen Format ab', () => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [...GUELTIGER_BLOCK.spalten, { ...NACHRICHT, format: 'text' }] }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('gekuerzt');
  });

  it.each([
    ['einen leeren Hinweis', { spalte: 'nachricht_gekuerzt', hinweis: '' }],
    ['einen zu langen Hinweis', { spalte: 'nachricht_gekuerzt', hinweis: 'x'.repeat(161) }],
    ['einen ungültigen Spaltennamen', { spalte: 'Text-Gekuerzt', hinweis: 'Gekürzt.' }],
  ])('lehnt %s ab', (_fall, gekuerzt) => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [...GUELTIGER_BLOCK.spalten, { ...NACHRICHT, gekuerzt }] }));
    expect(ergebnis.ok).toBe(false);
  });

  it('lehnt eine Langtext-Spalte als Kurztext der Übersicht ab: ein Mailtext gehört nicht auf eine Karte', () => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [...GUELTIGER_BLOCK.spalten, NACHRICHT], uebersicht: { kurztext: 'nachricht' } }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('kurztext');
  });
});

describe('modulBlockPruefen — Feld fach (COPI-107)', () => {
  it('nimmt Schema und Mindestversion der Fachmigrationen an', () => {
    const ergebnis = modulBlockPruefen(mit({ fach: { schema: 'eingang', mindestens: 2 } }));
    expect(ergebnis.ok && ergebnis.block.fach).toEqual({ schema: 'eingang', mindestens: 2 });
  });

  it('ist optional', () => {
    const ergebnis = modulBlockPruefen(GUELTIGER_BLOCK);
    expect(ergebnis.ok && ergebnis.block.fach).toBeUndefined();
  });

  it.each([
    ['das Schema des Cockpits', { schema: 'cockpit', mindestens: 1 }],
    ['das Standardschema', { schema: 'public', mindestens: 1 }],
    ['ein Systemschema', { schema: 'pg_catalog', mindestens: 1 }],
    ['ein Systemschema (information_schema)', { schema: 'information_schema', mindestens: 1 }],
    ['ein Schema mit Großbuchstaben', { schema: 'Eingang', mindestens: 1 }],
    ['ein Schema mit Punkt (Injection)', { schema: 'eingang"; DROP', mindestens: 1 }],
    ['ein leeres Schema', { schema: '', mindestens: 1 }],
    ['Mindestversion 0', { schema: 'eingang', mindestens: 0 }],
    ['eine gebrochene Mindestversion', { schema: 'eingang', mindestens: 1.5 }],
    ['eine Mindestversion über 9999', { schema: 'eingang', mindestens: 10000 }],
    ['ein unbekanntes Feld', { schema: 'eingang', mindestens: 1, tabelle: 'vorgang' }],
    ['fehlende Mindestversion', { schema: 'eingang' }],
  ])('lehnt %s ab', (_fall, fach) => {
    const ergebnis = modulBlockPruefen(mit({ fach }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('fach');
  });
});

describe('modulBlockPruefen — Feld anhaenge (COPI-110)', () => {
  it('nimmt eine eigene View für die Anhänge an', () => {
    const ergebnis = modulBlockPruefen(mit({ anhaenge: 'v_modul_server_zustand_anhaenge' }));
    expect(ergebnis.ok && ergebnis.block.anhaenge).toBe('v_modul_server_zustand_anhaenge');
  });

  it('ist optional', () => {
    const ergebnis = modulBlockPruefen(GUELTIGER_BLOCK);
    expect(ergebnis.ok && ergebnis.block.anhaenge).toBeUndefined();
  });

  it.each([
    ['ohne Präfix v_modul_', 'anhaenge'],
    ['mit Schema', 'eingang.anhang'],
    ['mit Anführungszeichen (Injection)', 'v_modul_x"; DROP'],
    ['die Modul-View selbst', 'v_modul_server_zustand'],
  ])('lehnt eine View %s ab', (_fall, anhaenge) => {
    const ergebnis = modulBlockPruefen(mit({ anhaenge }));
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('anhaenge');
  });

  it('gibt es nur bei Liste+Detail', () => {
    const ergebnis = modulBlockPruefen(
      mit({ ansicht: 'kennzahlen', view: 'v_modul_kosten', spalten: [{ name: 'wert', label: 'Kosten' }], anhaenge: 'v_modul_kosten_anhaenge' }),
    );
    expect(!ergebnis.ok && ergebnis.grund).toContain('anhaenge: nur für den Ansichtstyp „liste-detail" möglich.');
  });
});

describe('modulBlockPruefen — Format link und Statuswörter (COPI-91)', () => {
  const link = (spalte: Record<string, unknown>): unknown => mit({ spalten: [{ name: 'url', label: 'Ausschreibung', format: 'link', ...spalte }] });

  it('nimmt einen Link mit Domain-Liste an', () => {
    const ergebnis = modulBlockPruefen(link({ domains: ['portal-a.example.com', 'www.example.com'] }));
    expect(ergebnis.ok && ergebnis.block.spalten[0]?.domains).toEqual(['portal-a.example.com', 'www.example.com']);
  });

  it.each([
    ['ohne Domain-Liste', {}, 'domains: fehlt'],
    ['mit leerer Liste', { domains: [] }, 'domains'],
    ['mit Schema in der Domain', { domains: ['https://portal-a.example.com'] }, 'domains'],
    ['mit Pfad', { domains: ['portal-a.example.com/jobs'] }, 'domains'],
    ['mit Großbuchstaben', { domains: ['Portal-a.example.com'] }, 'domains'],
    ['mit Port', { domains: ['portal-a.example.com:443'] }, 'domains'],
    ['ohne Punkt', { domains: ['localhost'] }, 'domains'],
  ])('lehnt einen Link %s ab', (_fall, spalte, teil) => {
    const ergebnis = modulBlockPruefen(link(spalte));
    expect(!ergebnis.ok && ergebnis.grund).toContain(teil);
  });

  it('lehnt eine Domain-Liste an einer Spalte ohne Format link ab', () => {
    const ergebnis = modulBlockPruefen(mit({ spalten: [{ name: 'url', label: 'URL', domains: ['portal-a.example.com'] }] }));
    expect(!ergebnis.ok && ergebnis.grund).toContain('nur beim Format „link" möglich.');
  });

  it('lässt einen Link nicht als Anriss im Posteingang zu', () => {
    const ergebnis = modulBlockPruefen(
      mit({
        spalten: [
          { name: 'url', label: 'URL', format: 'link', domains: ['portal-a.example.com'] },
          { name: 'zeit', label: 'Zeit', format: 'zeitpunkt' },
        ],
        posteingang: { anriss: 'url', zeit: 'zeit' },
      }),
    );
    expect(!ergebnis.ok && ergebnis.grund).toContain('Langtext oder Link');
  });

  it('nimmt Statuswörter je Farbe an und lehnt unbekannte Farben ab', () => {
    const ergebnis = modulBlockPruefen(mit({ statuswoerter: { gelb: 'Offen', gruen: 'Beworben' } }));
    expect(ergebnis.ok && ergebnis.block.statuswoerter).toEqual({ gelb: 'Offen', gruen: 'Beworben' });
    expect(modulBlockPruefen(mit({ statuswoerter: { blau: 'Neu' } })).ok).toBe(false);
    expect(modulBlockPruefen(mit({ statuswoerter: { gelb: '' } })).ok).toBe(false);
  });
});

describe('modulBlockPruefen — Eingriff entscheiden (COPI-91)', () => {
  const ENTSCHEIDUNG = {
    titel: 'Deine Entscheidung',
    optionen: [
      { wert: 'interessant', label: 'Interessant', kurz: 'Interessant', primaer: true },
      { wert: 'passt_nicht', label: 'Passt nicht', kurz: 'Passt nicht', wenn: ['offen', 'interessant'] },
      { wert: 'beworben', label: 'Beworben', kurz: 'Beworben', wenn: ['interessant'] },
    ],
    entwurf: { spalte: 'bewerbung', fassung: 'bewerbung_fassung', titel: 'Bewerbungsentwurf' },
  };

  it('nimmt Eingriff und Abschnitt zusammen an', () => {
    const ergebnis = modulBlockPruefen(mit({ eingriffe: ['entscheiden'], entscheidung: ENTSCHEIDUNG }));
    expect(ergebnis.ok, !ergebnis.ok ? ergebnis.grund : undefined).toBe(true);
  });

  it('nimmt bis zu zehn Optionen an, elf nicht (COPI-146: Social braucht acht)', () => {
    const optionen = (anzahl: number): { wert: string; label: string; kurz: string }[] =>
      Array.from({ length: anzahl }, (_, i) => ({ wert: `wert_${'abcdefghijk'.charAt(i)}`, label: `Option ${String(i)}`, kurz: `O${String(i)}` }));
    expect(modulBlockPruefen(mit({ eingriffe: ['entscheiden'], entscheidung: { titel: 'E', optionen: optionen(10) } })).ok).toBe(true);
    const elf = modulBlockPruefen(mit({ eingriffe: ['entscheiden'], entscheidung: { titel: 'E', optionen: optionen(11) } }));
    expect(!elf.ok && elf.grund).toContain('entscheidung.optionen');
  });

  it.each([
    ['den Eingriff ohne Abschnitt', { eingriffe: ['entscheiden'] }, 'entscheidung: fehlt'],
    ['den Abschnitt ohne Eingriff', { entscheidung: ENTSCHEIDUNG }, 'nur zusammen mit dem Eingriff „entscheiden".'],
    [
      'einen doppelten Wert',
      { eingriffe: ['entscheiden'], entscheidung: { ...ENTSCHEIDUNG, optionen: [ENTSCHEIDUNG.optionen[0], ENTSCHEIDUNG.optionen[0]] } },
      'mehrfach vergeben',
    ],
    [
      'ein unbekanntes wenn',
      { eingriffe: ['entscheiden'], entscheidung: { ...ENTSCHEIDUNG, optionen: [{ wert: 'ja', label: 'Ja', kurz: 'Ja', wenn: ['vielleicht'] }] } },
      'weder „offen" noch der Wert einer Option',
    ],
    ['den reservierten Wert offen', { eingriffe: ['entscheiden'], entscheidung: { ...ENTSCHEIDUNG, optionen: [{ wert: 'offen', label: 'Offen', kurz: 'Offen' }] } }, 'entscheidung.optionen.0.wert'],
    ['einen Wert mit Großbuchstaben', { eingriffe: ['entscheiden'], entscheidung: { ...ENTSCHEIDUNG, optionen: [{ wert: 'Ja', label: 'Ja', kurz: 'Ja' }] } }, 'entscheidung.optionen.0.wert'],
    ['eine Option ohne kurz', { eingriffe: ['entscheiden'], entscheidung: { ...ENTSCHEIDUNG, optionen: [{ wert: 'ja', label: 'Ja' }] } }, 'entscheidung.optionen.0.kurz'],
  ])('lehnt %s ab', (_fall, felder, teil) => {
    const ergebnis = modulBlockPruefen(mit(felder));
    expect(!ergebnis.ok && ergebnis.grund).toContain(teil);
  });
});

describe('modulBlockEntpacken — die Wrapper-Regel', () => {
  it('liefert den Wert unter cockpit:, wenn er da ist', () => {
    expect(modulBlockEntpacken({ cockpit: GUELTIGER_BLOCK })).toEqual(GUELTIGER_BLOCK);
  });

  it('ignoriert alles neben cockpit: (die übrigen Felder einer Blueprint-YAML)', () => {
    const blueprint = { rolle: 'admin', version: '1.0', cockpit: GUELTIGER_BLOCK };
    expect(modulBlockEntpacken(blueprint)).toEqual(GUELTIGER_BLOCK);
  });

  it('liefert die Daten selbst, wenn es keinen Schlüssel cockpit gibt', () => {
    expect(modulBlockEntpacken(GUELTIGER_BLOCK)).toEqual(GUELTIGER_BLOCK);
  });

  it.each([null, 'text', 42, ['a', 'b']])('liefert %j unverändert (kein Objekt, kein Wrapper möglich)', (wert) => {
    expect(modulBlockEntpacken(wert)).toBe(wert);
  });
});

describe('modulBlockPruefen — mit dem cockpit:-Wrapper', () => {
  it('prüft den entpackten Block, wenn er unter cockpit: steht', () => {
    const ergebnis = modulBlockPruefen({ rolle: 'admin', cockpit: GUELTIGER_BLOCK });
    expect(ergebnis.ok).toBe(true);
  });

  it('meldet dieselbe Ablehnung, ob mit oder ohne Wrapper', () => {
    const ohneWrapper = modulBlockPruefen(mit({ kennung: 'Falsch' }));
    const mitWrapper = modulBlockPruefen({ cockpit: mit({ kennung: 'Falsch' }) });
    expect(ohneWrapper.ok).toBe(false);
    expect(mitWrapper.ok).toBe(false);
    expect(!ohneWrapper.ok && !mitWrapper.ok && ohneWrapper.grund).toBe(!mitWrapper.ok && mitWrapper.grund);
  });
});

describe('modulBlockAusText — echtes YAML', () => {
  const YAML = `
kennung: server-zustand
menuename: "Server & Dienste"
ansicht: liste-detail
view: v_modul_server_zustand
spalten:
  - { name: titel, label: "Bereich" }
  - { name: status, label: "Zustand" }
  - { name: text, label: "Meldung" }
  - { name: aktualisiert_am, label: "Zuletzt geprüft", format: zeitpunkt }
rollen: [betreuer, betriebs_admin]
eingriffe: []
`;

  it('liest das Ticket-Beispiel aus YAML-Text', () => {
    const ergebnis = modulBlockAusText(YAML);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block).toEqual(GUELTIGER_BLOCK);
  });

  it('liest denselben Block, wenn er unter cockpit: eingerückt ist', () => {
    const eingerueckt = `cockpit:\n${YAML.trim()
      .split('\n')
      .map((zeile) => `  ${zeile}`)
      .join('\n')}\n`;
    const ergebnis = modulBlockAusText(eingerueckt);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block).toEqual(GUELTIGER_BLOCK);
  });

  it('meldet ungültiges YAML klar, ohne Stacktrace', () => {
    const ergebnis = modulBlockAusText('kennung: [unbalanciert');
    expect(ergebnis.ok).toBe(false);
    expect(!ergebnis.ok && ergebnis.grund).toContain('YAML');
    expect(!ergebnis.ok && ergebnis.grund).not.toContain('    at ');
  });
});

describe('modulBlockPruefen — bildvorschau und entscheidung.aufgabe (COPI-124)', () => {
  const MIT_ANHAENGEN = { ...GUELTIGER_BLOCK, anhaenge: 'v_modul_server_zustand_anhaenge' };
  const ENTSCHEIDUNG = { titel: 'Entscheidung', optionen: [{ wert: 'freigeben', label: 'Freigeben', kurz: 'Freigegeben' }] };

  it('nimmt bildvorschau: true mit anhaenge an', () => {
    const ergebnis = modulBlockPruefen({ ...MIT_ANHAENGEN, bildvorschau: true });
    expect(ergebnis.ok && ergebnis.block.bildvorschau).toBe(true);
  });

  it('lehnt bildvorschau ohne anhaenge und mit anderem Wert ab', () => {
    const ohne = modulBlockPruefen({ ...GUELTIGER_BLOCK, bildvorschau: true });
    expect(ohne.ok ? '' : ohne.grund).toContain('bildvorschau');
    expect(modulBlockPruefen({ ...MIT_ANHAENGEN, bildvorschau: false }).ok).toBe(false);
  });

  it('macht offene Zeilen nur mit entscheiden und aufgabe: true zu Aufgaben', () => {
    const mit = modulBlockPruefen({ ...GUELTIGER_BLOCK, eingriffe: ['entscheiden'], entscheidung: { ...ENTSCHEIDUNG, aufgabe: true } });
    const ohne = modulBlockPruefen({ ...GUELTIGER_BLOCK, eingriffe: ['entscheiden'], entscheidung: ENTSCHEIDUNG });
    expect(mit.ok && entscheidungAlsAufgabe(mit.block)).toBe(true);
    expect(ohne.ok && entscheidungAlsAufgabe(ohne.block)).toBe(false);
  });
});

describe('modulBlockPruefen — Knöpfe je Phase und einfache Formatierung (COPI-125)', () => {
  const basis = { ...GUELTIGER_BLOCK, eingriffe: ['entscheiden'] };
  const option = (entwurf?: string) => ({ wert: 'freigeben', label: 'Freigeben', kurz: 'Freigegeben', ...(entwurf ? { entwurf } : {}) });

  it('nimmt entwurf: mit/ohne und format: einfach an, wenn der Block einen Entwurf nennt', () => {
    const ergebnis = modulBlockPruefen({ ...basis, entscheidung: { titel: 'E', optionen: [option('mit'), { ...option('ohne'), wert: 'waehlen' }], entwurf: { spalte: 'text', titel: 'Artikel', format: 'einfach' } } });
    expect(ergebnis.ok, !ergebnis.ok ? ergebnis.grund : undefined).toBe(true);
  });

  it('lehnt entwurf an einer Option ohne entscheidung.entwurf ab, und unbekannte Werte', () => {
    const ohne = modulBlockPruefen({ ...basis, entscheidung: { titel: 'E', optionen: [option('mit')] } });
    expect(ohne.ok ? '' : ohne.grund).toContain('entwurf');
    expect(modulBlockPruefen({ ...basis, entscheidung: { titel: 'E', optionen: [option('immer')], entwurf: { spalte: 'text', titel: 'A' } } }).ok).toBe(false);
    expect(modulBlockPruefen({ ...basis, entscheidung: { titel: 'E', optionen: [option()], entwurf: { spalte: 'text', titel: 'A', format: 'markdown' } } }).ok).toBe(false);
  });
});

describe('Modul-Art und Kundenrolle (COPI-134)', () => {
  it('nimmt art: fach und art: betrieb an und lehnt andere Werte ab', () => {
    expect(modulBlockPruefen(mit({ art: 'fach' })).ok).toBe(true);
    expect(modulBlockPruefen(mit({ art: 'betrieb' })).ok).toBe(true);
    expect(modulBlockPruefen(mit({ art: 'intern' })).ok).toBe(false);
  });

  it('kennt ein Fachmodul nur für den Betreuer als Fehler, ein technisches oder eines mit Kundenrolle nicht', () => {
    expect(kundenrolleFehlt({ rollen: ['betreuer'] })).toContain('Kundenrolle');
    expect(kundenrolleFehlt({ art: 'fach', rollen: ['betreuer'] })).toContain('Kundenrolle');
    expect(kundenrolleFehlt({ art: 'betrieb', rollen: ['betreuer'] })).toBeUndefined();
    expect(kundenrolleFehlt({ rollen: ['betreuer', 'betriebs_admin'] })).toBeUndefined();
    expect(kundenrolleFehlt({ rollen: ['betrieb_mitarbeiter'] })).toBeUndefined();
  });

  it('nennt nur art: betrieb ein technisches Modul', () => {
    expect(istBetriebsmodul({ art: 'betrieb' })).toBe(true);
    expect(istBetriebsmodul({ art: 'fach' })).toBe(false);
    expect(istBetriebsmodul({})).toBe(false);
  });
});

describe('Block-Hilfen (Kennung, Spalten, erlaubte Eingriffe)', () => {
  /** Ein geprüfter Block aus dem gültigen Beispiel, mit den übergebenen Änderungen. */
  function block(aenderung: Record<string, unknown> = {}): ModulBlock {
    const ergebnis = modulBlockPruefen(mit(aenderung));
    if (!ergebnis.ok) {
      throw new Error(ergebnis.grund);
    }
    return ergebnis.block;
  }

  function entscheidung(aenderung: Partial<ModulEntscheidung> = {}): ModulEntscheidung {
    return { titel: 'Entscheidung', optionen: [{ wert: 'ja', label: 'Ja', kurz: 'Ja' }], ...aenderung };
  }

  const FREIGABE: ModulFreigabe = { entwurf: 'entwurf', fassung: 'fassung' };

  describe('istModulKennung (COPI-78)', () => {
    it.each(['akquise', 'ki-verbrauch', 'a1', 'a'.repeat(63)])('nimmt „%s" an', (kennung) => {
      expect(istModulKennung(kennung)).toBe(true);
    });

    it.each(['', '-akquise', 'Akquise', 'ki_verbrauch', 'a'.repeat(64)])('lehnt „%s" ab', (kennung) => {
      expect(istModulKennung(kennung)).toBe(false);
    });
  });

  describe('entscheidungSpalten', () => {
    it('liefert ohne Entscheidung oder ohne Entwurf nichts', () => {
      expect(entscheidungSpalten(undefined)).toEqual({});
      expect(entscheidungSpalten(entscheidung())).toEqual({});
    });

    it('verlangt mit Entwurf die Spalte als text', () => {
      expect(entscheidungSpalten(entscheidung({ entwurf: { spalte: 'entwurf_text', titel: 'Entwurf' } }))).toEqual({ entwurf_text: 'text' });
    });

    it('verlangt mit Fassung zusätzlich eine ganze Zahl', () => {
      expect(entscheidungSpalten(entscheidung({ entwurf: { spalte: 'entwurf_text', fassung: 'entwurf_fassung', titel: 'Entwurf' } }))).toEqual({
        entwurf_text: 'text',
        entwurf_fassung: 'integer',
      });
    });
  });

  describe('freigabeSpalten (COPI-90)', () => {
    it('verlangt nur die Pflichtspalten als text und integer', () => {
      expect(freigabeSpalten(FREIGABE)).toEqual({ entwurf: 'text', fassung: 'integer' });
    });

    it('nimmt optionale Spalten nur auf, wenn sie gesetzt sind', () => {
      expect(freigabeSpalten({ ...FREIGABE, empfaenger: 'an', betreff: 'thema', gesendet_am: 'gesendet' })).toEqual({
        entwurf: 'text',
        fassung: 'integer',
        an: 'text',
        thema: 'text',
        gesendet: 'timestamp with time zone',
      });
      expect(freigabeSpalten({ ...FREIGABE, betreff: 'thema' })).toEqual({ entwurf: 'text', fassung: 'integer', thema: 'text' });
    });
  });

  describe('entscheidenErlaubt und entscheidungAlsAufgabe (COPI-124)', () => {
    it('erlaubt nur mit Entscheidung und Eingriff zugleich', () => {
      expect(entscheidenErlaubt({ eingriffe: ['entscheiden'], entscheidung: entscheidung() })).toBe(true);
      expect(entscheidenErlaubt({ eingriffe: ['entscheiden'] })).toBe(false);
      expect(entscheidenErlaubt({ eingriffe: [], entscheidung: entscheidung() })).toBe(false);
    });

    it('macht Zeilen nur mit aufgabe: true zu Aufgaben', () => {
      expect(entscheidungAlsAufgabe({ eingriffe: ['entscheiden'], entscheidung: entscheidung({ aufgabe: true }) })).toBe(true);
      expect(entscheidungAlsAufgabe({ eingriffe: ['entscheiden'], entscheidung: entscheidung() })).toBe(false);
      expect(entscheidungAlsAufgabe({ eingriffe: ['entscheiden'], entscheidung: entscheidung({ aufgabe: false }) })).toBe(false);
      expect(entscheidungAlsAufgabe({ eingriffe: [], entscheidung: entscheidung({ aufgabe: true }) })).toBe(false);
      expect(entscheidungAlsAufgabe({ eingriffe: ['entscheiden'] })).toBe(false);
    });
  });

  describe('freigabeErlaubt (COPI-90)', () => {
    it('erlaubt nur mit Abschnitt und Eingriff zugleich', () => {
      expect(freigabeErlaubt({ eingriffe: ['antwort_freigeben'], freigabe: FREIGABE })).toBe(true);
      expect(freigabeErlaubt({ eingriffe: ['antwort_freigeben'] })).toBe(false);
      expect(freigabeErlaubt({ eingriffe: [], freigabe: FREIGABE })).toBe(false);
    });
  });

  describe('inHauptnavigation (COPI-121)', () => {
    it('gilt nur für navigation: haupt', () => {
      expect(inHauptnavigation(block({ navigation: 'haupt' }))).toBe(true);
      expect(inHauptnavigation(block())).toBe(false);
    });
  });

  describe('uebernehmenErlaubt (COPI-85)', () => {
    it('gilt nur, wenn der Eingriff uebernehmen deklariert ist', () => {
      expect(uebernehmenErlaubt(block({ eingriffe: ['uebernehmen'] }))).toBe(true);
      expect(uebernehmenErlaubt(block())).toBe(false);
    });
  });
});
