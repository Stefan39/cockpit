/**
 * Typen für `passkey.js`, damit die Tests das Browser-Skript typgeprüft einbinden.
 * Das Skript selbst ist reines JavaScript ohne Build-Schritt und wird unverändert
 * ausgeliefert.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export function base64urlKodieren(daten: ArrayBuffer | ArrayBufferView): string;
export function base64urlDekodieren(text: string): Uint8Array<ArrayBuffer>;

/** Die Optionen so, wie `navigator.credentials.create` sie erwartet: Bytes statt base64url. */
export type OptionenFuerBrowser = Omit<
  PublicKeyCredentialCreationOptionsJSON,
  'challenge' | 'user' | 'excludeCredentials'
> & {
  challenge: Uint8Array;
  user: Omit<PublicKeyCredentialCreationOptionsJSON['user'], 'id'> & { id: Uint8Array };
  excludeCredentials?: { id: Uint8Array; type: 'public-key'; transports?: string[] | undefined }[];
};

export function optionenAusJson(json: PublicKeyCredentialCreationOptionsJSON): OptionenFuerBrowser;

/** Das Ergebnis von `navigator.credentials.create`, soweit das Skript es liest. */
export interface Anmeldedaten {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null | undefined;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject: ArrayBuffer;
    getTransports?: () => string[];
  };
  getClientExtensionResults: () => object;
}

export function anmeldedatenZuJson(anmeldedaten: Anmeldedaten): RegistrationResponseJSON;

/** Die Optionen der Anmeldung, wie `navigator.credentials.get` sie erwartet: Bytes statt base64url. */
export type AnmeldeOptionenFuerBrowser = Omit<
  PublicKeyCredentialRequestOptionsJSON,
  'challenge' | 'allowCredentials'
> & {
  challenge: Uint8Array;
  allowCredentials?: { id: Uint8Array; type: 'public-key'; transports?: string[] | undefined }[];
};

export function anmeldeOptionenAusJson(json: PublicKeyCredentialRequestOptionsJSON): AnmeldeOptionenFuerBrowser;

/** Das Ergebnis von `navigator.credentials.get`, soweit das Skript es liest. */
export interface Assertion {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null | undefined;
  response: {
    clientDataJSON: ArrayBuffer;
    authenticatorData: ArrayBuffer;
    signature: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
  getClientExtensionResults: () => object;
}

export function assertionZuJson(anmeldedaten: Assertion): AuthenticationResponseJSON;
