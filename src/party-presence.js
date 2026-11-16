/**
 * Keep a room's participant roles locally. Owlbear's party.onChange reports
 * subsequent changes, so camera messages never need a getPlayers() roundtrip.
 */
export class PartyPresence {
  constructor(party, onError = console.warn,
    schedule = (callback, ms) => globalThis.setTimeout(callback, ms)) {
    this.party = party;
    this.onError = onError;
    this.schedule = schedule;
    this.players = [];
    this.initialized = false;
    this.started = null;
    this.retriesScheduled = 0;
  }

  start() {
    if (this.started) return this.started;
    this.party.onChange((players) => {
      this.players = Array.isArray(players) ? players : [];
      this.initialized = true;
    });
    // Subscribe first: an arriving player must not be lost while the initial
    // snapshot is in flight. Only one initial SDK read per background iframe.
    this.started = this.readOnce();
    return this.started;
  }

  readOnce() {
    return this.party.getPlayers()
      .then((players) => {
        if (!this.initialized) {
          this.players = Array.isArray(players) ? players : [];
          this.initialized = true;
        }
      })
      .catch((error) => {
        this.onError(error);
        // A busy Owlbear room may reject even the first read. Retry only a
        // few times with long gaps, never on camera ticks or button presses.
        if (this.initialized || this.retriesScheduled >= 3) return;
        const seconds = [5, 15, 30][this.retriesScheduled++];
        this.schedule(() => {
          if (!this.initialized) void this.readOnce();
        }, seconds * 1000);
      });
  }

  count(role) {
    return this.players.filter((player) => player.role === role).length;
  }

  isRole(connectionId, role) {
    return this.players.some((player) =>
      player.connectionId === connectionId && player.role === role);
  }
}
