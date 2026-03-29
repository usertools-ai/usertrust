const S = {
	stroke: "currentColor",
	strokeWidth: 0.75,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
};
const D = { ...S, strokeWidth: 0.5, strokeDasharray: "3 3", opacity: 0.35 };
const T = { ...S, strokeWidth: 0.35, opacity: 0.18 };
const Label = {
	fontSize: 6,
	fontFamily: "monospace",
	fill: "currentColor",
	opacity: 0.35,
};
const LabelDim = {
	fontSize: 5,
	fontFamily: "monospace",
	fill: "currentColor",
	opacity: 0.22,
};

function Reg({ x, y }: { x: number; y: number }) {
	return (
		<g>
			<line x1={x - 3} y1={y} x2={x + 3} y2={y} {...T} />
			<line x1={x} y1={y - 3} x2={x} y2={y + 3} {...T} />
		</g>
	);
}

const FIG: Record<string, string> = {
	pending: "1.1",
	execute: "1.2",
	post: "1.3",
	void: "1.4",
	receipt: "1.5",
};

/* ------------------------------------------------------------------ */
/*  PENDING — Double-entry budget hold                                 */
/* ------------------------------------------------------------------ */
function PendingDrawing() {
	return (
		<g>
			<Reg x={20} y={20} />
			<Reg x={220} y={20} />
			<Reg x={20} y={175} />
			<Reg x={220} y={175} />

			{/* Input: trust(client) call */}
			<line x1="120" y1="12" x2="120" y2="42" {...S} />
			<circle cx="120" cy="12" r="2" fill="currentColor" opacity="0.4" />
			<text x="126" y="15" {...Label}>
				trust(client)
			</text>
			<text x="126" y="22" {...LabelDim}>
				estimateCost()
			</text>

			{/* Budget check gate — small diamond */}
			<polygon points="120,42 134,52 120,62 106,52" {...S} fill="none" />
			<text x="138" y="55" {...LabelDim}>
				BUDGET CHECK
			</text>
			<circle cx="106" cy="52" r="1.5" fill="currentColor" opacity="0.4" />
			<circle cx="134" cy="52" r="1.5" fill="currentColor" opacity="0.4" />

			{/* Insufficient balance — deny path */}
			<line x1="106" y1="52" x2="58" y2="52" {...S} opacity="0.3" />
			<path d="M64,48 L56,52 L64,56" {...S} fill="none" opacity="0.3" />
			<text x="36" y="48" {...LabelDim}>
				InsufficientBalanceError
			</text>

			{/* Double-entry ledger — two account columns */}
			{/* Left: AVAILABLE */}
			<rect x="48" y="74" width="60" height="52" rx="1" {...S} fill="none" opacity="0.5" />
			<text x="52" y="72" {...Label}>
				AVAILABLE
			</text>
			<line x1="48" y1="84" x2="108" y2="84" {...T} opacity="0.25" />
			<text x="54" y="92" {...LabelDim}>
				balance: 50,000
			</text>
			<text x="54" y="100" {...LabelDim}>
				− hold: 3,200
			</text>
			<line x1="54" y1="103" x2="100" y2="103" {...T} opacity="0.15" />
			<text x="54" y="111" {...LabelDim}>
				remaining: 46,800
			</text>
			{/* Debit indicator */}
			<text x="54" y="120" {...LabelDim} opacity="0.15">
				DR
			</text>

			{/* Right: RESERVED */}
			<rect x="132" y="74" width="60" height="52" rx="1" {...S} fill="none" opacity="0.5" />
			<text x="136" y="72" {...Label}>
				RESERVED
			</text>
			<line x1="132" y1="84" x2="192" y2="84" {...T} opacity="0.25" />
			<text x="138" y="92" {...LabelDim}>
				hold: 3,200
			</text>
			<text x="138" y="100" {...LabelDim}>
				status: PENDING
			</text>
			<text x="138" y="108" {...LabelDim}>
				transferId: u128
			</text>
			{/* Credit indicator */}
			<text x="182" y="120" {...LabelDim} opacity="0.15">
				CR
			</text>

			{/* Hold transfer arrow between accounts */}
			<line x1="108" y1="96" x2="132" y2="96" {...S} opacity="0.6" />
			<path d="M126,92 L134,96 L126,100" {...S} fill="none" opacity="0.5" />

			{/* Section cut */}
			<line x1="32" y1="96" x2="44" y2="96" {...D} opacity="0.2" />
			<circle cx="28" cy="96" r="4" {...T} opacity="0.25" />
			<text x="26" y="98" fontSize="5" fontFamily="monospace" fill="currentColor" opacity="0.2">
				A
			</text>

			{/* Output: transferId */}
			<line x1="120" y1="126" x2="120" y2="170" {...S} />
			<path d="M116,163 L120,173 L124,163" {...S} fill="none" />
			<text x="126" y="148" {...Label}>
				transferId
			</text>
			<text x="126" y="156" {...LabelDim}>
				+ PENDING hold
			</text>
			<text x="126" y="163" {...LabelDim}>
				+ estimatedCost
			</text>

			{/* Dimension marks — ledger width */}
			<line x1="48" y1="132" x2="192" y2="132" {...T} />
			<line x1="48" y1="129" x2="48" y2="135" {...T} />
			<line x1="192" y1="129" x2="192" y2="135" {...T} />
			<text x="105" y="140" {...LabelDim}>
				DOUBLE-ENTRY
			</text>
		</g>
	);
}

