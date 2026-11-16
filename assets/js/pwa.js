/**
 * Die installierbare App (COPI-58) — der Browser-Teil, auf jeder angemeldeten Seite.
 *
 * 1. Meldet den Service Worker an (`/sw.js`, Geltungsbereich `/`). Er speichert nichts; er macht das Cockpit
 *    installierbar und nimmt später Push an (COPI-59).
 * 2. Zeigt in den Einstellungen, ob Benachrichtigungen auf diesem Gerät gehen (ADR 6: „das Cockpit muss fehlenden
 *    Push-Zugang erkennen und anzeigen"). Die Texte stehen im HTML (`[data-push-zustand]`, verborgen); das Skript
 *    macht nur den passenden sichtbar. Ohne Skript bleibt der Hinweis stehen, dass es dafür JavaScript braucht.
 *
 * iPhone und iPad: Web Push erst ab iOS 16.4 und **nur** nach „Zum Home-Bildschirm" — im Safari-Tab gibt es keine
 * Push-Berechtigung. Ein iPad meldet sich als Mac; es verrät sich über den Touchscreen.
 *
 * 3. Schaltet Push für dieses Gerät an und aus (COPI-59): der öffentliche VAPID-Schlüssel steht an der Steuerung
 *    (`data-push-schluessel`); das Abo geht als JSON an `/push/abo`, das Abmelden an `/push/abmelden`.
 *
 * 4. Lädt Seiten mit `data-aktualisieren="<Sekunden>"` neu, sobald ihr Stand älter ist (COPI-105): in der installierten
 *    App gibt es keine Neuladen-Geste, man sähe sonst unbemerkt einen alten Stand. Geprüft wird alle 15 Sekunden und
 *    sofort beim Zurückkehren in die App. Nie, solange die Seite verborgen ist, das Gerät offline ist (sonst stünde eine
 *    Fehlerseite statt des alten Stands da) oder ein Formular bearbeitet wird.
 *
 * 5. Der Posteingang im Kopf (COPI-112): blendet die Filter ein (Alle, Chat, Mails, Meldungen), schließt das Panel mit
 *    Escape, einem Klick daneben oder dem Schließen-Knopf, und holt den Posteingang jede Minute neu (`GET /posteingang`,
 *    ein fertig escaptes HTML-Stück vom Server) — nur, solange er zugeklappt und die Seite sichtbar ist. Eine Seite mit
 *    offenem Posteingang lädt sich nicht von selbst neu (4.).
 *
 * 6. Push bei neuen Einträgen (COPI-116): die Zahl am App-Symbol folgt dem Badge (`data-posteingang-gesamt`), beim
 *    Laden und bei jedem Nachholen; die Adresse `/#posteingang` (Ziel des Push) klappt den Posteingang auf.
 *
 * 7. „Text kopieren" (COPI-91): Knöpfe mit `data-kopieren="<id>"` sind ohne Skript verborgen (`hidden`); gibt es die
 *    Zwischenablage, werden sie sichtbar und legen den Text des Elements mit dieser `id` hinein. Ohne Skript bleibt der
 *    Text markierbar.
 *
 * 8. Aufklappbare Bereiche der Übersicht (COPI-122): `<details data-merken="<schluessel>">` merkt sich auf/zu in diesem
 *    Browser (`localStorage`, `cockpit-bereich:<schluessel>`). Ein Bereich mit offenen Punkten trägt das Attribut nicht
 *    und bleibt immer offen. Ohne Speicher (privates Fenster, gesperrt) bleibt es beim Stand des Servers.
 *
 * `pushZugang`, `istIos`, `schluesselBytes`, `neuLadenFaellig`, `formularBeschaeftigt`, `symbolZahl` und `bereichOffen` stehen einzeln bereit, damit
 * `test/pwa-skript.test.ts` sie ohne Browser prüfen kann.
 */

/** Kürzester Takt, den das Skript annimmt: ein Tippfehler im Markup soll keine Neulade-Schleife auslösen. */
const TAKT_MINDESTENS = 15;
const PRUEFEN_ALLE_MS = 15_000;

