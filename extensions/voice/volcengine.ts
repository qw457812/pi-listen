/**
 * VolcEngine (Doubao / Bytedance) Seed ASR backend — WebSocket binary protocol.
 *
 * Implements the Seed ASR 2.0 bidirectional streaming protocol:
 *   wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
 *
 * Protocol reference:
 *   https://www.volcengine.com/docs/6561/1354869
 *
 * Architecture:
 *   - Binary frames: 4-byte variable header + sequence + payload size + payload
 *   - Payload compression: gzip
 *   - Payload serialization: JSON
 *   - Audio format: PCM s16le 16kHz mono (matches pi-listen pipeline)
 *
 * Three streaming modes:
 *   - bigmodel_async: optimized bidirectional — our default. Lower RTF, better
 *     first-token and last-token latency than bigmodel. Only sends incremental
 *     results when they change (result_type="single").
 *   - bigmodel: bidirectional with cumulative results — not used.
 *   - bigmodel_nostream: batch — not used (we have local backend for that).
 *
 * Auth: HTTP headers on WebSocket upgrade
 *   Common:
 *     - X-Api-Resource-Id: service tier identifier
 *   Old console:
 *     - X-Api-App-Key: APP ID from VolcEngine console
 *     - X-Api-Access-Key: Access Token from VolcEngine console
 *     - X-Api-Connect-Id: UUID for tracing
 *   New console:
 *     - X-Api-Key: APP Key from VolcEngine console
 *     - X-Api-Request-Id: UUID for tracing
 */

import type { VoiceConfig } from "./config";
import { spawn } from "node:child_process";
import { SAMPLE_RATE, CHANNELS } from "./deepgram";

// ─── Constants ───────────────────────────────────────────────────────────────

// Optimized bidirectional streaming endpoint — only returns data when results change.
// Better RTF, first-token and last-token latency vs standard bigmodel endpoint.
// Supports enable_nonstream (two-pass recognition) for higher accuracy.
export const VOLCENGINE_WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
export const VOLCENGINE_API_KEY_URL = "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default";

// Resource IDs for Seed ASR 2.0 (hourly billing)
const RESOURCE_ID_SEED_2_DURATION = "volc.seedasr.sauc.duration";
const RESOURCE_ID_SEED_2_CONCURRENT = "volc.seedasr.sauc.concurrent";
// Resource IDs for ASR 1.0
const RESOURCE_ID_SEED_1_DURATION = "volc.bigasr.sauc.duration";
const RESOURCE_ID_SEED_1_CONCURRENT = "volc.bigasr.sauc.concurrent";

// ─── Binary protocol constants ───────────────────────────────────────────────

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001; // header size = 1 * 4 = 4 bytes

const MSG_TYPE_CLIENT_FULL_REQUEST = 0b0001;
const MSG_TYPE_CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const MSG_TYPE_SERVER_FULL_RESPONSE = 0b1001;
const MSG_TYPE_SERVER_ERROR_RESPONSE = 0b1111;

const FLAG_NO_SEQUENCE = 0b0000;
const FLAG_POS_SEQUENCE = 0b0001;
const FLAG_LAST_PACKET = 0b0010;
const FLAG_NEG_SEQUENCE = 0b0011;

const SERIALIZATION_NONE = 0b0000;
const SERIALIZATION_JSON = 0b0001;

const COMPRESSION_NONE = 0b0000;
const COMPRESSION_GZIP = 0b0001;

// Recommended segment size: 200ms of audio at 16kHz 16bit mono = 6400 bytes
const SEGMENT_DURATION_MS = 200;
const SEGMENT_SIZE = Math.floor((SAMPLE_RATE * 2 * CHANNELS * SEGMENT_DURATION_MS) / 1000);

