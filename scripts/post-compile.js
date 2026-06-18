#!/usr/bin/env node
// Cross-platform replacement for `cp out/cli.js out/minercon && chmod +x out/minercon`.
// On Unix this sets the executable bit; on Windows the .cmd wrapper npm generates
// for bin entries handles invocation, so chmod is a no-op there.
const fs = require('fs');
fs.copyFileSync('out/cli.js', 'out/minercon');
try { fs.chmodSync('out/minercon', 0o755); } catch { /* Windows: no-op */ }
