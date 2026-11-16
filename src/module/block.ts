/**
 * Der `cockpit:`-Block einer Agent-Blueprint-YAML (COPI-77, Epic E5): Menüname, Ansichtstyp, View,
 * Spalten, Rollen-Sichtbarkeit und Eingriffe. „Modulseiten sind deklariert, nicht programmiert" — dieser
 * Block ist der ganze Vertrag, den ein Fachmodul der Oberfläche gibt; die eigentlichen Daten liefert eine
 * SQL-View mit festen Spaltennamen (`registry.ts` prüft sie gegen den Katalog).
 *
 * Reine Funktionen ohne Datenbank und ohne Dateisystem: YAML-Text (oder ein schon geparstes Objekt)
 * hinein, ein geprüfter `ModulBlock` oder ein deutscher Grund heraus. `modulEinspielen` (`modul-speicher.ts`)
 * ruft `modulBlockAusText` auf, bevor überhaupt eine Datenbankverbindung aufgemacht wird.
 *
 * **Der Wrapper `cockpit:`.** Eine Blueprint-YAML trägt neben dem Cockpit-Block eigene Felder (Rolle,
 * Version, Grenzen …). Damit sich der Abschnitt direkt aus so einer Datei pipen lässt
 * (`yq .cockpit agent-admin.yaml | ... modul-einspielen`), gilt eine feste Regel: trägt das oberste
 * YAML-Objekt einen Schlüssel `cockpit`, gilt dessen Wert als Block — alle anderen Felder daneben werden
 * ignoriert. Fehlt der Schlüssel, gilt das ganze Dokument selbst als Block (der Fall, wenn nur der
 * Abschnitt allein eingespielt wird, wie im Beispiel oben). Ein Dokument mit einem Schlüssel `cockpit`,
 * der **kein** Block sein soll, gibt es nicht: der Block ist ohnehin nur unter diesem Namen vorgesehen.
 *
 * **Fünf Ansichtstypen, einer umgesetzt.** Das Schema kennt alle fünf aus der ADR (Liste+Detail, Verlauf,
 * Belegung, Aufgaben, Kennzahlen); nur `liste-detail` hat eine Umsetzung. Ein Block mit einem anderen
 * Ansichtstyp ist strukturell gültiges YAML, scheitert aber mit einer eigenen, klaren Meldung — nicht mit
 * „unbekannter Wert" wie bei einem Tippfehler.
 *
 * **Eingriffe (COPI-85).** `eingriffe` bleibt eine Liste von Namen. Umgesetzt sind `uebernehmen` (die
 * Übernahme-Sperre, `vorgang-sperre.ts`) und `antwort_freigeben` (COPI-90, `freigabe.ts`). Jeder andere Name scheitert
 * mit derselben Art Meldung wie ein noch nicht umgesetzter Ansichtstyp.
 *
 * **Antwort freigeben (COPI-90).** Der Eingriff `antwort_freigeben` braucht den Abschnitt `freigabe:` und umgekehrt: er
 * nennt die Spalten der View mit der jüngsten Fassung des Entwurfs (`entwurf` Text, `fassung` ganze Zahl, optional
 * `empfaenger`, `betreff` und `gesendet_am`). Diese Spalten stehen **nicht** in `spalten` — sie erscheinen nur in der
 * Entwurfskarte der Detailseite; `registry.ts` prüft ihre Typen.
 *
 * **Karten auf der Übersicht (COPI-81).** Der optionale Abschnitt `uebersicht:` meldet die Zeilen des Moduls als
 * Karten für das Dashboard der Übersicht an (`docs/modul-vertrag.md`); `kurztext` muss eine deklarierte Spalte sein.
 *
 * **Darstellung der Modulseite (COPI-82).** Das optionale Feld `darstellung` (`liste`, Standard, oder `kacheln`)
 * bestimmt, ob `GET /module/:kennung` die Zeilen als Liste oder als Kartenraster zeigt — nur bei `ansicht:
 * liste-detail`. Ein Block ohne das Feld verhält sich genau wie vor COPI-82 (Liste).
 *
 * **Posteingang (COPI-112).** Der optionale Abschnitt `posteingang:` meldet die Zeilen des Moduls für den Posteingang im
 * Kopf der Seiten an (etwa die Mails des Moduls Kommunikation): `anriss` ist eine deklarierte Spalte (kein Langtext), deren
 * Anfang unter dem Titel steht, `zeit` eine deklarierte Spalte im Format `zeitpunkt`, nach der „neu" bestimmt wird. Der
 * Titel ist die Pflichtspalte `titel`, der Link die Detailseite. Nur bei `ansicht: liste-detail`.
 *
 * **Hauptnavigation (COPI-121).** Das optionale Feld `navigation: haupt` heftet das Modul als eigenen Eintrag in die
 * Hauptnavigation (Sidebar direkt unter „Nachrichten", mobil in der Tab-Leiste anstelle von „Meldungen"). Trägt das Modul
 * `posteingang:`, steht dort die Zahl seiner ungelesenen Zeilen — und nur dort, nicht mehr zusätzlich an „Nachrichten".
 *
 * **Agent (COPI-113).** Das optionale Feld `agent` nennt die Kennung des Agenten, dem das Modul gehört (Form wie im
 * Inventar). Seine Detailseite zeigt dann die Zeilen des Moduls (Reiter „Mails") und die Übernahmen darin (Protokoll).
 *
 * **Anhänge (COPI-110).** Das optionale Feld `anhaenge` nennt eine zweite View (Namensregel wie `view`) mit den Anhängen der
 * Zeilen: `id`, `vorgang_id` (die `id` der Zeile), `dateiname`, `groesse`, `inhalt` (`bytea`, NULL: liegt nur im
 * Postfach), optional `typ` und `position`. Die Detailseite zeigt sie mit Gefahrenklasse (`anhang-pruefung.ts`), der
 * Download geht nur über eine Warnseite mit Bestätigung. Nur bei `ansicht: liste-detail`.
 *
 * **Bildvorschau (COPI-124).** Mit `bildvorschau: true` (nur zusammen mit `anhaenge`) zeigt die Detailseite Bild-Anhänge
 * (PNG, JPEG, WebP; Endung und Inhalt müssen passen, `anhang-pruefung.ts`) direkt als Vorschau — etwa Maras Creatives.
 * Mit `entscheidung.aufgabe: true` sind offene Zeilen Aufgaben unter „Freigaben" (Posteingang, „Zu tun").
 *
 * **Entscheiden (COPI-91).** Der Eingriff `entscheiden` braucht den Abschnitt `entscheidung:` und umgekehrt: eine Karte mit
 * Knöpfen (`optionen`), je Option ihr Wert, ihre Beschriftung, ein kurzes Wort für Marke und Band und in welchem Stand sie
 * angeboten wird (`wenn`: `offen` = noch keine Entscheidung, sonst Werte anderer Optionen). Optional `entwurf`: Spalten der
 * View mit einem Text des Agenten (etwa einem Bewerbungsentwurf) und seiner Fassung — er steht in der Karte zum Kopieren.
 * Gespeichert wird die Entscheidung im Cockpit (`entscheidung.ts`), nie in der Fachtabelle; der Agent fragt sie ab.
 *
 * **Links und Statuswörter (COPI-91).** Das Spaltenformat `link` zeigt eine URL der View als Link nach außen — aber nur,
 * wenn sie `https` ist und ihr Host in `domains` der Spalte steht (genau oder als Subdomain). Das ist die einzige Ausnahme
 * von „Moduldaten nie verlinken" (Entscheidung Stefan, 06.10.2026), deshalb ist die Liste Pflicht. Das optionale Feld
 * `statuswoerter` ersetzt die Wörter der drei Farben („Achtung" → „Neu"), die Farben selbst bleiben.
 *
 * **Kennzahlen (COPI-98).** Der zweite umgesetzte Ansichtstyp: Summen über einen Zeitraum statt Zeilen mit Zustand.
 * `spalten` nennt hier die Kennzahlen (numerische Spalten der View, die erste ist der Hauptwert `wert`),
 * `aufteilungen` die Textspalten, nach denen der Hauptwert aufgeteilt wird, `anteile` Teilbeträge des Hauptwerts und
 * `hinweise` eine View mit Warnzeilen. Diese drei Felder gibt es nur bei `ansicht: kennzahlen`
 * (`docs/modul-vertrag.md`, „Ansichtstyp Kennzahlen").
 */
