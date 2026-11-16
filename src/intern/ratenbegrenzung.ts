/**
 * Der Zähler der Agenten-API (COPI-35): ein festes Zeitfenster je Schlüssel, im Arbeitsspeicher.
 *
 * **Warum nicht in der Datenbank wie bei der Anmeldung (`auth/ratenbegrenzung.ts`)?** Dort schützt der
 * Zähler ein Geheimnis: ein Passwort lässt sich raten, und eine Sperre, die ein Neustart aufhebt, wäre
 * keine. Ein Token der Agenten-API hat 256 Bit Zufall und lässt sich nicht erraten. Der Zähler schützt
 * hier nur Ressourcen — er bremst eine Flut von Anfragen, bevor sie die Datenbank belasten. Dass ein
 * Neustart ihn zurücksetzt, ist dafür harmlos, und ein Schreibzugriff je Anfrage würde den Angriff
 * verstärken statt ihn zu bremsen.
 *
 * **Reservieren, dann prüfen** (wie bei der Anmeldung): eine Anfrage wird gezählt, *bevor* sie geprüft
 * wird. Gleichzeitige Anfragen laufen sonst gemeinsam durch, bevor die erste als Fehlversuch gezählt ist.
 * Wer die Prüfung besteht, bekommt seine Reservierung zurück (`gutschreiben`); so verbraucht ein Agent,
 * der oft meldet, kein Budget.
 *
 * Die Zeit ist Parameter (Millisekunden), damit Fensterende und Sperre ohne Warten prüfbar sind.
 */

export interface Reservierung {
  readonly erlaubt: boolean;
  /** Bis das Fenster endet, aufgerundet auf ganze Sekunden — für `Retry-After`. 0, wenn erlaubt. */
  readonly wiederNachSekunden: number;
}

interface Stand {
  beginn: number;
  anzahl: number;
}

export interface ZaehlerOptionen {
  /**
   * So viele Schlüssel hält der Zähler höchstens. Ohne Grenze ließe sich der Prozess mit erfundenen
   * Adressen füllen. Ist er voll, gehen zuerst abgelaufene Schlüssel, dann die ältesten. Wer so einen
   * laufenden Zähler verdrängt, gewinnt nichts: er beginnt nur von vorn.
   */
  readonly hoechstensSchluessel?: number;
}

/** Wie oft höchstens nach abgelaufenen Schlüsseln gesucht wird, wenn der Zähler voll ist. */
const AUFRAEUMEN_ABSTAND_MS = 10_000;

export class FensterZaehler {
  private readonly staende = new Map<string, Stand>();
  private readonly hoechstens: number;
  private naechstesAufraeumen = 0;

  constructor(
    private readonly grenze: number,
    private readonly fensterMs: number,
    optionen: ZaehlerOptionen = {},
  ) {
    this.hoechstens = optionen.hoechstensSchluessel ?? 10_000;
  }

  /** Zählt eine Anfrage und sagt, ob sie innerhalb der Grenze liegt. Ein abgelaufenes Fenster beginnt von vorn. */
  reservieren(schluessel: string, jetzt: number): Reservierung {
    let stand = this.staende.get(schluessel);
    if (stand === undefined || jetzt >= stand.beginn + this.fensterMs) {
      this.staende.delete(schluessel);
      this.platzSchaffen(jetzt);
      stand = { beginn: jetzt, anzahl: 0 };
      this.staende.set(schluessel, stand);
    }
    stand.anzahl += 1;
    if (stand.anzahl <= this.grenze) {
      return { erlaubt: true, wiederNachSekunden: 0 };
    }
    const rest = stand.beginn + this.fensterMs - jetzt;
    return { erlaubt: false, wiederNachSekunden: Math.max(1, Math.ceil(rest / 1000)) };
  }

  /** Schreibt eine Reservierung wieder gut — um eins, nie unter null. */
  gutschreiben(schluessel: string): void {
    const stand = this.staende.get(schluessel);
    if (stand !== undefined) {
      stand.anzahl = Math.max(0, stand.anzahl - 1);
    }
  }

  /** Die Zahl der gehaltenen Schlüssel — für Tests. */
  groesse(): number {
    return this.staende.size;
  }

  private platzSchaffen(jetzt: number): void {
    if (this.staende.size < this.hoechstens) {
      return;
    }
    if (jetzt >= this.naechstesAufraeumen) {
      this.naechstesAufraeumen = jetzt + AUFRAEUMEN_ABSTAND_MS;
      for (const [schluessel, stand] of this.staende) {
        if (jetzt >= stand.beginn + this.fensterMs) {
          this.staende.delete(schluessel);
        }
      }
    }
    // Die Map behält die Reihenfolge des Einfügens: der erste Schlüssel ist der älteste.
    while (this.staende.size >= this.hoechstens) {
      const aeltester = this.staende.keys().next();
      if (aeltester.done) {
        return;
      }
      this.staende.delete(aeltester.value);
    }
  }
}