// Timeouts
const WS_CONNECT_TIMEOUT_MS = 15_000;
const STALE_SESSION_TIMEOUT_MS = 15_000;
const STREAM_FINALIZE_TIMEOUT_MS = 3000;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Credentials resolved from config / environment. */
interface VolcCredentials {
	/** New console (X-Api-Key). Takes priority if set. */
	apiKey?: string;
	/** Old console (X-Api-App-Key + X-Api-Access-Key). */
	appKey?: string;
	accessKey?: string;
	resourceId: string;
}

/** Decoded server frame from the binary protocol. */
export interface DecodedFrame {
	messageType: number;
	sequence: number | null;
	isLast: boolean;
	payload: unknown;
}

/** VolcEngine streaming session — mirrors Deepgram StreamingSession interface. */
export interface VolcEngineSession {
	backend: "volcengine";
	ws: WebSocket;
	recProcess: import("node:child_process").ChildProcess;
	interimText: string;
	finalizedParts: string[];
	/** Monotonic sequence counter — incremented per frame sent to server. */
	sequence: number;
	staleSessionTimer: ReturnType<typeof setTimeout> | null;
	finalizeTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
	stopRequested: boolean;
	hadAudioData: boolean;
	hadSpeech: boolean;
	receivedMessage: boolean;
	onTranscript: (interim: string, finals: string[]) => void;
	onDone: (fullText: string, meta: { hadAudio: boolean; hadSpeech: boolean }) => void;
	onError: (err: string) => void;
	/** Optional hook for UI audio-level metering. Called from the same stdout listener that streams audio. */
	onAudioData?: (chunk: Buffer) => void;
}

// ─── Config helpers ──────────────────────────────────────────────────────────

/**
 * Resolve VolcEngine API credentials from environment or config.
 * Priority: environment variables > config fields.
 */
export function resolveVolcEngineCredentials(config: VoiceConfig): VolcCredentials | null {
	// New console: single API key via VOLC_API_KEY env or volcApiKey config
	const apiKey = process.env.VOLC_API_KEY || config.volcApiKey || "";
	// Old console: APP ID + Access Token
	const appKey = process.env.VOLC_APP_KEY || config.volcAppKey || "";
	const accessKey = process.env.VOLC_ACCESS_KEY || config.volcAccessKey || "";

	// Determine resource ID based on model version
	const version = config.volcModelVersion || "2.0";
	const resourceId = version === "1.0"
		? RESOURCE_ID_SEED_1_DURATION
		: RESOURCE_ID_SEED_2_DURATION;

	// New console takes priority (single key)
	if (apiKey) {
		return { apiKey, resourceId };
	}
	// Fallback: old console (needs both appKey + accessKey)
	if (appKey && accessKey) {
		return { appKey, accessKey, resourceId };
	}
	return null;
}

/** Check if VolcEngine backend is configured and ready. */
export function isVolcEngineReady(config: VoiceConfig): boolean {
	return resolveVolcEngineCredentials(config) !== null;
}

// ─── Binary protocol: frame building ────────────────────────────────────────

import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

export function buildHeader(
	messageType: number,
	flags: number,
	serialization: number,
	compression: number,
): Uint8Array {
	return new Uint8Array([
		(PROTOCOL_VERSION << 4) | HEADER_SIZE,
		(messageType << 4) | flags,
		(serialization << 4) | compression,
		0, // reserved
	]);
}

/** Write an int32 value in big-endian to a Uint8Array at the given offset. */
function writeInt32BE(arr: Uint8Array, offset: number, value: number): void {
	arr[offset] = (value >>> 24) & 0xff;
	arr[offset + 1] = (value >>> 16) & 0xff;
	arr[offset + 2] = (value >>> 8) & 0xff;
	arr[offset + 3] = value & 0xff;
}

/** Write a uint32 value in big-endian to a Uint8Array at the given offset. */
function writeUInt32BE(arr: Uint8Array, offset: number, value: number): void {
	writeInt32BE(arr, offset, value >>> 0);
}

