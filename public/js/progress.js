// Pure helper for the TV display progress bar: the fraction (0..1) of the
// current phase still remaining. Browser-loaded via <script> (sets
// window.roundProgress) and required by test/progress.test.js (module.exports).
// No DOM, no dependencies.
/* global module */
(function (root) {
  function roundProgress(s) {
    const full = s.phase === 'rest' ? s.restDuration : s.roundDuration;
    if (!full || full <= 0) return 0;
    return Math.max(0, Math.min(1, s.timeRemaining / full));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { roundProgress };
  root.roundProgress = roundProgress;
})(typeof globalThis !== 'undefined' ? globalThis : this);