/* ------------------------------------------------------------------ */
/*  EXECUTE — Policy gate + LLM call                                   */
/* ------------------------------------------------------------------ */
function ExecuteDrawing() {
	return (
		<g>
			<Reg x={20} y={20} />
			<Reg x={220} y={20} />
			<Reg x={20} y={175} />
			<Reg x={220} y={175} />

			{/* Input */}
			<line x1="84" y1="12" x2="84" y2="40" {...S} />
			<circle cx="84" cy="12" r="2" fill="currentColor" opacity="0.4" />
			<text x="90" y="15" {...Label}>
				ActionRequest
			</text>
			<text x="90" y="22" {...LabelDim}>
				hold active
			</text>

			{/* Policy gate — large diamond */}
			<polygon points="84,40 120,62 84,84 48,62" {...S} fill="none" />
			{/* Inner diamond */}
			<polygon points="84,48 110,62 84,76 58,62" {...D} fill="none" />
			<text x="72" y="60" fontSize="6" fontFamily="monospace" fill="currentColor" opacity="0.3">
				POLICY
			</text>
			<text x="74" y="68" {...LabelDim}>
				GATE
			</text>

			{/* Policy checks — stacked on left */}
			<line x1="48" y1="62" x2="24" y2="42" {...D} opacity="0.25" />
			<text x="10" y="30" {...LabelDim}>
				PII check
			</text>
			<text x="10" y="38" {...LabelDim}>
				model allowlist
			</text>
			<text x="10" y="46" {...LabelDim}>
				rate limit
			</text>
			<text x="10" y="54" {...LabelDim}>
				spend limit
			</text>

			{/* DENY path — left */}
			<line x1="48" y1="62" x2="24" y2="78" {...S} opacity="0.3" />
			<text x="10" y="84" {...Label}>
				DENY
			</text>
			<text x="10" y="92" {...LabelDim}>
				→ PolicyDeniedError
			</text>

			{/* ALLOW path — continues down and right to provider */}
			<line x1="84" y1="84" x2="84" y2="100" {...S} />
			<text x="90" y="94" {...Label}>
				ALLOW
			</text>

			{/* Provider connection — beam to right */}
			<line x1="84" y1="100" x2="198" y2="100" {...S} opacity="0.5" />
			<path d="M192,96 L200,100 L192,104" {...S} fill="none" opacity="0.4" />

			{/* Provider endpoint */}
			<rect x="198" y="88" width="26" height="24" rx="2" {...S} fill="none" opacity="0.5" />
			<text x="202" y="98" {...LabelDim}>
				LLM
			</text>
			<text x="200" y="106" {...LabelDim}>
				Provider
			</text>

			{/* Provider labels */}
			<text x="196" y="82" {...LabelDim}>
				Anthropic
			</text>
			<text x="196" y="120" {...LabelDim}>
				OpenAI / Google
			</text>

			{/* Response back */}
			<line x1="198" y1="106" x2="120" y2="140" {...S} opacity="0.4" />
			<path d="M126,136 L118,142 L126,142" {...S} fill="none" opacity="0.35" />

			{/* Response box */}
			<rect x="52" y="132" width="68" height="22" rx="1" {...T} opacity="0.3" />
			<text x="56" y="142" {...LabelDim}>
				LLM Response
			</text>
			<text x="56" y="150" {...LabelDim}>
				+ usage (input/output tokens)
			</text>

			{/* Output */}
			<line x1="86" y1="154" x2="86" y2="172" {...S} />
			<path d="M82,165 L86,175 L90,165" {...S} fill="none" />
			<text x="92" y="170" {...Label}>
				→ POST or VOID
			</text>

			{/* Hold active indicator — dashed border */}
			<rect x="40" y="90" width="170" height="70" rx="3" {...D} opacity="0.12" />
			<text x="144" y="166" {...LabelDim}>
				HOLD ACTIVE
			</text>

			{/* Dimension — gate height */}
			<line x1="130" y1="40" x2="130" y2="84" {...T} />
			<line x1="127" y1="40" x2="133" y2="40" {...T} />
			<line x1="127" y1="84" x2="133" y2="84" {...T} />
		</g>
	);
}

