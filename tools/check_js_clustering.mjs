/**
 * Gate: the browser clustering chain must reproduce the reference w_p.
 *
 * scripts/export_web_clustering.py computes w_p at the adopted best fit through
 * the real qhtools chain and stores it in clustering.json. This recomputes it
 * from the exported triangles and compares. A wrong port still draws a
 * plausible correlation function, so this is the only thing standing between a
 * mistake and a wrong figure on a public page.
 *
 *   node tools/check_js_clustering.mjs assets/emulator
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const emuDir = process.argv[2] || "assets/emulator";
globalThis.fetch = async (url) => {
	const p = decodeURIComponent(new URL(url, pathToFileURL(process.cwd() + "/")).pathname);
	const b = readFileSync(p);
	return { ok: true, status: 200, json: async () => JSON.parse(b.toString()),
		arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};
const cwd = process.cwd();
const { loadShared, loadQuantity, predict } = await import(cwd + "/assets/js/baqaro-emulator.js");
const { loadClustering, clusteringCurve } = await import(cwd + "/assets/js/baqaro-clustering.js");

const FID = [-1.235476, 0.832736, 0.507524, 5.894683, -6.469369, 0.505643];
const shared = await loadShared(emuDir);
const qhmf = await loadQuantity(emuDir, "qhmf", shared);
const flat = predict(qhmf, FID);
const clu = await loadClustering(emuDir);

const [nz, nThr, nM] = qhmf.outputShape;
let worstRel = 0, worstWhere = "";
for (const [key, panel] of Object.entries(clu.panels)) {
	const iz = panel.z_emulator_index, it = clu.threshold_index;
	// Feed the port the SAME float64 QHMF the reference was built from, so
	// this gate tests the clustering chain alone. The emulator port has its
	// own gate (check_js_emulator.mjs); mixing them here would hide a real
	// clustering bug inside the emulator's float32 storage budget.
	const slice = panel.reference_qhmf_slice;
	const base = (iz * nThr + it) * nM;
	const viaEmulator = Array.from(flat.subarray(base, base + nM));
	let qhmfDrift = 0;
	for (let i = 0; i < slice.length; i++) {
		qhmfDrift = Math.max(qhmfDrift, Math.abs(viaEmulator[i] - slice[i]));
	}

	const t0 = process.hrtime.bigint();
	const got = clusteringCurve(panel, qhmf.axes.log_bins, slice);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;

	const want = panel.reference_wp_rp;
	let rel = 0, absw = 0;
	const scale = Math.max(...want.map(Math.abs));
	for (let i = 0; i < want.length; i++) {
		const d = Math.abs(got[i] - want[i]) / scale;      // scaled: wp spans decades
		if (d > rel) rel = d;
		absw = Math.max(absw, Math.abs(got[i] - want[i]));
	}
	if (rel > worstRel) { worstRel = rel; worstWhere = `z=${key}`; }
	console.log(`  z=${key.padEnd(4)} ${panel.kind.padEnd(5)} ${String(want.length).padStart(2)} rp bins  ` +
		`${ms.toFixed(1).padStart(5)} ms   max|Δ|/scale = ${rel.toExponential(2)}` +
		`   (QHMF via JS emulator differs by ${qhmfDrift.toExponential(1)} dex)`);
}
const TOL = 1e-6;
console.log(`\n  worst ${worstRel.toExponential(2)} at ${worstWhere}  (limit ${TOL})`);
if (!(worstRel <= TOL)) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
