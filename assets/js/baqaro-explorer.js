/**
 * Interactive BAQARO explorer.
 *
 * Two families of panel, driven by the same six sliders:
 *
 *   FITTED STATISTICS  -- run the released Gaussian-process emulators in the
 *                         browser and show what the model predicts.
 *   MODEL INGREDIENTS  -- the accretion, seeding and variability prescriptions
 *                         in closed form, so you can see WHY the statistics
 *                         move the way they do.
 *
 * A dashed ghost of the best fit is kept on every panel: a slider's effect is
 * only legible next to what it changed from.
 */

import { loadShared, loadQuantity, predict, outOfBounds } from "./baqaro-emulator.js";
import { drawPanel, trustedSpan, TOL } from "./baqaro-plot.js";
import { erdfRelation, seedRelation, lightcurve, runningMean } from "./baqaro-physics.js";
import { loadClustering, clusteringCurve } from "./baqaro-clustering.js";

const BASE = "assets/emulator";
const FIDUCIAL = [-1.235476, 0.832736, 0.507524, 5.894683, -6.469369, 0.505643];

// Paper notation, not the code's internal names. Readers arrive from the
// paper, and a slider called "std_0" is not findable in Table 1.
const LABELS = {
	log_eta_mean_0:    "log η_av,0 · mean accretion rate at sṀ = 1 Gyr⁻¹",
	log_eta_mean_evol: "η_av,slope · how that mean tracks the cold-gas supply",
	std_0:             "σ_acc · scatter in accretion rate [dex]",
	logtcoherence:     "log τ_coherence · coherence time of accretion [log yr]",
	logfseed:          "log M_seed · seed mass at the pivot halo mass [log M☉]",
	sigmaseed:         "σ_seed · scatter in seed mass [dex]",
};

/**
 * Display transforms between the code's parameters and the paper's.
 *
 * The seeding parameter is the same relation written two ways. The code stores
 * f_seed, the ratio M_BH/M_halo at seeding; the paper quotes M_seed, the seed
 * mass at the pivot halo mass 10^10.5 M_sun, because that is a mass a reader
 * can hold in their head. They differ by exactly the pivot:
 *
 *     log10 M_seed = log10 f_seed + 10.5
 *
 * Verified against the paper's Table 1 at both ends: the fiducial -6.4694 maps
 * to 4.03, and the prior [-7.5, -3.5] maps to [3.0, 7.0].
 */
const SEED_PIVOT_DEX = 10.5;
const DISPLAY = {
	logfseed: { to: (v) => v + SEED_PIVOT_DEX, from: (v) => v - SEED_PIVOT_DEX },
};
const toDisplay = (name, v) => (DISPLAY[name] ? DISPLAY[name].to(v) : v);

/** Which sliders actually do anything on each panel. The rest are dimmed. */
const RELEVANT = {
	qlf: [0, 1, 2, 3, 4, 5], bhmf: [0, 1, 2, 3, 4, 5],
	cerdf: [0, 1, 2, 3, 4, 5], qhmf: [0, 1, 2, 3, 4, 5],
	clustering: [0, 1, 2, 3, 4, 5],
	accretion: [0, 1, 2], seeding: [4, 5], variability: [0, 1, 2, 3],
};

const EMULATED = {
	qlf:   { title: "Quasar luminosity function",
	         x: "log₁₀ L_bol  [erg s⁻¹]", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -10, yMax: -2.5 },
	bhmf:  { title: "Black hole mass function",
	         x: "log₁₀ M_BH  [M☉]", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -11, yMax: -2 },
	cerdf: { title: "Conditional Eddington-ratio distribution",
	         x: "log₁₀ η  (accretion ratio)", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -10, yMax: -5 },
	qhmf:  { title: "Quasar host halo mass function",
	         x: "log₁₀ M_halo  [M☉]", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -10, yMax: -5 },
};

