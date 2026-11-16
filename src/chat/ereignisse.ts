/**
 * Der Verteiler neuer Nachrichten im Prozess (COPI-55): Wer eine Nachricht speichert — die Chat-Seite, die Meldung
 * des Cockpits, die Antwort des Koordinators über die Agenten-API —, meldet sie hier. Server-Sent Events (COPI-56) und
 * Web Push (COPI-59) hängen sich an. Ein Prozess, ein Verteiler (ADR 2): kein Redis, kein LISTEN/NOTIFY.
 *
 * Ein Abonnent, der wirft, hält weder den Speichernden noch die anderen Abonnenten auf: der Fehler geht an `fehler`.
 * Ob ein Abonnent eine Nachricht sehen darf (welcher Kanal, welcher Benutzer), entscheidet er selbst.
 */
import type { Nachricht } from './nachricht-speicher.js';

export type NachrichtAbonnent = (nachricht: Nachricht) => void;

export class ChatEreignisse {
  private readonly abonnenten = new Set<NachrichtAbonnent>();

  constructor(private readonly fehler: (grund: unknown) => void = () => undefined) {}

  /** Meldet eine eben gespeicherte Nachricht an jeden Abonnenten. */
  melden(nachricht: Nachricht): void {
    for (const abonnent of this.abonnenten) {
      try {
        abonnent(nachricht);
      } catch (grund) {
        this.fehler(grund);
      }
    }
  }

  /** Abonniert neue Nachrichten; liefert die Abmeldung. */
  abonnieren(abonnent: NachrichtAbonnent): () => void {
    this.abonnenten.add(abonnent);
    return () => {
      this.abonnenten.delete(abonnent);
    };
  }

  /** Wie viele gerade abonniert sind (für Tests und das Aufräumen der Streams). */
  get anzahl(): number {
    return this.abonnenten.size;
  }
}
