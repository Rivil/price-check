// The contract every alert channel type implements (ntfy, Resend, SMTP and the
// desktop app's native notifications, at most one of each — decision channels_per_type).
//
// A send result carries a fixed failure reason and never free text: an error's
// own message can name a host, a topic or a credential, and results end up in
// logs and on the account page (c-7).

export type ChannelKind = 'ntfy' | 'resend' | 'smtp' | 'desktop';

/** What an alert is about; 'test' is the account page's Send test and is never routed. */
export type AlertKind = 'price_drop' | 'check_failed' | 'test';

/** The alert kinds a channel can be set to receive. */
export type RoutedAlertKind = Exclude<AlertKind, 'test'>;

/** 'unsupported' is a desktop send on a platform whose OS reports no notification support. */
export type FailureReason =
	'bad_credentials' | 'refused' | 'unreachable' | 'timeout' | 'unsupported';

/** The words shown on the page and written to logs for each reason. */
export const REASON_LABELS: Readonly<Record<FailureReason, string>> = {
	bad_credentials: 'bad credentials',
	refused: 'refused',
	unreachable: 'unreachable',
	timeout: 'timeout',
	unsupported: 'notifications not supported'
};

export function describeFailure(reason: FailureReason): string {
	return REASON_LABELS[reason];
}

/**
 * A fixed pointer at the likeliest fix for a failure, chosen by the driver from the
 * service's status, error name or reply code, never from its text.
 */
export type FailureHint = 'domain_unverified' | 'app_password';

/** The page copy for each hint; fixed text, so no service text reaches the page. */
export const HINT_COPY: Readonly<Record<FailureHint, string>> = {
	domain_unverified: "Check the sender's domain is verified in Resend.",
	// Decision auth_hint: shown when an SMTP server rejects the login.
	app_password: 'Gmail and most providers need an app password, not your account password.'
};

/** status is the HTTP status when the service answered; never any text. */
export type SendResult =
	{ ok: true } | { ok: false; reason: FailureReason; status?: number; hint?: FailureHint };

/**
 * click is the shop URL, which ntfy, Resend and SMTP link to; watchId is the watch
 * the alert is about, which the desktop driver opens in the app (decision click_target).
 */
export type Alert = {
	kind: AlertKind;
	title: string;
	message: string;
	click?: string;
	watchId?: string;
};

export type DriverDeps = {
	fetch: (input: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	/** Tests only: the extra CA an SMTP send trusts, so the fake server's certificate verifies. */
	tlsCa?: string;
	/**
	 * Tests only: the port an SMTP send connects to instead of the saved one. The TLS
	 * mode still follows the saved port, so the 465 path can reach an ephemeral port.
	 */
	connectPort?: number;
};

/** Submitted form fields by name; a field left out of the form is undefined. */
export type ConfigForm = Readonly<Record<string, string | undefined>>;

export type ParsedConfig<Config> = { ok: true; config: Config } | { ok: false; message: string };

/** What the owner may see of a saved config: public fields, and only whether each secret is set. */
export type ConfigView = Readonly<Record<string, string | boolean | null>>;

export interface ChannelDriver<Config> {
	readonly kind: ChannelKind;
	/** What a newly saved channel of this kind receives. */
	readonly defaultKinds: readonly RoutedAlertKind[];
	/**
	 * Form -> config. Secrets are write-only: a blank secret keeps the one in
	 * previous. A refusal's message never echoes what was typed into a secret field.
	 */
	parseConfig(form: ConfigForm, previous: Config | null): ParsedConfig<Config>;
	view(config: Config): ConfigView;
	/** Never throws. */
	send(config: Config, alert: Alert, deps: DriverDeps): Promise<SendResult>;
}