const NOTES = {
	qlf: "How many quasars there are at each luminosity — the primary constraint on the fit. Squares are the binned points the likelihood evaluates; faint circles are the individual survey measurements behind them.",
	bhmf: "The mass function of ALL black holes, not just the active ones — most of the population is dark. The measurements are of ACTIVE black holes only, so they are a lower bound on this curve, not a target.",
	cerdf: "How fast black holes accrete at fixed luminosity. The model's known weak spot: this distribution comes out 1.5–2× too broad.",
	qhmf: "Which halos host the quasars. Together with clustering, this is what pins the seeding.",
	clustering: "How strongly quasars cluster — the third dataset in the fit, and the one that pins the coherence time. Computed the full way: the host halo mass function is pushed through the simulation's halo-halo correlation triangle and projected along the line of sight, exactly as the likelihood does it. At z = 6.1 it is the quasar–galaxy CROSS-correlation measured by EIGER, not an auto-correlation.",
	accretion: "The whole accretion prescription: log η_acc is drawn from a lognormal whose mean is a power law in the host's cold-gas supply, with scatter independent of it. η_av,0 sets the height, η_av,slope the slope, σ_acc the width. Points are where the real population sits, from the released run — the line is not fitted to them, it IS the same prescription.",
	seeding: "A black hole is seeded in each halo as it enters the merger tree, with a mass scaling linearly with the host halo mass and lognormal scatter. M_seed is quoted at the pivot halo mass 10^10.5 M☉ — the median mass of a halo at first appearance. This is an empirical anchor marking where a growth track starts, NOT a physical seed mass.",
	variability: "The accretion rate is held fixed for one coherence time and then redrawn — a piecewise-constant process, the simplest history consistent with the one-point distribution. Short τ averages away and grows black holes smoothly; long τ leaves growth to a few rare bursts. The fit lands at τ ≈ 0.8 Myr, and this is where the rare billion-solar-mass black holes come from.",
};

// Chosen so every default curve has measurements against it: the z = 0 slice
// has none, because the uniqueness guard gives the z = 0.2 data to z = 0.261.
const DEFAULT_Z = [0.261, 2.0, 4.0, 6.0];
const Z_AXIS = [7.315, 6.708, 6.145, 5.377, 5.024, 4.532, 3.937, 3.534,
	3.0, 2.5, 2.0, 1.5, 1.0, 0.741, 0.5, 0.261, 0.0];

const state = {
	shared: null, emus: {}, fiducialCache: {}, population: null, obs: null,
	clustering: null, clusterZ: "4.0",
	showObs: true,
	panel: "qlf", theta: FIDUCIAL.slice(), zPicked: null, iThreshold: 0,
};

const linspace = (a, b, n) =>
	Float64Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

function emulatedSpec(emu) {
	const cfg = EMULATED[emu.name];
	const xs = emu.axes.log_bins;
	const shape = emu.outputShape, nBin = shape[shape.length - 1];
	const threeD = shape.length === 3;
	const nThr = threeD ? shape[1] : 1;

	const slice = (flat, iz) => {
		const base = threeD ? (iz * nThr + state.iThreshold) * nBin : iz * nBin;
		return flat.subarray(base, base + nBin);
	};
	const flat = predict(emu, state.theta);
	const fid = state.fiducialCache[emu.name];

	const curves = [];
	state.zPicked.forEach((iz, k) => {
		const y = slice(fid, iz);
		curves.push({ y, span: trustedSpan(y, emu.floorValue), colour: TOL[k % TOL.length], dashed: true });
	});
	state.zPicked.forEach((iz, k) => {
		const y = slice(flat, iz);
		curves.push({
			y, span: trustedSpan(y, emu.floorValue), colour: TOL[k % TOL.length],
			label: `z = ${emu.axes.redshift[iz].toFixed(1)}`,
		});
	});

	const spec = {
		xs, xLabel: cfg.x, yLabel: cfg.y,
		xMin: xs[0], xMax: xs[xs.length - 1], yMin: cfg.yMin, yMax: cfg.yMax,
		curves, points: [], title: cfg.title,
	};

	// The measurements.
	//
	// Keyed by EMULATOR SLICE INDEX, not by redshift: which dataset constrains
	// which slice is decided by the likelihood (nearest within 0.4, plus a
	// uniqueness guard so one dataset cannot bind to two slices), and that
	// binding is computed once by scripts/export_web_obsdata.py rather than
	// re-derived here where it could drift out of agreement with the fit.
	//
	// Two kinds, kept visually distinct because they are not interchangeable:
	// SQUARES are the binned values the likelihood evaluates; faint circles are
	// the individual survey measurements behind them, context only.
	const obs = state.obs && state.obs[emu.name];
	if (obs) {
		state.zPicked.forEach((iz, k) => {
			const entry = obs[String(iz)];
			if (!entry) return;                       // this slice is not constrained
			const colour = TOL[k % TOL.length];
			if (entry.raw) {
				spec.points.push({ x: entry.raw.x, y: entry.raw.y, colour, alpha: 0.22, size: 2.2 });
			}
			spec.points.push({
				x: entry.fitted.x, y: entry.fitted.y,
				err_up: entry.fitted.err_up, err_down: entry.fitted.err_down,
				limit: entry.fitted.limit,
				colour, square: true, size: 3.4,
			});
		});
	}
	return spec;
}

