// Page view in Find in a document: when opened at a line (#r12), move focus to that line
// so the screen reader starts reading there.
(() => {
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) target.focus();
})();
