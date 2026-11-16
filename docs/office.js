"use strict";

// The public page uses the office record. Every save is also written to
// database/record.json in this GitHub repository, which is the shared database.
if (location.hostname.endsWith("github.io")) {
  window.ARIES_API = "https://blank-studied-tracy-electricity.trycloudflare.com";
  window.ARIES_SHARED = true;
}
