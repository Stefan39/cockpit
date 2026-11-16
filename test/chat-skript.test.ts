/**
 * Das Browser-Skript des Chats (`assets/js/chat.js`, COPI-56): eine neue Nachricht aus dem Stream erscheint genau
 * einmal, und Hinweis und Leerzustand verschwinden. Ohne Browser: ein kleines Dokument aus Attrappen genügt, denn das
 * Skript braucht nur `getElementById`, `querySelector(All)` und eine `template`.
 */
import { describe, expect, it } from 'vitest';
import { beantwortetMarkieren, nachrichtEinfuegen, tasteEntscheiden, type ChatDokument, type ChatListe, type ChatTaste } from '../assets/js/chat.js';

interface Knoten {
  readonly id: string;
  readonly markierung: string;
  entfernt: boolean;
  remove(): void;
}

function knoten(id: string, markierung = ''): Knoten {
  return { id, markierung, entfernt: false, remove() { this.entfernt = true; } };
}

function aufbau(ids: string[], weitere: Knoten[] = []) {
  const eingefuegt: string[] = [];
  const bekannt = new Set(ids.map((id) => `nachricht-${id}`));
  const behaelter = { append: (inhalt: { html: string }) => eingefuegt.push(inhalt.html) };
  const liste = {
    querySelector: (auswahl: string) => (auswahl === '[data-chat-nachrichten]' ? behaelter : null),
    querySelectorAll: () => weitere.filter((k) => !k.entfernt),
  };
  const dokument = {
    getElementById: (id: string) => (bekannt.has(id) ? {} : null),
    createElement: () => {
      const vorlage = { html: '', content: { html: '' } };
      return Object.defineProperty(vorlage, 'innerHTML', { set(wert: string) { vorlage.content.html = wert; } });
    },
  };
  return { dokument: dokument as unknown as ChatDokument, liste: liste as unknown as ChatListe, eingefuegt };
}

describe('nachrichtEinfuegen', () => {
  it('hängt eine neue Nachricht an und entfernt Hinweis und Leerzustand', () => {
    const hinweis = knoten('h', 'data-chat-hinweis');
    const leer = knoten('l', 'data-chat-leer');
    const { dokument, liste, eingefuegt } = aufbau(['1', '2'], [hinweis, leer]);

    expect(nachrichtEinfuegen(dokument, liste, '3', '<article id="nachricht-3">x</article>')).toBe(true);

    expect(eingefuegt).toEqual(['<article id="nachricht-3">x</article>']);
    expect(hinweis.entfernt).toBe(true);
    expect(leer.entfernt).toBe(true);
  });

  it('fügt eine Nachricht, die schon da ist, kein zweites Mal ein', () => {
    const { dokument, liste, eingefuegt } = aufbau(['1', '2']);

    expect(nachrichtEinfuegen(dokument, liste, '2', '<article id="nachricht-2">x</article>')).toBe(false);
    expect(eingefuegt).toEqual([]);
  });
});

describe('tasteEntscheiden (COPI-64)', () => {
  const taste = (teil: Partial<ChatTaste> = {}): ChatTaste => ({
    key: 'Enter',
    isComposing: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...teil,
  });

  it.each<[string, Partial<ChatTaste>, boolean, string]>([
    ['Enter schickt ab', {}, false, 'senden'],
    ['Strg+Enter macht eine neue Zeile', { ctrlKey: true }, false, 'zeile'],
    ['Umschalt+Enter macht wie gewohnt eine neue Zeile (der Browser)', { shiftKey: true }, false, 'nichts'],
    ['Alt+Enter bleibt dem Browser', { altKey: true }, false, 'nichts'],
    ['Cmd+Enter bleibt dem Browser', { metaKey: true }, false, 'nichts'],
    ['während einer IME-Eingabe nichts', { isComposing: true }, false, 'nichts'],
    ['Strg+Enter während einer IME-Eingabe nichts', { isComposing: true, ctrlKey: true }, false, 'nichts'],
    ['andere Tasten nichts', { key: 'a' }, false, 'nichts'],
    ['auf Touch-Geräten ist Enter eine neue Zeile', {}, true, 'nichts'],
    ['auf Touch-Geräten macht Strg+Enter (Hardware-Tastatur) eine neue Zeile', { ctrlKey: true }, true, 'zeile'],
  ])('%s', (_fall, teil, beruehrung, erwartet) => {
    expect(tasteEntscheiden(taste(teil), beruehrung)).toBe(erwartet);
  });
});

describe('beantwortetMarkieren (COPI-69)', () => {
  function haken(nachricht: string, stand: string) {
    const text = { textContent: stand };
    return { dataset: { chatStatus: stand, chatNachricht: nachricht }, text, querySelector: () => text };
  }

  it('setzt eigene Nachrichten vor der Antwort auf beantwortet, samt Text für Screenreader', () => {
    const alt = haken('3', 'angenommen');
    const gesendet = haken('4', 'gesendet');
    const spaeter = haken('9', 'angenommen');
    const fertig = haken('2', 'beantwortet');
    const liste = { querySelectorAll: () => [alt, gesendet, spaeter, fertig] };

    expect(beantwortetMarkieren(liste, '5')).toBe(2);

    expect(alt.dataset.chatStatus).toBe('beantwortet');
    expect(alt.text.textContent).toBe('beantwortet');
    expect(gesendet.dataset.chatStatus).toBe('beantwortet');
    expect(spaeter.dataset.chatStatus).toBe('angenommen');
    expect(spaeter.text.textContent).toBe('angenommen');
  });
});
