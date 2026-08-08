"use client";

import { useEffect, useState } from "react";
import type { ChainSlice } from "@/evidence/types";
import {
	cardStateClassName,
	chainArrowClassName,
	computeBaseline,
	computeTamperedHash,
	computeTamperVerdict,
	hasNextEntry,
	prevHashClassName,
	previewCardHash,
	splitFirstChar,
} from "@/lib/exhibit-d";
import { flipFirstByte } from "./lib/sha256";

type Entries = ChainSlice["entries"];

interface TamperState {
	index: number;
	mutatedSummary: string;
	recomputedHash: string;
}

/**
 * Two hash families live on these cards, and the distinction is the honesty
 * of the demo:
 *  - `entry.hash` / `entry.prevHash` prefixes are the REAL captured values
 *    from chain-slice.json — the identity of the entries.
 *  - `baseline[i]` is the demo's own sha-256 (real WebCrypto) over each
 *    card's visible payload, chained exactly like the product chain: each
 *    entry's preimage includes the entry before it's computed hash.
 *    Tampering recomputes with the same function, so "broken" is a genuine
 *    digest inequality (baseline[i] !== recomputed), never a style toggle.
 */
export default function ExhibitDDom({ entries }: { entries: Entries }) {
	const [baseline, setBaseline] = useState<string[] | null>(null);
	const [tamper, setTamper] = useState<TamperState | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const hashes = await computeBaseline(entries);
			if (!cancelled) setBaseline(hashes);
		})();
		return () => {
			cancelled = true;
		};
	}, [entries]);

	async function handleFlip(index: number) {
		if (!baseline) return;
		const mutatedSummary = flipFirstByte(entries[index].summary);
		const recomputedHash = await computeTamperedHash(entries, baseline, index, mutatedSummary);
		setTamper({ index, mutatedSummary, recomputedHash });
	}

	const verdict =
		tamper !== null && baseline
			? computeTamperVerdict(entries, tamper.index, tamper.recomputedHash, baseline)
			: null;

	return (
		<div>
			<div
				className="overflow-x-auto"
				tabIndex={0}
				role="group"
				aria-label="captured audit chain entries — flip a byte in any entry to break the chain"
			>
				<ol className="flex min-w-max items-center py-4">
					{entries.map((entry, i) => {
						const isTampered = tamper?.index === i;
						const isDownstream = tamper !== null && i > tamper.index;
						const failed = isTampered || isDownstream;
						const summary = isTampered && tamper ? tamper.mutatedSummary : entry.summary;
						const { first, rest } = splitFirstChar(summary);
						return (
							<li key={entry.hash} className="flex items-center">
								<article className={cardStateClassName(failed)}>
									<header className="flex items-baseline justify-between">
										<span className="text-white/50">entry {entry.seq}</span>
										<span className={failed ? "text-danger" : "text-ut"}>
											{isTampered ? "TAMPERED" : isDownstream ? "FAILED" : "✓"}
										</span>
									</header>
									<p className="mt-2 truncate text-white/80">{entry.type}</p>
									<p className="mt-1 truncate text-white/50">
										{isTampered ? (
											<>
												<mark className="bg-danger/30 text-danger">{first}</mark>
												{rest}
											</>
										) : (
											summary
										)}
									</p>
									<p className="mt-2 text-white/40">sha256 {previewCardHash(entry.hash)}…</p>
									<p className={prevHashClassName(isDownstream)}>
										prev&nbsp;&nbsp;&nbsp;{previewCardHash(entry.prevHash)}…
									</p>
									{isTampered && tamper && baseline && (
										<p className="mt-2 border-t border-danger/40 pt-2">
											<span className="block text-danger">
												now {previewCardHash(tamper.recomputedHash)}…
											</span>
											<span className="block text-white/40">
												was {previewCardHash(baseline[i])}…
											</span>
										</p>
									)}
									{isDownstream && <p className="mt-2 text-danger">prevHash no longer matches</p>}
									<button
										type="button"
										onClick={() => handleFlip(i)}
										disabled={!baseline}
										className="focus-ring mt-3 w-full rounded-sm border border-brand-border px-2 py-1 text-white/70 hover:border-brand-border-hover hover:text-white disabled:opacity-40"
									>
										flip a byte
									</button>
								</article>
								{hasNextEntry(i, entries.length) && (
									<span
										aria-hidden="true"
										className={chainArrowClassName(tamper !== null && i >= tamper.index)}
									>
										⟶
									</span>
								)}
							</li>
						);
					})}
				</ol>
			</div>
			<div className="mt-4 flex flex-wrap items-center gap-4">
				<button
					type="button"
					onClick={() => setTamper(null)}
					disabled={tamper === null}
					className="focus-ring rounded-sm border border-brand-border px-3 py-1.5 font-mono text-xs text-white/70 hover:border-brand-border-hover hover:text-white disabled:opacity-40"
				>
					restore
				</button>
				<p role="status" aria-live="polite" className="font-mono text-xs">
					{verdict === null ? (
						<span className="text-white/50">
							chain intact — {entries.length} entries, every prevHash verified
						</span>
					) : (
						<span className="text-danger">
							<span className="block">✗ chain broken at entry {verdict.brokenSeq}</span>
							<span className="block text-danger/80">{verdict.message}</span>
						</span>
					)}
				</p>
			</div>
		</div>
	);
}
