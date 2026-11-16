/**
 * Die Katalogprüfung eines Modul-Blocks gegen die echte Datenbank (COPI-77, Epic E5): Der Block allein
 * sagt nur, was ein Modul **verspricht** (`block.ts`); ob die View mit diesem Namen wirklich existiert
 * und die versprochenen Spalten trägt, weiß nur die Datenbank. „Der Vertrag zum Fachmodul ist eine SQL-
 * View mit festen Spaltennamen, nie Code" (ADR) — das hier ist die Prüfung dieses Vertrags.
 *
 * Alles parametrisiert über `information_schema`, nie String-Konkatenation mit einer Nutzereingabe:
 * `block.view` und die Spaltennamen kommen als `$1`/`$2` in die Abfrage, nie in den SQL-Text.
 */
import {
  entscheidungSpalten,
  freigabeSpalten,
  ANSICHT_KENNZAHLEN,
  OPTIONALE_SPALTEN_ANHAENGE,
  OPTIONALE_SPALTEN_LISTE_DETAIL,
  PFLICHTSPALTEN_ANHAENGE,
  OPTIONALE_SPALTEN_VERLAUF,
  PFLICHTSPALTEN_HINWEISE,
  PFLICHTSPALTEN_KENNZAHLEN,
  PFLICHTSPALTEN_LISTE_DETAIL,
  PFLICHTSPALTEN_VERLAUF,
  kennzahlenSpalten,
  nurBetreuer,
  type ModulBlock,
} from './block.js';
import type { Abfrager } from '../auth/protokoll.js';

/**
 * `optionale`: die optionalen Spalten (COPI-83, Messwert), die die View trägt — nur gesetzt, wenn es welche gibt.
 * Das Lesen selektiert genau diese mit (`liste-detail.ts`, `uebersicht-lesen.ts`), nie eine ungeprüfte.
 */
export type KatalogErgebnis =
  | { readonly ok: true; readonly optionale?: readonly string[] }
  | { readonly ok: false; readonly grund: string };

interface SpaltenZeile {
  readonly column_name: string;
  readonly data_type: string;
}

/** Was eine View erfüllen muss: Name, Pflichtspalten mit Typ, weitere deklarierte Spalten und wer sie sieht. */
interface ViewVertrag {
  readonly view: string;
  readonly pflichtspalten: Readonly<Record<string, string>>;
  /** Spalten, die fehlen dürfen; sind sie da, gilt ihr Typ genau wie bei den Pflichtspalten (COPI-83). */
  readonly optional: Readonly<Record<string, string>>;
  readonly deklariert: readonly string[];
  readonly rollen: readonly string[];
}

/**
 * Prüft eine View gegen ihren Vertrag — dieselben Schritte für die Modul-View und die Verlaufs-View (COPI-81):
 *
 *   1. Die View existiert im Schema `cockpit` und ist wirklich eine View (nicht etwa eine Tabelle
 *      gleichen Namens).
 *   2. Die Pflichtspalten sind da, mit genau dem erwarteten Postgres-Typnamen; optionale Spalten (COPI-83) dürfen
 *      fehlen, tragen aber, wenn sie da sind, ebenso genau ihren Typ.
 *   3. Jede deklarierte Spalte existiert in der View.
 *   4. Ist irgendeine andere Rolle als `betreuer` freigegeben, darf die View weder `text_intern`
 *      verwenden noch auf einer anderen View aufbauen (`kundensichtPruefen`) — Rohbefunde gehen nie
 *      an den Kunden (ADR).
 */
async function viewPruefen(db: Abfrager, vertrag: ViewVertrag): Promise<KatalogErgebnis> {
  const { view } = vertrag;
  const viewVorhanden = await db.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema = 'cockpit' AND table_name = $1`,
    [view],
  );
  if (viewVorhanden.rowCount === 0) {
    return { ok: false, grund: `Die View cockpit.${view} gibt es nicht (oder ist keine View).` };
  }

  const spaltenErgebnis = await db.query<SpaltenZeile>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'cockpit' AND table_name = $1`,
    [view],
  );
  const spalten = new Map(spaltenErgebnis.rows.map((zeile) => [zeile.column_name, zeile.data_type]));

  const typFalsch = (name: string, erwartet: string): KatalogErgebnis | undefined => {
    const gefunden = spalten.get(name);
    return gefunden === undefined || gefunden === erwartet
      ? undefined
      : { ok: false, grund: `Die Spalte ${name} in cockpit.${view} hat den Typ ${gefunden}, erwartet ${erwartet}.` };
  };

  for (const [name, erwarteterTyp] of Object.entries(vertrag.pflichtspalten)) {
    if (!spalten.has(name)) {
      return { ok: false, grund: `Der Pflicht-Spalte ${name} fehlt in cockpit.${view}.` };
    }
    const fehler = typFalsch(name, erwarteterTyp);
    if (fehler !== undefined) {
      return fehler;
    }
  }

  const optionale = Object.keys(vertrag.optional).filter((name) => spalten.has(name));
  for (const name of optionale) {
    const fehler = typFalsch(name, vertrag.optional[name] ?? '');
    if (fehler !== undefined) {
      return fehler;
    }
  }

  for (const name of vertrag.deklariert) {
    if (!spalten.has(name)) {
      return { ok: false, grund: `Die Spalte ${name} fehlt in cockpit.${view}.` };
    }
  }

  if (!nurBetreuer(vertrag.rollen)) {
    const kundensicht = await kundensichtPruefen(db, view);
    if (!kundensicht.ok) {
      return kundensicht;
    }
  }

  return optionale.length > 0 ? { ok: true, optionale } : { ok: true };
}

