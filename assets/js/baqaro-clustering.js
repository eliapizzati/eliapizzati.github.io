/**
 * Quasar clustering in the browser: QHMF -> xi(r) -> w_p(r_p).
 *
 * A port of the chain the reference implementation runs, which is the
 * same one the clustering likelihood uses:
 *
 *   1. the QHMF emulator gives the quasar host halo mass function;
 *   2. abundance-weight the precomputed halo-halo correlation triangle by it,
 *      xi_eff(r) = sum_ij xi_ij(r) w_i w_j  with w the fractional number
 *      density per mass bin;
 *   3. project along the line of sight to w_p(r_p).
 *
 * Step 3 refines each radial bin with a power-law interpolation, which is not
 * linear in xi -- so the chain cannot be collapsed into a precomputed operator
 * without quietly turning the web curve into an approximation of the fitted
 * one. It is done here in full instead. The cost is ~260k multiply-adds per
 * panel, a couple of milliseconds.
 */

const N_SUB = 10;          // sub-bins per radial bin, as in get_projected_wp

/** Trapezoid over a non-uniform grid. */
function trapz(y, x) {
	let s = 0;
	for (let i = 1; i < x.length; i++) s += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
	return s;
}

/**
 * Fractional number density per triangle mass bin.
 *
 * w_i = <phi>_i * dlogm / integral(phi), the mean of phi over the fine-grid
 * points inside bin i. Here the fine grid and the bin centres are the same
 * axis, which is how the reference implementation calls it.
 */
function massWeights(centres, logMAxis, phi) {
	const n = centres.length;
	const dlm = centres[1] - centres[0];
	const norm = trapz(phi, logMAxis);
	const w = new Float64Array(n);
	if (!(norm > 0)) return w;
	for (let i = 0; i < n; i++) {
		const lo = centres[i] - dlm / 2, hi = centres[i] + dlm / 2;
		let acc = 0, cnt = 0;
		for (let k = 0; k < logMAxis.length; k++) {
			if (logMAxis[k] >= lo && logMAxis[k] < hi) { acc += phi[k]; cnt++; }
		}
		w[i] = cnt ? (acc / cnt) * dlm / norm : 0;
	}
	return w;
}

/** xi_eff(r) = sum_ij T[i][j][r] w1_i w2_j. Auto-correlation passes w1 === w2. */
function xiFromTriangle(tri, nM, nR, w1, w2) {
	const xi = new Float64Array(nR);
	for (let i = 0; i < nM; i++) {
		const wi = w1[i];
		if (wi === 0) continue;
		for (let j = 0; j < nM; j++) {
			const wij = wi * w2[j];
			if (wij === 0) continue;
			const off = (i * nM + j) * nR;
			for (let r = 0; r < nR; r++) xi[r] += wij * tri[off + r];
		}
	}
	return xi;
}

/** Bin centres -> edges, geometric, matching qhtools' _ensure_edges. */
function centresToEdges(c) {
	const n = c.length;
	const e = new Float64Array(n + 1);
	for (let i = 1; i < n; i++) e[i] = Math.sqrt(c[i - 1] * c[i]);
	e[0] = c[0] * c[0] / e[1];
	e[n] = c[n - 1] * c[n - 1] / e[n - 1];
	return e;
}

/** Power-law refinement of each radial bin (qhtools' _refine_bins). */
function refineBins(corr, edges, nSub) {
	const n = corr.length;
	const centres = new Float64Array(n);
	for (let j = 0; j < n; j++) centres[j] = Math.sqrt(edges[j] * edges[j + 1]);

	const subEdges = new Float64Array(n * nSub + 1);
	const subCorr = new Float64Array(n * nSub);
	for (let j = 0; j < n; j++) {
		// The slope cascade must match qhtools exactly: forward difference
		// where it is usable, BACKWARD where the forward neighbour is not
		// positive, flat only when neither is. Defaulting straight to flat --
		// which is the obvious-looking simplification -- changes w_p at the
		// 1e-4 level, small enough to look like rounding and large enough to
		// be a real disagreement with the fitted curve.
		let alpha = 0;
		if (j < n - 1 && corr[j] > 0 && corr[j + 1] > 0) {
			alpha = Math.log(corr[j + 1] / corr[j]) / Math.log(centres[j + 1] / centres[j]);
		} else if (j > 0 && corr[j - 1] > 0 && corr[j] > 0) {
			alpha = Math.log(corr[j] / corr[j - 1]) / Math.log(centres[j] / centres[j - 1]);
		}
		const lo = edges[j], hi = edges[j + 1];
		const ratio = Math.pow(hi / lo, 1 / nSub);
		let a = lo;
		for (let k = 0; k < nSub; k++) {
			const b = a * ratio;
			const mid = Math.sqrt(a * b);
			subEdges[j * nSub + k] = a;
			subCorr[j * nSub + k] = corr[j] * Math.pow(mid / centres[j], alpha);
			a = b;
		}
	}
	subEdges[n * nSub] = edges[n];
	return { subEdges, subCorr };
}

/**
 * w_p for piecewise-constant xi (qhtools' _wp_piecewise).
 *
 *   w_p(rp) = 2 sum_j xi_j [ sqrt(r_hi^2 - rp^2) - sqrt(r_lo^2 - rp^2) ]
 *
 * The antiderivative form means the 1/sqrt singularity at r = rp is handled
 * exactly rather than numerically.
 */
