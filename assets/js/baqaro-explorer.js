/**
 * Interactive BAQARO explorer: six sliders, four statistics, no server.
 *
 * Every curve is computed in the browser from the released Gaussian-process
 * emulators (see baqaro-emulator.js). A dashed ghost of the best-fit model
 * stays on the plot so a slider's effect is visible rather than remembered.
 */

import { loadShared, loadQuantity, predict, outOfBounds } from "./baqaro-emulator.js";

const BASE = "assets/emulator";

/** Paul Tol's 'bright' qualitative scheme -- the same colours as the paper. */
const TOL = ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#000000"];

const FIDUCIAL = [-1.235476, 0.832736, 0.507524, 5.894683, -6.469369, 0.505643];

const LABELS = {
	log_eta_mean_0:    "η₀  mean log Eddington ratio",
	log_eta_mean_evol: "η_evol  dependence on halo accretion",
	std_0:             "σ₀  Eddington-ratio scatter [dex]",
	logtcoherence:     "log τ  accretion coherence time [log yr]",
	logfseed:          "log f_seed  seed mass fraction",
	sigmaseed:         "σ_seed  scatter on seed mass [dex]",
};

const AXES = {
	qlf:   { x: "log₁₀ L_bol  [erg s⁻¹]", y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -11, yMax: -4 },
	bhmf:  { x: "log₁₀ M_BH  [M☉]",             y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -11, yMax: -1 },
	cerdf: { x: "log₁₀ η  (accretion ratio)",   y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -11, yMax: -4 },
	qhmf:  { x: "log₁₀ M_halo  [M☉]",           y: "log₁₀ Φ  [Mpc⁻³ dex⁻¹]", yMin: -11, yMax: -4 },
};

const TITLES = {
	qlf: "Quasar luminosity function",
	bhmf: "Black hole mass function",
	cerdf: "Conditional Eddington-ratio distribution",
	qhmf: "Quasar host halo mass function",
};

/** Redshifts offered as curves, chosen to span the range without crowding. */
const DEFAULT_Z = [0, 2, 4, 6];

const state = {
	shared: null,
	emus: {},          // quantity -> loaded emulator
	quantity: "qlf",
	theta: FIDUCIAL.slice(),
	zPicked: null,     // indices into the redshift axis
	iThreshold: 0,
	fiducialCache: {},
};

// ---------------------------------------------------------------------------
// plotting
// ---------------------------------------------------------------------------

function css(name, fallback) {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return v || fallback;
}

