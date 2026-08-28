/* Local source-preview shim. The Pages build serves the shared script from /assets/. */
(() => {
  "use strict";

  const current = document.currentScript;
  if (!current) return;
  const script = document.createElement("script");
  script.src = new URL("../../assets/site.js", current.src).href;
  document.head.append(script);
})();