/* ------------------------------------------------------------------ */
/*  POST — Settlement + hash chain append                              */
/* ------------------------------------------------------------------ */
function PostDrawing() {
	return (
		<g>
			<Reg x={20} y={20} />
			<Reg x={220} y={20} />
			<Reg x={20} y={175} />
			<Reg x={220} y={175} />

			{/* Input: LLM success */}
			<line x1="120" y1="12" x2="120" y2="36" {...S} />
			<circle cx="120" cy="12" r="2" fill="currentColor" opacity="0.4" />
			<text x="126" y="15" {...Label}>
				LLM Success
			</text>

			{/* Cost calculation box */}
			<rect x="72" y="36" width="96" height="42" rx="1" {...S} fill="none" opacity="0.45" />
			<text x="76" y="34" {...Label}>
				ACTUAL COST
			</text>
			<line x1="72" y1="46" x2="168" y2="46" {...T} opacity="0.2" />
			<text x="78" y="53" {...LabelDim}>
				input_tokens × rate
			</text>
			<text x="78" y="60" {...LabelDim}>
				output_tokens × rate
			</text>
			<line x1="78" y1="63" x2="160" y2="63" {...T} opacity="0.12" />
			<text x="78" y="70" {...LabelDim}>
				actualCost = 2,847
			</text>
			<text x="130" y="70" {...LabelDim}>
				(est: 3,200)
			</text>

			{/* Settlement: PENDING → POSTED */}
			<line x1="120" y1="78" x2="120" y2="98" {...S} />

			{/* State transition */}
			<rect x="76" y="98" width="88" height="16" rx="1" {...S} fill="none" opacity="0.5" />
			<text x="82" y="109" {...Label} opacity="0.4">
				PENDING → POSTED
			</text>

			{/* Delta refund */}
			<line x1="168" y1="58" x2="204" y2="58" {...D} opacity="0.25" />
			<text x="172" y="52" {...LabelDim}>
				Δ refund: 353
			</text>
			<text x="172" y="66" {...LabelDim}>
				→ AVAILABLE
			</text>

			{/* Hash chain append */}
			<line x1="120" y1="114" x2="120" y2="130" {...S} />

			{/* Three chain blocks */}
			<rect x="28" y="130" width="44" height="28" rx="1" {...S} fill="none" opacity="0.25" />
			<text x="32" y="140" {...LabelDim}>
				prevHash
			</text>
			<text x="32" y="148" {...LabelDim}>
				event[n-1]
			</text>

			{/* Link arrow */}
			<line x1="72" y1="144" x2="88" y2="144" {...S} opacity="0.3" />
			<path d="M82,140 L90,144 L82,148" {...S} fill="none" opacity="0.25" />

			{/* Current block — highlighted */}
			<rect x="88" y="130" width="64" height="28" rx="1" {...S} fill="none" opacity="0.6" />
			<text x="92" y="140" {...Label} opacity="0.45">
				SHA-256
			</text>
			<text x="92" y="148" {...LabelDim}>
				event[n] ← CURRENT
			</text>

			{/* Next link */}
			<line x1="152" y1="144" x2="168" y2="144" {...D} opacity="0.2" />

			{/* Future block */}
			<rect x="168" y="130" width="44" height="28" rx="1" {...D} fill="none" opacity="0.15" />
			<text x="172" y="144" {...LabelDim}>
				next...
			</text>

			{/* Chain label */}
			<text x="88" y="168" {...Label}>
				APPEND-ONLY AUDIT CHAIN
			</text>

			{/* Section cut */}
			<line x1="60" y1="106" x2="72" y2="106" {...D} opacity="0.2" />
			<circle cx="56" cy="106" r="4" {...T} opacity="0.25" />
			<text x="54" y="108" fontSize="5" fontFamily="monospace" fill="currentColor" opacity="0.2">
				B
			</text>

			{/* Dimension — chain width */}
			<line x1="28" y1="162" x2="212" y2="162" {...T} />
			<line x1="28" y1="159" x2="28" y2="165" {...T} />
			<line x1="212" y1="159" x2="212" y2="165" {...T} />
		</g>
	);
}

