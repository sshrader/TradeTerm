// Applies the saved colour theme before the first paint, so there is no flash of the default colours.
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('pulse.theme'));
    if (typeof t === 'string' && /^[a-z]{3,12}$/.test(t)) document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable */ }
})();
