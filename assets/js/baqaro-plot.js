/**
 * A small canvas line-plotter: axes, curves, shaded bands, points, legend.
 *
 * Deliberately not a charting library. It draws what these panels need and
 * nothing else, reads its colours from the site's CSS custom properties so it
 * follows light/dark automatically, and stays under 200 lines.
 */

/** Paul Tol's 'bright' qualitative scheme -- the same colours as the paper. */
/**
 * Redshift colours, matching the paper.
 *
 * plotting_common/plot_config.py colours curves by redshift with
 * tol_cmap('rainbow_PuRd') under Normalize(vmin=0, vmax=7). These are that
 * colormap sampled on 33 even stops, so a figure here and a figure in the
 * paper put the same redshift at the same colour.
 */
const Z_CMAP = ["#6f4c9b","#6555a4","#5d5eae","#5568b8","#5173c0","#4e7ec5",
	"#4d89c6","#4e91c0","#5098ba","#549db4","#57a2ad","#5ba6a6","#5faa9f",
	"#65ae96","#6cb28c","#75b67f","#82ba72","#91bc64","#a2be57","#b2bd4e",
	"#c1bb47","#ceb642","#d7b03f","#dea83c","#e39f3a","#e59437","#e78a35",
	"#e67d33","#e56f30","#e3602c","#e04e29","#dd3825","#da2222"];

/** Colour for redshift `z`, linearly interpolated over 0 <= z <= 7. */
export function zColour(z) {
	const u = Math.min(1, Math.max(0, z / 7)) * (Z_CMAP.length - 1);
	const i = Math.min(Z_CMAP.length - 2, Math.floor(u)), f = u - i;
	const hex = (s) => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
	const a = hex(Z_CMAP[i]), b = hex(Z_CMAP[i + 1]);
	const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
	return `rgb(${mix.join(",")})`;
}

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
// (the reference implementation's physical_floor). Use the same number
// here rather than inventing a second convention: with the emulators' floor
// of -10 that is a margin of 0.5.
export const FLOOR_MARGIN = 0.5;

