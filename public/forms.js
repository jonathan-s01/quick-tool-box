// Profile and form pages: move focus to the message at the top after an action,
// so the screen reader reads what happened.
(() => {
  const target = document.getElementById('flash') || (location.hash === '#result' && document.getElementById('result-h'));
  if (target) target.focus();
})();
