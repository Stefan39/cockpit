/**
 * Ein Software-Authenticator für Tests (COPI-26): Registrierung und Assertion mit
 * einem eigenen ES256-Schlüsselpaar, ohne Browser und ohne Gerät.
 *
 * Er baut die Bytes, die ein Browser aus einem echten Authenticator zurückgibt —
 * `clientDataJSON`, `authenticatorData` (mit Flags, Zähler und beglaubigten
 * Schlüsseldaten), das Attestationsobjekt mit Format `none` und die Signatur —
 * und kodiert sie wie `PublicKeyCredential.toJSON()` (base64url). Was daraus wird,
 * prüft die echte Bibliothek; der Helfer selbst wird in `test/passkey.test.ts`
 * gegen sie gemessen, damit ein Negativtest aus dem richtigen Grund rot wird.
 *
 * `Abweichung` lässt gezielt genau einen Fehler zu: falsche Challenge, falsche
 * Herkunft, falsche rpID oder eine Antwort ohne Benutzerprüfung.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/** Flags in `authenticatorData` (WebAuthn §6.1). */
const FLAG_ANWESENHEIT = 0x01;
const FLAG_BENUTZERPRUEFUNG = 0x04;
const FLAG_SCHLUESSELDATEN = 0x40;

/** COSE-Kennungen für ES256 (ECDSA, P-256, SHA-256). */
const COSE_ES256 = -7;

export interface Abweichung {
  /** Statt der Challenge aus den Optionen. */
  readonly challenge?: string;
  /** Statt der Herkunft, die der Browser eintrüge. */
  readonly origin?: string;
  /** Die rpID, deren Hash in `authenticatorData` steht, statt der aus den Optionen. */
  readonly rpId?: string;
  /** `false`: das Flag „Benutzer geprüft" bleibt aus (kein PIN, keine Biometrie). */
  readonly benutzerPruefung?: boolean;
  /** Nur bei `signieren`: dieser Zähler statt der fortlaufenden Zählung (Klon, Zurücksetzen). */
  readonly zaehler?: number;
}

type CborWert = number | string | Buffer | Map<number | string, CborWert>;

function cborKopf(hauptTyp: number, wert: number): Buffer {
  if (wert < 24) {
    return Buffer.from([(hauptTyp << 5) | wert]);
  }
  if (wert < 256) {
    return Buffer.from([(hauptTyp << 5) | 24, wert]);
  }
  return Buffer.from([(hauptTyp << 5) | 25, wert >> 8, wert & 0xff]);
}

/** Genug CBOR für Attestationsobjekt und COSE-Schlüssel: Zahlen, Texte, Bytes, Maps. */
function cbor(wert: CborWert): Buffer {
  if (typeof wert === 'number') {
    return wert >= 0 ? cborKopf(0, wert) : cborKopf(1, -1 - wert);
  }
  if (typeof wert === 'string') {
    const text = Buffer.from(wert, 'utf8');
    return Buffer.concat([cborKopf(3, text.length), text]);
  }
  if (Buffer.isBuffer(wert)) {
    return Buffer.concat([cborKopf(2, wert.length), wert]);
  }
  const teile: Buffer[] = [cborKopf(5, wert.size)];
  for (const [schluessel, eintrag] of wert) {
    teile.push(cbor(schluessel), cbor(eintrag));
  }
  return Buffer.concat(teile);
}

function base64url(daten: Buffer | string): string {
  return Buffer.from(daten).toString('base64url');
}

function sha256(daten: Buffer | string): Buffer {
  return createHash('sha256').update(daten).digest();
}

function zaehlerBytes(zaehler: number): Buffer {
  const puffer = Buffer.alloc(4);
  puffer.writeUInt32BE(zaehler);
  return puffer;
}

export class SoftwareAuthenticator {
  /** Kennung des Passkeys, base64url — wie `credential.id` im Browser. */
  readonly kennung: string;
  private readonly kennungBytes: Buffer;
  private readonly privat: KeyObject;
  private readonly oeffentlich: KeyObject;
  private zaehler = 0;

