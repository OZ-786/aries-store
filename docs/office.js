"use strict";

// The public page reads and writes database/record.json on GitHub.
// It does not call the office computer.
if (location.hostname.endsWith("github.io")) {
  window.ARIES_SHARED = true;
  try {
    const saved = localStorage.getItem("aries-github-token");
    if (saved) window.ARIES_GITHUB_TOKEN = saved;
  } catch (error) {
    /* this browser is not storing the save key */
  }
}
