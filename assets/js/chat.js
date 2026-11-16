/**
 * Der Chat ohne Neuladen (COPI-56) — der Browser-Teil.
 *
 * Bewusst klein und ohne Bibliothek: öffnet die Server-Sent Events des Kanals (`data-chat-strom` an der Liste) und
 * hängt jede neue Nachricht an. Die Nachricht kommt als fertiges, auf dem Server escaptes HTML-Fragment — dasselbe
 * Partial wie die Seite —, das Skript baut nichts aus Inhalten zusammen. Eine Nachricht, die schon da ist (gleiche ID),
 * kommt kein zweites Mal. Wiederverbinden erledigt der Browser selbst, samt `Last-Event-ID`.
 *
 * Ohne JavaScript oder ohne `EventSource` bleibt die Seite, wie sie ist: neue Nachrichten stehen beim nächsten Laden da.
 *
 * Die Eingabe (COPI-64): **Enter schickt ab**, Strg+Enter (und wie gewohnt Umschalt+Enter) macht eine neue Zeile.
 * Nicht während einer IME-Eingabe (Akzente, Autokorrektur) und nicht bei leerem Feld. Auf Touch-Geräten bleibt Enter
 * eine neue Zeile, gesendet wird dort mit dem Knopf — wie bei Chat-Programmen mit Bildschirmtastatur üblich. Ohne
 * Skript ist Enter eine neue Zeile.
 *
 * Häkchen (COPI-69): Trifft eine Antwort des Koordinators ein (`data-chat-antwort`), springen die eigenen Nachrichten davor
 * live auf „beantwortet" (`beantwortetMarkieren`) — Stand und Text für Screenreader, ohne Neuladen.
 *
 * `nachrichtEinfuegen`, `beantwortetMarkieren` und `tasteEntscheiden` stehen einzeln bereit, damit `test/chat-skript.test.ts` sie ohne Browser
 * prüfen kann.
 */

/**
 * Was eine Taste im Eingabefeld tut: `senden`, `zeile` (das Skript fügt den Umbruch ein, weil der Browser es bei
 * Strg+Enter nicht tut) oder `nichts` (der Browser macht, was er immer macht).
 */
export function tasteEntscheiden(taste, beruehrung) {
  if (taste.key !== 'Enter' || taste.isComposing) {
    return 'nichts';
  }
  if (taste.ctrlKey) {
    return 'zeile';
  }
  if (taste.shiftKey || taste.altKey || taste.metaKey || beruehrung) {
    return 'nichts';
  }
  return 'senden';
}

/**
 * Fügt eine Nachricht (HTML-Fragment des Servers) in die Liste ein. Liefert `false`, wenn sie schon da war.
 * Hinweise zur ausstehenden Antwort und der Leerzustand verschwinden, sobald etwas Neues da ist.
 */
export function nachrichtEinfuegen(dokument, liste, id, html) {
  if (dokument.getElementById(`nachricht-${id}`)) {
    return false;
  }
  const behaelter = liste.querySelector('[data-chat-nachrichten]');
  if (!behaelter) {
    return false;
  }
  const vorlage = dokument.createElement('template');
  vorlage.innerHTML = html;
  behaelter.append(vorlage.content);
  for (const alt of liste.querySelectorAll('[data-chat-hinweis], [data-chat-leer]')) {
    alt.remove();
  }
  return true;
}

/**
 * Setzt jede eigene Nachricht mit kleinerer ID als die Antwort auf „beantwortet": Stand (`data-chat-status`, das CSS
 * färbt) und Text für Screenreader. Liefert, wie viele sich geändert haben.
 */
export function beantwortetMarkieren(liste, antwortId) {
  let geaendert = 0;
  for (const haken of liste.querySelectorAll('[data-chat-status]')) {
    if (haken.dataset.chatStatus === 'beantwortet' || !(Number(haken.dataset.chatNachricht) < Number(antwortId))) {
      continue;
    }
    haken.dataset.chatStatus = 'beantwortet';
    const text = haken.querySelector('.sr-only');
    if (text) {
      text.textContent = 'beantwortet';
    }
    geaendert += 1;
  }
  return geaendert;
}

function eingabeEinrichten() {
  const feld = document.querySelector('.chat-eingabe textarea');
  if (!feld || !feld.form) {
    return;
  }
  const beruehrung = window.matchMedia('(pointer: coarse)').matches;
  feld.addEventListener('keydown', (taste) => {
    const was = tasteEntscheiden(taste, beruehrung);
    if (was === 'zeile') {
      taste.preventDefault();
      feld.setRangeText('\n', feld.selectionStart, feld.selectionEnd, 'end');
    } else if (was === 'senden') {
      taste.preventDefault();
      if (/\S/.test(feld.value)) {
        feld.form.requestSubmit();
      }
    }
  });
}

function starten() {
  eingabeEinrichten();
  const liste = document.querySelector('[data-chat-strom]');
  if (!liste || typeof EventSource !== 'function') {
    return;
  }
  const quelle = new EventSource(liste.dataset.chatStrom);
  quelle.addEventListener('nachricht', (ereignis) => {
    if (nachrichtEinfuegen(document, liste, ereignis.lastEventId, ereignis.data)) {
      const neu = document.getElementById(`nachricht-${ereignis.lastEventId}`);
      if (neu && neu.hasAttribute('data-chat-antwort')) {
        beantwortetMarkieren(liste, ereignis.lastEventId);
      }
    }
  });
  // Mehr verpasst, als eine Seite fasst: neu laden statt eine Lücke zu zeigen.
  quelle.addEventListener('neuladen', () => {
    quelle.close();
    window.location.reload();
  });
}

if (typeof document !== 'undefined') {
  starten();
}
