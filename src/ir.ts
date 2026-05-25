/**
 * Map UC media-player command IDs that drive the SoundBridge's native menu UI
 * to RCP `IrDispatchCommand` keys.
 *
 * The SoundBridge accepts `CK_*` button identifiers (per the RCP manual) —
 * not the `IR_KEY_*` family. Notable corners:
 *   - Directional keys are compass-named (`CK_NORTH/SOUTH/EAST/WEST`).
 *   - There is no `CK_HOME`; the closest is `CK_MENU` (the main settings menu).
 *   - There is no `CK_INFO` accepted by current firmware — `info` is omitted.
 *   - SoundBridge has no numeric keypad on its IR remote, so `digit_N` has no
 *     useful mapping here and is intentionally not handled.
 *
 * Returns null if the command id is not an IR-dispatchable navigation command.
 */

const STATIC: Record<string, string> = {
  cursor_up: "CK_NORTH",
  cursor_down: "CK_SOUTH",
  cursor_left: "CK_WEST",
  cursor_right: "CK_EAST",
  cursor_enter: "CK_SELECT",
  home: "CK_MENU",
  menu: "CK_BROWSE",
  back: "CK_EXIT",
};

export function resolveCommand(cmdId: string): string | null {
  if (cmdId in STATIC) return STATIC[cmdId]!;
  return null;
}

/**
 * Names of `IrDispatchCommand` keys we expose as media-player simple_commands
 * so the UC remote can map them to physical buttons. These are passed
 * verbatim to the SoundBridge — i.e. the user sees and configures them as
 * `CK_PRESET_A1`, `CK_POWER_ON`, etc.
 *
 * Verified live against an M2000 (firmware 3.x): every entry in this list
 * returns `IrDispatchCommand: OK`.
 */
export const SIMPLE_IR_COMMANDS: readonly string[] = [
  // Dpad + the menu/home/back nav buttons. These are also exposed via the
  // Dpad/Home/Menu features, which makes them appear in the touch-screen
  // dpad widget, but the *physical-button* mapping picker only shows
  // commands declared as simple_commands. Listing them here makes the
  // remote let users map a hardware button to any of these too.
  "cursor_up",
  "cursor_down",
  "cursor_left",
  "cursor_right",
  "cursor_enter",
  "home",
  "menu",
  "back",

  // Power (distinct from the on/off features which already use these
  // implicitly — exposing them separately lets the user wire a single
  // hard "Power" button on the remote).
  "CK_POWER",
  "CK_POWER_ON",
  "CK_POWER_OFF",

  // Browse shortcuts — jump straight into a category.
  "CK_BROWSE_ALBUMS",
  "CK_BROWSE_ARTISTS",
  "CK_BROWSE_COMPOSERS",
  "CK_BROWSE_GENRES",
  "CK_BROWSE_SONGS",
  "CK_PLAYLISTS",

  // Source / mode switches.
  "CK_SOURCE",
  "CK_INTERNET_RADIO",
  "CK_AM_RADIO",
  "CK_FM_RADIO",
  "CK_LAST_MUSIC_SERVER",

  // Library actions.
  "CK_ADD",
  "CK_SEARCH",
  "CK_SHUFFLE",
  "CK_REPEAT",

  // Display / device.
  "CK_BRIGHTNESS",
  "CK_GROUP",

  // Alarm / sleep.
  "CK_ALARM",
  "CK_SNOOZE",

  // Scan (FM/AM tuning).
  "CK_SCAN_UP",
  "CK_SCAN_DOWN",

  // 18 preset slots (A1..A6, B1..B6, C1..C6).
  "CK_PRESET_A1", "CK_PRESET_A2", "CK_PRESET_A3", "CK_PRESET_A4", "CK_PRESET_A5", "CK_PRESET_A6",
  "CK_PRESET_B1", "CK_PRESET_B2", "CK_PRESET_B3", "CK_PRESET_B4", "CK_PRESET_B5", "CK_PRESET_B6",
  "CK_PRESET_C1", "CK_PRESET_C2", "CK_PRESET_C3", "CK_PRESET_C4", "CK_PRESET_C5", "CK_PRESET_C6",
];