/** Ob die Seite jetzt neu geladen werden soll. */
export function neuLadenFaellig({ jetzt, geladenUm, taktSekunden, sichtbar, online, beschaeftigt }) {
  if (!Number.isFinite(taktSekunden) || taktSekunden < TAKT_MINDESTENS) {
    return false;
  }
  return sichtbar && online && !beschaeftigt && jetzt - geladenUm >= taktSekunden * 1000;
}

const EINGABE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const KEIN_INHALT = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/** Ob jemand gerade etwas eingibt: ein Eingabefeld hat den Fokus, oder ein Feld weicht vom geladenen Wert ab. */
export function formularBeschaeftigt(dokument) {
  const aktiv = dokument.activeElement;
  if (aktiv && (EINGABE.has(aktiv.tagName) || aktiv.isContentEditable)) {
    return true;
  }
  for (const feld of dokument.querySelectorAll('input, textarea, select')) {
    if (KEIN_INHALT.has(feld.type)) {
      continue;
    }
    // Eine Auswahl hat kein `defaultValue`; geändert ist sie, wenn eine Option anders gewählt ist als geladen.
    if (feld.options) {
      if ([...feld.options].some((option) => option.selected !== option.defaultSelected)) {
        return true;
      }
      continue;
    }
    if (feld.type === 'checkbox' || feld.type === 'radio' ? feld.checked !== feld.defaultChecked : feld.value !== (feld.defaultValue ?? feld.value)) {
      return true;
    }
  }
  return false;
}

function aktualisierenEinrichten() {
  const markierung = document.querySelector('[data-aktualisieren]');
  if (!markierung) {
    return;
  }
  const taktSekunden = Number(markierung.dataset.aktualisieren);
  const geladenUm = Date.now();
  const pruefen = () => {
    if (
      neuLadenFaellig({
        jetzt: Date.now(),
        geladenUm,
        taktSekunden,
        sichtbar: document.visibilityState === 'visible',
        online: navigator.onLine !== false,
        beschaeftigt: formularBeschaeftigt(document) || document.querySelector('[data-posteingang][open]') !== null,
      })
    ) {
      window.location.reload();
    }
  };
  window.setInterval(pruefen, PRUEFEN_ALLE_MS);
  document.addEventListener('visibilitychange', pruefen);
}

/** base64url → Bytes, für `applicationServerKey`. */
export function schluesselBytes(schluessel) {
  const base64 = schluessel.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (schluessel.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (zeichen) => zeichen.charCodeAt(0));
}

/** Ein iPhone, iPod oder iPad (auch eines, das sich als Mac ausgibt). */
export function istIos(userAgent, plattform, beruehrungspunkte) {
  return /iPad|iPhone|iPod/.test(userAgent) || (plattform === 'MacIntel' && beruehrungspunkte > 1);
}

/**
 * Ob Benachrichtigungen auf diesem Gerät gehen:
 *   * `home_bildschirm` — iPhone/iPad im Browser-Tab: erst „Zum Home-Bildschirm", dann von dort öffnen.
 *   * `nicht_unterstuetzt` — der Browser kann kein Web Push (etwa iOS vor 16.4).
 *   * `abgelehnt` — die Berechtigung ist verweigert; nur in den Einstellungen des Geräts umkehrbar.
 *   * `erlaubt` — die Berechtigung ist erteilt.
 *   * `moeglich` — geht, sobald der Benutzer zustimmt.
 */
export function pushZugang(umgebung) {
  if (umgebung.ios && !umgebung.standalone) {
    return 'home_bildschirm';
  }
  if (!umgebung.serviceWorker || !umgebung.pushManager || !umgebung.notification) {
    return 'nicht_unterstuetzt';
  }
  if (umgebung.erlaubnis === 'denied') {
    return 'abgelehnt';
  }
  if (umgebung.erlaubnis === 'granted') {
    return 'erlaubt';
  }
  return 'moeglich';
}

function umgebungLesen() {
  const benachrichtigung = typeof Notification === 'function' ? Notification : undefined;
  return {
    ios: istIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0),
    standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notification: benachrichtigung !== undefined,
    erlaubnis: benachrichtigung?.permission,
  };
}

