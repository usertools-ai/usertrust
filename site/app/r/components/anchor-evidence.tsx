import {
	ANCHOR_EXTERNAL_VISIBILITY,
	ANCHOR_NOT_PROOF_OF_UNIQUENESS,
	ANCHOR_PARTIAL_MITIGATION,
	EXTENSION_FAILURE_MEANING,
	HISTORY_WALK_PROVED,
	REKOR_EVIDENCE_MEANING,
	RESULT_LABEL,
	S3_OPERATOR_ASSERTED,
	UNAVAILABLE_MEANING,
} from "../lib/claims";
import type { AnchorEvidence, CheckEntry, SegmentCheckpointV2, Verification } from "../lib/wire";
import HashValue from "./hash-value";

/**
 * R32 / R7 / R8 / R10 — the extension EVIDENCE, rendered per format and per
 * RESULT.
 *
 * Two rules shape this component, and both are about not overclaiming.
 *
 * **S3 Object Lock evidence "must never render as a green anchor claim" (R8).**
 * The two formats therefore share no container, no color and no heading: Rekor
 * renders in the emerald voice as the independently-verifiable attachment it
 * is; the S3 probes render in the steel voice under their own
 * operator-asserted label. C4 (`commit-s3-only.json`) is the fixture that
 * proves the split — S3 evidence with no Rekor member must produce no anchor
 * claim anywhere on the page.
 *
 * **A served member is not a passed check (R10).** `commit-anchor-failed.json`
 * carries a full Rekor attachment whose check result is `failed` /
 * `ANCHOR_INVALID`, and `commit-history-failed.json` carries a history whose
 * walk did not pass. Rendering either in the emerald "this is what earned the
 * rung" voice would be exactly the green anchor chip R10 forbids — so the
 * evidence's VOICE is a function of the check result, the failure is NAMED, and
 * the base verdict is stated as preserved. The evidence still renders: hiding
 * it would deny the reader the material the resolver actually examined.
 *
 * `anchorEvidence`'s inner shapes are not validated by `wire.ts` (unsigned
 * envelope members, and §4.1 tolerates unknown members within version 1), so
 * every field is read defensively. A member whose shape this component does not
 * recognize renders as absent rather than as an empty claim — fail-closed.
 */

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(bag: Bag, key: string): string | undefined {
	const value = bag[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(bag: Bag, key: string): number | undefined {
	const value = bag[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The voice an extension's served evidence is entitled to. */
interface Standing {
	upheld: boolean;
	frame: string;
	labelInk: string;
	/** The sentence that names WHY this evidence is not (or is) load-bearing. */
	note: string | null;
	resultWord: string;
	failure?: string;
}

function standingFor(entry: CheckEntry): Standing {
	switch (entry.result) {
		case "passed":
			return {
				upheld: true,
				frame: "lift-1 rounded-xl border border-ut/30 bg-ut/[0.05] p-4",
				labelInk: "text-ut",
				note: null,
				resultWord: RESULT_LABEL.passed,
			};
		case "failed":
			return {
				upheld: false,
				frame: "lift-1 rounded-xl border border-danger/30 bg-danger/[0.05] p-4",
				labelInk: "text-danger-ink",
				note: EXTENSION_FAILURE_MEANING,
				resultWord: RESULT_LABEL.failed,
				failure: entry.failure,
			};
		case "unavailable":
			return {
				upheld: false,
				frame: "lift-1 rounded-xl border border-warning/40 bg-warning/[0.05] p-4",
				labelInk: "text-warning",
				note: UNAVAILABLE_MEANING,
				resultWord: RESULT_LABEL.unavailable,
			};
		default:
			return {
				upheld: false,
				frame: "rounded-xl border border-dashed border-white/20 p-4",
				labelInk: "text-white/70",
				note: null,
				resultWord: RESULT_LABEL.notApplicable,
			};
	}
}

function ExtensionHeader({ title, standing }: { title: string; standing: Standing }) {
	return (
		<p className="flex flex-wrap items-baseline justify-between gap-2">
			<span className={`font-mono text-[12px] uppercase tracking-[0.12em] ${standing.labelInk}`}>
				{title}
			</span>
			<span className={`font-mono text-[12px] tracking-[0.12em] ${standing.labelInk}`}>
				{standing.resultWord}
				{standing.failure ? ` · ${standing.failure}` : ""}
			</span>
		</p>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function RekorPanel({ rekor, standing }: { rekor: Bag; standing: Standing }) {
	const log = isBag(rekor.log) ? rekor.log : undefined;
	const artifactHash = str(rekor, "artifactHash");
	const url = log ? str(log, "url") : undefined;
	const logIndex = log ? num(log, "logIndex") : undefined;
	const integratedTime = log ? num(log, "integratedTime") : undefined;
	const rootHash = log ? str(log, "rootHash") : undefined;
	return (
		<div
			className={standing.frame}
			data-testid="rekor-evidence"
			data-anchor-standing={standing.upheld ? "upheld" : "not-upheld"}
		>
			<ExtensionHeader title="rekor anchor evidence" standing={standing} />
			<p className="mt-2 text-[13px] leading-relaxed text-white/85">{REKOR_EVIDENCE_MEANING}</p>
			{standing.note ? (
				<p className="mt-2 text-[13px] leading-relaxed text-white/70">{standing.note}</p>
			) : null}

			<dl className="mt-3 grid gap-3 sm:grid-cols-2">
				{url ? (
					<Row label="log">
						<span className="font-mono text-[13px] text-white/85">{url}</span>
					</Row>
				) : null}
				{logIndex !== undefined ? (
					<Row label="log index">
						<span className="font-mono text-[13px] text-white/85">{logIndex}</span>
					</Row>
				) : null}
				{integratedTime !== undefined ? (
					<Row label="integratedTime (unix seconds)">
						<span className="font-mono text-[13px] text-white/85">{integratedTime}</span>
					</Row>
				) : null}
				{artifactHash ? (
					<Row label="artifact hash">
						<HashValue value={artifactHash} label="Rekor artifactHash" head={20} />
					</Row>
				) : null}
				{rootHash ? (
					<Row label="log root hash">
						<HashValue value={rootHash} label="Rekor log rootHash" head={20} />
					</Row>
				) : null}
			</dl>

			{/* R8 — the caveat travels WITH an UPHELD anchor. On a failed or
			    unavailable one there is no anchor claim to caveat, and printing
			    the mitigation sentence anyway would read as one. */}
			{standing.upheld ? (
				<p className="mt-3 text-[13px] leading-relaxed text-white/70" data-testid="anchor-caveat">
					{ANCHOR_PARTIAL_MITIGATION}: {ANCHOR_EXTERNAL_VISIBILITY} —{" "}
					{ANCHOR_NOT_PROOF_OF_UNIQUENESS}
				</p>
			) : null}
		</div>
	);
}

function S3Panel({ probes }: { probes: unknown[] }) {
	return (
		<div
			className="rounded-xl border border-dashed border-tim-ink/40 bg-transparent p-4"
			data-testid="s3-object-lock"
		>
			<p className="font-mono text-[12px] uppercase tracking-[0.12em] text-tim-ink">
				s3 object lock probes — context only
			</p>
			<p className="mt-2 text-[13px] leading-relaxed text-white/70">{S3_OPERATOR_ASSERTED}</p>
			<ul className="mt-3 flex flex-col gap-3">
				{probes.filter(isBag).map((report, index) => {
					const sink = str(report, "sink");
					const checks = Array.isArray(report.checks) ? report.checks.filter(isBag) : [];
					return (
						<li key={sink ?? `probe-${index}`}>
							<p className="font-mono text-[12px] break-all text-white/70">
								{sink ?? "(unnamed sink)"}
							</p>
							<ul className="mt-1 flex flex-col gap-1">
								{checks.map((check, checkIndex) => (
									<li
										key={str(check, "name") ?? `check-${checkIndex}`}
										className="font-mono text-[12px] text-white/70"
									>
										{str(check, "name")} · {str(check, "status")} · {str(check, "detail")}
									</li>
								))}
							</ul>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function HistoryPanel({
	history,
	standing,
}: {
	history: SegmentCheckpointV2[];
	standing: Standing;
}) {
	return (
		<div
			className={standing.frame}
			data-testid="checkpoint-history"
			data-history-standing={standing.upheld ? "upheld" : "not-upheld"}
		>
			<ExtensionHeader
				title={`segment-checkpoint history (${history.length})`}
				standing={standing}
			/>
			{/* R7 — "what the walk PROVED" is a claim, so it renders only where the
			    walk actually passed. A served-but-failed history proved nothing. */}
			{standing.upheld ? (
				<p className="mt-2 text-[13px] leading-relaxed text-white/70" data-testid="history-proved">
					{HISTORY_WALK_PROVED}
				</p>
			) : null}
			{standing.note ? (
				<p className="mt-2 text-[13px] leading-relaxed text-white/70">{standing.note}</p>
			) : null}
			<ol className="mt-3 flex flex-col gap-2">
				{history.map((checkpoint) => (
					<li key={checkpoint.segmentId} className="font-mono text-[12px] text-white/70">
						<span className="text-white/85">{checkpoint.segmentId}</span> · first sequence{" "}
						{checkpoint.segmentFirstSequence} · tree size {checkpoint.treeSize} · previous{" "}
						{checkpoint.previousSegmentId}
					</li>
				))}
			</ol>
		</div>
	);
}

export default function AnchorEvidencePanels({
	anchorEvidence,
	checkpointHistory,
	checks,
}: {
	anchorEvidence?: AnchorEvidence;
	checkpointHistory?: SegmentCheckpointV2[];
	/** The extension RESULTS — what the served evidence is entitled to claim. */
	checks: Verification["checks"];
}) {
	const rekor = anchorEvidence && isBag(anchorEvidence.rekor) ? anchorEvidence.rekor : undefined;
	const probes =
		anchorEvidence && Array.isArray(anchorEvidence.s3ObjectLock)
			? anchorEvidence.s3ObjectLock
			: undefined;
	const history =
		Array.isArray(checkpointHistory) && checkpointHistory.length > 0
			? checkpointHistory
			: undefined;
	if (!rekor && !probes && !history) return null;

	return (
		<div className="flex flex-col gap-4" data-testid="extension-evidence">
			{history ? (
				<HistoryPanel history={history} standing={standingFor(checks.checkpointHistory)} />
			) : null}
			{rekor ? <RekorPanel rekor={rekor} standing={standingFor(checks.anchorEvidence)} /> : null}
			{probes ? <S3Panel probes={probes} /> : null}
		</div>
	);
}
