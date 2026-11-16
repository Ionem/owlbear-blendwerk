import OBR from "./obr-sdk.js";
import { MESSAGE_CHANNEL } from "./constants.js";
import { midiBridgeUrl } from "./bridge.js";
import { PORTRAIT_SLOT_COUNT, normalizeSpeakers } from "./speakers.js";


const el = id => document.getElementById(id);
let isGM = false;
let state = normalizeSpeakers(null);
let midiStatus = null;
const cards = new Map();

function showMessage(text, error = false) {
  el("message").textContent = text;
  el("message").classList.toggle("error", error);
}

async function command(type, values = {}) {
  showMessage("");
  try {
    await OBR.broadcast.sendMessage(MESSAGE_CHANNEL, { type, ...values },
      { destination: "LOCAL" });
  } catch (error) {
    showMessage(`Steuerung fehlgeschlagen: ${error.message}`, true);
  }
}

async function chooseImage(slot) {
  try {
    const picked = await OBR.assets.downloadImages(false);
    if (!picked?.length) return;
    const data = picked[0];
    const image = { name: data.name, url: data.image?.url,
      width: data.image?.width, height: data.image?.height, mime: data.image?.mime };
    await command("speaker_set_image", { slot, image });
  } catch (error) {
    showMessage(`Bildauswahl fehlgeschlagen: ${error.message}`, true);
  }
}

function buildPortraitRows() {
  const list = el("portrait-list");
  for (let slot = 1; slot <= PORTRAIT_SLOT_COUNT; slot += 1) {
    const row = document.createElement("div");
    row.className = "portrait-row";
    const number = document.createElement("div");
    number.className = "pad-number";
    number.textContent = String(slot);
    number.setAttribute("aria-label", `Pad ${slot}`);
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const preview = document.createElement("img");
    preview.alt = `Porträt ${slot}`;
    preview.hidden = true;
    preview.loading = "lazy";
    const placeholder = document.createElement("span");
    placeholder.className = "placeholder";
    placeholder.textContent = "–";
    thumb.append(preview, placeholder);
    const info = document.createElement("div");
    info.className = "portrait-info";
    const name = document.createElement("strong");
    name.className = "portrait-name";
    name.textContent = "Kein Bild gewählt";
    name.title = "";
    const commands = document.createElement("div");
    commands.className = "row-actions";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "button button-outline";
    select.textContent = "Bild wählen";
    select.addEventListener("click", () => void chooseImage(slot));
    const show = document.createElement("button");
    show.type = "button";
    show.className = "button button-primary";
    show.textContent = "Anzeigen";
    show.addEventListener("click", () => void command("speaker_toggle", { slot }));
    commands.append(select, show);
    info.append(name, commands);
    row.append(number, thumb, info);
    list.append(row);
    cards.set(slot, { row, preview, placeholder, name, show, select });
  }
}

function render() {
  const count = Array.from({ length: PORTRAIT_SLOT_COUNT }, (_, index) =>
    Boolean(state.images[index + 1])).filter(Boolean).length;
  el("count").textContent = `${count} / ${PORTRAIT_SLOT_COUNT} belegt`;
  el("active").textContent = state.active === null
    ? "Karte sichtbar" : `Pad ${state.active} aktiv`;
  for (let slot = 1; slot <= PORTRAIT_SLOT_COUNT; slot += 1) {
    const card = cards.get(slot);
    const image = state.images[slot];
    const active = state.active === slot;
    card.row.classList.toggle("is-active", active);
    card.preview.hidden = !image;
    card.placeholder.hidden = Boolean(image);
    if (image) {
      if (card.preview.src !== image.url) card.preview.src = image.url;
    } else card.preview.removeAttribute("src");
    card.name.textContent = image?.name ?? "Kein Bild gewählt";
    card.name.title = image?.name ?? "";
    card.show.textContent = active ? "Ausblenden" : "Anzeigen";
    card.show.disabled = !isGM || !image;
    card.select.disabled = !isGM;
  }
}

async function updateSyncState(enabled = undefined) {
  const active = typeof enabled === "boolean" ? enabled : await OBR.player.getSyncView();
  el("sync-label").textContent = active ? "Aktiv – Cast folgt der Kamera" : "Inaktiv";
  el("sync").textContent = active ? "Ausschalten" : "Einschalten";
  el("sync").disabled = !isGM;
}

function renderMidi() {
  if (!midiStatus) {
    el("midi-status").textContent = "Offline (optional)";
    el("room-status").textContent = "Ohne MIDI nutzbar";
    el("midi-arm").disabled = true;
    return;
  }
  el("midi-status").textContent = midiStatus.midiConnected ? "Verbunden" :
    midiStatus.mappingLoaded ? "Gerät nicht verbunden" : "Nicht eingerichtet";
  el("midi-status").title = midiStatus.midiError ?? "";
  el("room-status").textContent = midiStatus.armed ? "Dieser Raum ist aktiv" :
    midiStatus.otherRoomArmed ? "Anderer Raum ist aktiv" : "Nicht aktiviert";
  el("midi-arm").disabled = !isGM;
  el("midi-arm").textContent = midiStatus.armed ? "Raum deaktivieren" : "Diesen Raum aktivieren";
}

async function refreshMidi() {
  try {
    const response = await fetch(midiBridgeUrl(`/api/midi/status?room=${encodeURIComponent(OBR.room.id)}`),
      { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    midiStatus = await response.json();
  } catch {
    midiStatus = null;
  }
  renderMidi();
}

async function toggleRoom() {
  if (!isGM || !midiStatus) return;
  try {
    const response = await fetch(midiBridgeUrl("/api/midi/target"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: midiStatus.armed ? null : OBR.room.id }),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    await refreshMidi();
  } catch (error) {
    showMessage(`Raum konnte nicht umgeschaltet werden: ${error.message}`, true);
  }
}

buildPortraitRows();
render();
OBR.onReady(async () => {
  isGM = (await OBR.player.getRole()) === "GM";
  if (!isGM) {
    showMessage("Die Porträtsteuerung ist nur für die Spielleitung verfügbar.", true);
    return;
  }
  OBR.broadcast.onMessage(MESSAGE_CHANNEL, event => {
    if (event.data?.type === "speaker_state") {
      state = normalizeSpeakers(event.data.speakers);
      el("speaker-status").textContent = event.data.speakerStatus ?? "";
      if (typeof event.data.syncViewActive === "boolean")
        void updateSyncState(event.data.syncViewActive);
      render();
    } else if (event.data?.type === "error") {
      showMessage(event.data.message, true);
    }
  });
  el("midi-arm").addEventListener("click", () => void toggleRoom());
  el("sync").addEventListener("click", () => void command("sync_toggle"));
  OBR.player.onChange(player => {
    if (typeof player.syncView === "boolean") void updateSyncState(player.syncView);
  });
  if (!(await OBR.scene.isReady())) showMessage("Bitte zuerst eine Owlbear-Szene öffnen.", true);
  await command("speaker_state");
  await updateSyncState();
  await refreshMidi();
  globalThis.setInterval(() => { void refreshMidi(); }, 4000);
  render();
});