/**
 * Die Modul-View eines bereits geprüften Blocks (nur `liste-detail`, siehe `block.ts` — ein anderer
 * Ansichtstyp erreicht diese Funktion nie, das Schema weist ihn vorher ab): Pflichtspalten von Liste+Detail
 * (`id`, `titel`, `status`, `aktualisiert_am`), die optionalen Messwert-Spalten (COPI-83) und jede in `spalten` deklarierte Spalte. Das prüft
 * `liste-detail.ts` vor jedem Lesen erneut.
 */
export async function modulViewPruefen(db: Abfrager, block: ModulBlock): Promise<KatalogErgebnis> {
  return viewPruefen(db, {
    view: block.view,
    // Die Zeit des Posteingangs (COPI-112) wird verglichen und sortiert: ihr Typ muss stimmen, nicht nur ihr Name.
    // Die Spalten des Entwurfs (COPI-90) stehen nicht in `spalten`; auch ihr Typ muss stimmen.
    pflichtspalten: {
      ...PFLICHTSPALTEN_LISTE_DETAIL,
      ...(block.posteingang === undefined ? {} : { [block.posteingang.zeit]: 'timestamp with time zone' }),
      ...(block.freigabe === undefined ? {} : freigabeSpalten(block.freigabe)),
      // Der Entwurf zur Entscheidung (COPI-91) steht ebenso nicht in `spalten`.
      ...entscheidungSpalten(block.entscheidung),
    },
    optional: OPTIONALE_SPALTEN_LISTE_DETAIL,
    // Mit der Spalte, die einen Langtext als gekürzt meldet (COPI-103): auch sie muss es in der View geben.
    deklariert: block.spalten.flatMap((spalte) => (spalte.gekuerzt === undefined ? [spalte.name] : [spalte.name, spalte.gekuerzt.spalte])),
    rollen: block.rollen,
  });
}

/**
 * Die Verlaufs-View aus `uebersicht.verlauf` (COPI-81): `id`, `zeitpunkt`, `status` (optional `wert`, `einheit`, COPI-83), dieselbe Kundensicht-Regel
 * wie die Modul-View. Ohne Verlaufs-View gibt es nichts zu prüfen. Vor jedem Lesen erneut geprüft
 * (`verlauf.ts`); scheitert sie dort, bleiben nur die Bänder neutral, die Karten erscheinen trotzdem.
 */
export async function verlaufViewPruefen(db: Abfrager, block: ModulBlock): Promise<KatalogErgebnis> {
  const verlauf = block.uebersicht?.verlauf;
  if (verlauf === undefined) {
    return { ok: true };
  }
  return viewPruefen(db, { view: verlauf, pflichtspalten: PFLICHTSPALTEN_VERLAUF, optional: OPTIONALE_SPALTEN_VERLAUF, deklariert: [], rollen: block.rollen });
}

/**
 * Die Anhang-View aus `anhaenge` (COPI-110): `id`, `vorgang_id`, `dateiname`, `groesse`, `inhalt` (optional `typ`,
 * `position`), dieselbe Kundensicht-Regel wie die Modul-View. Ohne Anhang-View gibt es nichts zu prüfen. Vor jedem Lesen
 * erneut geprüft (`anhaenge.ts`); scheitert sie dort, fehlt nur die Anhangliste.
 */
export async function anhaengeViewPruefen(db: Abfrager, block: ModulBlock): Promise<KatalogErgebnis> {
  if (block.anhaenge === undefined) {
    return { ok: true };
  }
  return viewPruefen(db, { view: block.anhaenge, pflichtspalten: PFLICHTSPALTEN_ANHAENGE, optional: OPTIONALE_SPALTEN_ANHAENGE, deklariert: [], rollen: block.rollen });
}

/**
 * Die View eines Kennzahlen-Blocks (COPI-98): `tag` und `wert`, dazu jede deklarierte Spalte **mit Typ** — Kennzahlen,
 * ihre `davon`-Teile und Anteile `numeric`, Aufteilungen `text`. Anders als bei Liste+Detail rechnet das Cockpit mit
 * diesen Spalten (Summen, Gruppen); eine Spalte mit anderem Typ scheitert hier statt beim Lesen. Dieselbe
 * Kundensicht-Regel wie jede Modul-View. `kennzahlen-lesen.ts` prüft vor jedem Lesen erneut.
 */
