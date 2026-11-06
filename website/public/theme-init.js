// Dark is the default; a saved choice wins. Loaded before the page paints, so there is no flash.
try {
  var t = localStorage.getItem("ls-site-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
