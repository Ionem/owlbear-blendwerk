import { normalizeSpeakers, shouldPresent, SPEAKER_MODAL_ID } from "./speakers.js";

/** Opens the overlay locally on the GM, and on player/Cast clients when shared. */
export class SpeakerPresenter {
  constructor({ modal, role, report = () => {} }) {
    this.modal = modal;
    this.role = role;
    this.report = report;
    this.visible = false;
    this.queue = Promise.resolve();
  }

  update(raw) {
    const state = normalizeSpeakers(raw);
    // Serialized: rapid A -> B -> off must not leave an obsolete modal open.
    this.queue = this.queue.then(async () => {
      const desired = shouldPresent(state, this.role);
      if (desired === this.visible) return;
      try {
        if (desired) {
          await this.modal.open({
            id: SPEAKER_MODAL_ID,
            url: "/speaker.html",
            fullScreen: true,
            hidePaper: true,
            hideBackdrop: true,
            disablePointerEvents: true,
          });
          this.visible = true;
          this.report({ type: "modal-open" });
        } else {
          await this.modal.close(SPEAKER_MODAL_ID);
          this.visible = false;
          this.report({ type: "modal-close" });
        }
      } catch (error) {
        this.report({ type: "modal-error", message: error?.message ?? String(error) });
      }
    });
    return this.queue;
  }
}