import * as z from 'zod';
import { parse as yamlParsen } from 'yaml';
import { ALLE_ROLLEN, ROLLE_BETREUER } from '../auth/berechtigung.js';

/** Die fünf Ansichtstypen der ADR. Umgesetzt sind `liste-detail` und `kennzahlen` (siehe Kopf). */
export const ANSICHTSTYPEN = ['liste-detail', 'verlauf', 'belegung', 'aufgaben', 'kennzahlen'] as const;

export type Ansichtstyp = (typeof ANSICHTSTYPEN)[number];

export const ANSICHT_LISTE_DETAIL: Ansichtstyp = 'liste-detail';

/** Summen über einen Zeitraum (COPI-98). */
export const ANSICHT_KENNZAHLEN: Ansichtstyp = 'kennzahlen';

/** Die umgesetzten Ansichtstypen; die übrigen drei kommen mit dem Ticket, das sie braucht. */
const UMGESETZTE_ANSICHTEN: readonly Ansichtstyp[] = [ANSICHT_LISTE_DETAIL, ANSICHT_KENNZAHLEN];

/**
 * Wie eine Spalte formatiert wird; ohne Angabe zeigt sie `text` (bei Kennzahlen: `zahl`). `euro` (COPI-98, seit COPI-137
 * auch in Liste+Detail): ein Betrag in Euro, „12.345,67 €".
 * `langtext` (COPI-103): ein langer Fremdtext (etwa eine Mail), nur auf der Detailseite in einem eigenen Abschnitt —
 * nie in Liste, Kachel oder Übersichtskarte.
 */
export const SPALTEN_FORMATE = ['text', 'zeitpunkt', 'zahl', 'euro', 'langtext', 'link'] as const;

/** Die Formate einer Kennzahl (COPI-98): eine Summe ist eine Zahl oder ein Betrag, nie Text oder Zeitpunkt. */
const KENNZAHL_FORMATE: readonly string[] = ['zahl', 'euro'];

export type SpaltenFormat = (typeof SPALTEN_FORMATE)[number];

/** Kennung eines Moduls: wie eine Wachen-/Agenten-Kennung, aber ohne `_` und `.` (Migration 0028). */
const MODUL_KENNUNG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Kennung eines Agenten wie im Inventar (Migration 0015): mit `_` und `.` (COPI-113). */
const AGENT_KENNUNG = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** Ein Host für die Domain-Liste eines Links (COPI-91): Kleinbuchstaben, mindestens ein Punkt, kein Port, kein Pfad. */
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Ein SQL-Bezeichner in Kleinbuchstaben: Spaltenname oder (ohne das Präfix) Viewname, höchstens 63 Zeichen. */
const BEZEICHNER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Der Name der View: `v_modul_` und mindestens ein weiteres Zeichen, zusammen höchstens 63 (Postgres-Grenze). */
const VIEW_NAME = /^v_modul_[a-z0-9_]{1,55}$/;

const SPALTE_SCHEMA = z.strictObject({
  name: z.string().regex(BEZEICHNER),
  label: z.string().trim().min(1).max(80),
  format: z.enum(SPALTEN_FORMATE).optional(),
  // Nur bei Kennzahlen (COPI-98): ein Teil dieser Kennzahl, gezeigt als „davon 95 % <text>".
  davon: z.strictObject({ name: z.string().regex(BEZEICHNER), text: z.string().trim().min(1).max(60) }).optional(),
  // Nur bei `langtext` (COPI-103): eine Spalte der View, die „gekürzt" meldet, und der Satz, den die Seite dann zeigt.
  gekuerzt: z.strictObject({ spalte: z.string().regex(BEZEICHNER), hinweis: z.string().trim().min(1).max(160) }).optional(),
  // Nur bei `langtext` (COPI-131): `einfach` zeigt Absätze, Überschriften, Listen, fett und kursiv — maskiert, nie ein Link.
  formatierung: z.literal('einfach').optional(),
  // Nur bei `link` (COPI-91): die Hosts, auf die verlinkt werden darf — Pflicht, sonst bleibt die URL Text.
  domains: z.array(z.string().regex(HOST)).min(1).max(20).optional(),
});

