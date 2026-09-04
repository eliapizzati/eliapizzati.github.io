/**
 * The model's three ingredients, in closed form.
 *
 * These panels do not use the emulator at all. Accretion, seeding and
 * variability are each two lines of arithmetic in BAQARO, and showing them
 * directly is the difference between "here is a fit" and "here is why the fit
 * looks like that". Every formula below is the one the forward model uses.
 */

// ---------------------------------------------------------------------------
// 1. Accretion: the distribution of eta_acc = Mdot_BH,acc / Mdot_Edd
//    (a dimensionless accretion rate, NOT the Eddington ratio L/L_Edd)
//
//     mu    = eta_0 + eta_evol * log10(sSAR_cold)
//     sigma = sigma_0                              (independent of everything)
//     log10(eta) ~ Normal(mu, sigma)
//
// So the model's central claim about accretion is a STRAIGHT LINE in
// log(eta)-log(sSAR) with constant scatter: eta_0 sets its height, eta_evol
// its slope, sigma_0 its width.
// ---------------------------------------------------------------------------

export function erdfRelation(theta, xs) {
	const [eta0, etaEvol, sigma0] = theta;
	const mu = new Float64Array(xs.length);
	const lo1 = new Float64Array(xs.length), hi1 = new Float64Array(xs.length);
	const lo2 = new Float64Array(xs.length), hi2 = new Float64Array(xs.length);
	for (let j = 0; j < xs.length; j++) {
		mu[j] = eta0 + etaEvol * xs[j];
		lo1[j] = mu[j] - sigma0; hi1[j] = mu[j] + sigma0;
		lo2[j] = mu[j] - 2 * sigma0; hi2[j] = mu[j] + 2 * sigma0;
	}
	return { mu, lo1, hi1, lo2, hi2 };
}

/** The lognormal itself, at one value of the cold specific accretion rate. */
export function erdfPdf(theta, logSSAR, xs) {
	const [eta0, etaEvol, sigma0] = theta;
	const mu = eta0 + etaEvol * logSSAR;
	const norm = 1 / (sigma0 * Math.sqrt(2 * Math.PI));
	const y = new Float64Array(xs.length);
	for (let j = 0; j < xs.length; j++) {
		const t = (xs[j] - mu) / sigma0;
		y[j] = norm * Math.exp(-0.5 * t * t);
	}
	return { y, mu };
}

// ---------------------------------------------------------------------------
// 2. Seeding:  M_BH = M_halo * 10^(log_f_seed + Normal(0, sigma_seed))
//
// A straight line of slope 1 in log-log, with a fixed vertical scatter. Both
// seed parameters are pure offsets here, which is exactly why they are the
// hardest pair to constrain from the luminosity function alone.
// ---------------------------------------------------------------------------

export function seedRelation(theta, logMhalo) {
	const logF = theta[4], sigmaSeed = theta[5];
	const med = new Float64Array(logMhalo.length);
	const lo1 = new Float64Array(logMhalo.length), hi1 = new Float64Array(logMhalo.length);
	const lo2 = new Float64Array(logMhalo.length), hi2 = new Float64Array(logMhalo.length);
	for (let j = 0; j < logMhalo.length; j++) {
		med[j] = logMhalo[j] + logF;
		lo1[j] = med[j] - sigmaSeed; hi1[j] = med[j] + sigmaSeed;
		lo2[j] = med[j] - 2 * sigmaSeed; hi2[j] = med[j] + 2 * sigmaSeed;
	}
	return { med, lo1, hi1, lo2, hi2 };
}

/** Distribution of seed masses for a fixed halo mass. */
export function seedPdf(theta, logMhalo, xs) {
	const mu = logMhalo + theta[4], s = Math.max(theta[5], 1e-6);
	const norm = 1 / (s * Math.sqrt(2 * Math.PI));
	const y = new Float64Array(xs.length);
	for (let j = 0; j < xs.length; j++) {
		const t = (xs[j] - mu) / s;
		y[j] = norm * Math.exp(-0.5 * t * t);
	}
	return { y, mu };
}

