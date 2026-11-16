/**
 * Passkey einrichten (COPI-26) und anmelden (COPI-27) — der Browser-Teil.
 *
 * Bewusst klein und ohne Bibliothek: übersetzt die Optionen des Servers (JSON, mit
 * base64url) in das, was `navigator.credentials.create` erwartet (Bytes), und das
 * Ergebnis zurück in JSON. Die eigentliche Prüfung geschieht auf dem Server; hier
 * steht nichts, dem er vertrauen müsste.
 *
 * Ablauf beim Einrichten: Formular `[data-passkey]` (zunächst verborgen) → Passwort an
 * `/optionen` → Gerät fragen (`create`) → Ergebnis in das versteckte Feld `antwort`
 * schreiben und das Formular an `/pruefen` abschicken. Der Server rendert daraufhin die
 * Seite mit den Ersatzcodes, es gibt keine Anzeige aus JavaScript.
 *
 * Beim Anmelden: Formular `[data-passkey-anmelden]` auf der Codeseite → Optionen holen →
 * Gerät fragen (`get`) → Ergebnis in `antwort`, Formular abschicken. Der Server legt die
 * Sitzung an, oder zeigt die Codeseite mit der neutralen Meldung.
 *
 * Auf `/sicherheit` (COPI-94) dieselben beiden Formulare: einen weiteren Passkey anlegen
 * (`data-passkey`, ohne Passwortfeld) und mit einem vorhandenen bestätigen
 * (`data-passkey-anmelden`).
 *
 * Ohne JavaScript oder ohne WebAuthn bleiben die Formulare verborgen; TOTP und
 * Ersatzcode sind weiter erreichbar.
 *
 * Die Kodierfunktionen stehen einzeln und ohne DOM-Zugriff bereit, damit
 * `test/passkey.test.ts` sie in Node prüfen kann.
 */

/** Bytes → base64url, ohne Auffüllung. */
export function base64urlKodieren(daten) {
  const bytes = ArrayBuffer.isView(daten)
    ? new Uint8Array(daten.buffer, daten.byteOffset, daten.byteLength)
    : new Uint8Array(daten);
  let binaer = '';
  for (const byte of bytes) {
    binaer += String.fromCharCode(byte);
  }
  return btoa(binaer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (mit oder ohne Auffüllung) → Bytes. */
export function base64urlDekodieren(text) {
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const binaer = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binaer.length);
  for (let stelle = 0; stelle < binaer.length; stelle += 1) {
    bytes[stelle] = binaer.charCodeAt(stelle);
  }
  return bytes;
}

/** Optionen des Servers (JSON) → Argument für `navigator.credentials.create`. */
export function optionenAusJson(json) {
  const optionen = {
    ...json,
    challenge: base64urlDekodieren(json.challenge),
    user: { ...json.user, id: base64urlDekodieren(json.user.id) },
  };
  if (json.excludeCredentials !== undefined) {
    optionen.excludeCredentials = json.excludeCredentials.map((eintrag) => ({
      ...eintrag,
      id: base64urlDekodieren(eintrag.id),
    }));
  }
  return optionen;
}

/** Der Rahmen jedes Ergebnisses von `navigator.credentials.create/get`: gleich, nur die Antwort darin nicht. */
function anmeldedatenZuJsonMit(anmeldedaten, antwortJson) {
  const json = {
    id: anmeldedaten.id,
    rawId: base64urlKodieren(anmeldedaten.rawId),
    type: anmeldedaten.type,
    clientExtensionResults: anmeldedaten.getClientExtensionResults(),
    response: antwortJson,
  };
  if (anmeldedaten.authenticatorAttachment) {
    json.authenticatorAttachment = anmeldedaten.authenticatorAttachment;
  }
  return json;
}

/** Ergebnis von `navigator.credentials.create` → JSON für den Server. */
export function anmeldedatenZuJson(anmeldedaten) {
  const antwort = anmeldedaten.response;
  return anmeldedatenZuJsonMit(anmeldedaten, {
    clientDataJSON: base64urlKodieren(antwort.clientDataJSON),
    attestationObject: base64urlKodieren(antwort.attestationObject),
    transports: typeof antwort.getTransports === 'function' ? antwort.getTransports() : [],
  });
}

/** Optionen der Anmeldung (JSON) → Argument für `navigator.credentials.get`. */
export function anmeldeOptionenAusJson(json) {
  const optionen = { ...json, challenge: base64urlDekodieren(json.challenge) };
  if (json.allowCredentials !== undefined) {
    optionen.allowCredentials = json.allowCredentials.map((eintrag) => ({
      ...eintrag,
      id: base64urlDekodieren(eintrag.id),
    }));
  }
  return optionen;
}

/** Ergebnis von `navigator.credentials.get` → JSON für den Server. */
export function assertionZuJson(anmeldedaten) {
  const antwort = anmeldedaten.response;
  const antwortJson = {
    clientDataJSON: base64urlKodieren(antwort.clientDataJSON),
    authenticatorData: base64urlKodieren(antwort.authenticatorData),
    signature: base64urlKodieren(antwort.signature),
  };
  if (antwort.userHandle) {
    antwortJson.userHandle = base64urlKodieren(antwort.userHandle);
  }
  return anmeldedatenZuJsonMit(anmeldedaten, antwortJson);
}

const MELDUNG_ABBRUCH = 'Der Vorgang wurde abgebrochen oder ist abgelaufen. Bitte erneut versuchen.';
const MELDUNG_SCHON_DA = 'Dieses Gerät ist für das Konto schon eingerichtet.';
const MELDUNG_GERAET =
  'Dieses Gerät kann den Passkey nicht anlegen. Bitte die Authenticator-App verwenden.';
const MELDUNG_EINRICHTEN =
  'Der Passkey konnte nicht eingerichtet werden. Bitte erneut versuchen oder die Authenticator-App verwenden.';
const MELDUNG_ANMELDEN =
  'Die Anmeldung mit dem Passkey ist nicht gelungen. Bitte erneut versuchen oder einen Code verwenden.';

/** Eine Meldung, die der Server oder das Skript selbst formuliert hat und die so angezeigt wird. */
class Anzeige extends Error {}

function meldungFuer(fehler, allgemein) {
  if (fehler instanceof Anzeige) {
    return fehler.message;
  }
  switch (fehler?.name) {
    case 'NotAllowedError':
      return MELDUNG_ABBRUCH;
    case 'InvalidStateError':
      return MELDUNG_SCHON_DA;
    case 'NotSupportedError':
    case 'SecurityError':
      return MELDUNG_GERAET;
    default:
      return allgemein;
  }
}

async function optionenHolen(formular, koerper, allgemein) {
  const antwort = await fetch(formular.dataset.optionenUrl, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(koerper),
  });
  if (antwort.redirected) {
    // Die Sitzung oder der Anmeldevorgang ist abgelaufen: das Cockpit hat umgeleitet.
    window.location.assign(antwort.url);
    return undefined;
  }
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) {
    throw new Anzeige(typeof daten.fehler === 'string' ? daten.fehler : allgemein);
  }
  return daten;
}