export type ModulSpalte = z.infer<typeof SPALTE_SCHEMA>;

/** Die umgesetzten Eingriffe einer Modulseite (COPI-85). Ein weiterer kommt mit dem Ticket, das ihn umsetzt. */
export const EINGRIFFE = ['uebernehmen', 'antwort_freigeben', 'entscheiden'] as const;

/**
 * Wie ein Modul auf dem Dashboard erscheint (COPI-122): `karten` als Kartenraster, das in Zustand, Kennzahlen und Woche
 * zählt (Server & Dienste), `liste` als kompakte Liste in der Team-Reihe (die Arbeit eines Agenten, kein Dienst).
 */
export const UEBERSICHT_ARTEN = ['karten', 'liste'] as const;

/** Standard-Reihenfolge eines Übersichts-Abschnitts ohne eigene Angabe (COPI-81). */
export const UEBERSICHT_REIHENFOLGE_STANDARD = 100;

/**
 * Der optionale Abschnitt `uebersicht:` (COPI-81, Entscheidung Stefan 28.09.2026): Ein Modul meldet damit seine
 * Karten für das Dashboard der Übersicht an. `kurztext` nennt eine in `spalten` deklarierte Spalte (Text der
 * Karte), `verlauf` optional eine Verlaufs-View für die 24-Stunden-Bänder (dieselbe Namensregel wie `view`).
 */
const UEBERSICHT_SCHEMA = z.strictObject({
  titel: z.string().trim().min(1).max(40).optional(),
  // Pflicht bei `liste-detail` (`uebersichtPruefen`); bei `kennzahlen` gibt es keinen Kurztext.
  kurztext: z.string().regex(BEZEICHNER).optional(),
  verlauf: z.string().regex(VIEW_NAME).optional(),
  reihenfolge: z.number().int().min(0).max(1000).optional(),
  // COPI-122: `karten` (Standard) zählt in den Zustand des Dashboards; `liste` ist eine kompakte Liste in der Team-Reihe.
  art: z.enum(UEBERSICHT_ARTEN).optional(),
});

export type ModulUebersicht = z.infer<typeof UEBERSICHT_SCHEMA>;

/** Der optionale Abschnitt `posteingang:` (COPI-112, siehe Kopf). */
const POSTEINGANG_SCHEMA = z.strictObject({
  anriss: z.string().regex(BEZEICHNER),
  zeit: z.string().regex(BEZEICHNER),
});

export type ModulPosteingang = z.infer<typeof POSTEINGANG_SCHEMA>;

/** Der Abschnitt `freigabe:` (COPI-90, siehe Kopf): die Spalten der View mit dem Entwurf. */
const FREIGABE_SCHEMA = z.strictObject({
  entwurf: z.string().regex(BEZEICHNER),
  fassung: z.string().regex(BEZEICHNER),
  empfaenger: z.string().regex(BEZEICHNER).optional(),
  betreff: z.string().regex(BEZEICHNER).optional(),
  gesendet_am: z.string().regex(BEZEICHNER).optional(),
});

export type ModulFreigabe = z.infer<typeof FREIGABE_SCHEMA>;

/** Der Wert einer Entscheidung (COPI-91): klein, mit Unterstrich, höchstens 30 Zeichen. `offen` ist reserviert. */
const ENTSCHEIDUNG_WERT = /^[a-z][a-z_]{0,29}$/;

/** Der Stand vor jeder Entscheidung, für `wenn`. */
export const ENTSCHEIDUNG_OFFEN = 'offen';

const ENTSCHEIDUNG_OPTION = z.strictObject({
  wert: z.string().regex(ENTSCHEIDUNG_WERT).refine((wert) => wert !== ENTSCHEIDUNG_OFFEN, { message: '„offen" ist reserviert.' }),
  label: z.string().trim().min(1).max(60),
  // Das Wort in Marke und Band, etwa „Interessant".
  kurz: z.string().trim().min(1).max(30),
  primaer: z.boolean().optional(),
  wenn: z.array(z.string().regex(ENTSCHEIDUNG_WERT)).min(1).max(10).optional(),
  // COPI-125: nur anbieten, wenn die Zeile einen Entwurf hat (`mit`) bzw. keinen (`ohne`) — etwa „Thema wählen" vor dem
  // Artikel, „Freigeben" erst danach. Ohne Angabe gleich, ob es einen gibt.
  entwurf: z.enum(['mit', 'ohne']).optional(),
});

export type EntscheidungOption = z.infer<typeof ENTSCHEIDUNG_OPTION>;

/** Der Abschnitt `entscheidung:` (COPI-91, siehe Kopf). */
const ENTSCHEIDUNG_SCHEMA = z.strictObject({
  titel: z.string().trim().min(1).max(40),
  hinweis: z.string().trim().min(1).max(300).optional(),
  optionen: z.array(ENTSCHEIDUNG_OPTION).min(1).max(10),
  entwurf: z
    .strictObject({
      spalte: z.string().regex(BEZEICHNER),
      fassung: z.string().regex(BEZEICHNER).optional(),
      titel: z.string().trim().min(1).max(40),
      hinweis: z.string().trim().min(1).max(300).optional(),
      // COPI-125: `einfach` zeigt Absätze, Überschriften (`## `) und Listen (`* `) — alles maskiert, nie ein Link.
      format: z.literal('einfach').optional(),
    })
    .optional(),
  // COPI-124: offene Zeilen (Status rot oder gelb) sind Aufgaben — sie stehen im Posteingang und in „Zu tun" unter
  // „Freigaben", solange sie offen sind (etwa Maras Posts: freigeben oder posten).
  aufgabe: z.boolean().optional(),
});

export type ModulEntscheidung = z.infer<typeof ENTSCHEIDUNG_SCHEMA>;

/** Die Typen, die `registry.ts` für die Entwurfsspalten von `entscheidung:` verlangt. */
export function entscheidungSpalten(entscheidung: ModulEntscheidung | undefined): Readonly<Record<string, string>> {
  const entwurf = entscheidung?.entwurf;
  if (entwurf === undefined) {
    return {};
  }
  return { [entwurf.spalte]: 'text', ...(entwurf.fassung ? { [entwurf.fassung]: 'integer' } : {}) };
}