/* ------------------------------------------------------------------ */
/*  VOID — Hold release + error capture                                */
/* ------------------------------------------------------------------ */
function VoidDrawing() {
	return (
		<g>
			<Reg x={20} y={20} />
			<Reg x={220} y={20} />
			<Reg x={20} y={175} />
			<Reg x={220} y={175} />

			{/* Input: Error */}
			<line x1="120" y1="12" x2="120" y2="38" {...S} />
			<circle cx="120" cy="12" r="2" fill="currentColor" opacity="0.4" />
			{/* X mark for error */}
			<line x1="116" y1="16" x2="124" y2="24" {...S} opacity="0.5" />
			<line x1="124" y1="16" x2="116" y2="24" {...S} opacity="0.5" />
			<text x="128" y="15" {...Label}>
				LLM Failure
			</text>

			{/* Error classification */}
			<rect x="72" y="38" width="96" height="28" rx="1" {...S} fill="none" opacity="0.4" />
			<text x="76" y="36" {...Label}>
				ERROR CLASSIFY
			</text>
			<line x1="72" y1="48" x2="168" y2="48" {...T} opacity="0.2" />
			<text x="78" y="55" {...LabelDim}>
				transient | permanent | timeout
			</text>
			<text x="78" y="62" {...LabelDim}>
				error propagated to caller
			</text>

			{/* Release flow: RESERVED → AVAILABLE (reverse) */}
			<line x1="120" y1="66" x2="120" y2="82" {...S} />

			{/* State transition */}
			<rect x="76" y="82" width="88" height="16" rx="1" {...S} fill="none" opacity="0.5" />
			<text x="82" y="93" {...Label} opacity="0.4">
				PENDING → VOIDED
			</text>

			{/* Reverse double-entry */}
			<line x1="120" y1="98" x2="120" y2="112" {...S} />

			{/* RESERVED releasing back */}
			<rect x="132" y="112" width="56" height="26" rx="1" {...S} fill="none" opacity="0.35" />
			<text x="136" y="110" {...LabelDim}>
				RESERVED
			</text>
			<text x="138" y="122" {...LabelDim}>
				hold: 3,200
			</text>
			<text x="138" y="130" {...LabelDim}>
				→ RELEASED
			</text>

			{/* Arrow back to available */}
			<line x1="132" y1="125" x2="108" y2="125" {...S} opacity="0.5" />
			<path d="M114,121 L106,125 L114,129" {...S} fill="none" opacity="0.4" />

			{/* AVAILABLE restored */}
			<rect x="52" y="112" width="56" height="26" rx="1" {...S} fill="none" opacity="0.35" />
			<text x="56" y="110" {...LabelDim}>
				AVAILABLE
			</text>
			<text x="58" y="122" {...LabelDim}>
				+ 3,200 restored
			</text>
			<text x="58" y="130" {...LabelDim}>
				balance: 50,000
			</text>

			{/* DLQ fallback */}
			<line x1="120" y1="138" x2="120" y2="158" {...D} opacity="0.25" />
			<rect x="100" y="156" width="40" height="12" rx="1" {...T} opacity="0.3" />
			<text x="104" y="164" {...LabelDim}>
				DLQ fallback
			</text>
			<text x="144" y="164" {...LabelDim}>
				(if audit write fails)
			</text>

			{/* Section cut */}
			<line x1="32" y1="125" x2="48" y2="125" {...D} opacity="0.2" />
			<circle cx="28" cy="125" r="4" {...T} opacity="0.25" />
			<text x="26" y="127" fontSize="5" fontFamily="monospace" fill="currentColor" opacity="0.2">
				C
			</text>

			{/* Zero charge emphasis */}
			<text x="168" y="152" {...Label} opacity="0.3">
				$0.00 charged
			</text>

			{/* Dimension — release flow height */}
			<line x1="200" y1="82" x2="200" y2="138" {...T} />
			<line x1="197" y1="82" x2="203" y2="82" {...T} />
			<line x1="197" y1="138" x2="203" y2="138" {...T} />
			<text x="190" y="114" {...LabelDim} transform="rotate(-90 190 114)">
				RELEASE
			</text>
		</g>
	);
}