/** Concatenate multiple Uint8Arrays into one. */
function concatU8(arrays: Uint8Array[]): Uint8Array {
	let totalLen = 0;
	for (const a of arrays) totalLen += a.length;
	const result = new Uint8Array(totalLen);
	let offset = 0;
	for (const a of arrays) {
		result.set(a, offset);
		offset += a.length;
	}
	return result;
}

/** Convert a Buffer to a plain Uint8Array. Buffer is a subtype of Uint8Array,
 *  but some operations (e.g. frame.buffer.slice) behave differently with pooled
 *  Buffer memory, so we copy to a standalone Uint8Array for safety. */
function toU8(buf: Uint8Array | Buffer): Uint8Array {
	if (buf instanceof Uint8Array) {
		// Buffer is also a Uint8Array — if it's a pooled Buffer, copy to avoid
		// shared ArrayBuffer issues when slicing.
		if (Buffer.isBuffer(buf) && buf.buffer !== buf.buffer) {
			return new Uint8Array(buf as unknown as ArrayBufferLike);
		}
		return buf;
	}
	// Should not happen at runtime, but keep for type completeness
	const arr = new Uint8Array((buf as any).length);
	for (let i = 0; i < (buf as any).length; i++) arr[i] = (buf as any)[i]!;
	return arr;
}

/** Encode a string to UTF-8 bytes (avoids Buffer.from with encoding). */
const _textEncoder = new TextEncoder();
function utf8Encode(s: string): Uint8Array {
	return _textEncoder.encode(s);
}

/**
 * Build a "full client request" frame — sent once after WebSocket open.
 * Contains audio metadata and request parameters as gzipped JSON.
 *
 * bigmodel_async requires a positive sequence number (FLAG_POS_SEQUENCE)
 * even for the initial config frame; omitting it causes:
 *   "autoAssignedSequence mismatch sequence in request"
 */
export function buildFullClientRequest(sequence: number, payload: unknown): Uint8Array {
	const body = toU8(gzipSync(utf8Encode(JSON.stringify(payload))));
	const meta = new Uint8Array(8);
	writeInt32BE(meta, 0, sequence);      // sequence number (positive)
	writeUInt32BE(meta, 4, body.length);   // payload size
	return concatU8([
		buildHeader(MSG_TYPE_CLIENT_FULL_REQUEST, FLAG_POS_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_GZIP),
		meta,
		body,
	]);
}

/**
 * Build an "audio only" frame — sent for each audio chunk.
 * Last frame uses negative sequence to signal end of stream.
 */
export function buildAudioRequest(sequence: number, audio: Buffer, isLast: boolean): Uint8Array {
	const body = toU8(gzipSync(audio));
	const meta = new Uint8Array(8);
	writeInt32BE(meta, 0, isLast ? -sequence : sequence);
	writeUInt32BE(meta, 4, body.length);
	return concatU8([
		buildHeader(
			MSG_TYPE_CLIENT_AUDIO_ONLY_REQUEST,
			isLast ? FLAG_NEG_SEQUENCE : FLAG_POS_SEQUENCE,
			SERIALIZATION_NONE,
			COMPRESSION_GZIP,
		),
		meta,
		body,
	]);
}

// ─── Binary protocol: frame parsing ─────────────────────────────────────────

function bufferFromWsData(data: ArrayBuffer | ArrayBufferView): Buffer {
	if (data == null) throw new Error("VolcEngine: received null/undefined WebSocket data");
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (typeof (data as any).buffer === "object" && (data as any).buffer instanceof ArrayBuffer) {
		return Buffer.from((data as any).buffer, (data as any).byteOffset, (data as any).byteLength);
	}
	// Fallback: try Buffer.from with the data directly
	return Buffer.from(data as any);
}