/** Die Typen, die `registry.ts` für die Spalten von `freigabe:` verlangt. */
export function freigabeSpalten(freigabe: ModulFreigabe): Readonly<Record<string, string>> {
  return {
    [freigabe.entwurf]: 'text',
    [freigabe.fassung]: 'integer',
    ...(freigabe.empfaenger ? { [freigabe.empfaenger]: 'text' } : {}),
    ...(freigabe.betreff ? { [freigabe.betreff]: 'text' } : {}),
    ...(freigabe.gesendet_am ? { [freigabe.gesendet_am]: 'timestamp with time zone' } : {}),
  };
}

/** Ein Wort je Statusfarbe (COPI-91), etwa „Neu" statt „Achtung"; nicht genannte Farben behalten ihr Wort. */
const STATUSWOERTER_SCHEMA = z.strictObject({
  rot: z.string().trim().min(1).max(30).optional(),
  gelb: z.string().trim().min(1).max(30).optional(),
  gruen: z.string().trim().min(1).max(30).optional(),
});

export type Statuswoerter = z.infer<typeof STATUSWOERTER_SCHEMA>;

/** Die Darstellung der Modulseite (COPI-82): `liste` (Standard) oder `kacheln`. */
export const DARSTELLUNGEN = ['liste', 'kacheln'] as const;

/** Wo ein Modul in der Navigation steht (COPI-121): ohne Angabe nur unter „Module", mit `haupt` als eigener Eintrag. */
export const NAVIGATION_HAUPT = 'haupt';

export type Darstellung = (typeof DARSTELLUNGEN)[number];

/** Ohne eigene Angabe gilt ein Block als `liste` — genau das bisherige Verhalten (vor COPI-82). */
export const DARSTELLUNG_STANDARD: Darstellung = 'liste';

/** Höchstens so viele Kennzahlen, Aufteilungen und Anteile trägt eine Kennzahlen-Seite (COPI-98). */
const KENNZAHLEN_HOECHSTENS = 4;

/**
 * Eine Aufteilung des Hauptwerts nach einer Textspalte (COPI-98), etwa „Je Projekt". Mit `filter: true` verlinkt jede
 * Zeile auf die Seite, gefiltert auf ihren Wert; `darunter` nennt dann die Spalte, die gefiltert an ihre Stelle tritt
 * („Je Ticket").
 */
const AUFTEILUNG_SCHEMA = z.strictObject({
  name: z.string().regex(BEZEICHNER),
  label: z.string().trim().min(1).max(40),
  filter: z.boolean().optional(),
  darunter: z.strictObject({ name: z.string().regex(BEZEICHNER), label: z.string().trim().min(1).max(40) }).optional(),
});

export type ModulAufteilung = z.infer<typeof AUFTEILUNG_SCHEMA>;

/** Wie ein Anteil gezeigt wird: als Prozent des Hauptwerts (Standard) oder als Anzahl, die ab 1 als Warnung gilt. */
export const ANTEIL_FORMATE = ['anteil', 'anzahl'] as const;

/** Ein Teilbetrag des Hauptwerts (COPI-98), etwa „geschätzt": eine numerische Spalte, gezeigt mit Erklärung. */
const ANTEIL_SCHEMA = z.strictObject({
  name: z.string().regex(BEZEICHNER),
  label: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(120).optional(),
  format: z.enum(ANTEIL_FORMATE).optional(),
});

export type ModulAnteil = z.infer<typeof ANTEIL_SCHEMA>;

/**
 * Das Fachschema eines Moduls (COPI-107): Kleinbuchstaben, Ziffern, `_`, beginnt mit einem Buchstaben. Nie das Schema
 * des Cockpits und nie eines von Postgres — dort gibt es keine Fachmigrationen, und gelesen wird daraus nur
 * `<schema>._migration` (`fach-migration.ts`).
 */
const FACH_SCHEMA = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/)
  .refine((schema) => !['cockpit', 'public', 'information_schema'].includes(schema) && !schema.startsWith('pg_'), {
    message: 'Das Schema des Cockpits und die Schemata von Postgres sind kein Fachschema.',
  });

/** Die Fachmigrationen, die ein Block mindestens voraussetzt (COPI-107): `fach: { schema, mindestens }`. */
const FACH = z.strictObject({ schema: FACH_SCHEMA, mindestens: z.number().int().min(1).max(9999) });

/**
 * Was für ein Modul es ist (COPI-134): `fach` (Standard) hält Fachdaten des Kunden — der Betreuer sieht es nur, wenn der
 * Betriebs-Admin es freigibt (`betreuer-zugriff.ts`); `betrieb` ist ein technisches Modul ohne Fachdaten (Server-Zustand,
 * KI-Verbrauch), das der Betreuer zum Betreuen immer braucht.
 */
export const MODUL_ARTEN = ['fach', 'betrieb'] as const;

export type ModulArt = (typeof MODUL_ARTEN)[number];

