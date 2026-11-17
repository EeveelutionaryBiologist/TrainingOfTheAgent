/*
 * schema.js — print or write the layout of the current observation version.
 *
 *   node js/node/schema.js            print the layout as JSON
 *   node js/node/schema.js --write    write schema/obs_v<version>.json (the frozen snapshot the tests compare with)
 *
 * The layout is defined in js/core/observe.js. The snapshot exists so that any change to fields or vocabularies
 * fails a test until it is made on purpose, with a new version number (R9).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Observe = require('../core/observe.js');

const text = JSON.stringify(Observe.LAYOUT, null, 1) + '\n';
if (process.argv.includes('--write')) {
  const file = path.join(__dirname, '..', '..', 'schema', `obs_v${Observe.VERSION}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`wrote ${file}`);
} else process.stdout.write(text);