function drawPlot(canvas, emu, curves, ghosts) {
	const dpr = window.devicePixelRatio || 1;
	const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
	canvas.width = Math.round(cssW * dpr);
	canvas.height = Math.round(cssH * dpr);
	const g = canvas.getContext("2d");
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, cssW, cssH);

	const ink = css("--text", "#1b1b1b");
	const muted = css("--muted", "#5b6157");
	const grid = css("--border", "rgba(0,0,0,0.08)");

	const pad = { l: 62, r: 14, t: 16, b: 44 };
	const W = cssW - pad.l - pad.r, H = cssH - pad.t - pad.b;
	if (W <= 20 || H <= 20) return;

	const xs = emu.axes.log_bins;
	const ax = AXES[emu.name];
	const xMin = xs[0], xMax = xs[xs.length - 1];
	const yMin = ax.yMin, yMax = ax.yMax;
	const X = (v) => pad.l + ((v - xMin) / (xMax - xMin)) * W;
	const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * H;

	// --- grid + axes ---
	g.strokeStyle = grid; g.lineWidth = 1; g.font = "12px Inter, sans-serif";
	g.fillStyle = muted; g.textAlign = "center"; g.textBaseline = "top";
	const xStep = (xMax - xMin) > 6 ? 1 : 0.5;
	for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) {
		g.beginPath(); g.moveTo(X(v), pad.t); g.lineTo(X(v), pad.t + H); g.stroke();
		g.fillText(Number(v.toFixed(1)), X(v), pad.t + H + 7);
	}
	g.textAlign = "right"; g.textBaseline = "middle";
	for (let v = Math.ceil(yMin); v <= yMax; v += 2) {
		g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(pad.l + W, Y(v)); g.stroke();
		g.fillText(v, pad.l - 8, Y(v));
	}
	g.strokeStyle = muted; g.lineWidth = 1.2;
	g.strokeRect(pad.l, pad.t, W, H);

	// --- axis labels ---
	g.fillStyle = ink; g.font = "13px Inter, sans-serif";
	g.textAlign = "center"; g.textBaseline = "bottom";
	g.fillText(ax.x, pad.l + W / 2, cssH - 4);
	g.save();
	g.translate(14, pad.t + H / 2); g.rotate(-Math.PI / 2);
	g.textBaseline = "top"; g.fillText(ax.y, 0, 0);
	g.restore();

	const clipAndStroke = (vals, colour, dashed) => {
		g.save();
		g.beginPath(); g.rect(pad.l, pad.t, W, H); g.clip();
		g.strokeStyle = colour;
		g.lineWidth = dashed ? 1.4 : 2.2;
		g.setLineDash(dashed ? [5, 4] : []);
		g.globalAlpha = dashed ? 0.55 : 1;
		g.beginPath();
		let started = false;
		for (let j = 0; j < xs.length; j++) {
			const v = vals[j];
			if (!isFinite(v) || v <= yMin + 0.02) { started = false; continue; }
			const px = X(xs[j]), py = Y(v);
			started ? g.lineTo(px, py) : g.moveTo(px, py);
			started = true;
		}
		g.stroke();
		g.restore();
	};

	ghosts.forEach((c, i) => clipAndStroke(c.vals, TOL[i % TOL.length], true));
	curves.forEach((c, i) => clipAndStroke(c.vals, TOL[i % TOL.length], false));

	// --- legend ---
	g.setLineDash([]); g.globalAlpha = 1;
	g.font = "12px Inter, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
	let ly = pad.t + 12;
	curves.forEach((c, i) => {
		g.strokeStyle = TOL[i % TOL.length]; g.lineWidth = 2.2;
		g.beginPath(); g.moveTo(pad.l + W - 96, ly); g.lineTo(pad.l + W - 72, ly); g.stroke();
		g.fillStyle = ink; g.fillText(c.label, pad.l + W - 66, ly);
		ly += 17;
	});
	if (ghosts.length) {
		g.strokeStyle = muted; g.lineWidth = 1.4; g.setLineDash([5, 4]); g.globalAlpha = 0.7;
		g.beginPath(); g.moveTo(pad.l + W - 96, ly); g.lineTo(pad.l + W - 72, ly); g.stroke();
		g.setLineDash([]); g.globalAlpha = 1;
		g.fillStyle = muted; g.fillText("best fit", pad.l + W - 66, ly);
	}
}

// ---------------------------------------------------------------------------
// slicing a flat prediction into per-redshift curves
// ---------------------------------------------------------------------------

function sliceCurves(emu, flat) {
	const shape = emu.outputShape;
	const nBin = shape[shape.length - 1];
	const zs = emu.axes.redshift;
	const threeD = shape.length === 3;
	const nThr = threeD ? shape[1] : 1;
	return state.zPicked.map((iz) => {
		const base = threeD
			? (iz * nThr + state.iThreshold) * nBin
			: iz * nBin;
		return { label: `z = ${zs[iz].toFixed(1)}`, vals: flat.subarray(base, base + nBin) };
	});
}

