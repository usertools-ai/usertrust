import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				background: "#0a0a1a",
				position: "relative",
			}}
		>
			{/* Bliss-like gradient background */}
			<div
				style={{
					position: "absolute",
					bottom: 0,
					left: 0,
					right: 0,
					height: "45%",
					background:
						"linear-gradient(180deg, #0a0a1a 0%, #0f2a1a 30%, #1a4a2a 50%, #2d6b3a 70%, #1a4a2a 85%, #0a0a1a 100%)",
				}}
			/>
			{/* Sky gradient */}
			<div
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					right: 0,
					height: "60%",
					background: "linear-gradient(180deg, #0a1a3a 0%, #0f2a4a 40%, #1a3a5a 70%, #0a0a1a 100%)",
				}}
			/>

			{/* Content */}
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					gap: "16px",
					position: "relative",
					zIndex: 1,
				}}
			>
				{/* Open source badge */}
				<div
					style={{
						display: "flex",
						padding: "6px 16px",
						borderRadius: "999px",
						border: "1px solid rgba(52,211,153,0.3)",
						fontSize: "14px",
						color: "rgba(52,211,153,0.8)",
						letterSpacing: "0.05em",
					}}
				>
					Open source · Apache 2.0
				</div>

				{/* Main title */}
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: "4px",
					}}
				>
					<span
						style={{
							fontSize: "72px",
							fontWeight: 700,
							color: "#34d399",
							fontFamily: "monospace",
							letterSpacing: "-0.02em",
						}}
					>
						trust()
					</span>
					<span
						style={{
							fontSize: "56px",
							fontWeight: 700,
							color: "#ffffff",
							letterSpacing: "-0.01em",
						}}
					>
						your AI spend
					</span>
				</div>

				{/* Install command */}
				<div
					style={{
						display: "flex",
						padding: "10px 24px",
						borderRadius: "12px",
						border: "1px solid rgba(255,255,255,0.1)",
						background: "rgba(255,255,255,0.04)",
						fontSize: "18px",
						fontFamily: "monospace",
						color: "rgba(255,255,255,0.6)",
						letterSpacing: "0.02em",
					}}
				>
					<span style={{ color: "rgba(52,211,153,0.6)" }}>$</span>
					<span style={{ marginLeft: "8px" }}>npm install usertrust</span>
				</div>
			</div>
		</div>,
		{
			width: 1200,
			height: 630,
		},
	);
}
