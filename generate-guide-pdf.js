#!/usr/bin/env node

// Compatibility entry point. The guarded generator validates that the HTML is
// the complete guide and preserves the existing PDF on every failure path.
require("./scripts/_gen_userguide_pdf.js");