const MODUL_BLOCK_SCHEMA = z
  .strictObject({
    kennung: z.string().regex(MODUL_KENNUNG),
    art: z.enum(MODUL_ARTEN).optional(),
    menuename: z.string().trim().min(1).max(40),
    ansicht: z.enum(ANSICHTSTYPEN),
    view: z.string().regex(VIEW_NAME),
    spalten: z.array(SPALTE_SCHEMA).min(1),
    rollen: z.array(z.enum(ALLE_ROLLEN)).min(1),
    eingriffe: z.array(z.string()),
    uebersicht: UEBERSICHT_SCHEMA.optional(),
    posteingang: POSTEINGANG_SCHEMA.optional(),
    darstellung: z.enum(DARSTELLUNGEN).optional(),
    navigation: z.literal(NAVIGATION_HAUPT).optional(),
    aufteilungen: z.array(AUFTEILUNG_SCHEMA).max(KENNZAHLEN_HOECHSTENS).optional(),
    anteile: z.array(ANTEIL_SCHEMA).max(KENNZAHLEN_HOECHSTENS).optional(),
    hinweise: z.string().regex(VIEW_NAME).optional(),
    fach: FACH.optional(),
    agent: z.string().regex(AGENT_KENNUNG).optional(),
    freigabe: FREIGABE_SCHEMA.optional(),
    anhaenge: z.string().regex(VIEW_NAME).optional(),
    bildvorschau: z.literal(true).optional(),
    statuswoerter: STATUSWOERTER_SCHEMA.optional(),
    entscheidung: ENTSCHEIDUNG_SCHEMA.optional(),
  })
  .superRefine((block, ctx) => {
    if (!UMGESETZTE_ANSICHTEN.includes(block.ansicht)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ansicht'],
        message: `Ansichtstyp „${block.ansicht}" ist noch nicht umgesetzt (bisher nur „${UMGESETZTE_ANSICHTEN.join('", „')}").`,
      });
    }
    kennzahlenPruefen(block, ctx);
    for (const eingriff of block.eingriffe) {
      if (!(EINGRIFFE as readonly string[]).includes(eingriff)) {
        ctx.addIssue({
          code: 'custom',
          path: ['eingriffe'],
          message: `Eingriff „${eingriff}" ist noch nicht umgesetzt (bisher nur „${EINGRIFFE.join('", „')}").`,
        });
      }
    }
    uebersichtPruefen(block, ctx);
    posteingangPruefen(block, ctx);
    freigabePruefen(block, ctx);
    entscheidungPruefen(block, ctx);
    block.spalten.forEach((spalte, stelle) => {
      for (const feld of ['gekuerzt', 'formatierung'] as const) {
        if (spalte[feld] !== undefined && spalte.format !== 'langtext') {
          ctx.addIssue({ code: 'custom', path: ['spalten', stelle, feld], message: 'nur beim Format „langtext" möglich.' });
        }
      }
      if (spalte.format === 'link' && spalte.domains === undefined) {
        ctx.addIssue({ code: 'custom', path: ['spalten', stelle, 'domains'], message: 'fehlt: ein Link braucht die Liste der erlaubten Domains.' });
      }
      if (spalte.domains !== undefined && spalte.format !== 'link') {
        ctx.addIssue({ code: 'custom', path: ['spalten', stelle, 'domains'], message: 'nur beim Format „link" möglich.' });
      }
    });
    for (const feld of ['darstellung', 'anhaenge'] as const) {
      if (block[feld] !== undefined && block.ansicht !== ANSICHT_LISTE_DETAIL) {
        ctx.addIssue({ code: 'custom', path: [feld], message: `nur für den Ansichtstyp „${ANSICHT_LISTE_DETAIL}" möglich.` });
      }
    }
    if (block.bildvorschau === true && block.anhaenge === undefined) {
      ctx.addIssue({ code: 'custom', path: ['bildvorschau'], message: 'nur mit anhaenge möglich: die Vorschau zeigt Bild-Anhänge.' });
    }
    if (block.anhaenge !== undefined && block.anhaenge === block.view) {
      ctx.addIssue({ code: 'custom', path: ['anhaenge'], message: 'Die Anhänge brauchen eine eigene View, nicht die Modul-View.' });
    }
  });

/** Was die Regeln jenseits der Form vom Block sehen — der Typ des Blocks entsteht erst aus dem Schema. */
interface BlockFelder {
  readonly ansicht: Ansichtstyp;
  readonly spalten: readonly ModulSpalte[];
  readonly eingriffe: readonly string[];
  readonly uebersicht?: ModulUebersicht | undefined;
  readonly posteingang?: ModulPosteingang | undefined;
  readonly freigabe?: ModulFreigabe | undefined;
  readonly entscheidung?: ModulEntscheidung | undefined;
  readonly aufteilungen?: readonly ModulAufteilung[] | undefined;
  readonly anteile?: readonly ModulAnteil[] | undefined;
  readonly hinweise?: string | undefined;
}

/**
 * Die Regeln der Kennzahlen (COPI-98). Ihre Felder gibt es nur dort; dort gilt: die erste Kennzahl ist der Hauptwert
 * `wert` (die Pflichtspalte der View), Kennzahlen sind Zahl oder Betrag, keine Eingriffe (es gibt keine Zeile, an der
 * man eingreifen könnte), höchstens eine Aufteilung mit Filter.
 */
function kennzahlenPruefen(block: BlockFelder, ctx: z.RefinementCtx): void {
  const melden = (pfad: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path: pfad, message });
  };
  if (block.ansicht !== ANSICHT_KENNZAHLEN) {
    const nurDort = `nur für den Ansichtstyp „${ANSICHT_KENNZAHLEN}" möglich.`;
    for (const feld of ['aufteilungen', 'anteile', 'hinweise'] as const) {
      if (block[feld] !== undefined) {
        melden([feld], nurDort);
      }
    }
    block.spalten.forEach((spalte, stelle) => {
      if (spalte.davon !== undefined) {
        melden(['spalten', stelle, 'davon'], nurDort);
      }
    });
    return;
  }
  if (block.spalten[0]?.name !== 'wert') {
    melden(['spalten'], 'Die erste Kennzahl muss die Spalte „wert" sein (der Hauptwert).');
  }
  if (block.spalten.length > KENNZAHLEN_HOECHSTENS) {
    melden(['spalten'], `höchstens ${String(KENNZAHLEN_HOECHSTENS)} Kennzahlen.`);
  }
  block.spalten.forEach((spalte, stelle) => {
    if (spalte.format !== undefined && !KENNZAHL_FORMATE.includes(spalte.format)) {
      melden(['spalten', stelle, 'format'], `Eine Kennzahl ist „${KENNZAHL_FORMATE.join('" oder „')}".`);
    }
  });
  if (block.eingriffe.length > 0) {
    melden(['eingriffe'], `Der Ansichtstyp „${ANSICHT_KENNZAHLEN}" kennt keine Eingriffe.`);
  }
  const aufteilungen = block.aufteilungen ?? [];
  if (aufteilungen.filter((aufteilung) => aufteilung.filter === true).length > 1) {
    melden(['aufteilungen'], 'höchstens eine Aufteilung mit filter.');
  }
  aufteilungen.forEach((aufteilung, stelle) => {
    if (aufteilung.darunter !== undefined && aufteilung.filter !== true) {
      melden(['aufteilungen', stelle, 'darunter'], 'nur zusammen mit filter: true.');
    }
  });
  // Jede Spalte der View hat genau eine Aufgabe; zwei Felder mit demselben Namen wären ein Tippfehler.
  const namen = kennzahlenSpalten(block);
  const alle = [...namen.zahlen, ...namen.texte];
  const doppelt = alle.find((name, stelle) => alle.indexOf(name) !== stelle);
  if (doppelt !== undefined) {
    melden([], `Die Spalte „${doppelt}" ist mehrfach deklariert.`);
  }
}

