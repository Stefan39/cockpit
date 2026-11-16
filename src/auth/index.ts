/**
 * Epic E2 (Identität & Zugang) — öffentliche Schnittstelle des Auth-Bereichs.
 * Better Auth (Argon2id, TOTP), Erststart-Bootstrap-Token, Anmeldung mit
 * zweitem Faktor samt eigener Ratenbegrenzung, zentrales Tor, Passkey
 * (WebAuthn) als zweiter Faktor (COPI-26; die Anmeldung damit folgt in COPI-27).
 */
export { erzeugeAuth, geheimnisBesorgen } from './konfiguration.js';
export type { AuthOptionen, CockpitAuth } from './konfiguration.js';
export {
  AUTH_BASIS_PFAD,
  COOKIE_PRAEFIX,
  DB_SCHEMA,
  MINDEST_PASSWORTLAENGE,
  SITZUNGS_COOKIE_NAME,
} from './konfiguration.js';
export { passwortHashen, passwortPruefen } from './passwort.js';
export {
  einmalTokenErzeugen,
  istAbgelaufen,
  tokenHashVergleichen,
  tokenHashen,
  TOKEN_LAENGE_BYTES,
} from './einmal-token.js';
export type { EinmalToken } from './einmal-token.js';
export { erststartTokenErzeugen, GUELTIGKEIT_MS } from './erststart-token.js';
export type { ErststartToken } from './erststart-token.js';
export {
  einladungsTokenErzeugen,
  EINLADUNG_GUELTIGKEIT_MS,
} from './einladung-token.js';
export type { EinladungsToken } from './einladung-token.js';
export {
  einladungAnlegen,
  einladungEinloesen,
  einladungPruefen,
  emailNormalisieren,
  kontoVorhanden,
  rolleSetzen,
} from './einladung-speicher.js';
export type { EingeloesteEinladung, EinladungsPruefung } from './einladung-speicher.js';
export {
  ALLE_ROLLEN,
  darfEinladen,
  einladbareRollen,
  hatRecht,
  istRolle,
  istVergebbareRolle,
  zugangsZustandLesen,
  zugangLeserBauen,
  OHNE_ZUGANG,
  RECHTE,
  ROLLEN,
  ROLLE_ADMIN,
  ROLLE_BETREUER,
  ROLLE_DEFAULT,
} from './berechtigung.js';
export type { Recht, Rolle, VergebbareRolle, Zugang, ZugangLesen, ZugangsZustand } from './berechtigung.js';
export { zweiterFaktorAktiv } from './zweiter-faktor.js';
export { BetreuerUebergabeFehler, betreuerUebergeben } from './betreuer.js';
export type { UebergabeAuftrag, UebergabeErgebnis, UebergabeGrund } from './betreuer.js';
export {
  benutzerVorhanden,
  neuesErststartTokenAnlegen,
  tokenEinloesen,
  tokenPruefen,
  unfertigesKontoEntfernen,
} from './erststart-speicher.js';
export { erststartBlockAusgeben, erststartBlockBauen } from './erststart-ausgabe.js';
export { mitBenutzerAnlage, benutzerAnlageErlaubt } from './benutzer-anlage.js';
export {
  registriereZweiFaktorTor,
  torEntscheidung,
  ABMELDEN_PFAD,
  ANMELDEN_PFAD,
  EINLADUNG_FORMULAR_PFAD,
  ERSTSTART_PFAD,
  GESUND_PFAD,
  ZWEI_FAKTOR_PFAD,
} from './zwei-faktor-tor.js';
export type { SitzungLesen, SitzungsZustand, TorEingabe, TorEntscheidung } from './zwei-faktor-tor.js';
export {
  clientIpErmitteln,
  registriereClientIp,
  CLIENT_IP_KOPF,
  IP_UNBEKANNT,
  WEITERGELEITET_KOPF,
} from './client-ip.js';
export { herkunftErlaubt } from './herkunft.js';
export {
  grenzeFuer,
  istGesperrt,
  kennungHash,
  sperrePruefen,
  versuchReservieren,
  zaehlerAufraeumen,
  zaehlerGutschreiben,
  zaehlerZuruecksetzen,
  ANMELDE_FENSTER_MS,
  ANMELDE_SPERRE_MS,
} from './ratenbegrenzung.js';
export type { Reservierung, Zaehlerart, ZaehlerStand } from './ratenbegrenzung.js';
export {
  anmeldevorgaengeAufraeumen,
  anmeldevorgangAnlegen,
  anmeldevorgangCookie,
  anmeldevorgangCookieLoeschen,
  anmeldevorgangLesen,
  anmeldevorgangVerbrauchen,
  benutzerIdZuEmail,
  cookieLesen,
  ANMELDEVORGANG_COOKIE_NAME,
  ANMELDEVORGANG_GUELTIGKEIT_MS,
} from './anmeldevorgang.js';