export function trustedSpan(vals, floor,
		{ margin = FLOOR_MARGIN, riseTol = 0.02, minFrac = 0.12,
		  requireLeft = false, leftFrac = 0.25 } = {}) {
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

	// Some corners of the parameter box make the GP produce signal ONLY at the
	// bright end, with the faint end on the floor. For a function that declines
	// with L or M that is impossible: the faint end is where it is largest. So
	// for those quantities the trusted run has to reach the left edge.
	//
	// Measured over 400 random draws from the prior box: legitimate qlf and bhmf
	// rows always start at index 0, while the artefacts start beyond 70% of the
	// grid and are 7-11 bins wide. A width cut alone therefore does not separate
	// them, which is why this tests WHERE the run sits, not how long it is.
	// qhmf and cerdf legitimately start mid-grid (up to 48% and 62%), so they
	// pass requireLeft = false and keep the width test only.
	if (requireLeft && best[0] > leftFrac * n) return null;
	if (best[1] - best[0] + 1 < minFrac * n) return null;

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

	// deliberately NOT --text/--muted/--border: the figures follow the paper, and
	// the redshift palette below is calibrated against a white ground, so the
	// plots stay light whatever the visitor's OS theme is doing.
	const ink = css("--plot-ink", "#1b1b1b");
	const muted = css("--plot-muted", "#5b6157");
	const grid = css("--plot-grid", "rgba(27,27,27,0.10)");

	// A stacked pair shares one x axis, so the upper panel passes xLabel "" and
	// gets its bottom padding back rather than reserving room for nothing.
	// padRight lets a panel reserve the room a neighbour needs for its right-hand
	// axis, so two stacked panels share one horizontal scale instead of drifting
	// apart by the width of a label.
	const pad = { l: 64, r: spec.padRight ?? (spec.yLabelR ? 62 : 16),
	              t: 16, b: spec.xLabel ? 46 : 28 };
	const W = cssW - pad.l - pad.r, H = cssH - pad.t - pad.b;
	if (W <= 20 || H <= 20) return;

	const { xMin, xMax, yMin, yMax, logX, logY } = spec;
	const fx = logX ? Math.log10 : (v) => v;
	const fy = logY ? Math.log10 : (v) => v;
	const x0 = fx(xMin), x1 = fx(xMax), y0 = fy(yMin), y1 = fy(yMax);
	const X = (v) => pad.l + ((fx(v) - x0) / (x1 - x0)) * W;
	const Y = (v) => pad.t + (1 - (fy(v) - y0) / (y1 - y0)) * H;
	// Optional right-hand axis, for a panel carrying two quantities that cannot
	// share a scale (mass in Msun against luminosity in erg/s). A curve opts in
	// with axis: "right"; without yMinR/yMaxR nothing changes.
	const hasR = spec.yMinR !== undefined && spec.yMaxR !== undefined;
	const YR = hasR
		? (v) => pad.t + (1 - (v - spec.yMinR) / (spec.yMaxR - spec.yMinR)) * H
		: Y;
	const yOf = (c) => (c.axis === "right" ? YR : Y);
	const xsOf = (c) => c.x || spec.xs;

	// --- grid ---
	const niceStep = (range) => {
		const raw = range / 4;          // ~4-5 gridlines: 6 made the panels busy
		const mag = Math.pow(10, Math.floor(Math.log10(raw)));
		return [1, 2, 2.5, 5, 10].map((m) => m * mag)
			.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
	};
	/** Decade ticks for a log axis, labelled 10^n (or plainly near unity). */
	const decades = (lo, hi) => {
		const out = [];
		for (let e = Math.ceil(Math.log10(lo)); e <= Math.log10(hi) + 1e-9; e++) {
			out.push({ v: Math.pow(10, e),
				label: e >= 0 && e <= 3 ? String(Math.pow(10, e)) : `1e${e}` });
		}
		return out;
	};
	g.strokeStyle = grid; g.lineWidth = 1;
	g.font = "12px Inter, sans-serif"; g.fillStyle = muted;
	g.textAlign = "center"; g.textBaseline = "top";
	const xTicks = logX ? decades(xMin, xMax)
		: (() => { const st = niceStep(xMax - xMin), o = [];
			for (let v = Math.ceil(xMin / st) * st; v <= xMax + 1e-9; v += st)
				o.push({ v, label: String(Number(v.toPrecision(4))) });
			return o; })();
	for (const t of xTicks) {
		g.beginPath(); g.moveTo(X(t.v), pad.t); g.lineTo(X(t.v), pad.t + H); g.stroke();
		g.fillText(t.label, X(t.v), pad.t + H + 7);
	}
	g.textAlign = "right"; g.textBaseline = "middle";
	const yTicks = logY ? decades(yMin, yMax)
		: (() => { const st = niceStep(yMax - yMin), o = [];
			for (let v = Math.ceil(yMin / st) * st; v <= yMax + 1e-9; v += st)
				o.push({ v, label: String(Number(v.toPrecision(4))) });
			return o; })();
	for (const t of yTicks) {
		g.beginPath(); g.moveTo(pad.l, Y(t.v)); g.lineTo(pad.l + W, Y(t.v)); g.stroke();
		g.fillText(t.label, pad.l - 8, Y(t.v));
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
		if (!c.y) return;          // legend-only entry (a marker series has no line)
		const xs = xsOf(c);
		const [a, b] = c.span || [0, xs.length - 1];
		g.strokeStyle = c.colour || TOL[i % TOL.length];
		g.lineWidth = c.dashed ? 1.4 : 2.2;
		g.setLineDash(c.dotted ? [1.5, 3] : c.dashed ? [5, 4] : []);
		g.globalAlpha = c.dashed || c.dotted ? 0.55 : 1;
		g.beginPath();
		let started = false;
		const Yc = yOf(c);
		// `step` draws steps-mid, matching how the reference implementation plots a histogram
		const half = c.step && xs.length > 1 ? (xs[1] - xs[0]) / 2 : 0;
		for (let j = a; j <= b; j++) {
			const v = c.y[j];
			if (!isFinite(v) || (logY && v <= 0)) { started = false; continue; }
			if (c.step) {
				const lo = X(xs[j] - half), hi = X(xs[j] + half), yy = Yc(v);
				started ? g.lineTo(lo, yy) : g.moveTo(lo, yy);
				g.lineTo(hi, yy);
			} else {
				started ? g.lineTo(X(xs[j]), Yc(v)) : g.moveTo(X(xs[j]), Yc(v));
			}
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
			if (!isFinite(p.y[j]) || (logY && p.y[j] <= 0)) continue;
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
				// On a log axis y-err is often <= 0 (9 of 11 Shen+07 points are), and
				// Y() of that is NaN, so the whole bar vanished. Clamp the lower end
				// to the frame instead: the bar is then open-ended, which is what the
				// measurement actually says.
				const lower = logY ? Math.max(p.y[j] - ed, yMin) : p.y[j] - ed;
				const y0 = Y(lower), y1 = Y(p.y[j] + eu);
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

	if (hasR) {
		g.strokeStyle = muted; g.lineWidth = 1;
		g.textAlign = "left"; g.textBaseline = "middle";
		g.fillStyle = spec.colourR || muted;
		const st = niceStep(spec.yMaxR - spec.yMinR);
		for (let v = Math.ceil(spec.yMinR / st) * st; v <= spec.yMaxR + 1e-9; v += st) {
			g.beginPath(); g.moveTo(pad.l + W, YR(v)); g.lineTo(pad.l + W + 4, YR(v)); g.stroke();
			g.fillText(String(Number(v.toPrecision(4))), pad.l + W + 8, YR(v));
		}
		if (spec.yLabelR) {
			g.save();
			g.translate(cssW - 4, pad.t + H / 2);
			g.rotate(Math.PI / 2);
			g.textAlign = "center"; g.textBaseline = "top";
			g.fillText(spec.yLabelR, 0, 0);
			g.restore();
		}
	}

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

	// --- annotations: label a reference line where it sits, not in the legend ---
	(spec.annotations || []).forEach((a) => {
		g.save();
		g.beginPath(); g.rect(pad.l, pad.t, W, H); g.clip();
		g.fillStyle = a.colour || muted;
		g.font = "12px Inter, sans-serif";
		g.textAlign = a.align || "left";
		g.textBaseline = a.baseline || "bottom";
		g.fillText(a.text, X(a.x), Y(a.y));
		g.restore();
	});

	// --- legend ---
	if (spec.legend !== false) {
		const entries = (spec.curves || []).filter((c) => c.label);
		g.font = "12px Inter, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
		// Several short entries stacked in one column sit on top of the curves.
		// Flowing them across `legendCols` columns keeps them in the top strip.
		const cols = Math.max(1, spec.legendCols || 1);
		const colW = W / cols;
		const rows = Math.ceil(entries.length / cols);
		let ly = pad.t + 12;
		const x0 = spec.legendLeft ? pad.l + 12 : pad.l + W - 104;
		let k = -1;
		for (const c of entries) {
			k++;
			if (cols > 1) {
				ly = pad.t + 12 + (k % rows) * 17;
				var xCol = pad.l + 12 + Math.floor(k / rows) * colW;
			}
			const col = c.colour || TOL[entries.indexOf(c) % TOL.length];
			const xs0 = cols > 1 ? xCol : x0;
			if (c.marker) {                     // a series drawn as points, not a line
				g.fillStyle = col;
				g.beginPath(); g.arc(xs0 + 12, ly, 3.4, 0, 2 * Math.PI); g.fill();
			} else {
				g.strokeStyle = col;
				g.lineWidth = c.dashed || c.dotted ? 1.4 : 2.2;
				g.setLineDash(c.dotted ? [1.5, 3] : c.dashed ? [5, 4] : []);
				g.globalAlpha = c.dashed || c.dotted ? 0.6 : 1;
				g.beginPath(); g.moveTo(xs0, ly); g.lineTo(xs0 + 24, ly); g.stroke();
				g.setLineDash([]); g.globalAlpha = 1;
			}
			g.fillStyle = ink; g.fillText(c.label, xs0 + 30, ly);
			if (cols === 1) ly += 17;
		}
	}
}
