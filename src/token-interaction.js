import { TokenRotationFromPotentiometer } from "./midi-controls.js";

/**
 * A hardware dial can emit dozens of CC values each second. The Owlbear
 * interaction API is specifically designed for fast local item transforms:
 * only opening/closing an interaction uses the ordinary asynchronous API.
 */
export class TokenRotationInteraction {
  constructor({ getItem, startInteraction, commitRotation, onCommitError = console.error,
    delay = 450,
    setTimer = (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimer = (timer) => globalThis.clearTimeout(timer), clock = Date.now }) {
    this.getItem = getItem;
    this.startInteraction = startInteraction;
    if (typeof commitRotation !== "function") {
      throw new Error("Die finale Token-Rotation benötigt eine Speicherfunktion.");
    }
    this.commitRotation = commitRotation;
    this.onCommitError = onCommitError;
    this.delay = delay;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.clock = clock;
    this.dial = new TokenRotationFromPotentiometer();
    this.selectedId = null;
    this.generation = 0;
    this.token = null;
    this.blocked = false;
    this.interaction = null;
    this.timer = null;
    this.retryAt = 0;
    this.pendingCommit = Promise.resolve();
  }

  setSelection(id) {
    const next = typeof id === "string" && id.length > 0 ? id : null;
    if (next === this.selectedId) return;
    this.reset();
    this.selectedId = next;
  }

  stop() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.interaction) {
      const interaction = this.interaction;
      this.interaction = null;
      // Owlbear interactions are *previews*. Stopping alone reverts the token.
      // Commit exactly one permanent scene update, then end the preview.
      const id = this.token?.id;
      const angle = this.token?.rotation;
      this.pendingCommit = this.pendingCommit.then(async () => {
        try {
          if (typeof id === "string" && Number.isFinite(angle)) {
            await this.commitRotation(id, angle);
          }
        } finally {
          interaction.stop();
        }
      }).catch((error) => { this.onCommitError(error); });
    }
    return this.pendingCommit;
  }

  reset() {
    this.generation += 1;
    this.stop();
    this.selectedId = null;
    this.token = null;
    this.blocked = false;
    this.retryAt = 0;
    this.dial.reset();
  }

  async rotate(value) {
    if (!this.selectedId || this.blocked || this.clock() < this.retryAt) return false;
    const generation = this.generation;
    if (!this.token) {
      try {
        const token = await this.getItem(this.selectedId);
        if (generation !== this.generation) return false;
        if (!token || token.layer !== "CHARACTER" || token.locked) {
          this.blocked = true; // Do not repeatedly query maps or locked tokens.
          return false;
        }
        this.token = token;
      } catch (error) {
        if (generation === this.generation) this.retryAt = this.clock() + 1500;
        throw error;
      }
    }

    const angle = this.dial.resolve(this.token.id, this.token.rotation ?? 0, value);
    if (angle === null || Math.abs(angle - (this.token.rotation ?? 0)) < 0.001) return false;

    if (!this.interaction) {
      try {
        // A previous stroke might still be committing. Never start the next
        // preview against a scene state that is about to be overwritten.
        await this.pendingCommit;
        if (generation !== this.generation) return false;
        const interaction = await this.startInteraction(this.token);
        if (generation !== this.generation) {
          interaction.stop();
          return false;
        }
        this.interaction = interaction;
      } catch (error) {
        if (generation === this.generation) this.retryAt = this.clock() + 1500;
        throw error;
      }
    }

    // Synchronous local update; Owlbear samples and synchronizes the changes.
    let current;
    try {
      current = this.interaction.update((draft) => { draft.rotation = angle; });
    } catch (error) {
      this.stop();
      this.retryAt = this.clock() + 1500;
      throw error;
    }
    this.token = current ?? { ...this.token, rotation: angle };
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.stop(), this.delay);
    return true;
  }
}
