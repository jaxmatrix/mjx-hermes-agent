// The backend's session-search FTS layer wraps matched terms in literal '>>>' /
// '<<<' highlight markers — sqlite `snippet()` delimiters, see
// `hermes_state_search.py` (`snippet({table}, -1, '>>>', '<<<', '...', 40)`).
// The sidebar renders the snippet as PLAIN TEXT, so the markers have to come
// off or a search for "foo" paints rows reading ">>>foo<<<".
export function stripFtsMarkers(snippet: string): string {
  return snippet.replaceAll('>>>', '').replaceAll('<<<', '')
}