/**
 * Die Spalten, die ein Kennzahlen-Block von seiner View braucht (COPI-98), nach Typ: `zahlen` müssen `numeric` sein
 * (Kennzahlen, ihre `davon`-Teile, Anteile), `texte` `text` (Aufteilungen und `darunter`). `registry.ts` prüft sie,
 * `kennzahlen-lesen.ts` selektiert genau diese.
 */
export function kennzahlenSpalten(block: Pick<BlockFelder, 'spalten' | 'aufteilungen' | 'anteile'>): { readonly zahlen: readonly string[]; readonly texte: readonly string[] } {
  return {
    zahlen: [
      ...block.spalten.flatMap((spalte) => (spalte.davon === undefined ? [spalte.name] : [spalte.name, spalte.davon.name])),
      ...(block.anteile ?? []).map((anteil) => anteil.name),
    ],
    texte: (block.aufteilungen ?? []).flatMap((aufteilung) => (aufteilung.darunter === undefined ? [aufteilung.name] : [aufteilung.name, aufteilung.darunter.name])),
  };
}

/**
 * Die Regeln von `uebersicht:`, die über die Form hinausgehen. Liste+Detail: `kurztext` ist Pflicht und muss
 * deklariert sein. Kennzahlen (COPI-98): die Karte zeigt den Hauptwert des laufenden Monats — `kurztext` und `verlauf`
 * gibt es dort nicht.
 */
function uebersichtPruefen(block: BlockFelder, ctx: z.RefinementCtx): void {
  if (block.uebersicht === undefined) {
    return;
  }
  if (block.ansicht === ANSICHT_KENNZAHLEN) {
    for (const feld of ['kurztext', 'verlauf', 'art'] as const) {
      if (block.uebersicht[feld] !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['uebersicht', feld], message: `nur für den Ansichtstyp „${ANSICHT_LISTE_DETAIL}" möglich.` });
      }
    }
    return;
  }
  if (block.ansicht !== ANSICHT_LISTE_DETAIL) {
    ctx.addIssue({ code: 'custom', path: ['uebersicht'], message: `nur für den Ansichtstyp „${ANSICHT_LISTE_DETAIL}" möglich.` });
  }
  if (block.uebersicht.art === 'liste' && block.uebersicht.verlauf !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['uebersicht', 'verlauf'], message: 'Eine Liste zeigt keine Bänder: verlauf nur bei art „karten".' });
  }
  const kurztext = block.uebersicht.kurztext;
  if (kurztext === undefined) {
    ctx.addIssue({ code: 'custom', path: ['uebersicht', 'kurztext'], message: 'fehlt.' });
    return;
  }
  const spalte = block.spalten.find((kandidat) => kandidat.name === kurztext);
  if (spalte === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['uebersicht', 'kurztext'],
      message: `Die Spalte „${kurztext}" ist nicht in spalten deklariert.`,
    });
  } else if (spalte.format === 'langtext' || spalte.format === 'link') {
    ctx.addIssue({ code: 'custom', path: ['uebersicht', 'kurztext'], message: 'Ein Langtext oder Link gehört nicht auf eine Karte (COPI-103, COPI-91).' });
  }
}

/**
 * Die Regeln von `posteingang:` (COPI-112): nur bei Liste+Detail; `anriss` und `zeit` sind deklarierte Spalten, der
 * Anriss kein Langtext (der gehört nur auf die Detailseite, COPI-103), die Zeit im Format `zeitpunkt`.
 */
function posteingangPruefen(block: BlockFelder, ctx: z.RefinementCtx): void {
  const posteingang = block.posteingang;
  if (posteingang === undefined) {
    return;
  }
  const melden = (feld: string, message: string): void => {
    ctx.addIssue({ code: 'custom', path: ['posteingang', feld], message });
  };
  if (block.ansicht !== ANSICHT_LISTE_DETAIL) {
    ctx.addIssue({ code: 'custom', path: ['posteingang'], message: `nur für den Ansichtstyp „${ANSICHT_LISTE_DETAIL}" möglich.` });
    return;
  }
  const anriss = block.spalten.find((spalte) => spalte.name === posteingang.anriss);
  if (anriss === undefined) {
    melden('anriss', `Die Spalte „${posteingang.anriss}" ist nicht in spalten deklariert.`);
  } else if (anriss.format === 'langtext' || anriss.format === 'link') {
    melden('anriss', 'Ein Langtext oder Link gehört nicht in den Posteingang (COPI-103, COPI-91).');
  }
  const zeit = block.spalten.find((spalte) => spalte.name === posteingang.zeit);
  if (zeit === undefined) {
    melden('zeit', `Die Spalte „${posteingang.zeit}" ist nicht in spalten deklariert.`);
  } else if (zeit.format !== 'zeitpunkt') {
    melden('zeit', 'muss eine Spalte im Format „zeitpunkt" sein.');
  }
}

/**
 * Die Regeln von `freigabe:` (COPI-90): nur bei Liste+Detail, genau zusammen mit dem Eingriff `antwort_freigeben`, und
 * keine der Spalten zweimal.
 */
