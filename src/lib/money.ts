// Prices are integer pence everywhere; pounds exist only at the edges (form input
// and display). Loaded by the adapter:check CLI, so it runs under Node type
// stripping: no $app/* or $env/* imports, explicit .ts extensions, erasable syntax only.

/** The largest price a user may enter: £100,000.00. */
export const MAX_POUNDS_PENCE = 10_000_000;

export type ParsedPounds = { ok: true; pence: number } | { ok: false; message: string };

// An optional '£', whole pounds without separators, then optionally one or two
// decimal places. Deliberately a regex and never Number(): Number() also accepts
// '1e3', '0x10', 'Infinity' and ' ', none of which is a price.
const POUNDS = /^£?(\d+)(?:\.(\d{1,2}))?$/;

/** '24' -> 2400, '24.9' -> 2490, '£24.99' -> 2499; anything else is an error message. */
export function parsePounds(input: string): ParsedPounds {
	const match = POUNDS.exec(input.trim());
	if (match === null) {
		return { ok: false, message: 'Enter a price in pounds, like 24.99' };
	}
	const [, whole, fraction = ''] = match;
	if (whole.length > 7) return tooHigh();
	const pence = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
	if (pence === 0) return { ok: false, message: 'The price must be more than £0.00' };
	if (pence > MAX_POUNDS_PENCE) return tooHigh();
	return { ok: true, pence };
}

function tooHigh(): ParsedPounds {
	return { ok: false, message: `The price must be at most ${formatPence(MAX_POUNDS_PENCE)}` };
}

/** 129999 -> '£1,299.99' */
export function formatPence(pence: number): string {
	const pounds = String(Math.floor(pence / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `£${pounds}.${String(pence % 100).padStart(2, '0')}`;
}