function clusteringSpec() {
	const clu = state.clustering;
	const panel = clu && clu.panels[state.clusterZ];
	const emu = state.emus.qhmf;
	if (!panel || !emu) return null;

	const [, nThr, nM] = emu.outputShape;
	const cut = (theta) => {
		const flat = theta === FIDUCIAL
			? state.fiducialCache.qhmf : predict(emu, theta);
		const base = (panel.z_emulator_index * nThr + clu.threshold_index) * nM;
		return Array.from(flat.subarray(base, base + nM));
	};

	const wp = clusteringCurve(panel, emu.axes.log_bins, cut(state.theta));
	const wpFid = clusteringCurve(panel, emu.axes.log_bins, cut(FIDUCIAL));
	const obs = panel.obs;
	const kind = panel.kind === "cross" ? "cross-correlation" : "auto-correlation";

	const finite = [...wp, ...wpFid, ...obs.y].filter((v) => v > 0);
	const yMax = Math.pow(10, Math.ceil(Math.log10(Math.max(...finite))));
	const yMin = Math.max(Math.pow(10, Math.floor(Math.log10(Math.min(...finite)))), yMax * 1e-5);

	return {
		xs: panel.rpbins, logX: true, logY: true,
		xLabel: "r_p  [Mpc/h]", yLabel: "w_p(r_p) / r_p",
		xMin: Math.min(panel.rpbins[0], obs.x[0]) * 0.8,
		xMax: Math.max(panel.rpbins[panel.rpbins.length - 1], obs.x[obs.x.length - 1]) * 1.2,
		yMin, yMax,
		curves: [
			{ y: wpFid, colour: TOL[1], dashed: true },
			{ y: wp, colour: TOL[1], label: `z = ${panel.z}, ${kind}` },
		],
		points: [{ x: obs.x, y: obs.y, err_up: obs.err, err_down: obs.err,
			colour: TOL[1], square: true, size: 3.4 }],
		legendLeft: true,
		title: `Quasar clustering at z = ${panel.z} — ${obs.label}`,
	};
}

function accretionSpec() {
	const xs = linspace(-3.2, 1.6, 200);
	const cur = erdfRelation(state.theta, xs);
	const fid = erdfRelation(FIDUCIAL, xs);
	const spec = {
		xs, xLabel: "log₁₀ sSAR_cold   (how fast the halo is growing)",
		yLabel: "log₁₀ η   (Eddington ratio)",
		xMin: -3.2, xMax: 1.6, yMin: -5, yMax: 1.5,
		bands: [
			{ lo: cur.lo2, hi: cur.hi2, colour: TOL[0], alpha: 0.10 },
			{ lo: cur.lo1, hi: cur.hi1, colour: TOL[0], alpha: 0.18 },
		],
		curves: [
			{ y: fid.mu, colour: TOL[0], dashed: true },
			{ y: cur.mu, colour: TOL[0], label: "mean log η" },
		],
		points: [], legendLeft: true, title: "Accretion rate vs halo growth",
	};

	// where the real population sits, from the released run
	const pop = state.population;
	if (pop) {
		const px = [], py = [];
		pop.redshift.forEach((z, i) => {
			const med = pop.accreting[i][3];              // p50 of log sSAR_cold
			if (med == null) return;
			px.push(med);
			py.push(state.theta[0] + state.theta[1] * med);
		});
		spec.points.push({ x: px, y: py, colour: TOL[1] });
		spec.curves.push({ x: [px[0]], y: [py[0]], colour: TOL[1], label: "population median, z = 0 → 8" });
	}
	return spec;
}

