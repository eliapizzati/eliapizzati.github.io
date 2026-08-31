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
export function growthTrack(theta, { windowMyr = 100, n = 900, logSSAR = 0.4, seed = 1,
		steadyEta = null } = {}) {
	const lc = lightcurve(theta, { windowMyr, n, logSSAR, seed });
	const out = new Float64Array(n);
	const dt = windowMyr / (n - 1);
	let lnM = 0;
	for (let j = 0; j < n; j++) {
		const eta = steadyEta === null ? Math.pow(10, lc.y[j]) : steadyEta;
		lnM += eta * (1 - radEfficiency(eta)) * INV_TSAL_PER_MYR * dt;
		out[j] = lnM / Math.LN10;          // ln -> log10
	}
	return { t: lc.t, y: out, lc };
}
