/**
 * Passkey (COPI-26) — die reinen Teile, ohne Datenbank:
 *
 *   * der Software-Authenticator gegen die echte Bibliothek (er ist Werkzeug der
 *     übrigen Tests; sein Fehler dürfte keinen Negativtest aus dem falschen Grund
 *     rot machen),
 *   * rpID und Herkunft aus der festen Basis-URL (ADR 13.3),
 *   * die Kodierung im Browser-Skript.
 *
 * Erwartete Werte stehen als Literale: der Test rechnet nicht mit, wenn der
 * Produktivcode sie aus der Basis-URL anders ableitet.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/server';
import { describe, expect, it } from 'vitest';
import {
  anmeldeOptionenAusJson,
  anmeldedatenZuJson,
  assertionZuJson,
  base64urlDekodieren,
  base64urlKodieren,
  optionenAusJson,
} from '../assets/js/passkey.js';
import { passkeyKonfiguration, passkeyNameBereinigen } from '../src/auth/passkey.js';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

const ORIGIN = 'https://cockpit.kunde.example';
const RP_ID = 'cockpit.kunde.example';

async function optionen() {
  return generateRegistrationOptions({
    rpName: 'Cockpit',
    rpID: RP_ID,
    userName: 'person@example.org',
    authenticatorSelection: { userVerification: 'required' },
  });
}

function pruefen(
  antwort: Parameters<typeof verifyRegistrationResponse>[0]['response'],
  challenge: string,
) {
  return verifyRegistrationResponse({
    response: antwort,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
}

describe('SoftwareAuthenticator — gemessen an der echten Bibliothek', () => {
  it('besteht die Registrierung: Kennung, Zähler 0 und Schlüssel kommen an', async () => {
    const geraet = new SoftwareAuthenticator();
    const aufgabe = await optionen();

    const ergebnis = await pruefen(geraet.registrieren(aufgabe, ORIGIN), aufgabe.challenge);

    expect(ergebnis.verified).toBe(true);
    expect(ergebnis.registrationInfo?.credential.id).toBe(geraet.kennung);
    expect(ergebnis.registrationInfo?.credential.counter).toBe(0);
    expect(ergebnis.registrationInfo?.userVerified).toBe(true);
  });

  it('besteht die Anmeldung mit dem Schlüssel aus der Registrierung, der Zähler steigt', async () => {
    const geraet = new SoftwareAuthenticator();
    const aufgabe = await optionen();
    const registriert = await pruefen(geraet.registrieren(aufgabe, ORIGIN), aufgabe.challenge);
    const credential = registriert.registrationInfo?.credential;
    expect(credential).toBeDefined();
    const anmeldung = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });

    const ergebnis = await verifyAuthenticationResponse({
      response: geraet.signieren(anmeldung, ORIGIN),
      expectedChallenge: anmeldung.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: credential as NonNullable<typeof credential>,
    });

    expect(ergebnis.verified).toBe(true);
    expect(ergebnis.authenticationInfo.newCounter).toBe(1);
  });

  it.each([
    ['eine falsche Challenge', { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' }],
    ['eine falsche Herkunft', { origin: 'https://boese.example' }],
    ['eine falsche rpID', { rpId: 'boese.example' }],
    ['fehlende Benutzerprüfung', { benutzerPruefung: false }],
  ])('wird bei %s von der Bibliothek abgewiesen', async (_beschreibung, abweichung) => {
    const geraet = new SoftwareAuthenticator();
    const aufgabe = await optionen();

    await expect(
      pruefen(geraet.registrieren(aufgabe, ORIGIN, abweichung), aufgabe.challenge),
    ).rejects.toThrow();
  });

  it('gibt jedem Gerät ein eigenes Schlüsselpaar und eine eigene Kennung', () => {
    expect(new SoftwareAuthenticator().kennung).not.toBe(new SoftwareAuthenticator().kennung);
  });
});

describe('passkeyKonfiguration — rpID und Herkunft aus der festen Basis-URL', () => {
  it.each([
    ['http://localhost:3000', 'localhost', 'http://localhost:3000'],
    ['https://cockpit.kunde.example', 'cockpit.kunde.example', 'https://cockpit.kunde.example'],
    // Die rpID ist die Domain: ohne Port, ohne Pfad. Die Herkunft trägt den Port.
    ['https://cockpit.kunde.example:8443', 'cockpit.kunde.example', 'https://cockpit.kunde.example:8443'],
    ['https://cockpit.kunde.example/pfad/?x=1', 'cockpit.kunde.example', 'https://cockpit.kunde.example'],
    ['https://kunde.example.com', 'kunde.example.com', 'https://kunde.example.com'],
  ])('liest aus %s die rpID %s und die Herkunft %s', (basisUrl, rpId, origin) => {
    expect(passkeyKonfiguration(basisUrl)).toMatchObject({ rpId, origin });
  });

  it('nennt die Anwendung "Cockpit" in der Anzeige des Geräts', () => {
    expect(passkeyKonfiguration('https://cockpit.kunde.example').rpName).toBe('Cockpit');
  });

  it.each([
    ['keine URL', 'keine-url'],
    ['eine IP-Adresse (die rpID muss eine Domain sein)', 'https://203.0.113.7'],
    ['eine IPv6-Adresse', 'https://[2001:db8::1]'],
    ['http auf einer fremden Domain (kein sicherer Kontext, der Browser lehnt WebAuthn ab)', 'http://cockpit.kunde.example'],
    ['ein anderes Schema', 'ftp://cockpit.kunde.example'],
  ])('weist %s ab', (_beschreibung, basisUrl) => {
    expect(() => passkeyKonfiguration(basisUrl)).toThrow(/Passkey/);
  });
});

describe('Browser-Skript — Kodierung', () => {
  it('kodiert base64url ohne Auffüllung und mit - und _ statt + und /', () => {
    // 0xfb 0xff 0xfe ergibt im Standard-Base64 "+//+".
    expect(base64urlKodieren(Uint8Array.from([0xfb, 0xff, 0xfe]))).toBe('-__-');
  });

  it('dekodiert das wieder zu denselben Bytes, mit und ohne Auffüllung', () => {
    expect([...base64urlDekodieren('-__-')]).toEqual([0xfb, 0xff, 0xfe]);
    expect([...base64urlDekodieren('AQI')]).toEqual([1, 2]);
    expect([...base64urlDekodieren('AQI=')]).toEqual([1, 2]);
  });

  it('nimmt ein ArrayBuffer wie ein Uint8Array', () => {
    expect(base64urlKodieren(Uint8Array.from([1, 2]).buffer)).toBe('AQI');
  });

  it('wandelt Challenge, Konto-ID und ausgeschlossene Kennungen in Bytes, der Rest bleibt', async () => {
    const aufgabe = await generateRegistrationOptions({
      rpName: 'Cockpit',
      rpID: RP_ID,
      userName: 'person@example.org',
      excludeCredentials: [{ id: 'AQI', transports: ['internal'] }],
      authenticatorSelection: { userVerification: 'required' },
    });

    const fuerBrowser = optionenAusJson(aufgabe);

    expect(base64urlKodieren(fuerBrowser.challenge)).toBe(aufgabe.challenge);
    expect(base64urlKodieren(fuerBrowser.user.id)).toBe(aufgabe.user.id);
    expect(fuerBrowser.excludeCredentials?.map((eintrag) => [...new Uint8Array(eintrag.id)])).toEqual([[1, 2]]);
    expect(fuerBrowser.excludeCredentials?.[0]?.transports).toEqual(['internal']);
    expect(fuerBrowser.rp).toEqual(aufgabe.rp);
    expect(fuerBrowser.authenticatorSelection?.userVerification).toBe('required');
    expect(fuerBrowser.pubKeyCredParams).toEqual(aufgabe.pubKeyCredParams);
  });

  it('kommt ohne excludeCredentials aus', async () => {
    const ohne: PublicKeyCredentialCreationOptionsJSON = { ...(await optionen()) };
    delete ohne.excludeCredentials;

    expect(optionenAusJson(ohne).excludeCredentials).toBeUndefined();
  });

  it('gibt das Ergebnis so zurück, dass die Bibliothek es prüft (Hin- und Rückweg)', async () => {
    const geraet = new SoftwareAuthenticator();
    const aufgabe = await optionen();
    const original = geraet.registrieren(aufgabe, ORIGIN);
    // So sieht das Ergebnis von `navigator.credentials.create` im Browser aus.
    const anmeldedaten = {
      id: original.id,
      rawId: base64urlDekodieren(original.rawId).buffer,
      type: original.type,
      authenticatorAttachment: original.authenticatorAttachment,
      response: {
        clientDataJSON: base64urlDekodieren(original.response.clientDataJSON).buffer,
        attestationObject: base64urlDekodieren(original.response.attestationObject).buffer,
        getTransports: () => original.response.transports ?? [],
      },
      getClientExtensionResults: () => ({}),
    };

    const json = anmeldedatenZuJson(anmeldedaten);

    expect(json).toMatchObject({
      id: original.id,
      rawId: original.rawId,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: original.response.clientDataJSON,
        attestationObject: original.response.attestationObject,
        transports: ['internal'],
      },
    });
    const ergebnis = await pruefen(json as never, aufgabe.challenge);
    expect(ergebnis.verified).toBe(true);
  });

  it('wandelt die Optionen der Anmeldung: Challenge und erlaubte Kennungen als Bytes, der Rest bleibt', async () => {
    const aufgabe = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: [{ id: 'AQI', transports: ['internal'] }],
      userVerification: 'required',
    });

    const fuerBrowser = anmeldeOptionenAusJson(aufgabe);

    expect(base64urlKodieren(fuerBrowser.challenge)).toBe(aufgabe.challenge);
    expect(fuerBrowser.allowCredentials?.map((eintrag) => [...new Uint8Array(eintrag.id)])).toEqual([[1, 2]]);
    expect(fuerBrowser.allowCredentials?.[0]?.transports).toEqual(['internal']);
    expect(fuerBrowser.rpId).toBe(RP_ID);
    expect(fuerBrowser.userVerification).toBe('required');
  });

  it('gibt das Ergebnis der Anmeldung so zurück, dass die Bibliothek es prüft (Hin- und Rückweg)', async () => {
    const geraet = new SoftwareAuthenticator();
    const aufgabe = await optionen();
    const registriert = await pruefen(geraet.registrieren(aufgabe, ORIGIN), aufgabe.challenge);
    const credential = registriert.registrationInfo?.credential;
    const anmeldung = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });
    const original = geraet.signieren(anmeldung, ORIGIN);
    // So sieht das Ergebnis von `navigator.credentials.get` im Browser aus.
    const anmeldedaten = {
      id: original.id,
      rawId: base64urlDekodieren(original.rawId).buffer,
      type: original.type,
      authenticatorAttachment: original.authenticatorAttachment,
      response: {
        clientDataJSON: base64urlDekodieren(original.response.clientDataJSON).buffer,
        authenticatorData: base64urlDekodieren(original.response.authenticatorData).buffer,
        signature: base64urlDekodieren(original.response.signature).buffer,
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    };

    const json = assertionZuJson(anmeldedaten);

    expect(json).toMatchObject({
      id: original.id,
      rawId: original.rawId,
      type: 'public-key',
      response: {
        clientDataJSON: original.response.clientDataJSON,
        authenticatorData: original.response.authenticatorData,
        signature: original.response.signature,
      },
    });
    const ergebnis = await verifyAuthenticationResponse({
      response: json,
      expectedChallenge: anmeldung.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: credential as NonNullable<typeof credential>,
    });
    expect(ergebnis.verified).toBe(true);
  });
});

describe('passkeyNameBereinigen', () => {
  it('trimmt Leerraum an beiden Enden', () => {
    expect(passkeyNameBereinigen('  iPhone  ')).toBe('iPhone');
  });

  it('entfernt Steuerzeichen mitten im Namen', () => {
    expect(passkeyNameBereinigen('i\u0000Ph\none\t 15\u007f')).toBe('iPhone 15');
  });

  it.each([
    ['leerer String', ''],
    ['nur Leerzeichen', '   '],
    ['nur Steuerzeichen', '\u0000\n\t\u007f'],
  ])('fällt bei %s auf „Passkey“ zurück', (_beschreibung, eingabe) => {
    expect(passkeyNameBereinigen(eingabe)).toBe('Passkey');
  });

  it('kürzt auf höchstens 60 Zeichen', () => {
    expect(passkeyNameBereinigen('a'.repeat(61))).toBe('a'.repeat(60));
    expect(passkeyNameBereinigen('a'.repeat(60))).toBe('a'.repeat(60));
  });

  it('trimmt erneut, wenn der Name nach dem Kürzen auf Leerzeichen endet', () => {
    expect(passkeyNameBereinigen(`${'a'.repeat(58)}   b`)).toBe('a'.repeat(58));
  });

  it('lässt Umlaute und Emoji unverändert', () => {
    expect(passkeyNameBereinigen('Büro-Tablet 📱')).toBe('Büro-Tablet 📱');
  });
});
