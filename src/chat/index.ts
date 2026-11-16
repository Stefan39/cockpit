/**
 * Der Chat (Epic E4, COPI-4): je Benutzer ein Assistenten-Kanal mit dem Koordinator-Agenten und ein gemeinsamer
 * Team-Kanal der Instanz.
 *
 *   * `nachricht-speicher.ts` — Kanäle, Nachrichten, Verlauf und Lesestand in der Datenbank (COPI-52).
 *
 * Es folgen: Chat-Seite (COPI-53), Weiterleitung an den Koordinator (COPI-54), Antwortweg (COPI-55), SSE (COPI-56),
 * Tageslimit (COPI-57), PWA (COPI-58), Web Push (COPI-59), E-Mail-Zweitkanal (COPI-60).
 */
export {
  ABSENDER_ARTEN,
  assistentKanal,
  INHALT_HOECHSTENS,
  KANAL_ARTEN,
  lesestandSetzen,
  nachrichtAlsGeloeschtMarkieren,
  nachrichtAnlegen,
  nachrichtenSeit,
  nachrichtLesen,
  SEITE_HOECHSTENS,
  teamKanal,
  ungeleseneZaehlen,
  verlaufLesen,
} from './nachricht-speicher.js';
export type { AbsenderArt, Kanal, KanalArt, MarkierenErgebnis, Nachricht, NeueNachricht } from './nachricht-speicher.js';
