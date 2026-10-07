// Embedded by Engine. stdin carries only the verified entry snapshot.
const fs = require('node:fs');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const entry = process.argv[1];
const url = pathToFileURL(entry).href;
const source = fs.readFileSync(0, 'utf8');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === url) return { url, shortCircuit: true };
    return next(specifier, context);
  },
  load(target, context, next) {
    if (target !== url) return next(target, context);
    // Ask Node to determine .js package type; replace the entry bytes only.
    const loaded = next(target, context);
    return { ...loaded, source };
  },
});
// Keep normal entry semantics, including require.main and import.meta.main.
require('node:module').runMain(entry);
