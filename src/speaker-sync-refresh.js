/**
 * Restart Owlbear's native Sync View after a shared portrait scene update.
 * The user-established workaround is toggling Sync View off/on. A canvas click
 * can also trigger a fresh sync while enabled; setSyncView is the documented
 * supported API we can invoke deliberately.
 *
 * When permanent Sync View is off, make a one-shot on/off pulse so the Cast
 * can still see the full portrait, then restore the prior off state. The
 * user's explicit Pad 8 choice remains in effect after presentation. Requests
 * are coalesced so rapid presses cannot produce overlapping pulses.
 */
export class SpeakerSyncRefresh {
  constructor({ getSyncView, setSyncView, wait, prepareViewport = async () => {}, report = () => {} }) {
    this.getSyncView = getSyncView;
    this.setSyncView = setSyncView;
    this.wait = wait;
    this.prepareViewport = prepareViewport;
    this.report = report;
    this.revision = 0;
    this.queue = Promise.resolve();
  }

  request() {
    const revision = ++this.revision;
    this.queue = this.queue.catch(() => {}).then(async () => {
      // Wait for Owlbear to transmit and render the new NOTE/IMAGE items.
      // Give scene replication and any in-flight native viewport animation
      // time to settle before requesting the final, correct camera snapshot.
      await this.wait(480);
      if (revision !== this.revision) return false;
      // Reapply the camera after the delayed native zoom has had time to run.
      await this.prepareViewport();
      if (revision !== this.revision) return false;
      const original = await this.getSyncView();
      if (revision !== this.revision) return false;
      // Native cast sync is asymmetric: it copies the GM viewport to players.
      // Pulse off/on for a continuously synced table, on/off for an unsynced
      // table. The latter still aligns the cast once without permanently
      // changing the Pad 8 setting.
      await this.setSyncView(!original);
      try {
        await this.wait(180);
      } finally {
        await this.setSyncView(original);
      }
      this.report('Cast-Kamera nach Porträtwechsel abgeglichen.');
      return true;
    });
    return this.queue;
  }

  cancel() {
    this.revision += 1;
  }
}
