import { plainState } from "../lib/plain-copy";
import {
	INVALID_ID_HEADLINE,
	INVALID_ID_NEVER_ASKED,
	INVALID_ID_RULE_NOTE,
} from "../lib/shell-copy";
import type { InvalidIdState } from "../lib/wire";
import Details from "./details";
import NonGreenMasthead from "./nongreen-masthead";

/** Local R2 refusal: a plain word and line; the rule, the reason and the raw input are in Details. */
export default function InvalidIdStateView({ state }: { state: InvalidIdState }) {
	const plain = plainState(state);
	return (
		<section data-state="invalidId" className="flex flex-col gap-6">
			<NonGreenMasthead word={plain.word} register={plain.register}>
				<p className="text-[13px] leading-relaxed text-white/70">{plain.line}</p>
			</NonGreenMasthead>
			<Details>
				<p className="text-white/85">{INVALID_ID_HEADLINE}</p>
				<p className="text-[13px] leading-relaxed text-white/70" data-testid="invalid-id-reason">
					{state.reason}
				</p>
				<p className="text-[13px] leading-relaxed text-white/70">{INVALID_ID_RULE_NOTE}</p>
				<p className="text-[13px] leading-relaxed text-white/70">{INVALID_ID_NEVER_ASKED}</p>
				<p
					className="font-mono text-[12px] break-all text-white/50"
					data-testid="invalid-route-param"
				>
					{state.routeParamId}
				</p>
			</Details>
		</section>
	);
}