function wpPiecewise(rpArr, corr, edges, pimax) {
	const wp = new Float64Array(rpArr.length);
	for (let i = 0; i < rpArr.length; i++) {
		const rp = rpArr[i], rp2 = rp * rp;
		const rUpper = Math.sqrt(rp2 + pimax * pimax);
		let s = 0;
		for (let j = 0; j < corr.length; j++) {
			let rLo = edges[j], rHi = edges[j + 1];
			if (rHi <= rp || rLo >= rUpper) continue;
			if (rLo < rp) rLo = rp;
			if (rHi > rUpper) rHi = rUpper;
			s += corr[j] * (Math.sqrt(rHi * rHi - rp2) - Math.sqrt(rLo * rLo - rp2));
		}
		wp[i] = 2 * s;
	}
	return wp;
}

/** Load the triangles and grids. ~3 MB, so only when the panel is opened. */
export async function loadClustering(base) {
	const meta = await (await fetch(`${base}/clustering.json`)).json();
	const buf = new Float32Array(await (await fetch(`${base}/clustering.bin`)).arrayBuffer());
	for (const key of Object.keys(meta.panels)) {
		const p = meta.panels[key];
		const [nM, , nR] = p.triangle_shape;
		p.triangle = buf.subarray(p.offset, p.offset + nM * nM * nR);
		p.gal = p.has_gal ? buf.subarray(p.gal_offset, p.gal_offset + nM) : null;
		p.nM = nM; p.nR = nR;
	}
	return meta;
}

/**
 * w_p(r_p)/r_p for one panel, given log10(QHMF) on the emulator's mass grid.
 *
 * `logQhmfSlice` is the emulator output at this panel's redshift and threshold;
 * it is interpolated onto the triangle's mass axis first, exactly as the
 * reference chain does.
 */
/**
 * Volume of a sphere of radius r intersected with a cylindrical annulus.
 *
 * Port of qhtools _sphere_cyl_volume: integrate analytically over pi from 0 to
 * pimax, the inner rp-integral being (r^2-pi^2-rp_lo^2)/2 or (rp_hi^2-rp_lo^2)/2
 * depending on whether the sphere boundary falls inside or outside the annulus.
 */
function sphereCylVolume(r, rpLo, rpHi, pimax) {
	const rpLo2 = rpLo * rpLo, rpHi2 = rpHi * rpHi, r2 = r * r;
	if (r <= rpLo) return 0;
	const piB = Math.sqrt(r2 - rpLo2);
	const piA = r > rpHi ? Math.sqrt(r2 - rpHi2) : 0;
	const a = Math.min(piA, pimax), b = Math.min(piB, pimax);
	const I1 = ((rpHi2 - rpLo2) / 2) * a;
	const I2 = b > a
		? ((r2 - rpLo2) / 2) * (b - a) - (b * b * b - a * a * a) / 6
		: 0;
	return 4 * Math.PI * (I1 + I2);
}

/**
 * Volume-averaged xi in cylindrical annuli, for piecewise-constant xi.
 *
 * This is what a cross-correlation measured in cylindrical bins actually is:
 * DD/RR - 1 over a finite bin is the volume average of xi across it, not xi at
 * the bin centre. The z = 6.1 panel is this quantity, not w_p / r_p.
 */
function xiVolPiecewise(outEdges, corr, edges, pimax) {
	const out = new Float64Array(outEdges.length - 1);
	for (let i = 0; i < out.length; i++) {
		const rpLo = outEdges[i], rpHi = outEdges[i + 1];
		const vCyl = 2 * Math.PI * pimax * (rpHi * rpHi - rpLo * rpLo);
		let s = 0;
		for (let j = 0; j < corr.length; j++) {
			const rLo = edges[j], rHi = edges[j + 1];
			if (rHi <= rpLo) continue;
			if (rLo * rLo > rpHi * rpHi + pimax * pimax) break;
			s += corr[j] * (sphereCylVolume(rHi, rpLo, rpHi, pimax)
			              - sphereCylVolume(rLo, rpLo, rpHi, pimax));
		}
		out[i] = s / vCyl;
	}
	return out;
}

export function clusteringCurve(panel, logMbinsEmul, logQhmfSlice) {
	const axis = panel.log_m_axis;
	const phi = new Float64Array(axis.length);
	for (let k = 0; k < axis.length; k++) {
		phi[k] = Math.pow(10, interp(axis[k], logMbinsEmul, logQhmfSlice));
	}

	const w = massWeights(axis, axis, phi);
	let w2 = w;
	if (panel.gal) {
		const g = new Float64Array(panel.gal.length);
		for (let k = 0; k < g.length; k++) g[k] = panel.gal[k];
		w2 = massWeights(axis, axis, g);
	}

	const xi = xiFromTriangle(panel.triangle, panel.nM, panel.nR, w, w2);
	const edges = centresToEdges(Float64Array.from(panel.rbins));
	const { subEdges, subCorr } = refineBins(xi, edges, N_SUB);

	if (panel.out_edges) {          // cross: volume-averaged xi, already the observable
		return xiVolPiecewise(Float64Array.from(panel.out_edges), subCorr, subEdges, panel.pimax);
	}
	const wp = wpPiecewise(Float64Array.from(panel.rpbins), subCorr, subEdges, panel.pimax);
	const out = new Float64Array(wp.length);
	for (let i = 0; i < wp.length; i++) out[i] = wp[i] / panel.rpbins[i];
	return out;
}

/** Linear interpolation with edge clamping, matching numpy.interp. */
function interp(x, xs, ys) {
	if (x <= xs[0]) return ys[0];
	const n = xs.length;
	if (x >= xs[n - 1]) return ys[n - 1];
	let lo = 0, hi = n - 1;
	while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
	const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
	return ys[lo] + t * (ys[hi] - ys[lo]);
}