export async function kennzahlenViewPruefen(db: Abfrager, block: ModulBlock): Promise<KatalogErgebnis> {
  const spalten = kennzahlenSpalten(block);
  return viewPruefen(db, {
    view: block.view,
    pflichtspalten: {
      ...PFLICHTSPALTEN_KENNZAHLEN,
      ...Object.fromEntries(spalten.zahlen.map((name) => [name, 'numeric'])),
      ...Object.fromEntries(spalten.texte.map((name) => [name, 'text'])),
    },
    optional: {},
    deklariert: [],
    rollen: block.rollen,
  });
}

/**
 * Die Hinweis-View eines Kennzahlen-Blocks (`hinweise`, COPI-98): `titel` und `text`. Ohne sie gibt es nichts zu
 * prüfen. Scheitert sie beim Lesen, erscheinen die Zahlen trotzdem, nur ohne Warnzeilen.
 */
export async function hinweiseViewPruefen(db: Abfrager, block: ModulBlock): Promise<KatalogErgebnis> {
  if (block.hinweise === undefined) {
    return { ok: true };
  }
  return viewPruefen(db, { view: block.hinweise, pflichtspalten: PFLICHTSPALTEN_HINWEISE, optional: {}, deklariert: [], rollen: block.rollen });
}

/**
 * Der ganze Katalog eines Blocks beim Einspielen (`modul-speicher.ts`), je Ansichtstyp: Liste+Detail die Modul-View,
 * dann die Verlaufs-View und die Anhang-View; Kennzahlen die Kennzahlen-View, dann die Hinweis-View.
 */
export async function katalogPruefen(db: Abfrager, block: ModulBlock): Promise<KatalogErgebnis> {
  if (block.ansicht === ANSICHT_KENNZAHLEN) {
    const kennzahlen = await kennzahlenViewPruefen(db, block);
    return kennzahlen.ok ? hinweiseViewPruefen(db, block) : kennzahlen;
  }
  const modul = await modulViewPruefen(db, block);
  if (!modul.ok) {
    return modul;
  }
  const verlauf = await verlaufViewPruefen(db, block);
  return verlauf.ok ? anhaengeViewPruefen(db, block) : verlauf;
}

interface AbhaengigkeitZeile {
  readonly relation: string;
  readonly art: string;
  readonly spalte: string | null;
}

/**
 * Sieht ein Kunde die View, darf sie Rohbefunde weder direkt noch über Umwege lesen. Geprüft über die
 * Abhängigkeiten der View-Regel im Katalog (`pg_rewrite`/`pg_depend`), nicht über
 * `information_schema.view_column_usage`: Das kennt nur direkte Abhängigkeiten und nur Tabellen, die
 * der aktuellen Rolle gehören. Eine Zwischen-View (`SELECT text_intern AS harmlos …`) tarnte die Spalte
 * dort vollständig (Review COPI-77). Deshalb gilt für Kundensichten zusätzlich: nur auf Tabellen
 * aufbauen, nicht auf andere Views.
 */
async function kundensichtPruefen(db: Abfrager, view: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly grund: string }> {
  const abhaengigkeiten = await db.query<AbhaengigkeitZeile>(
    `SELECT DISTINCT ref.relname AS relation, ref.relkind::text AS art, att.attname AS spalte
       FROM pg_catalog.pg_class v
       JOIN pg_catalog.pg_namespace n ON n.oid = v.relnamespace
       JOIN pg_catalog.pg_rewrite r ON r.ev_class = v.oid
       JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = r.oid
       JOIN pg_catalog.pg_class ref ON ref.oid = d.refobjid AND ref.oid <> v.oid
       LEFT JOIN pg_catalog.pg_attribute att ON att.attrelid = ref.oid AND att.attnum = d.refobjsubid AND d.refobjsubid > 0
      WHERE n.nspname = 'cockpit' AND v.relname = $1`,
    [view],
  );
  const andereView = abhaengigkeiten.rows.find((zeile) => zeile.art === 'v' || zeile.art === 'm');
  if (andereView !== undefined) {
    return {
      ok: false,
      grund: `cockpit.${view} baut auf der View ${andereView.relation} auf. Für Kundenrollen muss eine Modul-View direkt auf Tabellen aufbauen, sonst lässt sich text_intern nicht sicher ausschließen.`,
    };
  }
  if (abhaengigkeiten.rows.some((zeile) => zeile.spalte === 'text_intern')) {
    return {
      ok: false,
      grund: `cockpit.${view} verwendet text_intern, ist aber nicht auf die Rolle betreuer beschränkt.`,
    };
  }
  return { ok: true };
}