async function einrichten(formular) {
  // Die erste Einrichtung verlangt das Passwort; ein weiterer Passkey auf `/sicherheit` (COPI-94) nicht, dort gilt
  // die frische Bestätigung durch einen vorhandenen Faktor.
  const passwort = formular.elements.passwort;
  const optionen = await optionenHolen(
    formular,
    passwort === undefined ? {} : { passwort: passwort.value },
    MELDUNG_EINRICHTEN,
  );
  if (optionen === undefined) {
    return;
  }
  const anmeldedaten = await navigator.credentials.create({ publicKey: optionenAusJson(optionen) });
  if (anmeldedaten === null) {
    throw new Anzeige(MELDUNG_ABBRUCH);
  }
  formular.elements.antwort.value = JSON.stringify(anmeldedatenZuJson(anmeldedaten));
  // Das Passwort wurde geprüft und wird kein zweites Mal gesendet.
  if (passwort !== undefined) {
    passwort.disabled = true;
  }
  // `submit()` löst kein `submit`-Ereignis aus: keine Schleife.
  formular.submit();
}

async function anmelden(formular) {
  const optionen = await optionenHolen(formular, {}, MELDUNG_ANMELDEN);
  if (optionen === undefined) {
    return;
  }
  const anmeldedaten = await navigator.credentials.get({ publicKey: anmeldeOptionenAusJson(optionen) });
  if (anmeldedaten === null) {
    throw new Anzeige(MELDUNG_ABBRUCH);
  }
  formular.elements.antwort.value = JSON.stringify(assertionZuJson(anmeldedaten));
  formular.submit();
}

/** Zeigt das Formular und führt bei `submit` den Ablauf aus; Fehler erscheinen im Formular. */
function formularBedienen(formular, ablauf, allgemein) {
  const meldung = formular.querySelector('[data-passkey-meldung]');
  const knopf = formular.querySelector('button[type="submit"]');
  formular.hidden = false;
  // Der Satz für Browser ohne Skript oder ohne WebAuthn (COPI-94) hat sich damit erledigt.
  for (const satz of document.querySelectorAll('[data-passkey-ohne-skript]')) {
    satz.hidden = true;
  }
  formular.addEventListener('submit', async (ereignis) => {
    ereignis.preventDefault();
    meldung.hidden = true;
    knopf.disabled = true;
    try {
      await ablauf(formular);
    } catch (fehler) {
      meldung.textContent = meldungFuer(fehler, allgemein);
      meldung.hidden = false;
      knopf.disabled = false;
    }
  });
}

function starten() {
  if (!window.PublicKeyCredential) {
    return;
  }
  const einrichtung = document.querySelector('form[data-passkey]');
  if (einrichtung !== null) {
    formularBedienen(einrichtung, einrichten, MELDUNG_EINRICHTEN);
  }
  const anmeldung = document.querySelector('form[data-passkey-anmelden]');
  if (anmeldung !== null) {
    formularBedienen(anmeldung, anmelden, MELDUNG_ANMELDEN);
  }
}

if (typeof document !== 'undefined') {
  starten();
}
