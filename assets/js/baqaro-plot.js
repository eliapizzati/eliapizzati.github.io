/**
 * A small canvas line-plotter: axes, curves, shaded bands, points, legend.
 *
 * Deliberately not a charting library. It draws what these panels need and
 * nothing else, reads its colours from the site's CSS custom properties so it
 * follows light/dark automatically, and stays under 200 lines.
 */

/** Paul Tol's 'bright' qualitative scheme -- the same colours as the paper. */
export const TOL = ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#000000"];

function css(name, fallback) {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return v || fallback;
}

/**
 * The stretch of an emulated curve that is worth drawing.
 *
 * Emulator outputs are trained with empty bins set to a floor value, and the
 * Gaussian process interpolates smoothly THROUGH that floor. So a curve is
 * meaningful only until it first reaches the floor; anything past that -- in
 * particular the smooth turn-UP that PCA reconstruction often produces in the
 * far tail -- is an artefact of the representation, not a prediction.
 *
 * Walking outward from the peak in both directions, we stop at the first bin
 * that either touches the floor or rises again. Returns an inclusive
 * `[i0, i1]`, or null if nothing is trustworthy.
 */
// The forward-model tooling treats log10(phi) < -9.5 as an empty bin
// (data_model_comparison/switcher.py: physical_floor). Use the same number
// here rather than inventing a second convention: with the emulators' floor
// of -10 that is a margin of 0.5.
export const FLOOR_MARGIN = 0.5;

export function trustedSpan(vals, floor, { margin = FLOOR_MARGIN, riseTol = 0.02 } = {}) {
	const n = vals.length;
	if (!n) return null;
	const limit = floor + margin;

	// Anchor on the LONGEST run above the floor, not on the global maximum.
	// A curve can come back up after crossing the floor, and that second bump
	// is sometimes the higher of the two -- anchoring on the maximum would then
	// keep the artefact and discard the real curve. The real signal is the
	// broad run; an interpolation artefact is a narrow one.
	let best = null, runStart = -1;
	for (let j = 0; j <= n; j++) {
		const above = j < n && vals[j] > limit;
		if (above && runStart < 0) runStart = j;
		if (!above && runStart >= 0) {
			const run = [runStart, j - 1];
			if (!best || run[1] - run[0] > best[1] - best[0]) best = run;
			runStart = -1;
		}
	}
	if (!best) return null;               // the whole curve is on the floor

	// Within that run, walk outward from its peak and stop as soon as the
	// curve turns back up: these statistics fall monotonically into both tails.
	let iMax = best[0];
	for (let j = best[0] + 1; j <= best[1]; j++) if (vals[j] > vals[iMax]) iMax = j;

	let i1 = iMax;
	for (let j = iMax + 1; j <= best[1]; j++) {
		if (vals[j] > vals[j - 1] + riseTol) break;
		i1 = j;
	}
	let i0 = iMax;
	for (let j = iMax - 1; j >= best[0]; j--) {
		if (vals[j] > vals[j + 1] + riseTol) break;
		i0 = j;
	}
	return [i0, i1];
}

/**
 * Draw a panel.
 *
 * spec = {
 *   xs, xLabel, yLabel, xMin, xMax, yMin, yMax,
 *   curves: [{ x?, y, label?, colour?, dashed?, span? }],
 *   bands:  [{ x?, lo, hi, colour?, alpha? }],
 *   points: [{ x, y, colour?, label? }],
 *   vlines: [{ x, label?, colour? }],
 *   legend: true,
 * }
 */
