/**
 * Das Tageslimit des Chats (COPI-57, ADR 1: „Der Chat ist ein direkter Draht zum Sprachmodell — ein Verbrauchslimit je
 * Benutzer/Tag ist Pflicht, nicht Ausbaustufe").
 *
 * **Was zählt:** Nachrichten an den Assistenten, je Konto und Kalendertag in der Zeit des Betriebs (Europe/Berlin).
 * Nur sie gehen an das Sprachmodell; der Team-Kanal bleibt unter Menschen und zählt nicht. Tokens und Euro misst die
 * Budget-Wache des Admin-Agenten, nicht das Cockpit — sie liest den Verbrauch über `GET /intern/chat/verbrauch`.
 *
 * Hier stehen die reinen Teile: welcher Tag gerade ist, wann der nächste beginnt (auch über die Umstellung der
 * Sommerzeit hinweg), und ab wann der Rest angezeigt wird.
 */

/** Ohne Angabe in der Umgebung (`COCKPIT_CHAT_TAGESLIMIT`). */
export const TAGESLIMIT_STANDARD = 50;

/** Ab diesem Anteil des Limits zeigt die Seite, wie viele Nachrichten heute noch gehen. */
export const REST_AB_ANTEIL = 0.8;

const ZEITZONE = 'Europe/Berlin';

const TEILE = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZEITZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function wandzeit(zeitpunkt: Date): { jahr: number; monat: number; tag: number; stunde: number; minute: number; sekunde: number } {
  const teile = Object.fromEntries(TEILE.formatToParts(zeitpunkt).map((teil) => [teil.type, teil.value]));
  return {
    jahr: Number(teile.year),
    monat: Number(teile.month),
    tag: Number(teile.day),
    stunde: Number(teile.hour),
    minute: Number(teile.minute),
    sekunde: Number(teile.second),
  };
}

/** Der Kalendertag in Berlin als `YYYY-MM-DD` — so steht er in `cockpit.chat_verbrauch.tag`. */
export function berlinerTag(zeitpunkt: Date): string {
  const { jahr, monat, tag } = wandzeit(zeitpunkt);
  return `${String(jahr)}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
}

/** Wie weit Berlin zu diesem Zeitpunkt UTC voraus ist, in Millisekunden (1 oder 2 Stunden). */
function versatz(zeitpunkt: number): number {
  const w = wandzeit(new Date(zeitpunkt));
  return Date.UTC(w.jahr, w.monat - 1, w.tag, w.stunde, w.minute, w.sekunde) - Math.floor(zeitpunkt / 1000) * 1000;
}

/**
 * Wann der nächste Tag in Berlin beginnt: Mitternacht nach `zeitpunkt`. Die Umstellung auf und von der Sommerzeit liegt
 * nachts um zwei bzw. drei, Mitternacht gibt es also jeden Tag genau einmal; der Versatz wird an der Mitternacht selbst
 * bestimmt, nicht an `zeitpunkt`.
 */
export function naechsterTagesbeginn(zeitpunkt: Date): Date {
  const { jahr, monat, tag } = wandzeit(zeitpunkt);
  const mitternachtAlsUtc = Date.UTC(jahr, monat - 1, tag + 1);
  const erste = mitternachtAlsUtc - versatz(mitternachtAlsUtc);
  return new Date(mitternachtAlsUtc - versatz(erste));
}

/** Wie viele Nachrichten heute noch gehen — `undefined`, solange weniger als 80 % verbraucht sind. */
export function restAnzeige(verbraucht: number, limit: number): number | undefined {
  return verbraucht >= Math.ceil(limit * REST_AB_ANTEIL) ? Math.max(0, limit - verbraucht) : undefined;
}
