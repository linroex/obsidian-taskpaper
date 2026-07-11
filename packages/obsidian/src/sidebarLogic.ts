/**
 * A signature describing everything the sidebar's rendered DOM depends on.
 *
 * The sidebar re-renders only when this signature changes. Crucially it does
 * NOT depend on focus/leaf changes, so clicking from the editor into the
 * sidebar does not rebuild the DOM mid-click (which would swallow the click).
 */
export function sidebarSignature(
  filePath: string | null,
  docLength: number,
  focusedLine: number | null,
): string {
  if (filePath === null) {
    return 'empty';
  }
  return `${filePath}|${docLength}|${focusedLine ?? '-'}`;
}