function hinweisZeigen() {
  const bereich = document.querySelector('[data-push-hinweise]');
  if (!bereich) {
    return undefined;
  }
  const zustand = pushZugang(umgebungLesen());
  for (const hinweis of bereich.querySelectorAll('[data-push-zustand]')) {
    hinweis.hidden = hinweis.dataset.pushZustand !== zustand;
  }
  return zustand;
}

async function senden(pfad, daten) {
  const antwort = await fetch(pfad, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(daten),
    credentials: 'same-origin',
  });
  if (!antwort.ok) {
    throw new Error(`Push: ${pfad} antwortete ${antwort.status}`);
  }
}

/** Die Knöpfe „einschalten"/„ausschalten" für dieses Gerät — nur, wo Push überhaupt gehen kann. */
async function steuerungEinrichten(zustand) {
  const steuerung = document.querySelector('[data-push-schluessel]');
  if (!steuerung || (zustand !== 'moeglich' && zustand !== 'erlaubt')) {
    return;
  }
  const registrierung = await navigator.serviceWorker.ready;
  const an = steuerung.querySelector('[data-push-an]');
  const aus = steuerung.querySelector('[data-push-aus]');
  const meldung = steuerung.querySelector('[data-push-meldung]');
  const zeigen = (abo) => {
    steuerung.hidden = false;
    an.hidden = Boolean(abo);
    aus.hidden = !abo;
  };
  const scheitern = () => {
    meldung.hidden = false;
  };
  zeigen(await registrierung.pushManager.getSubscription());

  an.addEventListener('click', async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        window.location.reload();
        return;
      }
      const abo = await registrierung.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: schluesselBytes(steuerung.dataset.pushSchluessel),
      });
      await senden('/push/abo', abo.toJSON());
      window.location.reload();
    } catch {
      scheitern();
    }
  });

  aus.addEventListener('click', async () => {
    try {
      const abo = await registrierung.pushManager.getSubscription();
      if (abo) {
        await senden('/push/abmelden', { endpoint: abo.endpoint });
        await abo.unsubscribe();
      }
      window.location.reload();
    } catch {
      scheitern();
    }
  });
}

/** Die Zahl für das App-Symbol aus dem Attribut des Badges, oder `undefined` bei allem, was keine Zahl ≥ 0 ist. */
export function symbolZahl(wert) {
  if (typeof wert !== 'string' || !/^[0-9]{1,6}$/.test(wert)) {
    return undefined;
  }
  return Number(wert);
}

/** Setzt die Zahl am App-Symbol nach dem Badge — nur, wo der Browser es kann; Fehler zählen nicht. */
function symbolZahlSetzen(posteingang) {
  const zahl = symbolZahl(posteingang.querySelector('[data-posteingang-gesamt]')?.dataset.posteingangGesamt);
  if (zahl === undefined || !('setAppBadge' in navigator)) {
    return;
  }
  (zahl === 0 ? navigator.clearAppBadge() : navigator.setAppBadge(zahl)).catch(() => undefined);
}

/** So oft holt der zugeklappte Posteingang seinen Stand neu. */
const POSTEINGANG_ALLE_MS = 60_000;

/** Filter und Schließen eines (neu eingesetzten) Posteingangs. */
function posteingangVerdrahten(posteingang) {
  const filter = posteingang.querySelector('[data-posteingang-filter]');
  const liste = posteingang.querySelector('[data-posteingang-liste]');
  if (filter && liste) {
    filter.hidden = false;
    for (const chip of filter.querySelectorAll('[data-filter]')) {
      chip.addEventListener('click', () => {
        for (const anderer of filter.querySelectorAll('[data-filter]')) {
          anderer.setAttribute('aria-pressed', String(anderer === chip));
        }
        if (chip.dataset.filter) {
          liste.dataset.filter = chip.dataset.filter;
        } else {
          delete liste.dataset.filter;
        }
      });
    }
  }
  for (const knopf of posteingang.querySelectorAll('[data-posteingang-schliessen]')) {
    knopf.addEventListener('click', () => {
      posteingang.open = false;
    });
  }
}

