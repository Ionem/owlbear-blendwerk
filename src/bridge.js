/** Optional local Launch Control / LED bridge. Portraits and shortcuts use Owlbear directly. */
export const MIDI_BRIDGE_ORIGIN = "http://127.0.0.1:5173";

export function midiBridgeUrl(path) {
  if (typeof path !== "string" || !path.startsWith("/api/midi/")) {
    throw new TypeError("Ungueltige MIDI-API-Route");
  }
  return `${MIDI_BRIDGE_ORIGIN}${path}`;
}
