/**
 * Map UC media-player command IDs that should drive the SoundBridge's
 * native menu UI to RCP `IrDispatchCommand` keys.
 *
 * Returns null if the command is not an IR-dispatchable navigation
 * command — caller should handle it explicitly.
 *
 * Key names are taken from the Roku RCP spec — they correspond to
 * physical IR remote buttons. For digit_N → IR_KEY_<n> we generate
 * dynamically.
 */

const STATIC: Record<string, string> = {
  cursor_up: "IR_KEY_UP",
  cursor_down: "IR_KEY_DOWN",
  cursor_left: "IR_KEY_LEFT",
  cursor_right: "IR_KEY_RIGHT",
  cursor_enter: "IR_KEY_OK",
  home: "IR_KEY_HOME",
  // The SoundBridge IR remote labels its menu key "Browse" — most of the
  // device's UI is reached from there.
  menu: "IR_KEY_BROWSE",
  back: "IR_KEY_BACK",
  info: "IR_KEY_DISPLAY",
};

export function resolveCommand(cmdId: string): string | null {
  if (cmdId in STATIC) return STATIC[cmdId]!;
  const m = cmdId.match(/^digit_(\d)$/);
  if (m) return `IR_KEY_${m[1]}`;
  return null;
}