function posteingangEinrichten() {
  const erster = document.querySelector('[data-posteingang]');
  if (!erster) {
    return;
  }
  posteingangVerdrahten(erster);
  symbolZahlSetzen(erster);
  // Ziel eines Push (COPI-116): den Posteingang aufklappen, die Marke aus der Adresse nehmen.
  if (window.location.hash === '#posteingang') {
    erster.open = true;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  document.addEventListener('keydown', (ereignis) => {
    const offen = document.querySelector('[data-posteingang][open]');
    if (ereignis.key === 'Escape' && offen) {
      offen.open = false;
      offen.querySelector('summary')?.focus();
    }
  });
  document.addEventListener('click', (ereignis) => {
    const offen = document.querySelector('[data-posteingang][open]');
    if (offen && ereignis.target && !offen.contains(ereignis.target)) {
      offen.open = false;
    }
  });
  const holen = async () => {
    const aktuell = document.querySelector('[data-posteingang]');
    if (!aktuell || aktuell.open || document.visibilityState !== 'visible' || navigator.onLine === false) {
      return;
    }
    try {
      const antwort = await fetch('/posteingang', { credentials: 'same-origin', headers: { accept: 'text/html' } });
      if (!antwort.ok || aktuell.open) {
        return;
      }
      const vorlage = document.createElement('template');
      vorlage.innerHTML = (await antwort.text()).trim();
      const neu = vorlage.content.querySelector('[data-posteingang]');
      if (neu) {
        aktuell.replaceWith(neu);
        posteingangVerdrahten(neu);
        symbolZahlSetzen(neu);
      }
    } catch {
      // Beim nächsten Takt wieder.
    }
  };
  window.setInterval(holen, POSTEINGANG_ALLE_MS);
  document.addEventListener('visibilitychange', holen);
}

/** „Text kopieren" (7.): Knöpfe zeigen und verdrahten. */
function kopierenEinrichten() {
  if (!navigator.clipboard) {
    return;
  }
  for (const knopf of document.querySelectorAll('[data-kopieren]')) {
    knopf.hidden = false;
    knopf.addEventListener('click', async () => {
      const quelle = document.getElementById(knopf.dataset.kopieren ?? '');
      const beschriftung = knopf.querySelector('[data-kopieren-text]');
      if (!quelle) {
        return;
      }
      try {
        await navigator.clipboard.writeText(quelle.textContent ?? '');
        if (beschriftung) {
          beschriftung.textContent = 'Kopiert';
        }
      } catch {
        if (beschriftung) {
          beschriftung.textContent = 'Bitte markieren und kopieren';
        }
      }
    });
  }
}

/** Ob ein Bereich offen ist (8.): der gemerkte Stand, sonst der des Servers. */
export function bereichOffen(gemerkt, standard) {
  return gemerkt === 'auf' ? true : gemerkt === 'zu' ? false : standard;
}

/** Aufklappbare Bereiche (8.): gemerkten Stand anwenden und jedes Auf- und Zuklappen merken. */
function bereicheEinrichten() {
  for (const bereich of document.querySelectorAll('details[data-merken]')) {
    const schluessel = `cockpit-bereich:${bereich.dataset.merken ?? ''}`;
    try {
      bereich.open = bereichOffen(window.localStorage.getItem(schluessel), bereich.open);
    } catch {
      // Ohne Speicher bleibt der Stand des Servers.
    }
    bereich.addEventListener('toggle', () => {
      try {
        window.localStorage.setItem(schluessel, bereich.open ? 'auf' : 'zu');
      } catch {
        // Ohne Speicher wird nichts gemerkt.
      }
    });
  }
}

if (typeof document !== 'undefined') {
  bereicheEinrichten();
  posteingangEinrichten();
  kopierenEinrichten();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }
  aktualisierenEinrichten();
  const zustand = hinweisZeigen();
  if (zustand && 'serviceWorker' in navigator) {
    steuerungEinrichten(zustand).catch(() => undefined);
  }
}
