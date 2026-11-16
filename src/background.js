import OBR from "./obr-sdk.js";
import { MESSAGE_CHANNEL } from "./constants.js";
import { midiBridgeUrl } from "./bridge.js";
import { nextZoomScale, centeredZoomPosition, pannedViewportPosition,
  coalesceMidiCommands } from "./midi-controls.js";
import { TokenRotationInteraction } from "./token-interaction.js";
import { SpeakerSceneOverlay } from "./speaker-scene-overlay.js";
import { SpeakerSyncRefresh } from "./speaker-sync-refresh.js";
import { SPEAKER_METADATA_KEY, PORTRAIT_SLOT_COUNT, normalizeSpeakers,
  chooseSpeaker, changeSpeakerImage, speakerPadColors, visiblePortraitKey,
  validPortraitSlot } from "./speakers.js";

// Exactly one GM in the armed Owlbear room processes MIDI. The PLAYER/Cast
// needs no extension UI: Owlbear renders shared NOTE items on its canvas.
const describeError = error => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? "Unbekannter Fehler"; }
  catch { return "Unbekannter Fehler"; }
};

OBR.onReady(async () => {
  if (await OBR.player.getRole() !== "GM") return;

  const room = OBR.room.id;
  const client = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  let sceneReady = await OBR.scene.isReady();
  let syncActive = await OBR.player.getSyncView();
  let speakerState = normalizeSpeakers((await OBR.room.getMetadata())[SPEAKER_METADATA_KEY]);
  let speakerStatus = "Bereit";
  let midiOwnsRoom = false;
  let lastLedKey = "";
  let ledUpdated = 0;
  let ledQueue = Promise.resolve();
  let commandQueue = Promise.resolve();
  let lastError = { text: "", at: 0 };

  const reportError = error => {
    const text = describeError(error);
    console.error("Blendwerk Porträts:", error);
    if (lastError.text !== text || Date.now() - lastError.at > 5000) {
      void OBR.notification.show(text, "ERROR");
      lastError = { text, at: Date.now() };
    }
    void OBR.broadcast.sendMessage(MESSAGE_CHANNEL,
      { type: "error", message: text }, { destination: "LOCAL" }).catch(console.error);
  };
  const publish = () => void OBR.broadcast.sendMessage(MESSAGE_CHANNEL,
    { type: "speaker_state", speakers: speakerState,
      speakerStatus, syncViewActive: syncActive },
    { destination: "LOCAL" }).catch(console.error);

  // Old GM fullscreen modals must not compete with the shared Owlbear stage.
  void OBR.modal.close("de.horasreich.viewjump/speaker-modal").catch(() => {});
  const overlay = new SpeakerSceneOverlay({
    items: OBR.scene.items, viewport: OBR.viewport,
    sceneGrid: OBR.scene.grid, userId: OBR.player.id,
    report: event => {
      if (event.type === "scene-overlay-open") {
        speakerStatus = `Pad ${speakerState.active} – auf der gemeinsamen Szene sichtbar`;
      } else if (event.type === "scene-overlay-close") {
        speakerStatus = "Karte sichtbar";
      } else if (event.type === "scene-overlay-error") {
        speakerStatus = `Fehler: ${event.message}`;
      }
      publish();
    },
  });
  // Retain the user-confirmed 0.6.10 workaround: re-sync AFTER image update.
  const syncRefresh = new SpeakerSyncRefresh({
    getSyncView: () => OBR.player.getSyncView(),
    setSyncView: value => OBR.player.setSyncView(value),
    prepareViewport: () => overlay.reassertCamera(),
    wait: ms => new Promise(resolve => globalThis.setTimeout(resolve, ms)),
  });

  function queueLedSync() {
    if (!midiOwnsRoom) return;
    ledQueue = ledQueue.catch(() => {}).then(async () => {
      if (!midiOwnsRoom) return;
      const colors = [...speakerPadColors(speakerState), syncActive ? "red_full" : "red_low"];
      const key = JSON.stringify({ colors, syncActive });
      if (key === lastLedKey && Date.now() - ledUpdated < 6000) return;
      const response = await fetch(midiBridgeUrl("/api/midi/leds"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, client, colors, syncView: syncActive }),
      });
      if (!response.ok) throw new Error(`LED-Status: HTTP ${response.status}`);
      lastLedKey = key;
      ledUpdated = Date.now();
    }).catch(error => {
      lastLedKey = "";
      console.debug("Blendwerk LED-Verbindung wird erneut versucht", error);
    });
  }

  // One serial path handles button presses and metadata changes. The former
  // speaker is not lost if the room metadata write is rejected.
  async function savePortraitState(next) {
    const previous = speakerState;
    const changed = visiblePortraitKey(previous) !== visiblePortraitKey(next);
    speakerState = next;
    try {
      await OBR.room.setMetadata({ [SPEAKER_METADATA_KEY]: next });
    } catch (error) {
      speakerState = previous;
      throw error;
    }
    if (sceneReady && changed) {
      // Exactly one serialized path for the locally initiated change.
      // Do not initiate a second stage update from room metadata echo.
      await overlay.update(next);
      await syncRefresh.request();
    }
    publish();
    queueLedSync();
  }

  OBR.room.onMetadataChange(metadata => {
    const next = normalizeSpeakers(metadata[SPEAKER_METADATA_KEY]);
    const changed = visiblePortraitKey(speakerState) !== visiblePortraitKey(next);
    speakerState = next;
    if (changed && sceneReady) {
      void overlay.update(next).then(() => syncRefresh.request()).catch(reportError);
    }
    publish();
    queueLedSync();
  });

  const rotation = new TokenRotationInteraction({
    getItem: async id => (await OBR.scene.items.getItems([id]))[0],
    startInteraction: async item => {
      const [update, stop] = await OBR.interaction.startItemInteraction(item);
      return { update, stop };
    },
    commitRotation: (id, angle) => OBR.scene.items.updateItems([id], items => {
      for (const item of items) if (item.id === id && item.layer === "CHARACTER" && !item.locked)
        item.rotation = angle;
    }),
    onCommitError: reportError,
  });
  let lastSelection = null;
  function trackSelection(selected) {
    const id = Array.isArray(selected) && selected.length === 1 ? selected[0] : null;
    if (lastSelection === id) return;
    lastSelection = id;
    rotation.setSelection(id);
  }
  trackSelection(await OBR.player.getSelection());

  async function adjustZoom(delta) {
    const [current, position, width, height] = await Promise.all([
      OBR.viewport.getScale(), OBR.viewport.getPosition(),
      OBR.viewport.getWidth(), OBR.viewport.getHeight(),
    ]);
    const next = nextZoomScale(current, delta);
    const pos = next !== null && next !== current
      ? centeredZoomPosition(position, current, next, width, height) : null;
    if (pos) await Promise.all([OBR.viewport.setPosition(pos), OBR.viewport.setScale(next)]);
  }

  async function handle(action, data = {}) {
    if (action === "speaker_state") { publish(); return; }
    if (action === "speaker_set_image") {
      if (!sceneReady) throw new Error("Bitte zuerst eine Owlbear-Szene öffnen.");
      await savePortraitState(changeSpeakerImage(speakerState, data.slot, data.image));
      return;
    }
    if (!sceneReady) throw new Error("Bitte zuerst eine Owlbear-Szene öffnen.");
    switch (action) {
      case "speaker_toggle":
        await savePortraitState(chooseSpeaker(speakerState, data.slot));
        break;
      case "sync_toggle":
        syncRefresh.cancel();
        syncActive = !(await OBR.player.getSyncView());
        await OBR.player.setSyncView(syncActive);
        queueLedSync(); publish();
        break;
      case "zoom_delta":
        if (Number.isInteger(data.delta) && Math.abs(data.delta) <= 4096)
          await adjustZoom(data.delta);
        break;
      case "pan_x_delta": case "pan_y_delta": {
        if (!Number.isInteger(data.delta) || Math.abs(data.delta) > 4096) break;
        const position = await OBR.viewport.getPosition();
        const next = pannedViewportPosition(position,
          action === "pan_x_delta" ? "x" : "y", data.delta);
        if (next) await OBR.viewport.setPosition(next);
        break;
      }
      case "rotation_value":
        if (Number.isInteger(data.value) && data.value >= 0 && data.value <= 127)
          await rotation.rotate(data.value);
        break;
    }
  }

  function enqueue(action, data = {}) {
    commandQueue = commandQueue.catch(() => {}).then(() => handle(action, data))
      .catch(reportError);
    return commandQueue;
  }

  OBR.broadcast.onMessage(MESSAGE_CHANNEL, event => {
    const action = event.data?.type;
    if (["speaker_toggle", "speaker_set_image", "speaker_state", "sync_toggle"].includes(action)) {
      if (action === "speaker_toggle" && !validPortraitSlot(event.data?.slot)) return;
      void enqueue(action, event.data);
    }
  });

  OBR.scene.onReadyChange(ready => {
    sceneReady = ready;
    if (!ready) {
      syncRefresh.cancel();
      rotation.reset();
      lastSelection = null;
    } else {
      void overlay.update(speakerState).catch(reportError);
      void OBR.player.getSelection().then(trackSelection).catch(console.error);
    }
  });
  OBR.player.onChange(player => {
    trackSelection(player.selection);
    if (typeof player.syncView === "boolean" && player.syncView !== syncActive) {
      syncActive = player.syncView;
      queueLedSync(); publish();
    }
  });

  // Only the activated presentation room can receive Launch Control pads.
  // Pads 1–7 all use the SAME portrait workflow, pad 8 toggles Sync View.
  async function pollMidiCommands() {
    let boot = "", after = 0, bankRevision = -1;
    const pause = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms));
    for (;;) {
      try {
        const query = new URLSearchParams({ room, client, after: String(after),
          boot, bankRevision: String(bankRevision) });
        const response = await fetch(midiBridgeUrl(`/api/midi/poll?${query}`), { cache: "no-store" });
        if (!response.ok) throw new Error(`MIDI-Server HTTP ${response.status}`);
        const payload = await response.json();
        midiOwnsRoom = Boolean(payload.armed && !payload.standby);
        if (Number.isInteger(payload.bankRevision)) bankRevision = payload.bankRevision;
        if (payload.boot !== boot || payload.resync) {
          boot = payload.boot; after = payload.latest; lastLedKey = "";
          queueLedSync(); continue;
        }
        if (!payload.armed || payload.standby) {
          after = payload.latest;
          await pause(payload.standby ? 1500 : 1000);
          continue;
        }
        queueLedSync();
        const events = payload.events ?? [];
        for (const event of events) after = Math.max(after, event.sequence);
        for (const command of coalesceMidiCommands(events.map(e => e.command))) {
          if (command?.type === "speaker_toggle" && validPortraitSlot(command.slot)) {
            await enqueue("speaker_toggle", { slot: command.slot });
          } else if (command?.type === "sync_toggle") {
            await enqueue("sync_toggle");
          } else if (["zoom_delta", "pan_x_delta", "pan_y_delta", "rotation_value"].includes(command?.type)) {
            await enqueue(command.type, command);
          }
        }
        after = Math.max(after, payload.latest);
      } catch (error) {
        midiOwnsRoom = false;
        console.warn("Blendwerk MIDI-Verbindung: neuer Versuch", error);
        await pause(2000);
      }
    }
  }

  for (let slot = 1; slot <= PORTRAIT_SLOT_COUNT + 1; slot += 1) {
    try {
      const isSync = slot === 8;
      await OBR.tool.createAction({
        id: `de.horasreich.viewjump/action-${slot}`,
        shortcut: `Alt+${slot}`,
        icons: [{ icon: new URL("../viewjump.svg", import.meta.url).href,
          label: isSync ? "Sync View umschalten (Alt+8)" : `Porträt ${slot} (Alt+${slot})`,
          filter: { roles: ["GM"] } }],
        onClick: () => { void enqueue(isSync ? "sync_toggle" : "speaker_toggle", { slot }); },
      });
    } catch (error) {
      console.warn(`Owlbear-Tastenkürzel Alt+${slot}:`, error);
    }
  }

  if (sceneReady) void overlay.update(speakerState).catch(reportError);
  publish();
  void pollMidiCommands();
});