function freigabePruefen(block: BlockFelder, ctx: z.RefinementCtx): void {
  const eingriff = block.eingriffe.includes('antwort_freigeben');
  if (block.freigabe === undefined) {
    if (eingriff) {
      ctx.addIssue({ code: 'custom', path: ['freigabe'], message: 'fehlt: der Eingriff „antwort_freigeben" braucht den Abschnitt freigabe.' });
    }
    return;
  }
  if (!eingriff) {
    ctx.addIssue({ code: 'custom', path: ['freigabe'], message: 'nur zusammen mit dem Eingriff „antwort_freigeben".' });
  }
  if (block.ansicht !== ANSICHT_LISTE_DETAIL) {
    ctx.addIssue({ code: 'custom', path: ['freigabe'], message: `nur für den Ansichtstyp „${ANSICHT_LISTE_DETAIL}" möglich.` });
  }
  const namen = Object.values(block.freigabe).filter((name): name is string => name !== undefined);
  const doppelt = namen.find((name, stelle) => namen.indexOf(name) !== stelle);
  if (doppelt !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['freigabe'], message: `Die Spalte „${doppelt}" ist mehrfach genannt.` });
  }
}

/**
 * Die Regeln von `entscheidung:` (COPI-91): nur bei Liste+Detail, genau zusammen mit dem Eingriff `entscheiden`, jeder
 * Wert einmal, `wenn` nennt nur `offen` oder Werte der Optionen.
 */
function entscheidungPruefen(block: BlockFelder, ctx: z.RefinementCtx): void {
  const eingriff = block.eingriffe.includes('entscheiden');
  const entscheidung = block.entscheidung;
  const melden = (pfad: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path: ['entscheidung', ...pfad], message });
  };
  if (entscheidung === undefined) {
    if (eingriff) {
      ctx.addIssue({ code: 'custom', path: ['entscheidung'], message: 'fehlt: der Eingriff „entscheiden" braucht den Abschnitt entscheidung.' });
    }
    return;
  }
  if (!eingriff) {
    melden([], 'nur zusammen mit dem Eingriff „entscheiden".');
  }
  if (block.ansicht !== ANSICHT_LISTE_DETAIL) {
    melden([], `nur für den Ansichtstyp „${ANSICHT_LISTE_DETAIL}" möglich.`);
  }
  const werte = entscheidung.optionen.map((option) => option.wert);
  const doppelt = werte.find((wert, stelle) => werte.indexOf(wert) !== stelle);
  if (doppelt !== undefined) {
    melden(['optionen'], `Der Wert „${doppelt}" ist mehrfach vergeben.`);
  }
  entscheidung.optionen.forEach((option, stelle) => {
    if (option.entwurf !== undefined && entscheidung.entwurf === undefined) {
      melden(['optionen', stelle, 'entwurf'], 'nur mit entscheidung.entwurf möglich: ohne Entwurfsspalte gäbe es nie einen Entwurf.');
    }
    for (const bedingung of option.wenn ?? []) {
      if (bedingung !== ENTSCHEIDUNG_OFFEN && !werte.includes(bedingung)) {
        melden(['optionen', stelle, 'wenn'], `„${bedingung}" ist weder „offen" noch der Wert einer Option.`);
      }
    }
  });
}

/** Ob der Block den Eingriff `entscheiden` erlaubt (COPI-91) — nur dann zeigt die Detailseite die Entscheidungskarte. */
export function entscheidenErlaubt(block: { readonly eingriffe: readonly string[]; readonly entscheidung?: ModulEntscheidung | undefined }): boolean {
  return block.entscheidung !== undefined && block.eingriffe.includes('entscheiden');
}

/** Ob offene Zeilen des Moduls Aufgaben unter „Freigaben" sind (COPI-124): `entscheiden` mit `entscheidung.aufgabe`. */
export function entscheidungAlsAufgabe(block: { readonly eingriffe: readonly string[]; readonly entscheidung?: ModulEntscheidung | undefined }): boolean {
  return entscheidenErlaubt(block) && block.entscheidung?.aufgabe === true;
}

/** Ob der Block den Eingriff `antwort_freigeben` erlaubt (COPI-90) — nur dann zeigt die Detailseite die Entwurfskarte. */
export function freigabeErlaubt(block: { readonly eingriffe: readonly string[]; readonly freigabe?: ModulFreigabe | undefined }): boolean {
  return block.freigabe !== undefined && block.eingriffe.includes('antwort_freigeben');
}

/** Steht das Modul als eigener Eintrag in der Hauptnavigation (COPI-121)? Dann ist es kein Postfach unter „Nachrichten". */
export function inHauptnavigation(block: { readonly navigation?: typeof NAVIGATION_HAUPT | undefined }): boolean {
  return block.navigation === NAVIGATION_HAUPT;
}

export type ModulBlock = z.infer<typeof MODUL_BLOCK_SCHEMA>;

/**
 * Löst den `cockpit:`-Wrapper auf (siehe Kopf): ein oberstes Objekt mit dem Schlüssel `cockpit` liefert
 * dessen Wert, sonst gilt `daten` selbst als Block. Reine Auswahl, ohne zu prüfen, ob das Ergebnis
 * überhaupt ein Block ist — das prüft die Schema-Prüfung danach.
 */
export function modulBlockEntpacken(daten: unknown): unknown {
  if (daten !== null && typeof daten === 'object' && !Array.isArray(daten) && 'cockpit' in (daten as Record<string, unknown>)) {
    return (daten as Record<string, unknown>).cockpit;
  }
  return daten;
}

/**
 * Ein Fehlertext aus einem `ZodError`, auf Deutsch und ohne die englischen Standardmeldungen von zod:
 * eigene Meldungen (`code: 'custom'`, oben) stehen mit Text, alles andere nur mit dem Feldnamen — das
 * genügt, um eine falsche Form (Kennung, Länge, unbekannte Rolle …) im YAML wiederzufinden.
 */
function fehlerBeschreiben(fehler: z.ZodError): string {
  const teile = new Set<string>();
  for (const issue of fehler.issues) {
    const pfad = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const name of issue.keys) {
        teile.add(pfad === '' ? `unbekanntes Feld „${name}"` : `${pfad}.${name}: unbekanntes Feld`);
      }
      continue;
    }
    if (issue.code === 'custom') {
      teile.add(pfad === '' ? issue.message : `${pfad}: ${issue.message}`);
      continue;
    }
    teile.add(pfad === '' ? '(Rumpf)' : pfad);
  }
  return [...teile].sort().join('; ');
}

export type ModulBlockErgebnis = { readonly ok: true; readonly block: ModulBlock } | { readonly ok: false; readonly grund: string };

