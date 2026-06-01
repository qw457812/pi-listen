/**
 * Standalone VolcEngine ASR test.
 * Mode 1 (default): bigmodel_nostream — batch, sends all audio then waits for result.
 * Mode 2: bigmodel_async — streaming, sends audio with interim results.
 *
 * Usage:
 *   VOLC_API_KEY=your-key bun run scripts/test-volcengine.ts
 *   VOLC_API_KEY=your-key STREAM=1 bun run scripts/test-volcengine.ts
 *
 * Audio source:
 *   - If WAV_FILE env is set, reads that file
 *   - Otherwise generates 3s of synthetic multi-tone audio (not speech)
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

const VOLC_WS_URL_NOSTREAM = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const VOLC_WS_URL_ASYNC = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SEGMENT_DURATION_MS = 200;
const SEGMENT_SIZE = Math.floor((SAMPLE_RATE * 2 * CHANNELS * SEGMENT_DURATION_MS) / 1000);

const useStream = process.env.STREAM === "1";
const VOLC_WS_URL = useStream ? VOLC_WS_URL_ASYNC : VOLC_WS_URL_NOSTREAM;

// Protocol constants
const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;
const MSG_FULL_REQ = 0b0001;
const MSG_AUDIO_REQ = 0b0010;
const FLAG_POS_SEQ = 0b0001;
const FLAG_NEG_SEQ = 0b0011;
const SER_JSON = 0b0001;
const COMP_GZIP = 0b0001;

function buildHeader(msgType: number, flags: number, ser: number, comp: number) {
	return Buffer.from([
		(PROTOCOL_VERSION << 4) | HEADER_SIZE,
		(msgType << 4) | flags,
		(ser << 4) | comp,
		0,
	]);
}

function buildFullReq(seq: number, payload: unknown) {
	const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
	const meta = Buffer.alloc(8);
	meta.writeInt32BE(seq, 0);
	meta.writeUInt32BE(body.length, 4);
	return Buffer.concat([buildHeader(MSG_FULL_REQ, FLAG_POS_SEQ, SER_JSON, COMP_GZIP), meta, body]);
}

function buildAudioReq(seq: number, audio: Buffer, isLast: boolean) {
	const body = gzipSync(audio);
	const meta = Buffer.alloc(8);
	meta.writeInt32BE(isLast ? -seq : seq, 0);
	meta.writeUInt32BE(body.length, 4);
	return Buffer.concat([
		buildHeader(MSG_AUDIO_REQ, isLast ? FLAG_NEG_SEQ : FLAG_POS_SEQ, 0, COMP_GZIP),
		meta,
		body,
	]);
}

function parseFrame(data: Buffer) {
	const headerSize = (data[0]! & 0x0f) * 4;
	const msgType = data[1]! >> 4;
	const flags = data[1]! & 0x0f;
	const ser = data[2]! >> 4;
	const comp = data[2]! & 0x0f;
	let offset = headerSize;
	let seq: number | null = null;
	const isLast = Boolean(flags & 0b0010);
	if (flags & 0b0001) { seq = data.readInt32BE(offset); offset += 4; }

	if (msgType === 0b1001) {
		const payloadSize = data.readUInt32BE(offset); offset += 4;
		const payload = data.subarray(offset, offset + payloadSize);
		const decoded = comp === 1 && payload.length > 0 ? gunzipSync(payload) : payload;
		const parsed = ser === 1 && decoded.length > 0 ? JSON.parse(decoded.toString("utf8")) : decoded;
		return { msgType, seq, isLast, payload: parsed };
	}
	if (msgType === 0b1111) {
		const errCode = data.readUInt32BE(offset); offset += 4;
		const payloadSize = data.readUInt32BE(offset); offset += 4;
		const payload = data.subarray(offset, offset + payloadSize);
		throw new Error(`ASR error ${errCode}: ${payload.toString("utf8")}`);
	}
	return { msgType, seq, isLast, payload: null };
}

function parseWavPcm(filePath: string): Buffer {
	const wav = readFileSync(filePath);
	if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
		throw new Error("Not a valid WAV file");
	}
	let offset = 12;
	let dataChunk: Buffer | null = null;
	while (offset + 8 <= wav.length) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		if (id === "data") {
			dataChunk = wav.subarray(offset + 8, offset + 8 + size);
			break;
		}
		offset += 8 + size + (size % 2);
	}
	if (!dataChunk) throw new Error("No data chunk in WAV");
	return dataChunk;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const apiKey = process.env.VOLC_API_KEY;
if (!apiKey) {
	console.error("Set VOLC_API_KEY env var");
	process.exit(1);
}

let pcm: Buffer;
const wavFile = process.env.WAV_FILE;

if (wavFile && existsSync(wavFile)) {
	console.log(`Reading WAV file: ${wavFile}`);
	pcm = parseWavPcm(wavFile);
	console.log(`PCM data: ${pcm.length} bytes (${(pcm.length / (SAMPLE_RATE * 2)).toFixed(2)}s)`);
} else {
	console.log("Generating 3s of synthetic audio (multi-tone, ~voice bandwidth)...");
	const durationSec = 3;
	const numSamples = SAMPLE_RATE * durationSec;
	pcm = Buffer.alloc(numSamples * 2);
	for (let i = 0; i < numSamples; i++) {
		// Mix of frequencies in voice range (300-3400 Hz) to simulate speech-like energy
		const t = i / SAMPLE_RATE;
		const val = Math.round(
			(Math.sin(2 * Math.PI * 300 * t) * 0.2 +
				Math.sin(2 * Math.PI * 800 * t) * 0.3 +
				Math.sin(2 * Math.PI * 1500 * t) * 0.2 +
				Math.sin(2 * Math.PI * 2500 * t) * 0.1 +
				(Math.random() - 0.5) * 0.2) * 16000
		);
		pcm.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
	}
	console.log(`PCM data: ${pcm.length} bytes (${durationSec}s)`);
}

console.log(`\nEndpoint: ${VOLC_WS_URL} (${useStream ? "streaming" : "batch"})`);

const connectId = randomUUID();
const ws = new (require("ws") as any)(VOLC_WS_URL, {
	headers: {
		"X-Api-Key": apiKey,
		"X-Api-Request-Id": connectId,
		"X-Api-Resource-Id": "volc.seedasr.sauc.duration",
	},
	handshakeTimeout: 15_000,
});

let sequence = 1;
let fullText = "";
let responseCount = 0;

ws.on("open", () => {
	console.log("✓ WebSocket connected");

	// Send full client request — sequence must increment synchronously
	const reqSeq = sequence;
	sequence += 1;

	const requestPayload = {
		user: { uid: "test-script" },
		audio: { format: "pcm", codec: "raw", rate: SAMPLE_RATE, bits: 16, channel: CHANNELS },
		request: {
			model_name: "bigmodel",
			enable_itn: true,
			enable_punc: true,
			enable_ddc: true,
			show_utterances: true,
			...(useStream
				? { result_type: "single", end_window_size: 1200, force_to_speech_time: 1000 }
				: { result_type: "full" }),
		},
	};

	console.log(`Sending full client request (seq=${reqSeq})...`);
	ws.send(buildFullReq(reqSeq, requestPayload));

	// Send all audio segments with last flag
	let audioPackets = 0;
	for (let offset = 0; offset < pcm.length; offset += SEGMENT_SIZE) {
		const seg = pcm.subarray(offset, Math.min(offset + SEGMENT_SIZE, pcm.length));
		const isLast = offset + SEGMENT_SIZE >= pcm.length;
		const seq = sequence;
		sequence += 1;
		audioPackets += 1;
		ws.send(buildAudioReq(seq, seg, isLast));
	}
	console.log(`✓ Sent ${audioPackets} audio packets + 1 last packet`);
	console.log("Waiting for response...\n");
});

ws.on("message", (data: Buffer) => {
	try {
		const frame = parseFrame(data);
		responseCount += 1;
		if (frame.payload) {
			const root = frame.payload as any;
			const result = root?.result;
			const text = result?.text || "";
			const utterances = result?.utterances || [];
			if (text || utterances.length > 0) {
				if (useStream) {
					const parts = utterances.map((u: any) =>
						u.definite ? `[final] ${u.text}` : `[interim] ${u.text}`
					);
					console.log(`  [${responseCount}] seq=${frame.seq} isLast=${frame.isLast}: ${parts.join(" | ") || text}`);
				} else {
					console.log(`  [${responseCount}] seq=${frame.seq} isLast=${frame.isLast}: text="${text}"`);
				}
				if (text) fullText = text;
			} else {
				console.log(`  [${responseCount}] seq=${frame.seq} isLast=${frame.isLast}: (empty payload)`);
			}
		}
		if (frame.isLast) {
			console.log(`\n━━━ Final transcript: "${fullText}" ━━━`);
			ws.close();
			process.exit(fullText ? 0 : 1);
		}
	} catch (e: any) {
		console.error(`  [${responseCount}] Parse error: ${e.message}`);
		ws.close();
		process.exit(1);
	}
});

ws.on("error", (err: Error) => {
	console.error("✗ WebSocket error:", err.message);
	process.exit(1);
});

ws.on("close", (code: number) => {
	console.log(`WebSocket closed (code=${code}), responses received: ${responseCount}`);
	if (!fullText) {
		console.log("No transcript received (expected for non-speech audio).");
	}
});

setTimeout(() => {
	console.error("\n✗ Timeout — no final transcript in 20s");
	ws.close();
	process.exit(1);
}, 20_000);