function decodePayload(serialization: number, compression: number, payload: Buffer): unknown {
	const decoded = compression === COMPRESSION_GZIP && payload.length > 0
		? gunzipSync(payload)
		: payload;
	if (serialization === SERIALIZATION_JSON && decoded.length > 0) {
		return JSON.parse(decoded.toString("utf8"));
	}
	return decoded;
}

/**
 * Parse a server frame from raw WebSocket data.
 * Throws on error frames or malformed data.
 */
export function parseServerFrame(data: ArrayBuffer | ArrayBufferView): DecodedFrame {
	const msg = bufferFromWsData(data);
	if (msg.length < 4) throw new Error("VolcEngine ASR: frame header too short");

	const headerSize = (msg[0]! & 0x0f) * 4;
	const messageType = msg[1]! >> 4;
	const flags = msg[1]! & 0x0f;
	const serialization = msg[2]! >> 4;
	const compression = msg[2]! & 0x0f;
	let offset = headerSize;

	// Read sequence number if present
	let sequence: number | null = null;
	const isLast = Boolean(flags & 0b0010); // FLAG_LAST_PACKET or FLAG_NEG_SEQUENCE
	if (flags & 0b0001) {
		sequence = msg.readInt32BE(offset);
		offset += 4;
	}

	// Full server response
	if (messageType === MSG_TYPE_SERVER_FULL_RESPONSE) {
		const payloadSize = msg.readUInt32BE(offset);
		offset += 4;
		if (offset + payloadSize > msg.length) {
			throw new Error(`VolcEngine ASR: payload truncated (need ${payloadSize}B at offset ${offset}, have ${msg.length}B)`);
		}
		const payload = msg.subarray(offset, offset + payloadSize);
		return {
			messageType,
			sequence,
			isLast,
			payload: decodePayload(serialization, compression, payload),
		};
	}

	// Error response
	if (messageType === MSG_TYPE_SERVER_ERROR_RESPONSE) {
		const errorCode = msg.readUInt32BE(offset);
		offset += 4;
		const payloadSize = msg.readUInt32BE(offset);
		offset += 4;
		if (offset + payloadSize > msg.length) {
			throw new Error(`VolcEngine ASR: error payload truncated (need ${payloadSize}B at offset ${offset}, have ${msg.length}B)`);
		}
		const payload = msg.subarray(offset, offset + payloadSize);
		let detail: unknown;
		try {
			detail = decodePayload(serialization, compression, payload);
		} catch {
			detail = payload.toString("utf8");
		}
		throw new Error(`VolcEngine ASR error ${errorCode}: ${JSON.stringify(detail)}`);
	}

	return { messageType, sequence, isLast, payload: null };
}

// ─── Transcript extraction ──────────────────────────────────────────────────

/**
 * Extract text from a VolcEngine server response payload.
 *
 * Response structure:
 *   { result: { text: "full text", utterances: [{ text, definite, ... }] } }
 *
 * Mapping to pi-listen's interim/final model:
 *   - utterance with definite=true → finalizedParts
 *   - utterance with definite=false → interimText
 *   - top-level result.text → fallback
 */
interface VolcUtterance {
	text?: string;
	definite?: boolean;
}

interface VolcResult {
	text?: string;
	utterances?: VolcUtterance[];
}

interface VolcResponse {
	result?: VolcResult;
}

export function extractTranscript(payload: unknown): { interim: string; finals: string[] } {
	if (!payload || typeof payload !== "object") return { interim: "", finals: [] };

	const root = payload as VolcResponse;
	const result = root.result;
	if (!result) return { interim: "", finals: [] };

	// If we have utterances, use definite flag to split interim/final
	if (Array.isArray(result.utterances) && result.utterances.length > 0) {
		const finals: string[] = [];
		let interim = "";

		for (const u of result.utterances) {
			const text = (typeof u.text === "string" ? u.text : "").trim();
			if (!text) continue;
			if (u.definite) {
				finals.push(text);
			} else {
				interim = text;
			}
		}
		return { interim, finals };
	}

	// Fallback: use top-level text as final (no interim separation possible)
	const text = (typeof result.text === "string" ? result.text : "").trim();
	if (text) {
		return { interim: "", finals: [text] };
	}
	return { interim: "", finals: [] };
}