// ---------------------------------------------------------------------------
// wiring
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
	const canvas = root.querySelector("canvas");
	const statusEl = root.querySelector("[data-role=status]");
	const warnEl = root.querySelector("[data-role=warning]");
	const timingEl = root.querySelector("[data-role=timing]");
	const slidersEl = root.querySelector("[data-role=sliders]");
	const zEl = root.querySelector("[data-role=redshifts]");
	const thrWrap = root.querySelector("[data-role=threshold-wrap]");
	const thrEl = root.querySelector("[data-role=threshold]");
	const titleEl = root.querySelector("[data-role=title]");

	try {
		statusEl.textContent = "loading the emulator…";
		state.shared = await loadShared(BASE);
	} catch (err) {
		statusEl.textContent = `Could not load the emulator: ${err.message}`;
		return;
	}

	// --- sliders ---
	const readouts = [];
	state.shared.paramNames.forEach((name, i) => {
		const [lo, hi] = state.shared.paramRanges[i];
		const row = document.createElement("div");
		row.className = "slider-row";
		row.innerHTML = `
			<label for="p${i}">${LABELS[name] || name}</label>
			<input type="range" id="p${i}" min="${lo}" max="${hi}" step="${(hi - lo) / 400}" value="${FIDUCIAL[i]}">
			<output for="p${i}">${FIDUCIAL[i].toFixed(3)}</output>`;
		slidersEl.appendChild(row);
		const input = row.querySelector("input"), out = row.querySelector("output");
		readouts.push({ input, out });
		input.addEventListener("input", () => {
			state.theta[i] = parseFloat(input.value);
			out.textContent = state.theta[i].toFixed(3);
			schedule();
		});
	});

	// --- redshift checkboxes ---
	const zs = [7.315, 6.708, 6.145, 5.377, 5.024, 4.532, 3.937, 3.534,
		3.0, 2.5, 2.0, 1.5, 1.0, 0.741, 0.5, 0.261, 0.0];
	state.zPicked = DEFAULT_Z.map((z) =>
		zs.reduce((best, v, k) => (Math.abs(v - z) < Math.abs(zs[best] - z) ? k : best), 0));
	zs.forEach((z, k) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "zchip" + (state.zPicked.includes(k) ? " on" : "");
		b.textContent = z.toFixed(1);
		b.addEventListener("click", () => {
			const at = state.zPicked.indexOf(k);
			if (at >= 0) { if (state.zPicked.length > 1) state.zPicked.splice(at, 1); }
			else if (state.zPicked.length < TOL.length) state.zPicked.push(k);
			state.zPicked.sort((a, b2) => a - b2);
			zEl.querySelectorAll(".zchip").forEach((el, idx) =>
				el.classList.toggle("on", state.zPicked.includes(idx)));
			schedule();
		});
		zEl.appendChild(b);
	});

	// --- statistic tabs ---
	root.querySelectorAll("[data-quantity]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			root.querySelectorAll("[data-quantity]").forEach((b) => b.classList.remove("on"));
			btn.classList.add("on");
			state.quantity = btn.dataset.quantity;
			await ensureQuantity(state.quantity, statusEl);
			render();
		});
	});

	// --- threshold selector (only the 3-D statistics have one) ---
	thrEl.addEventListener("input", () => {
		state.iThreshold = parseInt(thrEl.value, 10);
		thrEl.nextElementSibling.textContent =
			`L > 10^${(45.5 + 0.1 * state.iThreshold).toFixed(1)} erg/s`;
		render();
	});

	root.querySelector("[data-role=reset]").addEventListener("click", () => {
		state.theta = FIDUCIAL.slice();
		readouts.forEach(({ input, out }, i) => {
			input.value = FIDUCIAL[i];
			out.textContent = FIDUCIAL[i].toFixed(3);
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
		const emu = state.emus[state.quantity];
		if (!emu) return;
		titleEl.textContent = TITLES[emu.name] || emu.name;
		thrWrap.hidden = emu.outputShape.length !== 3;

		const t0 = performance.now();
		const flat = predict(emu, state.theta);
		const dt = performance.now() - t0;
		timingEl.textContent = `${dt.toFixed(1)} ms`;

		const bad = outOfBounds(state.shared, state.theta);
		warnEl.hidden = bad.length === 0;
		if (bad.length) {
			warnEl.textContent =
				"Outside the training box — the emulator is extrapolating here and is not calibrated.";
		}

		drawPlot(canvas, emu, sliceCurves(emu, flat),
			sliceCurves(emu, state.fiducialCache[emu.name]));
	}

	await ensureQuantity("qlf", statusEl);
	render();
	window.addEventListener("resize", schedule);
	// the canvas colours come from CSS custom properties, so a theme flip needs a redraw
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
}
