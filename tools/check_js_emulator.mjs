/**
 * Gate: the browser emulator must agree with the released reference implementation.
 *
 * Without this the JS port can drift from `predict.py` indefinitely and nobody
 * notices, because a wrong emulator still draws a perfectly plausible curve.
 *
 * Reads parameter vectors + expected outputs from a JSON file produced by
 * tools/check_js_emulator.py (which runs the real predict.py), recomputes them
 * here, and reports the worst disagreement.
 *
 *   node tools/check_js_emulator.mjs cases.json assets/emulator
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , casesPath, emuDir] = process.argv;
if (!casesPath || !emuDir) {
	console.error("usage: node tools/check_js_emulator.mjs <cases.json> <emulator-dir>");
	process.exit(2);
}

// the module fetches by URL; in node, serve it straight off the filesystem
globalThis.fetch = async (url) => {
	const path = decodeURIComponent(new URL(url, pathToFileURL(process.cwd() + "/")).pathname);
	const buf = readFileSync(path);
	return {
		ok: true,
		status: 200,
		json: async () => JSON.parse(buf.toString()),
		arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
	};
};

const { loadShared, loadQuantity, predict } = await import("../assets/js/baqaro-emulator.js");

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const shared = await loadShared(emuDir);

// The port must reproduce `expected_web` -- same arrays, same arithmetic --
// to machine level. Its distance from `expected` is the float32 storage
// budget, which is physics, not a bug, so it is reported and loosely bounded.
const TOL_PORT = 1e-9;
const TOL_PHYS = 1e-2;

let worstPort = 0, worstPortWhere = "", worstPhys = 0, nChecked = 0, failed = false;
for (const [name, entries] of Object.entries(cases)) {
	const emu = await loadQuantity(emuDir, name, shared);
	let qPort = 0, qPhys = 0;
	for (const { theta, expected, expected_web } of entries) {
		const got = predict(emu, theta);
		if (got.length !== expected.length) {
			console.error(`  ${name}: length ${got.length} != expected ${expected.length}`);
			failed = true;
			break;
		}
		for (let j = 0; j < got.length; j++) {
			const ep = Math.abs(got[j] - expected_web[j]);
			const ex = Math.abs(got[j] - expected[j]);
			if (ep > qPort) qPort = ep;
			if (ex > qPhys) qPhys = ex;
			if (ep > worstPort) { worstPort = ep; worstPortWhere = `${name}[${j}]`; }
			if (ex > worstPhys) worstPhys = ex;
		}
		nChecked++;
	}
	console.log(`  ${name.padEnd(6)} ${String(entries.length).padStart(3)} vectors   ` +
		`port ${qPort.toExponential(2)}   vs float64 ref ${qPhys.toExponential(2)} dex`);
}

console.log(`\n  ${nChecked} predictions checked`);
console.log(`  port fidelity      : ${worstPort.toExponential(2)} dex  (limit ${TOL_PORT})  at ${worstPortWhere}`);
console.log(`  float32 storage    : ${worstPhys.toExponential(2)} dex  (limit ${TOL_PHYS})`);
if (failed || !(worstPort <= TOL_PORT) || !(worstPhys <= TOL_PHYS)) {
	console.error("FAIL");
	process.exit(1);
}
console.log("PASS");
