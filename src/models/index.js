'use strict';

// Kamera modelleri (ana süreç): tanımlar + sürücüler.
const DEFS = require('./defs');

const DRIVERS = {
  cpdd075cct: require('./cpdd075cct.driver').Driver,
};
for (const id of Object.keys(require('./skydroid.driver').PROFILES)) DRIVERS[id] = require('./skydroid.driver').Driver;

const byId = Object.fromEntries(DEFS.map((d) => [d.id, d]));
const get = (id) => byId[id] || null;
const hasDriver = (id) => !!DRIVERS[id];
const createDriver = (conn) => (DRIVERS[conn.model] ? new DRIVERS[conn.model](conn) : null);
const external = (conn, cmd) => (DRIVERS[conn.model] && DRIVERS[conn.model].external ? DRIVERS[conn.model].external(cmd, conn) : null);

module.exports = { DEFS, get, hasDriver, createDriver, external };
