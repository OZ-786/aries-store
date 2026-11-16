"use strict";

// The public GitHub page cannot store one shared record by itself.
// It uses the office computer, which must stay switched on.
if (location.hostname.endsWith("github.io")) {
  window.ARIES_API = "https://blank-studied-tracy-electricity.trycloudflare.com";
}