function seedingSpec() {
	const xs = linspace(9.5, 14.5, 120);
	const cur = seedRelation(state.theta, xs);
	const fid = seedRelation(FIDUCIAL, xs);
	return {
		xs, xLabel: "log₁₀ M_halo  [M☉]", yLabel: "log₁₀ M_BH at seeding  [M☉]",
		xMin: 9.5, xMax: 14.5, yMin: 1, yMax: 9,
		bands: [
			{ lo: cur.lo2, hi: cur.hi2, colour: TOL[2], alpha: 0.10 },
			{ lo: cur.lo1, hi: cur.hi1, colour: TOL[2], alpha: 0.18 },
		],
		curves: [
			{ y: fid.med, colour: TOL[2], dashed: true },
			{ y: cur.med, colour: TOL[2], label: "median seed mass" },
		],
		legendLeft: true, title: "Seeding: black hole mass at birth",
	};
}

function variabilitySpec() {
	const W = 200;
	const cur = lightcurve(state.theta, { windowMyr: W });
	const fid = lightcurve(FIDUCIAL, { windowMyr: W });
	const mean = runningMean(state.theta, { windowMyr: W });
	return {
		xs: cur.t, xLabel: "time  [Myr]", yLabel: "log₁₀ η   (Eddington ratio)",
		xMin: 0, xMax: W, yMin: -4, yMax: 2,
		curves: [
			{ x: fid.t, y: fid.y, colour: TOL[5], dashed: true },
			{ x: cur.t, y: cur.y, colour: TOL[5], label: `τ = ${cur.tauMyr.toPrecision(2)} Myr` },
			{ x: cur.t, y: mean, colour: TOL[3], label: "running mean" },
		],
		legendLeft: true,
		title: `Accretion history — ${cur.nBlocks < 1 ? "less than one" : Math.round(cur.nBlocks)} independent draw${Math.round(cur.nBlocks) === 1 ? "" : "s"} in 200 Myr`,
	};
}

// ---------------------------------------------------------------------------

async function ensureQuantity(name, statusEl) {
	if (state.emus[name]) return state.emus[name];
	statusEl.textContent = `loading the ${name.toUpperCase()} emulator…`;
	const emu = await loadQuantity(BASE, name, state.shared);
	state.emus[name] = emu;
	state.fiducialCache[name] = predict(emu, FIDUCIAL);
	statusEl.textContent = "";
	return emu;
}