// ---------------------------------------------------------------------------
// 3. Variability: what the coherence time does to a light curve
//
// In BAQARO one accretion sub-step IS one coherence time: the accretion rate
// is redrawn from the same lognormal every tau = 10^(logtcoherence - 6) Myr
// and held constant in between. So a light curve in log(eta) is a block
// process -- piecewise constant, block length tau, each block an independent
// Normal(mu, sigma_0) draw.
//
// The realisation uses a FIXED noise field (a deterministic hash, not
// Math.random), so moving a slider changes the STRUCTURE of the light curve
// and never the luck of the draw. Without that, every parameter change
// reshuffles the noise and nothing is comparable.
// ---------------------------------------------------------------------------

/** Deterministic standard normal from an integer index (hash + Box-Muller). */
function gaussAt(i, seed = 1) {
	const hash = (n) => {
		n = Math.imul(n ^ (n >>> 16), 2246822507);
		n = Math.imul(n ^ (n >>> 13), 3266489909);
		return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
	};
	const u1 = Math.max(hash(i * 2 + seed * 1013), 1e-12);
	const u2 = hash(i * 2 + 1 + seed * 1013);
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A light curve in log10(eta) over `windowMyr`, sampled on `n` points.
 *
 * `logSSAR` fixes the mean through the ERDF relation; tau and sigma_0 come
 * from the parameter vector.
 */
export function lightcurve(theta, { windowMyr = 200, n = 900, logSSAR = 0.4, seed = 1 } = {}) {
	const [eta0, etaEvol, sigma0, logTau] = theta;
	const mu = eta0 + etaEvol * logSSAR;
	const tauMyr = Math.pow(10, logTau - 6);          // yr -> Myr
	const t = new Float64Array(n), y = new Float64Array(n);
	for (let j = 0; j < n; j++) {
		t[j] = (j / (n - 1)) * windowMyr;
		const block = Math.floor(t[j] / Math.max(tauMyr, 1e-9));
		y[j] = mu + sigma0 * gaussAt(block, seed);
	}
	return { t, y, tauMyr, mu, nBlocks: windowMyr / tauMyr };
}

/** Blocks are capped so a 3 kyr coherence time cannot lock up the page. */
const MAX_BLOCKS = 250000;

/**
 * Time-averaged accretion rate up to each plotted time, log10.
 *
 * This is the quantity that actually builds black hole mass, and it has to be
 * averaged over the blocks that ELAPSED, not over the points that happen to be
 * plotted. Averaging over plotted points instead makes the convergence
 * saturate at the sample count, which inverts the very effect the panel exists
 * to show: with a short coherence time the mean settles almost immediately,
 * and with a long one it is still wandering after 200 Myr.
 */
export function runningMean(theta, { windowMyr = 200, n = 900, logSSAR = 0.4, seed = 1 } = {}) {
	const [eta0, etaEvol, sigma0, logTau] = theta;
	const mu = eta0 + etaEvol * logSSAR;
	const tauMyr = Math.max(Math.pow(10, logTau - 6), windowMyr / MAX_BLOCKS);
	const nBlocks = Math.max(1, Math.ceil(windowMyr / tauMyr));

	// one pass over the blocks, accumulating the running sum of linear eta
	const cum = new Float64Array(nBlocks + 1);
	for (let b = 0; b < nBlocks; b++) {
		cum[b + 1] = cum[b] + Math.pow(10, mu + sigma0 * gaussAt(b, seed));
	}

	const out = new Float64Array(n);
	for (let j = 0; j < n; j++) {
		const time = (j / (n - 1)) * windowMyr;
		const whole = Math.min(Math.floor(time / tauMyr), nBlocks);
		const frac = Math.min(time / tauMyr - whole, 1);
		const elapsed = whole + frac;
		if (elapsed <= 0) { out[j] = mu + sigma0 * gaussAt(0, seed); continue; }
		const partial = frac > 0 && whole < nBlocks
			? frac * Math.pow(10, mu + sigma0 * gaussAt(whole, seed)) : 0;
		out[j] = Math.log10((cum[whole] + partial) / elapsed);
	}
	return out;
}

/**
 * Eddington ratio from the dimensionless accretion rate.
 *
 * eta_acc is Mdot/Mdot_Edd; lambda_Edd is L/L_Edd. They are NOT the same,
 * because the radiative efficiency depends on the accretion rate:
 *
 *     L = eps(eta) Mdot c^2,   L_Edd = eps_base Mdot_Edd c^2
 *     => lambda_Edd = eta * eps(eta) / eps_base
 *
 * with the Madau et al. (2014) Eq. 2 fit used by the model
 * (bh_accretion_fast.py, _MA/_MB/_MC). The eta cancels, leaving:
 */
const MA = 1.8260922439282448, MB = 0.7586284639465684, MC = 0.01611606486191978;
export function lambdaEdd(eta) {
	if (!(eta > 0)) return 0;
	return MA * (0.985 / (1.6 / eta + MB) + 0.015 / (1.6 / eta + MC));
}

/** Radiative efficiency at this accretion rate (Madau+ 2014, eps_base = 0.1). */
export function radEfficiency(eta) {
	return eta > 0 ? 0.1 * lambdaEdd(eta) / eta : 0.1;
}

/**
 * Mass growth along a light curve, as log10(M / M_start).
 *
 * The model grows a black hole at
 *     dlnM/dt = eta_acc (1 - eps(eta)) / t_Sal0,
 * with 1/t_Sal0 = inv_t_Edd_Gyr / eps_base ~= 22.18 per Gyr (the constant that
 * sets the Salpeter time; see bh_accretion_fast.py). Integrating the SAME
 * realisation the light curve draws is the point: the mass a black hole ends
 * with is the accumulated accretion rate, not the average one.
 *
 * `steady` integrates instead at a constant eta, which is what the long-run
 * average would give: the gap between the two is the luck of the draw.
 */
const INV_TSAL_PER_MYR = 22.18 / 1000;
/** d(lnM)/dt in 1/Myr at this accretion rate — shared by every growth track. */
export const growthRatePerMyr = (eta) => eta * (1 - radEfficiency(eta)) * INV_TSAL_PER_MYR;

export function growthTrack(theta, { windowMyr = 100, n = 900, logSSAR = 0.4, seed = 1,
		steadyEta = null } = {}) {
	const lc = lightcurve(theta, { windowMyr, n, logSSAR, seed });
	const out = new Float64Array(n);
	const rate = growthRatePerMyr;

	if (steadyEta !== null) {
		const r = rate(steadyEta);
		for (let j = 0; j < n; j++) out[j] = (r * lc.t[j]) / Math.LN10;
		return { t: lc.t, y: out, lc };
	}

	// Integrate over the coherence blocks that ELAPSED, not the points that
	// happen to be plotted -- the same trap runningMean documents. Summing the
	// 900 displayed samples caps the number of independent draws at the pixel
	// count, so at short tau the track kept a ~6x too-large scatter around the
	// average-rate line instead of self-averaging onto it (variance ~ tau).
	const [eta0, etaEvol, sigma0, logTau] = theta;
	const mu = eta0 + etaEvol * logSSAR;
	const tauMyr = Math.max(Math.pow(10, logTau - 6), windowMyr / MAX_BLOCKS);
	const nBlocks = Math.max(1, Math.ceil(windowMyr / tauMyr));

	const cum = new Float64Array(nBlocks + 1);   // ln-growth after each block
	for (let b = 0; b < nBlocks; b++) {
		cum[b + 1] = cum[b] + rate(Math.pow(10, mu + sigma0 * gaussAt(b, seed))) * tauMyr;
	}
	for (let j = 0; j < n; j++) {
		const whole = Math.min(Math.floor(lc.t[j] / tauMyr), nBlocks);
		const frac = Math.max(0, Math.min(lc.t[j] / tauMyr - whole, 1));
		const partial = whole < nBlocks
			? frac * tauMyr * rate(Math.pow(10, mu + sigma0 * gaussAt(whole, seed))) : 0;
		out[j] = (cum[whole] + partial) / Math.LN10;   // ln -> log10
	}
	return { t: lc.t, y: out, lc };
}

// ---------------------------------------------------------------------------
// 4. The same variability as a real damped random walk
//
// The block process above is the model's own variability: cheap enough to run
// over two billion halos, but piecewise-constant. When individual lightcurves
// are the point (feeding radiative transfer of quasar proximity zones —
// Pizzati et al., in prep.), the blocks are replaced by a damped random walk:
// an Ornstein-Uhlenbeck process in log10(eta) whose stationary marginal is the
// SAME lognormal ERDF and whose memory is the SAME coherence time. The
// discrete update below is exact for the OU process at any dt
// (drw_lightcurves.py in the model repository):
//
//     x_{k+1} = mu + rho (x_k - mu) + sigma sqrt(1 - rho^2) g_k,
//     rho = exp(-dt / tau_drw)
//
// One subtlety is inherited from the paper: the OU carries more integrated
// correlation than a block process of the same tau (a factor 2 in log space;
// R(sigma) after the exponential map to eta), so a DRW at the raw tau would
// grow slightly fatter bright tails. Setting tau_drw = tau / R(sigma)
// (~0.72 tau at the best-fit sigma) makes the walk bank the same integrated
// variability -- and therefore build the same black hole masses -- as the
// block model it replaces. That calibration is applied here too, and the
// growth panel is comparable to the block one above it because of it.
// ---------------------------------------------------------------------------

/** OU/block integrated-autocovariance ratio in eta-space (DRW_DELTA_T_TAU.md). */
export function areaRatioR(sigma) {
	const v = Math.pow(sigma * Math.LN10, 2);
	if (v < 1e-12) return 2;
	let sum = 0, term = 1;                       // term = v^k / k!
	for (let k = 1; k < 80; k++) {
		term *= v / k;
		sum += term / k;
	}
	return (2 * sum) / Math.expm1(v);
}

/**
 * One DRW realisation and everything the panels need from it, in one pass:
 * log10(eta) at the plotted times, the running time-average of eta, and the
 * accumulated mass growth (log10 M/M_start). The white-noise field is the same
 * deterministic hash as the block model, indexed by fine step, so a slider
 * changes the structure of the walk and never the luck of the draw.
 *
 * The fine grid must resolve BOTH the damping time (dt <= tau/8, or the
 * "walk" degenerates to white noise) and the plot (dt no coarser than a
 * sample spacing, or a long-tau curve turns blocky), floored by the global
 * step cap. Integrating on this grid rather than over plotted points avoids
 * the pixel-capped-draws trap documented at runningMean.
 */
export function drwTrack(theta, { windowMyr = 100, n = 900, logSSAR = 0.4, seed = 1 } = {}) {
	const [eta0, etaEvol, sigma0, logTau] = theta;
	const mu = eta0 + etaEvol * logSSAR;
	const tauDrw = Math.pow(10, logTau - 6) / areaRatioR(sigma0);
	const dt = Math.max(Math.min(tauDrw / 8, windowMyr / (n - 1)), windowMyr / MAX_BLOCKS);
	const K = Math.ceil(windowMyr / dt);
	const rho = Math.exp(-dt / tauDrw);
	const innov = sigma0 * Math.sqrt(Math.max(0, 1 - rho * rho));

	const x = new Float64Array(K + 1);
	const cumEta = new Float64Array(K + 2);      // integral of eta dt up to node k
	const cumG = new Float64Array(K + 2);        // integral of dlnM/dt up to node k
	let xk = mu + sigma0 * gaussAt(0, seed);     // stationary start
	for (let k = 0; k <= K; k++) {
		if (k > 0) xk = mu + rho * (xk - mu) + innov * gaussAt(k, seed);
		x[k] = xk;
		const eta = Math.pow(10, xk);
		cumEta[k + 1] = cumEta[k] + eta * dt;
		cumG[k + 1] = cumG[k] + growthRatePerMyr(eta) * dt;
	}

	const t = new Float64Array(n), y = new Float64Array(n);
	const mean = new Float64Array(n), growth = new Float64Array(n);
	for (let j = 0; j < n; j++) {
		t[j] = (j / (n - 1)) * windowMyr;
		const pos = t[j] / dt;
		const whole = Math.min(Math.floor(pos), K);
		const frac = Math.min(pos - whole, 1);
		y[j] = x[Math.min(Math.round(pos), K)];
		const etaW = Math.pow(10, x[whole]);
		const elapsed = (whole + frac) * dt;
		mean[j] = elapsed > 0
			? Math.log10((cumEta[whole] + frac * etaW * dt) / elapsed)
			: x[0];
		growth[j] = (cumG[whole] + frac * growthRatePerMyr(etaW) * dt) / Math.LN10;
	}
	return { t, y, mean, growth, mu, tauDrwMyr: tauDrw };
}
