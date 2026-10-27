'use strict';

// Coalesces refresh requests without dropping them. A push that arrives while a refresh is already
// running must trigger one more run afterwards: now that the dashboard no longer polls, a single
// write followed by no further pushes would otherwise leave the panel showing stale data.
function createRefreshQueue(task) {
  let running = null, queued = false;
  const start = () => {
    running = Promise.resolve().then(task);
    const settle = () => {
      running = null;
      if (queued) { queued = false; start(); }
    };
    // Both paths settle the queue; the task itself reports its own errors.
    running.then(settle, settle);
    return running;
  };
  return () => {
    if (!running) return start();
    queued = true;
    return running;
  };
}

module.exports = { createRefreshQueue };
