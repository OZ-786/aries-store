"use strict";

// The public page reads and writes database/record.json on GitHub.
// It does not call the office computer.
if (location.hostname.endsWith("github.io")) {
  window.ARIES_SHARED = true;
}
