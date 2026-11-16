import OBR from "./obr-sdk.js";
import { normalizeSpeakers, shouldPresent, SPEAKER_METADATA_KEY,
  SPEAKER_STATUS_CHANNEL } from "./speakers.js";

// Shared full-screen presentation. Each client renders from the room metadata;
// Sync View itself does NOT synchronize Owlbear modals.
const portraits = [document.getElementById("portrait-0"),
  document.getElementById("portrait-1")];
const error = document.getElementById("error");
let currentIndex = -1;
let currentUrl = null;
let generation = 0;
let role = null;

function report(type, message = "") {
  // The GM's iframe must reach the GM background running in the SAME client.
  // Player/Cast clients report to the GM via REMOTE.
  const destination = role === "GM" ? "LOCAL" : "REMOTE";
  void OBR.broadcast.sendMessage(SPEAKER_STATUS_CHANNEL,
    { type, message, role }, { destination }).catch(console.error);
}

function render(raw) {
  const state = normalizeSpeakers(raw);
  const image = shouldPresent(state, role) ? state.images[state.active] : null;
  if (!image) {
    ++generation;
    currentUrl = null;
    for (const portrait of portraits) portrait.classList.remove("visible");
    return;
  }
  if (image.url === currentUrl) return;
  const seq = ++generation;
  const next = (currentIndex + 1) % 2;
  const incoming = portraits[next];
  const previous = currentIndex === -1 ? null : portraits[currentIndex];
  incoming.classList.remove("visible");
  error.style.display = "none";
  incoming.onload = () => {
    if (seq !== generation) return;
    incoming.classList.add("visible");
    if (previous) previous.classList.remove("visible");
    currentIndex = next;
    currentUrl = image.url;
    report("image-loaded", image.name);
  };
  incoming.onerror = () => {
    if (seq !== generation) return;
    error.textContent = "Das Sprecherporträt konnte nicht geladen werden.";
    error.style.display = "block";
    report("image-error", `Bild nicht geladen: ${image.name}`);
  };
  incoming.alt = image.name;
  incoming.src = image.url;
}

OBR.onReady(async () => {
  role = await OBR.player.getRole();
  OBR.room.onMetadataChange((metadata) => render(metadata[SPEAKER_METADATA_KEY]));
  render((await OBR.room.getMetadata())[SPEAKER_METADATA_KEY]);
});