export function drawPanel(canvas, spec) {
	const dpr = window.devicePixelRatio || 1;
	const cssW = canvas.clientWidth || canvas.width;
	const cssH = canvas.clientHeight || canvas.height;
	canvas.width = Math.round(cssW * dpr);
	canvas.height = Math.round(cssH * dpr);
	const g = canvas.getContext("2d");
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, cssW, cssH);

	const ink = css("--text", "#1b1b1b");
	const muted = css("--muted", "#5b6157");
	const grid = css("--border", "rgba(0,0,0,0.08)");

	const pad = { l: 64, r: 16, t: 16, b: 46 };
	const W = cssW - pad.l - pad.r, H = cssH - pad.t - pad.b;
	if (W <= 20 || H <= 20) return;

	const { xMin, xMax, yMin, yMax } = spec;
	const X = (v) => pad.l + ((v - xMin) / (xMax - xMin)) * W;
	const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * H;
	const xsOf = (c) => c.x || spec.xs;

	// --- grid ---
	const niceStep = (range) => {
		const raw = range / 6;
		const mag = Math.pow(10, Math.floor(Math.log10(raw)));
		return [1, 2, 2.5, 5, 10].map((m) => m * mag)
			.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
	};
	g.strokeStyle = grid; g.lineWidth = 1;
	g.font = "12px Inter, sans-serif"; g.fillStyle = muted;
	g.textAlign = "center"; g.textBaseline = "top";
	const xStep = niceStep(xMax - xMin);
	for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + 1e-9; v += xStep) {
		g.beginPath(); g.moveTo(X(v), pad.t); g.lineTo(X(v), pad.t + H); g.stroke();
		g.fillText(Number(v.toPrecision(4)), X(v), pad.t + H + 7);
	}
	g.textAlign = "right"; g.textBaseline = "middle";
	const yStep = niceStep(yMax - yMin);
	for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
		g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(pad.l + W, Y(v)); g.stroke();
		g.fillText(Number(v.toPrecision(4)), pad.l - 8, Y(v));
	}

	g.save();
	g.beginPath(); g.rect(pad.l, pad.t, W, H); g.clip();

	// --- shaded bands ---
	for (const b of spec.bands || []) {
		const xs = xsOf(b);
		g.fillStyle = b.colour || TOL[0];
		g.globalAlpha = b.alpha ?? 0.16;
		g.beginPath();
		let started = false;
		for (let j = 0; j < xs.length; j++) {
			if (!isFinite(b.hi[j])) continue;
			started ? g.lineTo(X(xs[j]), Y(b.hi[j])) : g.moveTo(X(xs[j]), Y(b.hi[j]));
			started = true;
		}
		for (let j = xs.length - 1; j >= 0; j--) {
			if (!isFinite(b.lo[j])) continue;
			g.lineTo(X(xs[j]), Y(b.lo[j]));
		}
		g.closePath(); g.fill();
		g.globalAlpha = 1;
	}

	// --- vertical markers ---
	for (const v of spec.vlines || []) {
		g.strokeStyle = v.colour || muted; g.lineWidth = 1.2; g.setLineDash([3, 3]);
		g.beginPath(); g.moveTo(X(v.x), pad.t); g.lineTo(X(v.x), pad.t + H); g.stroke();
		g.setLineDash([]);
	}

	// --- curves ---
	(spec.curves || []).forEach((c, i) => {
		const xs = xsOf(c);
		const [a, b] = c.span || [0, xs.length - 1];
		g.strokeStyle = c.colour || TOL[i % TOL.length];
		g.lineWidth = c.dashed ? 1.4 : 2.2;
		g.setLineDash(c.dashed ? [5, 4] : []);
		g.globalAlpha = c.dashed ? 0.55 : 1;
		g.beginPath();
		let started = false;
		for (let j = a; j <= b; j++) {
			const v = c.y[j];
			if (!isFinite(v)) { started = false; continue; }
			started ? g.lineTo(X(xs[j]), Y(v)) : g.moveTo(X(xs[j]), Y(v));
			started = true;
		}
		g.stroke();
		g.setLineDash([]); g.globalAlpha = 1;
	});

	// --- points: asymmetric error bars, upper limits as arrows ---
	for (const p of spec.points || []) {
		const col = p.colour || muted;
		const r = p.size ?? 3.2;
		g.fillStyle = col; g.strokeStyle = col;
		g.globalAlpha = p.alpha ?? 1;
		g.lineWidth = 1.2;
		for (let j = 0; j < p.x.length; j++) {
			if (!isFinite(p.y[j])) continue;
			const px = X(p.x[j]), py = Y(p.y[j]);
			const isLimit = p.limit && p.limit[j];
			const eu = p.err_up ? p.err_up[j] : 0;
			const ed = p.err_down ? p.err_down[j] : eu;

			if (isLimit) {
				// published upper limit: value plus a downward arrow, never a
				// symmetric bar -- these carry an unbounded lower error
				const tip = Y(p.y[j] - 0.55);
				g.beginPath(); g.moveTo(px, py); g.lineTo(px, tip); g.stroke();
				g.beginPath();
				g.moveTo(px, tip); g.lineTo(px - 4, tip - 6); g.lineTo(px + 4, tip - 6);
				g.closePath(); g.fill();
				g.beginPath(); g.arc(px, py, r, 0, 2 * Math.PI); g.stroke();
				continue;
			}
			if (eu > 0 || ed > 0) {
				const y0 = Y(p.y[j] - ed), y1 = Y(p.y[j] + eu);
				g.beginPath(); g.moveTo(px, y0); g.lineTo(px, y1); g.stroke();
				g.beginPath(); g.moveTo(px - 3, y0); g.lineTo(px + 3, y0);
				g.moveTo(px - 3, y1); g.lineTo(px + 3, y1); g.stroke();
			}
			g.beginPath();
			if (p.square) g.rect(px - r, py - r, 2 * r, 2 * r);
			else g.arc(px, py, r, 0, 2 * Math.PI);
			g.fill();
			if (p.square) { g.save(); g.strokeStyle = ink; g.lineWidth = 1; g.stroke(); g.restore(); }
		}
		g.globalAlpha = 1;
	}
	g.restore();

	// --- frame + axis labels ---
	g.strokeStyle = muted; g.lineWidth = 1.2;
	g.strokeRect(pad.l, pad.t, W, H);
	g.fillStyle = ink; g.font = "13px Inter, sans-serif";
	g.textAlign = "center"; g.textBaseline = "bottom";
	g.fillText(spec.xLabel, pad.l + W / 2, cssH - 4);
	g.save();
	g.translate(14, pad.t + H / 2); g.rotate(-Math.PI / 2);
	g.textBaseline = "top"; g.fillText(spec.yLabel, 0, 0);
	g.restore();

	// --- legend ---
	if (spec.legend !== false) {
		const entries = (spec.curves || []).filter((c) => c.label);
		g.font = "12px Inter, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
		let ly = pad.t + 12;
		const x0 = spec.legendLeft ? pad.l + 12 : pad.l + W - 104;
		for (const c of entries) {
			g.strokeStyle = c.colour || TOL[entries.indexOf(c) % TOL.length];
			g.lineWidth = c.dashed ? 1.4 : 2.2;
			g.setLineDash(c.dashed ? [5, 4] : []);
			g.globalAlpha = c.dashed ? 0.6 : 1;
			g.beginPath(); g.moveTo(x0, ly); g.lineTo(x0 + 24, ly); g.stroke();
			g.setLineDash([]); g.globalAlpha = 1;
			g.fillStyle = ink; g.fillText(c.label, x0 + 30, ly);
			ly += 17;
		}
	}
}
