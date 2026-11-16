/**
 * Typen für `chat.js`, damit die Tests das Browser-Skript typgeprüft einbinden. Das Skript selbst ist reines
 * JavaScript ohne Build-Schritt und wird unverändert ausgeliefert. Beschrieben ist nur, was es vom Dokument braucht —
 * das Projekt kennt keine DOM-Typen.
 */
export interface ChatDokument {
  getElementById(id: string): unknown;
  createElement(name: 'template'): { innerHTML: string; readonly content: unknown };
}

export interface ChatListe {
  querySelector(auswahl: string): { append(inhalt: unknown): void } | null;
  querySelectorAll(auswahl: string): Iterable<{ remove(): void }>;
}

export function nachrichtEinfuegen(dokument: ChatDokument, liste: ChatListe, id: string, html: string): boolean;

export interface ChatHaken {
  readonly dataset: { chatStatus?: string; chatNachricht?: string };
  querySelector(auswahl: string): { textContent: string | null } | null;
}

export function beantwortetMarkieren(liste: { querySelectorAll(auswahl: string): Iterable<ChatHaken> }, antwortId: string): number;

export interface ChatTaste {
  readonly key: string;
  readonly isComposing: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export function tasteEntscheiden(taste: ChatTaste, beruehrung: boolean): 'senden' | 'zeile' | 'nichts';