export async function initExplorer(root) {
	const q = (sel) => root.querySelector(sel);
	const canvas = q("canvas");
	const statusEl = q("[data-role=status]");
	const warnEl = q("[data-role=warning]");
	const timingEl = q("[data-role=timing]");
	const slidersEl = q("[data-role=sliders]");
	const zWrap = q("[data-role=redshift-wrap]");
	const zEl = q("[data-role=redshifts]");
	const thrWrap = q("[data-role=threshold-wrap]");
	const thrEl = q("[data-role=threshold]");
	const titleEl = q("[data-role=title]");
	const noteEl = q("[data-role=note]");

	try {
		statusEl.textContent = "loading the emulator…";
		state.shared = await loadShared(BASE);
	} catch (err) {
		statusEl.textContent = `Could not load the emulator: ${err.message}`;
		return;
	}
	// optional extras: the panels degrade gracefully if either is missing
	try {
		state.population = await (await fetch(`${BASE}/population_ssar.json`)).json();
	} catch { /* the accretion panel simply omits the points */ }
	try {
		state.obs = await (await fetch(`${BASE}/obs_data.json`)).json();
	} catch { /* the predicted panels simply omit the measurements */ }

	const rows = [];
	state.shared.paramNames.forEach((name, i) => {
		const [lo, hi] = state.shared.paramRanges[i];
		const show = (v) => toDisplay(name, v).toFixed(3);
		const row = document.createElement("div");
		row.className = "slider-row";
		row.innerHTML = `
			<label for="p${i}">${LABELS[name] || name}</label>
			<input type="range" id="p${i}" min="${lo}" max="${hi}" step="${(hi - lo) / 400}" value="${FIDUCIAL[i]}">
			<output for="p${i}">${show(FIDUCIAL[i])}</output>`;
		slidersEl.appendChild(row);
		const input = row.querySelector("input"), out = row.querySelector("output");
		rows.push({ row, input, out, show });
		input.addEventListener("input", () => {
			state.theta[i] = parseFloat(input.value);
			out.textContent = show(state.theta[i]);
			schedule();
		});
	});

	state.zPicked = DEFAULT_Z.map((z) =>
		Z_AXIS.reduce((best, v, k) => (Math.abs(v - z) < Math.abs(Z_AXIS[best] - z) ? k : best), 0));
	// one chip per clustering panel -- a different, single-select set
	["2.5", "4.0", "6.1"].forEach((key) => {
		const b = document.createElement("button");
		b.type = "button";
		b.dataset.zkind = "clust";
		b.hidden = true;
		b.className = "zchip" + (key === state.clusterZ ? " on" : "");
		b.textContent = key;
		b.addEventListener("click", () => {
			state.clusterZ = key;
			zEl.querySelectorAll("[data-zkind=clust]").forEach((el) =>
				el.classList.toggle("on", el.textContent === key));
			render();
		});
		zEl.appendChild(b);
	});

	Z_AXIS.forEach((z, k) => {
		const b = document.createElement("button");
		b.type = "button";
		b.dataset.zkind = "emul";
		b.className = "zchip" + (state.zPicked.includes(k) ? " on" : "");
		b.textContent = z.toFixed(1);
		b.addEventListener("click", () => {
			const at = state.zPicked.indexOf(k);
			if (at >= 0) { if (state.zPicked.length > 1) state.zPicked.splice(at, 1); }
			else if (state.zPicked.length < 6) state.zPicked.push(k);
			state.zPicked.sort((a, c) => a - c);
			zEl.querySelectorAll(".zchip").forEach((el, idx) =>
				el.classList.toggle("on", state.zPicked.includes(idx)));
			schedule();
		});
		zEl.appendChild(b);
	});

	root.querySelectorAll("[data-panel]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			root.querySelectorAll("[data-panel]").forEach((b) => b.classList.remove("on"));
			btn.classList.add("on");
			state.panel = btn.dataset.panel;
			if (EMULATED[state.panel]) await ensureQuantity(state.panel, statusEl);
			if (state.panel === "clustering") {
				await ensureQuantity("qhmf", statusEl);
				if (!state.clustering) {
					statusEl.textContent = "loading the clustering triangles (3 MB)…";
					try {
						state.clustering = await loadClustering(BASE);
						statusEl.textContent = "";
					} catch (err) {
						statusEl.textContent = `Could not load the clustering inputs: ${err.message}`;
						return;
					}
				}
			}
			render();
		});
	});

	thrEl.addEventListener("input", () => {
		state.iThreshold = parseInt(thrEl.value, 10);
		thrEl.nextElementSibling.textContent =
			`L > 10^${(45.5 + 0.1 * state.iThreshold).toFixed(1)} erg/s`;
		render();
	});

	q("[data-role=reset]").addEventListener("click", () => {
		state.theta = FIDUCIAL.slice();
		rows.forEach(({ input, out, show }, i) => {
			input.value = FIDUCIAL[i];
			out.textContent = show(FIDUCIAL[i]);
		});
		render();
	});

	let queued = false;
	function schedule() {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => { queued = false; render(); });
	}

	function render() {
		const isEmu = Boolean(EMULATED[state.panel]);
		const emu = state.emus[state.panel];
		if (isEmu && !emu) return;

		const isClustering = state.panel === "clustering";
		zWrap.hidden = !isEmu && !isClustering;
		thrWrap.hidden = !isEmu || emu.outputShape.length !== 3;
		zEl.classList.toggle("cluster-mode", isClustering);
		zEl.querySelectorAll("[data-zkind=emul]").forEach((el) => { el.hidden = isClustering; });
		zEl.querySelectorAll("[data-zkind=clust]").forEach((el) => { el.hidden = !isClustering; });

		// dim the sliders this panel does not respond to
		const live = RELEVANT[state.panel] || [];
		rows.forEach(({ row }, i) => row.classList.toggle("muted", !live.includes(i)));

		const t0 = performance.now();
		const spec = isEmu ? emulatedSpec(emu)
			: state.panel === "clustering" ? clusteringSpec()
			: state.panel === "accretion" ? accretionSpec()
			: state.panel === "seeding" ? seedingSpec()
			: variabilitySpec();
		if (!spec) return;
		drawPanel(canvas, spec);
		timingEl.textContent = `${(performance.now() - t0).toFixed(1)} ms`;

		titleEl.textContent = spec.title;
		noteEl.textContent = NOTES[state.panel] || "";

		const bad = outOfBounds(state.shared, state.theta)
			.filter((i) => live.includes(i));
		warnEl.hidden = bad.length === 0;
		if (bad.length) {
			warnEl.textContent =
				"Outside the training box — the emulator is extrapolating here and is not calibrated.";
		}
	}

	await ensureQuantity("qlf", statusEl);
	render();
	window.addEventListener("resize", schedule);
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
}
