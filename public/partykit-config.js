// Host only — no https:// prefix (the app adds the protocol)
// Local dev: run `localStorage.PARTYKIT_HOST = 'localhost:1999'` in the
// console (and `delete localStorage.PARTYKIT_HOST` to undo) to point the
// frontend at `npx partykit dev` without editing this file.
window.PARTYKIT_HOST = localStorage.getItem('PARTYKIT_HOST') || 'bjj-timer.robreed64.partykit.dev';