/** Entpackt den Wrapper und prüft gegen das Schema; kein YAML, reine Objektprüfung (für die Schema-Tests). */
export function modulBlockPruefen(daten: unknown): ModulBlockErgebnis {
  const geparst = MODUL_BLOCK_SCHEMA.safeParse(modulBlockEntpacken(daten));
  if (!geparst.success) {
    return { ok: false, grund: `Modul-Block ungültig: ${fehlerBeschreiben(geparst.error)}` };
  }
  return { ok: true, block: geparst.data };
}

/** Wie `modulBlockPruefen`, aber ab rohem YAML-Text — was `modul-einspielen` von stdin bekommt. */
export function modulBlockAusText(text: string): ModulBlockErgebnis {
  let daten: unknown;
  try {
    daten = yamlParsen(text);
  } catch (fehler) {
    return { ok: false, grund: `Kein gültiges YAML: ${fehler instanceof Error ? fehler.message : 'unbekannt'}` };
  }
  return modulBlockPruefen(daten);
}

/** Die Pflichtspalten der Ansicht Liste+Detail mit ihrem Postgres-Typnamen (`registry.ts`). */
export const PFLICHTSPALTEN_LISTE_DETAIL: Readonly<Record<string, string>> = {
  id: 'text',
  titel: 'text',
  status: 'text',
  aktualisiert_am: 'timestamp with time zone',
};

/**
 * Die Pflichtspalten einer Anhang-View (`anhaenge`, COPI-110) mit ihrem Postgres-Typnamen (`registry.ts`). `groesse` ist
 * die Angabe des Absenders; ob ein Inhalt auslieferbar ist, misst das Cockpit selbst (`octet_length`).
 */
export const PFLICHTSPALTEN_ANHAENGE: Readonly<Record<string, string>> = {
  id: 'text',
  vorgang_id: 'text',
  dateiname: 'text',
  groesse: 'numeric',
  inhalt: 'bytea',
};

/** Optionale Spalten der Anhang-View: der Typ laut Absender (nur Anzeige, nie Grundlage der Klasse) und die Reihenfolge. */
export const OPTIONALE_SPALTEN_ANHAENGE: Readonly<Record<string, string>> = {
  typ: 'text',
  position: 'integer',
};

/** Die Pflichtspalten einer Verlaufs-View (`uebersicht.verlauf`, COPI-81) mit ihrem Postgres-Typnamen (`registry.ts`). */
export const PFLICHTSPALTEN_VERLAUF: Readonly<Record<string, string>> = {
  id: 'text',
  zeitpunkt: 'timestamp with time zone',
  status: 'text',
};

/**
 * Optionale Spalten der Modul-View: die Marke einer Listenzeile (COPI-91) und der Messwert (COPI-83): der aktuelle Wert einer Zeile mit Einheit, Obergrenze (Balken)
 * und Warnschwelle (Warnlinie). Fehlen sie, gilt alles wie bisher; sind sie da, muss der Typ genau stimmen.
 */
export const OPTIONALE_SPALTEN_LISTE_DETAIL: Readonly<Record<string, string>> = {
  // Eine kurze Marke neben der Zeit in der Liste (COPI-91), etwa „Grenzfall".
  marke: 'text',
  wert: 'numeric',
  einheit: 'text',
  wert_max: 'numeric',
  wert_warnung: 'numeric',
};

/** Die Pflichtspalten einer Kennzahlen-View (COPI-98): der Kalendertag und der Hauptwert. */
export const PFLICHTSPALTEN_KENNZAHLEN: Readonly<Record<string, string>> = {
  tag: 'date',
  wert: 'numeric',
};

/** Die Pflichtspalten einer Hinweis-View (`hinweise`, COPI-98): je Zeile eine Warnung mit Überschrift und Text. */
export const PFLICHTSPALTEN_HINWEISE: Readonly<Record<string, string>> = {
  titel: 'text',
  text: 'text',
};

/** Optionale Messwert-Spalten der Verlaufs-View (COPI-83): der Wert je Verlaufspunkt (die Kurve) und seine Einheit. */
export const OPTIONALE_SPALTEN_VERLAUF: Readonly<Record<string, string>> = {
  wert: 'numeric',
  einheit: 'text',
};

/** Ein technisches Modul (`art: betrieb`, COPI-134): der Betreuer sieht es immer, ohne Freigabe des Kunden. */
export function istBetriebsmodul(block: Pick<ModulBlock, 'art'>): boolean {
  return block.art === 'betrieb';
}

/**
 * Warum ein Block nicht eingespielt werden darf, weil ihn in einer Kundeninstanz niemand sähe (COPI-134): ein Fachmodul
 * nur für den Betreuer. Den Betreuer nennt `rollen` bei einem Fachmodul ohnehin vergeblich — ob er es sieht, entscheidet
 * der Kunde. Geprüft nur beim Einspielen, nicht beim Lesen: ein schon aktiver alter Block bleibt lesbar.
 */
export function kundenrolleFehlt(block: Pick<ModulBlock, 'art' | 'rollen'>): string | undefined {
  if (istBetriebsmodul(block) || !nurBetreuer(block.rollen)) {
    return undefined;
  }
  return 'Ein Fachmodul braucht in `rollen` mindestens eine Kundenrolle (betriebs_admin oder betrieb_mitarbeiter): ob der Betreuer es sieht, gibt der Kunde frei (COPI-134). Ein technisches Modul ohne Fachdaten bekommt `art: betrieb`.';
}

/** Nur für den Betreuer freigegeben — nur dann darf die View `text_intern` verwenden (`registry.ts`). */
export function nurBetreuer(rollen: readonly string[]): boolean {
  return rollen.every((rolle) => rolle === ROLLE_BETREUER);
}

/** Ob `wert` eine gültige Modul-Kennung ist (siehe oben) — für Routen, die eine Kennung aus der Adresse prüfen (COPI-78). */
export function istModulKennung(wert: string): boolean {
  return MODUL_KENNUNG.test(wert);
}

/** Ob der Block den Eingriff `uebernehmen` erlaubt (COPI-85) — nur dann bietet die Detailseite „Übernehmen" an. */
export function uebernehmenErlaubt(block: ModulBlock): boolean {
  return block.eingriffe.includes('uebernehmen');
}
