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
import { drawPanel, trustedSpan, TOL, zColour, FLOOR_MARGIN } from "./baqaro-plot.js";
import { erdfRelation, lightcurve, runningMean, lambdaEdd, growthTrack } from "./baqaro-physics.js";
import { loadClustering, clusteringCurve } from "./baqaro-clustering.js";

const BASE = "assets/emulator";
export const FIDUCIAL = [-1.235476, 0.832736, 0.507524, 5.894683, -6.469369, 0.505643];

// Paper notation, not the code's internal names. Readers arrive from the
// paper, and a slider called "std_0" is not findable in Table 1.
export const LABELS = {
	log_eta_mean_0:    "log η_av,0 · mean η_acc at sṀ_cold = 1 Gyr⁻¹",
	log_eta_mean_evol: "η_av,slope · how that mean tracks sṀ_cold",
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
export const toDisplay = (name, v) => (DISPLAY[name] ? DISPLAY[name].to(v) : v);

/** Which sliders actually do anything on each panel. The rest are dimmed. */
const RELEVANT = {
	qlf: [0, 1, 2, 3, 4, 5], bhmf: [0, 1, 2, 3, 4, 5],
	cerdf: [0, 1, 2, 3, 4, 5], qhmf: [0, 1, 2, 3, 4, 5],
	clustering: [0, 1, 2, 3, 4, 5],
	accretion: [0, 1, 2], seeding: [4, 5], variability: [0, 1, 2, 3],
};

const EMULATED = {
	qlf:   { title: "Quasar luminosity function",
	         x: "log₁₀ L_bol  [erg s⁻¹]", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -9.5, yMax: -2.5 },
	bhmf:  { title: "Black hole mass function",
	         x: "log₁₀ M_BH  [M☉]", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -9.5, yMax: -2 },
	cerdf: { title: "Conditional Eddington-ratio distribution",
	         x: "log₁₀ λ_Edd   (Eddington ratio)", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -9.5, yMax: -5 },
	qhmf:  { title: "Quasar host halo mass function",
	         x: "log₁₀ M_halo  [M☉]", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -9.5, yMax: -5 },
};

// Chosen so every default curve has measurements against it: the z = 0 slice
// has none, because the uniqueness guard gives the z = 0.2 data to z = 0.261.
/** Whole redshifts 1 to 6; each has a snapshot within 0.15. */
const DEFAULT_Z = [1, 2, 3, 4, 5, 6];
/** How many curves one panel may carry before it stops reading as a plot. */
const MAX_Z = 7;
const Z_AXIS = [7.315, 6.708, 6.145, 5.377, 5.024, 4.532, 3.937, 3.534,
	3.0, 2.5, 2.0, 1.5, 1.0, 0.741, 0.5, 0.261, 0.0];

const state = {
	shared: null, emus: {}, fiducialCache: {}, population: null, obs: null,
	clustering: null, clusterZ: "4.0",
	showObs: true,
	panel: "qlf", theta: FIDUCIAL.slice(), zPicked: null, iThreshold: 0,
	clusterThreshold: null, cerdfObs: null,
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
	// only the monotone-declining quantities may demand signal at the left edge
	const opts = { requireLeft: emu.name === "qlf" || emu.name === "bhmf" };
	const flat = predict(emu, state.theta);
	const fid = state.fiducialCache[emu.name];

	// A null span means the curve is on the floor, or is only a narrow artefact.
	// Skip it rather than pass it on: drawPanel falls back to the FULL range when
	// span is absent, which would draw the very thing we set out to suppress.
	const curves = [];
	let dropped = 0;
	state.zPicked.forEach((iz) => {
		const y = slice(fid, iz);
		const span = trustedSpan(y, emu.floorValue, opts);
		if (span) curves.push({ y, span, colour: zColour(Z_AXIS[iz]), dashed: true });
	});
	state.zPicked.forEach((iz) => {
		const y = slice(flat, iz);
		const span = trustedSpan(y, emu.floorValue, opts);
		if (!span) { dropped++; return; }
		curves.push({
			y, span, colour: zColour(Z_AXIS[iz]),
			label: `z = ${emu.axes.redshift[iz].toFixed(1)}`,
		});
	});

	// Never clip a drawn curve. cerdf and qhmf peak at about -4.5 at the best fit
	// but reach -1 in corners of the box, so a fixed top cuts them off; grow the
	// axis to the next half-dex instead, and keep the default when it is enough.
	const spec = {
		xs, xLabel: cfg.x, yLabel: cfg.y,
		xMin: xs[0], xMax: xs[xs.length - 1], yMin: cfg.yMin, yMax: cfg.yMax,
		curves, points: [], title: cfg.title, dropped,
	};

	// The measurements.
	//
	// Keyed by EMULATOR SLICE INDEX, not by redshift: which dataset constrains
	// which slice is decided by the likelihood (nearest within 0.4, plus a
	// uniqueness guard so one dataset cannot bind to two slices), and that
	// binding is computed once at export time rather than re-derived here,
	// where it could drift out of agreement with the fit.
	//
	// Two kinds, kept visually distinct because they are not interchangeable:
	// SQUARES are the binned values the likelihood evaluates; faint circles are
	// the individual survey measurements behind them, context only.
	const obs = state.obs && state.obs[emu.name];
	if (obs) {
		state.zPicked.forEach((iz, k) => {
			const entry = obs[String(iz)];
			if (!entry) return;                       // this slice is not constrained
			const colour = zColour(Z_AXIS[iz]);
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

	// Never clip a drawn series. cerdf and qhmf peak near -4.5 at the best fit but
	// reach -1 in corners of the box, and the scaled measurements can sit above
	// the model, so the top has to be decided AFTER everything is in.
	let top = cfg.yMax;
	spec.curves.forEach((c) => {
		const [a, b] = c.span || [0, c.y.length - 1];
		for (let j = a; j <= b; j++) if (c.y[j] > top) top = c.y[j];
	});
	spec.points.forEach((pt) => pt.y.forEach((v) => { if (isFinite(v) && v > top) top = v; }));
	spec.yMax = Math.max(cfg.yMax, Math.ceil((top + 0.25) * 2) / 2);

	return spec;
}

/**
 * The cERDF as a normalised distribution, which is how the reference implementation compares it.
 *
 * The number-density panel answers "how many"; this one answers "what shape",
 * and only the shape can be set against the measurements. The observed
 * histogram is a density (24 bins over [-3, 1.5], density=True), so the model
 * is divided by its own integral to match, rather than the measurements being
 * scaled up to the model as if their normalisation meant something.
 */
function cerdfShapeSpec() {
	const emu = state.emus.cerdf;
	const cobs = state.cerdfObs;
	if (!emu) return null;
	const xs = emu.axes.log_bins;
	const dx = xs[1] - xs[0];
	const [, nThr, nBin] = emu.outputShape;
	const flat = predict(emu, state.theta);

	const curves = [], points = [];
	state.zPicked.forEach((iz) => {
		const base = (iz * nThr + state.iThreshold) * nBin;
		const row = flat.subarray(base, base + nBin);
		let area = 0;
		for (let j = 0; j < nBin; j++) {
			if (row[j] > emu.floorValue + FLOOR_MARGIN) area += Math.pow(10, row[j]);
		}
		area *= dx;
		if (!(area > 0)) return;
		// zero, not NaN: a density that is simply zero out there should close the
		// curve down to the axis rather than leave it hanging in mid-air
		const y = Float64Array.from(row, (v) =>
			v > emu.floorValue + FLOOR_MARGIN ? Math.pow(10, v) / area : 0);
		curves.push({ y, colour: zColour(Z_AXIS[iz]),
			label: `z = ${emu.axes.redshift[iz].toFixed(1)}` });

		if (cobs && cobs.meta.counts[iz][state.iThreshold] >= cobs.meta.min_count) {
			const off = (iz * cobs.meta.n_thr + state.iThreshold) * cobs.meta.n_bins;
			const h = cobs.hist.subarray(off, off + cobs.meta.n_bins);
			// every bin, including the empty ones: dropping them leaves an uneven
			// x spacing, and steps-mid then draws each block the wrong width
			curves.push({ x: cobs.meta.bin_centres, y: Array.from(h),
				colour: zColour(Z_AXIS[iz]), step: true, dotted: true });
		}
	});

	return {
		xs, xLabel: "log₁₀ λ_Edd   (Eddington ratio)", yLabel: "probability density  [dex⁻¹]",
		// fixed, so a slider moves the curves and not the frame. 2.2 covers the
		// observed densities, which peak at 1.2 typically and reach 3.
		xMin: xs[0], xMax: xs[xs.length - 1], yMin: 0, yMax: 2.2,
		curves, points: [], legendLeft: true, legendCols: 2,
		title: "Conditional Eddington-ratio distribution",
	};
}

function clusteringSpec() {
	const clu = state.clustering;
	const panel = clu && clu.panels[state.clusterZ];
	const emu = state.emus.qhmf;
	if (!panel || !emu) return null;

	const [, nThr, nM] = emu.outputShape;
	const iThr = state.clusterThreshold ?? panel.threshold_index ?? clu.threshold_index;
	const cut = (theta) => {
		const flat = theta === FIDUCIAL
			? state.fiducialCache.qhmf : predict(emu, theta);
		const base = (panel.z_emulator_index * nThr + iThr) * nM;
		return Array.from(flat.subarray(base, base + nM));
	};

	const wp = clusteringCurve(panel, emu.axes.log_bins, cut(state.theta));
	const wpFid = clusteringCurve(panel, emu.axes.log_bins, cut(FIDUCIAL));
	const obs = panel.obs;
	const kind = panel.kind === "cross" ? "cross-correlation" : "auto-correlation";

	// A fixed decade range: an axis that rescales on every slider move makes it
	// impossible to see whether the curve moved or the axis did. The cross panel
	// is the volume-averaged xi, a different quantity from w_p/r_p, so it gets
	// its own range and its own label.
	const isCross = panel.kind === "cross";
	const yMin = isCross ? 1e-1 : 1e-2, yMax = 1e3;

	return {
		xs: panel.rpbins, logX: true, logY: true,
		xLabel: "r_p  [cMpc]",
		yLabel: isCross ? "χ_V   (volume-averaged ξ)" : "w_p(r_p) / r_p",
		xMin: Math.min(panel.rpbins[0], obs.x[0]) * 0.8,
		xMax: Math.max(panel.rpbins[panel.rpbins.length - 1], obs.x[obs.x.length - 1]) * 1.2,
		yMin, yMax,
		curves: [
			{ y: wpFid, colour: zColour(panel.z), dashed: true },
			{ y: wp, colour: zColour(panel.z),
			  label: `z = ${panel.z}, ${kind}, L > 10^${(panel.log_L_threshold ?? 46.5).toFixed(1)} erg/s` },
		],
		points: [{ x: obs.x, y: obs.y, err_up: obs.err, err_down: obs.err,
			colour: zColour(panel.z), square: true, size: 3.4 }],
		legendLeft: true,
		title: `Quasar clustering at z = ${panel.z}: ${obs.label}`,
	};
}

/**
 * eta_acc against the host's cold specific accretion rate.
 *
 * Axes and reference lines follow figures_paper/bh_specific_rate_vs_halo_rate.pdf.
 * NOTE eta_acc is Mdot_BH,acc / Mdot_Edd, a dimensionless ACCRETION RATE, not the
 * Eddington ratio L/L_Edd: with a variable radiative efficiency the two differ.
 *
 * The 1:1 line of that figure (BH specific rate = cold halo specific rate) sits
 * here at y = x - log10(1/t_Sal0) with 1/t_Sal0 = inv_t_Edd_Gyr/eps0 ~= 22.2/Gyr,
 * because the paper's left axis is the specific rate and this one is eta_acc.
 */
export function accretionSpec(theta, population) {
	const xs = linspace(-3.2, 1.6, 200);
	const cur = erdfRelation(theta, xs);
	const fid = erdfRelation(FIDUCIAL, xs);
	const spec = {
		xs,
		xLabel: "log₁₀ sṀ_cold   (how fast the halo accretes)",
		yLabel: "log₁₀ η_acc   (how fast the black hole accretes)",
		xMin: -3.2, xMax: 1.6, yMin: -5, yMax: 1.5,
		bands: [
			{ lo: cur.lo2, hi: cur.hi2, colour: TOL[0], alpha: 0.10 },
			{ lo: cur.lo1, hi: cur.hi1, colour: TOL[0], alpha: 0.18 },
		],
		curves: [
			// accreting at the Eddington rate; labelled in place, not in the legend
			{ x: [-3.2, 1.6], y: [0, 0], colour: "#8b1a1a", dashed: true },
			{ y: fid.mu, colour: TOL[0], dashed: true },
			{ y: cur.mu, colour: TOL[0], label: "mean" },
		],
		annotations: [
			{ x: -3.05, y: -0.08, text: "η_acc = 1", colour: "#8b1a1a", baseline: "top" },
		],
		points: [], legendLeft: true, title: "Accretion rate vs cold gas supply",
	};

	// where the real population sits, one point per snapshot, coloured by redshift
	// The population grid is dense and uneven at low z (41 snapshots, 13 of them
	// below z = 1.5), which bunches the points. Take the snapshot nearest each
	// whole redshift instead, so they read as an evenly spaced sequence.
	const pop = population;
	if (pop) {
		const wanted = [0, 1, 2, 3, 4, 5, 6, 7, 8];
		const picked = new Set(wanted.map((zt) => pop.redshift.reduce(
			(best, z, i) => (Math.abs(z - zt) < Math.abs(pop.redshift[best] - zt) ? i : best), 0)));
		let first = null;
		[...picked].sort((a, b) => a - b).forEach((i) => {
			const med = pop.accreting[i][3];              // p50 of log sṀ_cold
			if (med == null) return;
			const y = theta[0] + theta[1] * med;
			if (first === null) first = [med, y];
			spec.points.push({ x: [med], y: [y], colour: zColour(pop.redshift[i]) });
		});
		if (first) spec.curves.push({ colour: TOL[6], marker: true,
			label: "population median, z = 0 → 8" });
	}
	return spec;
}

/**
 * What the history above builds, in physical units.
 *
 * M_BH and L_bol cannot share a scale, so the mass is on the left axis and the
 * luminosity on the right, as in plotting_lightcurves_highz.py. The track
 * starts at 10^8 Msun, a black hole in the quasar epoch rather than a seed, so
 * the luminosities that come out of it are the ones a survey would see.
 */
const M_START_DEX = 8.0;

export function growthSpec(theta) {
	const W = 100, SEED = 21;   // the same realisation as the panel above
	const lucky = growthTrack(theta, { windowMyr: W, seed: SEED });
	const meanEta = Math.pow(10, lucky.lc.mu + 0.5 * Math.LN10 * theta[2] * theta[2]);
	const steady = growthTrack(theta, { windowMyr: W, seed: SEED, steadyEta: meanEta });

	const mass = Float64Array.from(lucky.y, (g) => M_START_DEX + g);
	const massSteady = Float64Array.from(steady.y, (g) => M_START_DEX + g);
	// L_bol = lambda_Edd * L_Edd(M) ; log10 L_Edd/erg/s = log10 M + 38.1
	const LOGL_EDD = 38.1;
	const lbol = Float64Array.from(lucky.lc.y, (ly, j) =>
		mass[j] + LOGL_EDD + Math.log10(Math.max(lambdaEdd(Math.pow(10, ly)), 1e-12)));

	const span = (arr, padLo, padHi) => {
		let lo = Infinity, hi = -Infinity;
		arr.forEach((v) => { if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } });
		return [lo - padLo, hi + padHi];
	};
	const [mLo, mHi] = span([...mass, ...massSteady], 0.03, 0.06);
	const [lLo, lHi] = span(lbol, 0.3, 0.5);

	return {
		xs: lucky.t, xLabel: "time  [Myr]", yLabel: "log₁₀ M_BH  [M☉]",
		xMin: 0, xMax: W, yMin: mLo, yMax: mHi,
		yMinR: lLo, yMaxR: lHi, yLabelR: "log₁₀ L_bol  [erg s⁻¹]", colourR: COL_LBOL,
		curves: [
			{ x: lucky.t, y: lbol, colour: COL_LBOL, axis: "right", label: "L_bol" },
			{ x: lucky.t, y: mass, colour: COL_MASS, label: "M_BH" },
			{ x: steady.t, y: massSteady, colour: COL_MASS, dashed: true, width: 2.2,
			  alpha: 0.9, label: "M_BH at the average rate" },
		],
		legendLeft: true, legendCols: 3,
		title: "What that history builds",
	};
}

/**
 * Distribution of black hole masses at seeding.
 *
 * Halos enter the merger tree just above the resolution limit, so their mass at
 * first appearance is narrow: measured over a 84k-halo sample of the fiducial
 * run, log10 M_halo has median 10.46 and a 16-84 range of only 10.43-10.53.
 * That is the histogram below, and it is why the pivot is quoted at 10^10.5.
 *
 * Convolving it with the lognormal seed scatter gives the seed mass function,
 * which is what a reader actually wants to see: nearly all of its width comes
 * from sigma_seed rather than from the halos.
 */
const HALO_BIRTH_LO = 10.2, HALO_BIRTH_HI = 11.4;
const HALO_BIRTH_W = [0.00476, 0.00637, 0.01468, 0.03692, 0.40650, 0.27803,
	0.13658, 0.06052, 0.03285, 0.01374, 0.00573, 0.00222, 0.00072, 0.00030,
	0.00006, 0.00001, 0, 0, 0, 0, 0, 0, 0, 0];

/** Seed-mass PDF: the measured halo histogram smeared by the seed scatter. */
function seedMassPdf(theta, xs) {
	const logF = theta[4], s = Math.max(theta[5], 1e-3);
	const dh = (HALO_BIRTH_HI - HALO_BIRTH_LO) / HALO_BIRTH_W.length;
	const norm = 1 / (s * Math.sqrt(2 * Math.PI));
	const y = new Float64Array(xs.length);
	for (let k = 0; k < HALO_BIRTH_W.length; k++) {
		const wk = HALO_BIRTH_W[k];
		if (!wk) continue;
		const mu = HALO_BIRTH_LO + (k + 0.5) * dh + logF;
		for (let j = 0; j < xs.length; j++) {
			const u = (xs[j] - mu) / s;
			y[j] += wk * norm * Math.exp(-0.5 * u * u);
		}
	}
	return y;
}

/**
 * @param bhmf optional {log_m, log_phi} for the z = 0 mass function, as a
 *   reference. Seeds and present-day black holes are the same objects, so the
 *   seed PDF is scaled to the same integrated number density: the two curves
 *   are then directly comparable, and the gap between them is 13 Gyr of growth.
 */
export function seedingSpec(theta, bhmf) {
	const xs = linspace(1, 11.5, 320);
	const dx = xs[1] - xs[0];

	let nTot = 1;
	if (bhmf) {
		const dm = bhmf.log_m[1] - bhmf.log_m[0];
		nTot = bhmf.log_phi.reduce((s, lp) => s + Math.pow(10, lp) * dm, 0);
	}
	const asPhi = (pdf) => Float64Array.from(pdf, (v) => Math.log10(Math.max(v * nTot, 1e-30)));
	const cur = asPhi(seedMassPdf(theta, xs));
	const fid = asPhi(seedMassPdf(FIDUCIAL, xs));

	const curves = [
		{ y: fid, colour: TOL[2], dashed: true },
		{ y: cur, colour: TOL[2], label: "at seeding" },
	];
	if (bhmf) {
		// fixed: the released best fit, so it does not follow the sliders
		curves.push({ x: bhmf.log_m, y: bhmf.log_phi, colour: TOL[5], dashed: true,
			label: `at z = ${bhmf.z} (best fit)` });
	}
	return {
		xs,
		xLabel: "log₁₀ M_BH  [M☉]",
		yLabel: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]",
		xMin: 1, xMax: 11.5, yMin: -9.5, yMax: 0,
		curves, legendLeft: true,
		title: "Seeding: where black holes start, and where they end up",
	};
}

// Colours from plotting_lightcurves_highz.py, so the panel and the paper's
// lightcurve figure read the same way: eta_acc grey behind, lambda_Edd purple.
const COL_MDOT = "#a6a6a6", COL_ETA = "#5e4fa2", COL_MASS = "#a00c1d", COL_LBOL = "#06437F";
// The "average" reference lines (running mean, long-run value, mass at the
// average rate). TOL[3] mustard was too light to see against the noise.
const COL_AVG = "#b8860b";

export function variabilitySpec(theta) {
	const W = 100;
	// seed 21: opens with two strongly high draws (z = 2.1, 1.5), so the average
	// starts ABOVE the long-run value, and it is still ahead at 100 Myr (1.16x the
	// mass the average rate would build). Both halves matter: a seed that starts
	// high and ends behind would contradict the growth panel below it.
	const SEED = 21;
	const cur = lightcurve(theta, { windowMyr: W, seed: SEED });
	const mean = runningMean(theta, { windowMyr: W, seed: SEED });
	const lam = Float64Array.from(cur.y, (ly) => Math.log10(Math.max(lambdaEdd(Math.pow(10, ly)), 1e-10)));

	// What the average converges to given unlimited time: the ARITHMETIC mean of
	// the lognormal, mu + ln(10) sigma^2 / 2 in log10.
	const logMeanEta = cur.mu + 0.5 * Math.LN10 * theta[2] * theta[2];

	return {
		xs: cur.t, xLabel: "", yLabel: "log₁₀ η_acc ,  log₁₀ λ_Edd",
		xMin: 0, xMax: W, yMin: -2.5, yMax: 2,
		curves: [
			{ x: cur.t, y: cur.y, colour: COL_MDOT, label: "η_acc" },
			{ x: cur.t, y: lam, colour: COL_ETA, label: "λ_Edd" },
			{ x: cur.t, y: mean, colour: COL_AVG, width: 2.6, label: "η_acc averaged so far" },
			{ x: [0, W], y: [logMeanEta, logMeanEta], colour: COL_AVG, dashed: true,
			  width: 2.2, alpha: 0.95, label: "its long-run value (population average)" },
			// last, so with 5 entries over 3 columns it sits alone on the right
			{ x: [0, W], y: [0, 0], colour: "#c0c0c0", dotted: true, label: "η_acc = 1" },
		],
		legendLeft: true, legendCols: 3,
		padRight: 62,          // match the growth panel's right axis, so the two align
		title: `Accretion history: ${cur.nBlocks < 1 ? "less than one" : Math.round(cur.nBlocks)} independent draw${Math.round(cur.nBlocks) === 1 ? "" : "s"} in ${W} Myr`,
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
			state.clusterThreshold = null;   // fall back to this dataset's own cut
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
		b.style.setProperty("--zc", zColour(z));
		b.textContent = z.toFixed(1);
		b.addEventListener("click", () => {
			const at = state.zPicked.indexOf(k);
			if (at >= 0) { if (state.zPicked.length > 1) state.zPicked.splice(at, 1); }
			else if (state.zPicked.length < MAX_Z) state.zPicked.push(k);
			state.zPicked.sort((a, c) => a - c);
			zEl.querySelectorAll("[data-zkind=emul]").forEach((el, idx) =>
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
			// the observed cERDF: 37 KB, only fetched if that panel is opened
			if (state.panel === "cerdf" && !state.cerdfObs) {
				try {
					const [meta, buf] = await Promise.all([
						fetch(`${BASE}/cerdf_obs.json`).then((r) => r.json()),
						fetch(`${BASE}/cerdf_obs.bin`).then((r) => r.arrayBuffer()),
					]);
					state.cerdfObs = { meta, hist: new Float32Array(buf) };
				} catch { /* the panel is still useful without the measurements */ }
			}
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

	const showThr = (i) => {
		thrEl.value = i;
		thrEl.nextElementSibling.textContent = `L > 10^${(45.5 + 0.1 * i).toFixed(1)} erg/s`;
	};
	thrEl.addEventListener("input", () => {
		const i = parseInt(thrEl.value, 10);
		if (state.panel === "clustering") state.clusterThreshold = i;
		else state.iThreshold = i;
		showThr(i);
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
		thrWrap.hidden = isClustering
			? false
			: (!isEmu || emu.outputShape.length !== 3);
		// each panel remembers its own threshold, so switching tabs restores it
		if (!thrWrap.hidden) {
			// the panel's own cut, not the manifest-wide one: each measurement has a
			// different luminosity selection
			const cpanel = state.clustering?.panels?.[state.clusterZ];
			showThr(isClustering
				? (state.clusterThreshold ?? cpanel?.threshold_index
				   ?? state.clustering?.threshold_index ?? 10)
				: state.iThreshold);
		}
		zEl.classList.toggle("cluster-mode", isClustering);
		zEl.querySelectorAll("[data-zkind=emul]").forEach((el) => { el.hidden = isClustering; });
		zEl.querySelectorAll("[data-zkind=clust]").forEach((el) => { el.hidden = !isClustering; });

		// dim the sliders this panel does not respond to
		const live = RELEVANT[state.panel] || [];
		rows.forEach(({ row }, i) => row.classList.toggle("muted", !live.includes(i)));

		const t0 = performance.now();
		const spec = state.panel === "cerdf" ? cerdfShapeSpec()
			: isEmu ? emulatedSpec(emu)
			: state.panel === "clustering" ? clusteringSpec()
			: state.panel === "accretion" ? accretionSpec(state.theta, state.population)
			: state.panel === "seeding" ? seedingSpec(state.theta)
			: variabilitySpec(state.theta);
		if (!spec) return;
		drawPanel(canvas, spec);

		timingEl.textContent = `${(performance.now() - t0).toFixed(1)} ms`;

		titleEl.textContent = spec.title;

		const bad = outOfBounds(state.shared, state.theta)
			.filter((i) => live.includes(i));
		warnEl.hidden = bad.length === 0;
		if (bad.length) {
			warnEl.textContent =
				"Outside the training box: the emulator is extrapolating here and is not calibrated.";
		}
	}

	await ensureQuantity("qlf", statusEl);
	render();
	window.addEventListener("resize", schedule);
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
}
