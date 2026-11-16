/**
 * Der Service Worker des Cockpits (COPI-58). Er macht das Cockpit installierbar und nimmt Web Push an (COPI-59).
 *
 * **Er speichert nichts.** Kein Offline-Cache, auch nicht für statische Dateien: nach dem Abmelden soll nichts vom
 * Cockpit im Gerät liegen, und jede Seite kommt frisch vom Server (die Seiten sind `no-store`). Ohne `fetch`-Handler
 * geht jede Anfrage unverändert ans Netz.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (ereignis) => {
  ereignis.waitUntil(self.clients.claim());
});

/**
 * Web Push (COPI-59): der Rumpf trägt nur einen Hinweis, nie den Text einer Nachricht. Die Ziele stehen hier fest; der
 * Rumpf wählt mit `ziel` nur einen Namen aus dieser Liste (COPI-116: `posteingang` öffnet den Posteingang im Kopf) —
 * eine Nachricht kann den Klick auf keine fremde Adresse lenken. Unbekannt oder fehlend: der Chat.
 */
const ZIELE = { chat: '/chat', posteingang: '/#posteingang' };

/** Das Ziel zu einem Namen aus dem Rumpf, nur aus der Liste. */
function zielZu(name) {
  return Object.prototype.hasOwnProperty.call(ZIELE, name) ? ZIELE[name] : ZIELE.chat;
}

/**
 * Die Zahl am App-Symbol (COPI-116): die Zahl des Posteingangs aus dem Rumpf, wenn der Browser es kann (iOS ab 16.4 in
 * der installierten App). Fehler zählen nicht: das Symbol ist eine Zugabe.
 */
async function symbolZahlSetzen(anzahl) {
  if (!Number.isInteger(anzahl) || anzahl < 0 || !('setAppBadge' in self.navigator)) {
    return;
  }
  try {
    await (anzahl === 0 ? self.navigator.clearAppBadge() : self.navigator.setAppBadge(anzahl));
  } catch {
    // ohne Zahl
  }
}

self.addEventListener('push', (ereignis) => {
  let daten;
  try {
    daten = ereignis.data ? ereignis.data.json() : {};
  } catch {
    daten = {};
  }
  const titel = typeof daten.titel === 'string' ? daten.titel.slice(0, 60) : 'Cockpit';
  const text = typeof daten.text === 'string' ? daten.text.slice(0, 120) : 'Neue Nachricht im Chat';
  const ziel = zielZu(daten.ziel);
  ereignis.waitUntil(
    Promise.all([
      self.registration.showNotification(titel, {
        body: text,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: ziel === ZIELE.chat ? 'cockpit-chat' : 'cockpit-posteingang',
        data: { ziel },
      }),
      symbolZahlSetzen(daten.anzahl),
    ]),
  );
});

self.addEventListener('notificationclick', (ereignis) => {
  ereignis.notification.close();
  // Das Ziel kommt aus `data`, das nur dieser Worker setzt — trotzdem nur, was in der Liste steht.
  const ziel = Object.values(ZIELE).includes(ereignis.notification.data?.ziel) ? ereignis.notification.data.ziel : ZIELE.chat;
  const pfad = new URL(ziel, self.location.origin).pathname;
  ereignis.waitUntil(
    (async () => {
      const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const eines of fenster) {
        if (ziel === ZIELE.chat && new URL(eines.url).pathname.startsWith(pfad) && 'focus' in eines) {
          return eines.focus();
        }
        // Posteingang: ein offenes Fenster dorthin führen, statt ein zweites zu öffnen.
        if (ziel !== ZIELE.chat && 'navigate' in eines) {
          await eines.navigate(ziel);
          return 'focus' in eines ? eines.focus() : undefined;
        }
      }
      return self.clients.openWindow(ziel);
    })(),
  );
});
