// Speaker Timer — single source of truth for the backend address.
//
// Every page reads window.SPEAKER_TIMER_SERVER before falling back to its
// hardcoded default, so this file is the ONLY place that needs to change
// when the backend moves. (The per-page fallbacks stay as a safety net for
// contexts where this file isn't served, e.g. a partial drag-and-drop deploy.)
//
// Local development: point this at your local server instead —
//   window.SPEAKER_TIMER_SERVER = 'wss://speaker-timer-production-4ec9.up.railway.app';
window.SPEAKER_TIMER_SERVER = 'wss://speaker-timer-production-4ec9.up.railway.app';