// ─── WebSocket send helper ───────────────────────────────────────────────────

function sendWs(ws: WebSocket, frame: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			const payload = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
			// Pi runs on WHATWG-style WebSocket implementations (Bun/Node globals),
			// whose send() signature is send(data) and ignores callback arguments.
			// Calling ws.send(data, options, cb) would make this Promise hang forever.
			// Binary-ness is inferred from ArrayBuffer, so no options are required.
			(ws as any).send(payload);
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Start a VolcEngine bidirectional streaming session.
 * Returns a VolcEngineSession or null on immediate failure.
 *
 * The session interface mirrors Deepgram's StreamingSession so voice.ts
 * can use the same onTranscript/onDone/onError callback pattern.
 */
export function startVolcEngineSession(
	config: VoiceConfig,
	audioTool: { name: string; cmd: string; args: string[] },
	debugLog: (...args: unknown[]) => void,
	callbacks: {
		onTranscript: (interim: string, finals: string[]) => void;
		onDone: (fullText: string, meta: { hadAudio: boolean; hadSpeech: boolean }) => void;
		onError: (err: string) => void;
		onAudioData?: (chunk: Buffer) => void;
	},
): VolcEngineSession | null {
	const creds = resolveVolcEngineCredentials(config);
	debugLog("startVolcEngineSession", { hasCreds: !!creds });
	if (!creds) {
		debugLog("startVolcEngineSession → no credentials");
		callbacks.onError("VolcEngine credentials not configured. Set VOLC_API_KEY (new console) or VOLC_APP_KEY + VOLC_ACCESS_KEY (old console), or configure in settings.");
		return null;
	}

	// Start audio capture
	const recProc = spawn(audioTool.cmd, audioTool.args, { stdio: ["pipe", "pipe", "pipe"] });
	recProc.stderr?.on("data", (d: Buffer) => {
		const msg = d.toString().trim();
		if (msg.includes("buffer overrun") || msg.includes("Discarding") || msg.includes("Last message repeated")) return;
		debugLog(`${audioTool.name} stderr:`, msg);
	});

	// Build WebSocket URL and connect
	const connectId = randomUUID();

	const ws = new WebSocket(VOLCENGINE_WS_URL, {
		headers: {
			...(creds.apiKey
				? { "X-Api-Key": creds.apiKey, "X-Api-Request-Id": connectId }
				: { "X-Api-App-Key": creds.appKey, "X-Api-Access-Key": creds.accessKey, "X-Api-Connect-Id": connectId }),
			"X-Api-Resource-Id": creds.resourceId,
		},
		handshakeTimeout: WS_CONNECT_TIMEOUT_MS,
	} as any);

	// Ensure binary frames arrive as ArrayBuffer, not Blob (browser default).
	// Pi's WebSocket may not read this property, but it's harmless if unsupported.
	try { (ws as any).binaryType = "arraybuffer"; } catch {}

	// Connection timeout
	const wsConnectTimeout = setTimeout(() => {
		if (ws.readyState !== WebSocket.OPEN) {
			debugLog("VolcEngine WebSocket connection timeout");
			try { ws.close(); } catch {}
			try { recProc.kill("SIGTERM"); } catch {}
			callbacks.onError("VolcEngine connection timed out. Check your network.");
		}
	}, WS_CONNECT_TIMEOUT_MS + 2000);

	// Build session object
	const session: VolcEngineSession = {
		backend: "volcengine",
		ws,
		recProcess: recProc,
		interimText: "",
		finalizedParts: [],
		sequence: 1,
		staleSessionTimer: null,
		finalizeTimer: null,
		closed: false,
		stopRequested: false,
		hadAudioData: false,
		hadSpeech: false,
		receivedMessage: false,
		onTranscript: callbacks.onTranscript,
		onDone: callbacks.onDone,
		onError: callbacks.onError,
		onAudioData: callbacks.onAudioData,
	};

	// Handle HTTP error responses before WebSocket upgrade
	if (typeof (ws as any).on === "function") {
		(ws as any).on("unexpected-response", (_req: any, res: any) => {
			let body = "";
			res.on("data", (d: Buffer) => { body += d.toString(); });
			res.on("end", () => {
				debugLog("VolcEngine unexpected-response", { status: res.statusCode, body });
				if (!session.closed) {
					failVolcSession(session, `VolcEngine HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
				}
			});
		});
	}

	ws.onopen = () => {
		clearTimeout(wsConnectTimeout);
		debugLog("VolcEngine WebSocket onopen → sending full client request");

		// Keepalive not used — VolcEngine protocol doesn't need it.
		// WebSocket TCP-level keepalive handles connection health.

		// Build and send full client request with audio metadata
		const requestPayload: Record<string, unknown> = {
			user: { uid: "pi-listen" },
			audio: {
				format: "pcm",
				codec: "raw",
				rate: SAMPLE_RATE,
				bits: 16,
				channel: CHANNELS,
				// NOTE: language field is NOT sent here — the bigmodel (bidirectional)
				// endpoint does not support it per VolcEngine docs. Default behavior
				// handles Chinese + English + dialects. For other languages, use
				// Deepgram or local backend instead.
			},
			request: {
				model_name: "bigmodel",
				enable_itn: true,
				enable_punc: true,
				enable_ddc: config.volcEnableDdc ?? true,
				show_utterances: true,
				result_type: "single",
				// Force sentence finalization after 1200ms silence
				// so we get timely definite=true markers
				end_window_size: 1200,
				// Allow finalization after 1000ms of speech — without this,
				// end_window_size cannot produce definite=true until 10s of
				// audio have been sent (default force_to_speech_time=10000).
				// This is critical for short utterances typical of pi-listen.
				force_to_speech_time: 1000,
			},
		};

		// Capture sequence synchronously BEFORE any async gap — audio data may
		// arrive before a .then() callback fires, so we must increment now.
		const fullRequestSeq = session.sequence;
		session.sequence += 1;

		sendWs(ws, buildFullClientRequest(fullRequestSeq, requestPayload))
			.then(() => {
				debugLog("VolcEngine full client request sent", { seq: fullRequestSeq });
			})
			.catch((err) => {
				debugLog("VolcEngine failed to send full client request", String(err));
				failVolcSession(session, `Failed to send VolcEngine request: ${err}`);
			});

		// Stream audio data to VolcEngine
		recProc.stdout?.on("data", async (chunk: Buffer) => {
			if (ws.readyState !== WebSocket.OPEN) return;
			session.onAudioData?.(chunk);
			session.hadAudioData = true;

			// Split audio into segments matching VolcEngine's recommended 200ms chunks.
			// Each segment is sent sequentially with backpressure — we await the
			// WebSocket write callback before sending the next segment. If the
			// buffer is saturated (>64KB), we skip the send; the server auto-finalizes
			// after end_window_size ms of silence from missing segments.
			const sendChunk = async (audio: Buffer): Promise<void> => {
				const seq = session.sequence;
				session.sequence += 1; // always increment — gaps are acceptable
				const buffered = (ws as any).bufferedAmount ?? 0;
				if (buffered > 65536) {
					debugLog("VolcEngine send skipped (buffer saturated)", { buffered, seq });
					return;
				}
				try {
					await sendWs(ws, buildAudioRequest(seq, audio, false));
				} catch (err) {
					debugLog("VolcEngine audio send error", { seq, err: String(err) });
					if (!session.closed) {
						failVolcSession(session, `VolcEngine audio send failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			};

			if (chunk.length <= SEGMENT_SIZE) {
				await sendChunk(chunk);
			} else {
				for (let offset = 0; offset < chunk.length; offset += SEGMENT_SIZE) {
					const seg = chunk.subarray(offset, Math.min(offset + SEGMENT_SIZE, chunk.length));
					await sendChunk(seg);
				}
			}

			// Start stale session watchdog on first audio chunk
			if (!session.staleSessionTimer && !session.receivedMessage) {
				session.staleSessionTimer = setTimeout(() => {
					if (!session.closed && !session.receivedMessage) {
						debugLog("VolcEngine stale session: no response after 15s of audio");
						failVolcSession(session, "No response from VolcEngine (15s). Check your credentials and network.");
					}
				}, STALE_SESSION_TIMEOUT_MS);
			}
		});
	};

	// With result_type="single", the server returns incremental results only.
	// Each response with definite=true contains newly finalized utterances —
	// no cumulative dedup needed.

	/** Process a binary WebSocket frame (extracted from onmessage). */
	const processFrame = (data: ArrayBuffer | ArrayBufferView) => {
		try {
			const frame = parseServerFrame(data);

			// Cancel stale-session watchdog on first response
			if (!session.receivedMessage) {
				session.receivedMessage = true;
				if (session.staleSessionTimer) {
					clearTimeout(session.staleSessionTimer);
					session.staleSessionTimer = null;
				}
			}

			if (frame.payload) {
				const { interim, finals } = extractTranscript(frame.payload);

				if (interim || finals.length > 0) {
					session.hadSpeech = true;
				}

				// result_type="single": finals are incremental, push directly
				if (finals.length > 0) {
					session.finalizedParts.push(...finals);
				}

				session.interimText = interim;
				session.onTranscript(session.interimText, session.finalizedParts);
			}

			// Check if this is the last frame (server signals end)
			if (frame.isLast) {
				debugLog("VolcEngine last frame received");
				finalizeVolcSession(session);
			}
		} catch (err) {
			debugLog("VolcEngine onmessage error", String(err));
			failVolcSession(session, `VolcEngine protocol error: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	ws.onmessage = (event: MessageEvent) => {
		try {
			const rawData = (event as MessageEvent).data;
			// Skip non-binary frames (text, undefined, etc.)
			if (rawData == null || typeof rawData === "string") {
				if (rawData != null) debugLog("VolcEngine text frame (skipping):", rawData.slice(0, 80));
				return;
			}
			// Browser WebSocket may deliver binary as Blob by default
			if (rawData instanceof Blob) {
				debugLog("VolcEngine Blob frame → converting to ArrayBuffer");
				rawData.arrayBuffer().then(processFrame).catch((err) => {
					debugLog("VolcEngine Blob conversion error", String(err));
					failVolcSession(session, `VolcEngine blob read error: ${err.message}`);
				});
				return;
			}
			processFrame(rawData as ArrayBuffer | ArrayBufferView);
		} catch (err) {
			// This shouldn't normally happen — processFrame has its own catch,
			// but guard against Blob check / cast failures.
			debugLog("VolcEngine onmessage outer error", String(err));
			failVolcSession(session, `VolcEngine message handling error: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	ws.onerror = (ev) => {
		clearTimeout(wsConnectTimeout);
		const errMsg = (ev as any)?.message || (ev as any)?.error?.message || "unknown";
		debugLog("VolcEngine WebSocket onerror", { readyState: ws.readyState, error: errMsg });
		if (!session.closed) {
			failVolcSession(session, `VolcEngine WebSocket error: ${errMsg}`);
		}
	};

	ws.onclose = (ev) => {
		clearTimeout(wsConnectTimeout);
		const code = (ev as any)?.code;
		const reason = (ev as any)?.reason;
		debugLog("VolcEngine WebSocket onclose", { code, reason, closed: session.closed });
		if (!session.closed) {
			if (session.stopRequested || code === 1000 || code === 1001 || session.finalizedParts.length > 0) {
				// Normal close — finalize with what we have
				if (session.interimText.trim()) {
					session.finalizedParts.push(session.interimText.trim());
					session.interimText = "";
				}
				finalizeVolcSession(session);
			} else {
				failVolcSession(session, `VolcEngine connection lost (code ${code ?? "unknown"}${reason ? `: ${reason}` : ""})`);
			}
		}
	};

	recProc.on("error", (err) => {
		debugLog("VolcEngine audio capture error:", err.message);
		if (!session.closed) {
			failVolcSession(session, `Audio capture error: ${err.message}`);
		}
	});

	recProc.on("close", (code, signal) => {
		debugLog("VolcEngine audio capture closed", { code, signal, closed: session.closed });
	});

	return session;
}

/**
 * Stop a VolcEngine session — kill audio capture and wait for final result.
 * The server auto-finalizes after end_window_size ms without incoming audio.
 */
export function stopVolcEngineSession(session: VolcEngineSession): void {
	if (session.closed) return;
	session.stopRequested = true;

	// Kill audio capture
	try { session.recProcess.kill("SIGTERM"); } catch {}

	// Do NOT send a last-audio packet. The server auto-finalizes after
	// end_window_size ms of silence (no incoming audio = end of stream).
	// Sending a negative-sequence last packet causes "last packet has been
	// received already" errors when the server has already auto-finalized.
	// The safety timeout below handles the case where finalization stalls.

	// Safety timeout — force finalize if server doesn't respond
	if (!session.finalizeTimer) {
		session.finalizeTimer = setTimeout(() => {
			session.finalizeTimer = null;
			if (session.closed) return;
			if (session.interimText.trim()) {
				session.finalizedParts.push(session.interimText.trim());
				session.interimText = "";
			}
			finalizeVolcSession(session);
		}, STREAM_FINALIZE_TIMEOUT_MS);
	}
}

/** Finalize session — collect all parts and call onDone. */
function finalizeVolcSession(session: VolcEngineSession): void {
	if (session.closed) return;
	session.closed = true;

	if (session.staleSessionTimer) {
		clearTimeout(session.staleSessionTimer);
		session.staleSessionTimer = null;
	}
	if (session.finalizeTimer) {
		clearTimeout(session.finalizeTimer);
		session.finalizeTimer = null;
	}
	try { session.ws.close(); } catch {}
	try { session.recProcess.kill("SIGKILL"); } catch {}

	const fullText = session.finalizedParts.join(" ").trim();
	session.onDone(fullText, {
		hadAudio: session.hadAudioData,
		hadSpeech: session.hadSpeech,
	});
}

/** Force-fail a session with an error. */
function failVolcSession(session: VolcEngineSession, err: string): void {
	if (session.closed) return;
	session.closed = true;
	session.stopRequested = true;

	if (session.staleSessionTimer) {
		clearTimeout(session.staleSessionTimer);
		session.staleSessionTimer = null;
	}
	if (session.finalizeTimer) {
		clearTimeout(session.finalizeTimer);
		session.finalizeTimer = null;
	}

	try { session.ws.close(); } catch {}
	try { session.recProcess.kill("SIGKILL"); } catch {}
	session.onError(err);
}

/** Abort a VolcEngine session — nuke everything synchronously. */
export function abortVolcEngineSession(session: VolcEngineSession | null): void {
	if (!session || session.closed) return;
	session.closed = true;
	if (session.staleSessionTimer) {
		clearTimeout(session.staleSessionTimer);
		session.staleSessionTimer = null;
	}
	if (session.finalizeTimer) {
		clearTimeout(session.finalizeTimer);
		session.finalizeTimer = null;
	}
	try { session.ws.close(); } catch {}
	try { session.recProcess.kill("SIGKILL"); } catch {}
}