/* ------------------------------------------------------------------ */
/*  RECEIPT — Hash-chained audit proof                                 */
/* ------------------------------------------------------------------ */
function ReceiptDrawing() {
	return (
		<g>
			<Reg x={20} y={20} />
			<Reg x={220} y={20} />
			<Reg x={20} y={175} />
			<Reg x={220} y={175} />

			{/* Receipt document shape */}
			<path d="M60,22 L180,22 L180,122 L60,122 Z" {...S} fill="none" opacity="0.4" />
			{/* Perforated top edge */}
			{[68, 80, 92, 104, 116, 128, 140, 152, 164, 172].map((x) => (
				<line key={x} x1={x} y1="22" x2={x} y2="18" {...T} opacity="0.2" />
			))}

			{/* Receipt header */}
			<line x1="60" y1="32" x2="180" y2="32" {...T} opacity="0.2" />
			<text x="64" y="29" {...Label} opacity="0.45">
				GOVERNANCE RECEIPT
			</text>

			{/* Receipt fields */}
			<text x="68" y="42" {...LabelDim}>
				transferId
			</text>
			<text x="120" y="42" {...LabelDim}>
				tx_m8k2f_a1b2c3
			</text>

			<text x="68" y="52" {...LabelDim}>
				model
			</text>
			<text x="120" y="52" {...LabelDim}>
				claude-sonnet-4
			</text>

			<text x="68" y="62" {...LabelDim}>
				cost
			</text>
			<text x="120" y="62" {...LabelDim}>
				2,847 UT ($0.2847)
			</text>

			<text x="68" y="72" {...LabelDim}>
				settled
			</text>
			<text x="120" y="72" {...LabelDim}>
				true
			</text>

			<text x="68" y="82" {...LabelDim}>
				input_tokens
			</text>
			<text x="120" y="82" {...LabelDim}>
				1,204
			</text>

			<text x="68" y="92" {...LabelDim}>
				output_tokens
			</text>
			<text x="120" y="92" {...LabelDim}>
				847
			</text>

			<line x1="64" y1="97" x2="176" y2="97" {...T} opacity="0.15" />

			<text x="68" y="106" {...Label} opacity="0.35">
				auditHash
			</text>
			<text x="68" y="116" {...LabelDim}>
				a7f3...9e2d (SHA-256)
			</text>

			{/* Hash chain visualization below receipt */}
			{/* Previous hash */}
			<rect x="24" y="136" width="40" height="22" rx="1" {...S} fill="none" opacity="0.2" />
			<text x="28" y="146" {...LabelDim}>
				hash[n-2]
			</text>
			<text x="28" y="154" {...LabelDim}>
				c4e1...
			</text>

			{/* Link */}
			<line x1="64" y1="147" x2="76" y2="147" {...S} opacity="0.25" />
			<path d="M70,143 L78,147 L70,151" {...S} fill="none" opacity="0.2" />

			{/* Previous */}
			<rect x="76" y="136" width="40" height="22" rx="1" {...S} fill="none" opacity="0.3" />
			<text x="80" y="146" {...LabelDim}>
				hash[n-1]
			</text>
			<text x="80" y="154" {...LabelDim}>
				f8b2...
			</text>

			{/* Link */}
			<line x1="116" y1="147" x2="128" y2="147" {...S} opacity="0.3" />
			<path d="M122,143 L130,147 L122,151" {...S} fill="none" opacity="0.25" />

			{/* Current — highlighted */}
			<rect x="128" y="136" width="40" height="22" rx="1" {...S} fill="none" opacity="0.6" />
			<text x="132" y="146" {...Label} opacity="0.4">
				hash[n]
			</text>
			<text x="132" y="154" {...LabelDim}>
				a7f3...
			</text>

			{/* Future placeholder */}
			<line x1="168" y1="147" x2="180" y2="147" {...D} opacity="0.15" />
			<rect x="180" y="136" width="32" height="22" rx="1" {...D} fill="none" opacity="0.1" />
			<text x="184" y="148" {...LabelDim}>
				n+1
			</text>

			{/* Tamper-evident label */}
			<text x="76" y="170" {...Label}>
				TAMPER-EVIDENT · APPEND-ONLY
			</text>

			{/* GENESIS marker */}
			<line x1="24" y1="147" x2="16" y2="147" {...D} opacity="0.15" />
			<text x="6" y="144" {...LabelDim}>
				GENESIS
			</text>
			<text x="6" y="152" {...LabelDim}>
				(64 zeros)
			</text>

			{/* Dimension — chain direction */}
			<line x1="24" y1="164" x2="212" y2="164" {...T} />
			<line x1="24" y1="161" x2="24" y2="167" {...T} />
			<line x1="212" y1="161" x2="212" y2="167" {...T} />
		</g>
	);
}

/* ------------------------------------------------------------------ */
/*  Registry + Wrapper                                                 */
/* ------------------------------------------------------------------ */
const DRAWINGS: Record<string, () => React.JSX.Element> = {
	pending: PendingDrawing,
	execute: ExecuteDrawing,
	post: PostDrawing,
	void: VoidDrawing,
	receipt: ReceiptDrawing,
};

export function LifecycleBlueprint({
	phaseId,
	className = "",
}: {
	phaseId: string;
	className?: string;
}) {
	const Drawing = DRAWINGS[phaseId];
	if (!Drawing) return null;

	return (
		<div className={`relative ${className}`}>
			<span className="absolute top-3 left-4 text-[10px] font-mono tracking-[0.2em] uppercase select-none text-white/20">
				FIG {FIG[phaseId] ?? "0.0"}
			</span>
			<svg
				viewBox="0 0 240 190"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="w-full h-auto"
				style={{ color: "rgba(255,255,255,0.7)" }}
				role="img"
				aria-label={`Blueprint diagram for ${phaseId} phase`}
			>
				<Drawing />
			</svg>
		</div>
	);
}