  /**
   * Ein neues Gerät mit eigenem Schlüsselpaar. Mit `kennungBytes` trägt es die Kennung
   * eines anderen Passkeys, aber seinen eigenen Schlüssel: so entsteht eine Signatur, die
   * zur Kennung passt und zum gespeicherten Schlüssel nicht.
   */
  constructor(kennungBytes?: Buffer) {
    const paar = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privat = paar.privateKey;
    this.oeffentlich = paar.publicKey;
    this.kennungBytes = kennungBytes ?? randomBytes(32);
    this.kennung = base64url(this.kennungBytes);
  }

  /** Die Kennung als Bytes, für ein zweites Gerät mit derselben Kennung. */
  get kennungAlsBytes(): Buffer {
    return Buffer.from(this.kennungBytes);
  }

  /** Der öffentliche Schlüssel im COSE-Format, wie ihn die Bibliothek speichert. */
  get oeffentlicherSchluesselCose(): Buffer {
    return this.coseSchluessel();
  }

  private coseSchluessel(): Buffer {
    const jwk = this.oeffentlich.export({ format: 'jwk' });
    return cbor(
      new Map<number | string, CborWert>([
        [1, 2], // Schlüsseltyp: EC2
        [3, COSE_ES256],
        [-1, 1], // Kurve: P-256
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
        [-3, Buffer.from(jwk.y ?? '', 'base64url')],
      ]),
    );
  }

  private flags(mitSchluesseldaten: boolean, abweichung: Abweichung): number {
    let flags = FLAG_ANWESENHEIT;
    if (abweichung.benutzerPruefung !== false) {
      flags |= FLAG_BENUTZERPRUEFUNG;
    }
    if (mitSchluesseldaten) {
      flags |= FLAG_SCHLUESSELDATEN;
    }
    return flags;
  }

  private clientDaten(typ: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type: typ, challenge, origin, crossOrigin: false }));
  }

  /** Antwort auf `navigator.credentials.create(...)`, Attestation `none`. */
  registrieren(
    optionen: PublicKeyCredentialCreationOptionsJSON,
    origin: string,
    abweichung: Abweichung = {},
  ): RegistrationResponseJSON {
    const rpId = abweichung.rpId ?? optionen.rp.id ?? '';
    const beglaubigt = Buffer.concat([
      Buffer.alloc(16), // AAGUID: bei Attestation `none` leer
      Buffer.from([this.kennungBytes.length >> 8, this.kennungBytes.length & 0xff]),
      this.kennungBytes,
      this.coseSchluessel(),
    ]);
    const authenticatorDaten = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(true, abweichung)]),
      zaehlerBytes(this.zaehler),
      beglaubigt,
    ]);
    const attestation = cbor(
      new Map<number | string, CborWert>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authenticatorDaten],
      ]),
    );
    const clientDaten = this.clientDaten(
      'webauthn.create',
      abweichung.challenge ?? optionen.challenge,
      abweichung.origin ?? origin,
    );
    return {
      id: this.kennung,
      rawId: this.kennung,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDaten),
        attestationObject: base64url(attestation),
        authenticatorData: base64url(authenticatorDaten),
        transports: ['internal'],
        publicKeyAlgorithm: COSE_ES256,
        publicKey: base64url(this.oeffentlich.export({ format: 'der', type: 'spki' })),
      },
    };
  }

  /** Antwort auf `navigator.credentials.get(...)`: signiert Daten und Client-Hash. */
  signieren(
    optionen: PublicKeyCredentialRequestOptionsJSON,
    origin: string,
    abweichung: Abweichung = {},
  ): AuthenticationResponseJSON {
    this.zaehler += 1;
    const rpId = abweichung.rpId ?? optionen.rpId ?? '';
    const authenticatorDaten = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(false, abweichung)]),
      zaehlerBytes(abweichung.zaehler ?? this.zaehler),
    ]);
    const clientDaten = this.clientDaten(
      'webauthn.get',
      abweichung.challenge ?? optionen.challenge,
      abweichung.origin ?? origin,
    );
    const signatur = sign('sha256', Buffer.concat([authenticatorDaten, sha256(clientDaten)]), this.privat);
    return {
      id: this.kennung,
      rawId: this.kennung,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDaten),
        authenticatorData: base64url(authenticatorDaten),
        signature: base64url(signatur),
      },
    };
  }
}
