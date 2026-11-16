/**
 * Reine Logik der Chat-Streams (COPI-163): Ereignisformat, Startpunkt eines Streams und Obergrenze je Konto.
 * Ohne Datenbank; der Zusammenhang mit echten Streams steht in `chat-strom-datenbank.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ereignisText, seitAus, STROEME_JE_KONTO, StromZaehler } from '../src/chat/strom.js';

describe('ereignisText', () => {
  it('schreibt nur Daten als data-Zeile mit Leerzeile am Ende', () => {
    expect(ereignisText({ daten: 'hallo' })).toBe('data: hallo\n\n');
  });

  it('setzt retry, id und art in dieser Reihenfolge vor data', () => {
    expect(ereignisText({ daten: 'x', art: 'nachricht', id: 7, retry: 5000 })).toBe(
      'retry: 5000\nid: 7\nevent: nachricht\ndata: x\n\n',
    );
  });

  it('verteilt mehrzeilige Daten auf mehrere data-Zeilen', () => {
    expect(ereignisText({ daten: 'eins\nzwei\ndrei' })).toBe('data: eins\ndata: zwei\ndata: drei\n\n');
  });

  it('lässt \\r weg, auch bei \\r\\n', () => {
    expect(ereignisText({ daten: 'a\rb' })).toBe('data: ab\n\n');
    expect(ereignisText({ daten: 'a\r\nb' })).toBe('data: a\ndata: b\n\n');
  });

  it('ergibt für ein leeres Ereignis nur eine Leerzeile', () => {
    expect(ereignisText({})).toBe('\n\n');
  });
});

describe('seitAus', () => {
  it('bevorzugt Last-Event-ID vor ?seit', () => {
    expect(seitAus('10', '20')).toBe(10);
  });

  it('fällt bei ungültiger erster Angabe auf die zweite zurück', () => {
    expect(seitAus('abc', '20')).toBe(20);
    expect(seitAus(undefined, '20')).toBe(20);
  });

  it('nimmt eine gültige positive ganze Zahl als Zahl', () => {
    expect(seitAus('42', undefined)).toBe(42);
  });

  it.each([
    ['0', '0'],
    ['-1', '-1'],
    ['01', '01'],
    ['1.5', '1.5'],
    ['16-stellige Zahl', '1234567890123456'],
  ])('verwirft %s', (_name, wert) => {
    expect(seitAus(wert, undefined)).toBeUndefined();
    expect(seitAus(undefined, wert)).toBeUndefined();
  });

  it('verwirft eine Zahl statt eines Strings', () => {
    expect(seitAus(42, 42)).toBeUndefined();
  });

  it('ergibt undefined ohne jede Angabe', () => {
    expect(seitAus(undefined, undefined)).toBeUndefined();
  });
});

describe('StromZaehler', () => {
  it('begrenzt standardmäßig auf STROEME_JE_KONTO', () => {
    const zaehler = new StromZaehler();
    for (let i = 0; i < STROEME_JE_KONTO; i += 1) {
      expect(zaehler.belegen('a')).toBe(true);
    }
    expect(STROEME_JE_KONTO).toBe(5);
    expect(zaehler.belegen('a')).toBe(false);
    expect(zaehler.anzahl('a')).toBe(STROEME_JE_KONTO);
  });

  it('nimmt eine eigene Grenze aus dem Konstruktor', () => {
    const zaehler = new StromZaehler(2);
    expect(zaehler.belegen('a')).toBe(true);
    expect(zaehler.belegen('a')).toBe(true);
    expect(zaehler.belegen('a')).toBe(false);
  });

  it('zählt Konten getrennt', () => {
    const zaehler = new StromZaehler(1);
    expect(zaehler.belegen('a')).toBe(true);
    expect(zaehler.belegen('a')).toBe(false);
    expect(zaehler.belegen('b')).toBe(true);
    expect(zaehler.anzahl('a')).toBe(1);
    expect(zaehler.anzahl('b')).toBe(1);
  });

  it('gibt mit freigeben einen Platz zurück', () => {
    const zaehler = new StromZaehler(1);
    zaehler.belegen('a');
    expect(zaehler.belegen('a')).toBe(false);
    zaehler.freigeben('a');
    expect(zaehler.anzahl('a')).toBe(0);
    expect(zaehler.belegen('a')).toBe(true);
  });

  it('lässt anzahl nie unter 0 fallen, auch ohne vorheriges belegen', () => {
    const zaehler = new StromZaehler(1);
    zaehler.freigeben('a');
    expect(zaehler.anzahl('a')).toBe(0);
    zaehler.belegen('a');
    zaehler.freigeben('a');
    zaehler.freigeben('a');
    expect(zaehler.anzahl('a')).toBe(0);
    expect(zaehler.belegen('a')).toBe(true);
    expect(zaehler.belegen('a')).toBe(false);
  });
});
