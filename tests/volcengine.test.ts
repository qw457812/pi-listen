import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
	resolveVolcEngineCredentials,
	isVolcEngineReady,
	buildHeader,
	buildFullClientRequest,
	buildAudioRequest,
	parseServerFrame,
	extractTranscript,
} from "../extensions/voice/volcengine";
import type { VoiceConfig } from "../extensions/voice/config";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal config for VolcEngine tests — all VolcEngine fields optional. */
function makeConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
	return {
		version: 2,
		enabled: true,
		language: "en",
		onboarding: { completed: true, schemaVersion: 2 },
		...overrides,
	} as VoiceConfig;
}

/** Build a VolcEngine server response frame (for parseServerFrame tests). */
function buildServerFrame(
	flags: number,
	serialization: number,
	compression: number,
	sequence: number | null,
	payload: unknown,
	isError = false,
	errorCode = 0,
): Buffer {
	const PROTOCOL_VERSION = 0b0001;
	const HEADER_SIZE = 0b0001;
	const MSG_TYPE_SERVER_FULL_RESPONSE = 0b1001;
	const MSG_TYPE_SERVER_ERROR_RESPONSE = 0b1111;
	const SERIALIZATION_JSON = 0b0001;
	const COMPRESSION_GZIP = 0b0001;

	const messageType = isError ? MSG_TYPE_SERVER_ERROR_RESPONSE : MSG_TYPE_SERVER_FULL_RESPONSE;

	const header = Buffer.from([
		(PROTOCOL_VERSION << 4) | HEADER_SIZE,
		(messageType << 4) | flags,
		(serialization << 4) | compression,
		0,
	]);

	const parts: Buffer[] = [header];

	// Sequence number (4 bytes, int32BE)
	if (flags & 0b0001) {
		const seqBuf = Buffer.alloc(4);
		seqBuf.writeInt32BE(sequence ?? 0, 0);
		parts.push(seqBuf);
	}

	// Error frames have an extra errorCode (4 bytes)
	if (isError) {
		const codeBuf = Buffer.alloc(4);
		codeBuf.writeUInt32BE(errorCode, 0);
		parts.push(codeBuf);
	}

	// Payload
	let payloadBytes: Buffer;
	if (serialization === SERIALIZATION_JSON && compression === COMPRESSION_GZIP) {
		payloadBytes = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
	} else if (serialization === SERIALIZATION_JSON) {
		payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
	} else {
		payloadBytes = payload as Buffer;
	}

	const sizeBuf = Buffer.alloc(4);
	sizeBuf.writeUInt32BE(payloadBytes.length, 0);
	parts.push(sizeBuf);
	parts.push(payloadBytes);

	return Buffer.concat(parts);
}

// ─── resolveVolcEngineCredentials ────────────────────────────────────────────

describe("resolveVolcEngineCredentials", () => {
	const origEnv = { ...process.env };

	test("returns null when no credentials configured", () => {
		process.env.VOLC_API_KEY = "";
		process.env.VOLC_APP_KEY = "";
		process.env.VOLC_ACCESS_KEY = "";
		const config = makeConfig();
		expect(resolveVolcEngineCredentials(config)).toBeNull();
	});

	test("resolves new console API key from environment", () => {
		process.env.VOLC_API_KEY = "test-api-key";
		process.env.VOLC_APP_KEY = "";
		process.env.VOLC_ACCESS_KEY = "";
		const config = makeConfig();
		const creds = resolveVolcEngineCredentials(config);
		expect(creds).not.toBeNull();
		expect(creds!.apiKey).toBe("test-api-key");
		expect(creds!.resourceId).toBe("volc.seedasr.sauc.duration");
	});

	test("resolves new console API key from config field", () => {
		process.env.VOLC_API_KEY = "";
		process.env.VOLC_APP_KEY = "";
		process.env.VOLC_ACCESS_KEY = "";
		const config = makeConfig({ volcApiKey: "config-api-key" });
		const creds = resolveVolcEngineCredentials(config);
		expect(creds).not.toBeNull();
		expect(creds!.apiKey).toBe("config-api-key");
	});

	test("environment variable takes priority over config field", () => {
		process.env.VOLC_API_KEY = "env-key";
		const config = makeConfig({ volcApiKey: "config-key" });
		const creds = resolveVolcEngineCredentials(config);
		expect(creds!.apiKey).toBe("env-key");
	});

	test("resolves old console credentials (appKey + accessKey) from environment", () => {
		process.env.VOLC_API_KEY = "";
		process.env.VOLC_APP_KEY = "test-app-key";
		process.env.VOLC_ACCESS_KEY = "test-access-key";
		const config = makeConfig();
		const creds = resolveVolcEngineCredentials(config);
		expect(creds).not.toBeNull();
		expect(creds!.apiKey).toBeUndefined();
		expect(creds!.appKey).toBe("test-app-key");
		expect(creds!.accessKey).toBe("test-access-key");
	});

	test("old console requires both appKey AND accessKey", () => {
		process.env.VOLC_API_KEY = "";
		process.env.VOLC_APP_KEY = "test-app-key";
		process.env.VOLC_ACCESS_KEY = "";
		const config = makeConfig();
		expect(resolveVolcEngineCredentials(config)).toBeNull();
	});

	test("new console API key takes priority over old console credentials", () => {
		process.env.VOLC_API_KEY = "new-key";
		process.env.VOLC_APP_KEY = "old-app";
		process.env.VOLC_ACCESS_KEY = "old-access";
		const config = makeConfig();
		const creds = resolveVolcEngineCredentials(config);
		expect(creds!.apiKey).toBe("new-key");
		expect(creds!.appKey).toBeUndefined();
	});

	test("resource ID for model version 1.0", () => {
		process.env.VOLC_API_KEY = "key";
		process.env.VOLC_APP_KEY = "";
		process.env.VOLC_ACCESS_KEY = "";
		const config = makeConfig({ volcModelVersion: "1.0" });
		const creds = resolveVolcEngineCredentials(config);
		expect(creds!.resourceId).toBe("volc.bigasr.sauc.duration");
	});

	test("resource ID defaults to 2.0 when volcModelVersion is undefined", () => {
		process.env.VOLC_API_KEY = "key";
		process.env.VOLC_APP_KEY = "";
		process.env.VOLC_ACCESS_KEY = "";
		const config = makeConfig();
		const creds = resolveVolcEngineCredentials(config);
		expect(creds!.resourceId).toBe("volc.seedasr.sauc.duration");
	});

	// Restore env after each test group
	test("cleanup", () => {
		Object.assign(process.env, origEnv);
	});
});

// ─── isVolcEngineReady ───────────────────────────────────────────────────────

describe("isVolcEngineReady", () => {
	const origEnv = { ...process.env };

	test("returns false when no credentials", () => {
		process.env.VOLC_API_KEY = "";
		process.env.VOLC_APP_KEY = "";
		process.env.VOLC_ACCESS_KEY = "";
		expect(isVolcEngineReady(makeConfig())).toBe(false);
	});

	test("returns true when new console API key is set", () => {
		process.env.VOLC_API_KEY = "key";
		process.env.VOLC_APP_KEY = "";
		process.env.VOLC_ACCESS_KEY = "";
		expect(isVolcEngineReady(makeConfig())).toBe(true);
	});

	test("returns true when old console credentials are set", () => {
		process.env.VOLC_API_KEY = "";
		process.env.VOLC_APP_KEY = "app";
		process.env.VOLC_ACCESS_KEY = "access";
		expect(isVolcEngineReady(makeConfig())).toBe(true);
	});

	test("cleanup", () => {
		Object.assign(process.env, origEnv);
	});
});

// ─── buildHeader ────────────────────────────────────────────────────────────

describe("buildHeader", () => {
	test("encodes protocol version and header size in byte 0", () => {
		const header = buildHeader(0b0001, 0b0001, 0b0001, 0b0001);
		expect(header[0]).toBe((0b0001 << 4) | 0b0001); // 0x11
	});

	test("encodes message type and flags in byte 1", () => {
		const header = buildHeader(0b0010, 0b0011, 0b0000, 0b0000);
		expect(header[1]).toBe((0b0010 << 4) | 0b0011); // 0x23
	});

	test("encodes serialization and compression in byte 2", () => {
		const header = buildHeader(0b0001, 0b0000, 0b0001, 0b0001);
		expect(header[2]).toBe((0b0001 << 4) | 0b0001); // 0x11
	});

	test("byte 3 is reserved zero", () => {
		const header = buildHeader(0b1111, 0b1111, 0b1111, 0b1111);
		expect(header[3]).toBe(0);
	});

	test("returns a 4-byte Uint8Array", () => {
		const header = buildHeader(0, 0, 0, 0);
		expect(header.length).toBe(4);
		expect(header instanceof Uint8Array).toBe(true);
	});
});

// ─── buildFullClientRequest ─────────────────────────────────────────────────

describe("buildFullClientRequest", () => {
	test("produces a frame starting with the correct header", () => {
		const frame = buildFullClientRequest(1, { test: true });
		// Protocol version (0b0001) | header size (0b0001) = 0x11
		expect(frame[0]).toBe(0x11);
		// Message type (0b0001 = client full request) | flags (0b0001 = positive sequence)
		expect(frame[1]).toBe((0b0001 << 4) | 0b0001); // 0x11
		// Serialization (0b0001 = JSON) | compression (0b0001 = gzip)
		expect(frame[2]).toBe((0b0001 << 4) | 0b0001); // 0x11
	});

	test("encodes the sequence number after the 4-byte header", () => {
		const frame = buildFullClientRequest(42, { test: true });
		// Sequence starts at byte 4, big-endian int32
		const seqView = new DataView(frame.buffer, frame.byteOffset + 4, 4);
		expect(seqView.getInt32(0, false)).toBe(42);
	});

	test("payload size follows the sequence number", () => {
		const frame = buildFullClientRequest(1, { test: true });
		// Payload size at bytes 8-11, big-endian uint32
		const sizeView = new DataView(frame.buffer, frame.byteOffset + 8, 4);
		const payloadSize = sizeView.getUint32(0, false);
		expect(payloadSize).toBeGreaterThan(0);
		// Total frame = 4 (header) + 4 (seq) + 4 (size) + payload
		expect(frame.length).toBe(12 + payloadSize);
	});

	test("payload decodes to the original object", () => {
		const frame = buildFullClientRequest(1, { model: "bigmodel", rate: 16000 });
		const payloadStart = 12;
		const sizeView = new DataView(frame.buffer, frame.byteOffset + 8, 4);
		const payloadSize = sizeView.getUint32(0, false);
		const payloadBuf = Buffer.from(frame.buffer, frame.byteOffset + payloadStart, payloadSize);
		// Payload is gzipped — decompress before parsing JSON
		const decompressed = require("node:zlib").gunzipSync(payloadBuf);
		const decoded = JSON.parse(decompressed.toString("utf8"));
		expect(decoded.model).toBe("bigmodel");
		expect(decoded.rate).toBe(16000);
	});
});

// ─── buildAudioRequest ──────────────────────────────────────────────────────

describe("buildAudioRequest", () => {
	test("non-last frame uses positive sequence and POS_SEQUENCE flag", () => {
		const audio = Buffer.alloc(100);
		const frame = buildAudioRequest(5, audio, false);
		// Message type (0b0010 = audio only) | flags (0b0001 = POS_SEQUENCE)
		expect(frame[1]).toBe((0b0010 << 4) | 0b0001); // 0x21
		// Sequence is positive
		const seqView = new DataView(frame.buffer, frame.byteOffset + 4, 4);
		expect(seqView.getInt32(0, false)).toBe(5);
	});

	test("last frame uses negative sequence and NEG_SEQUENCE flag", () => {
		const audio = Buffer.alloc(0);
		const frame = buildAudioRequest(7, audio, true);
		// Flags = 0b0011 = NEG_SEQUENCE
		expect(frame[1]).toBe((0b0010 << 4) | 0b0011); // 0x23
		// Sequence is negative
		const seqView = new DataView(frame.buffer, frame.byteOffset + 4, 4);
		expect(seqView.getInt32(0, false)).toBe(-7);
	});

	test("serialization is NONE and compression is GZIP for audio frames", () => {
		const audio = Buffer.alloc(100);
		const frame = buildAudioRequest(1, audio, false);
		// Serialization (0b0000 = NONE) | compression (0b0001 = GZIP)
		expect(frame[2]).toBe((0b0000 << 4) | 0b0001); // 0x01
	});
});

// ─── parseServerFrame ────────────────────────────────────────────────────────

describe("parseServerFrame", () => {
	test("parses a full server response with positive sequence", () => {
		const payload = { result: { text: "你好世界" } };
		const frame = buildServerFrame(0b0001, 0b0001, 0b0001, 42, payload);
		const result = parseServerFrame(frame);

		expect(result.messageType).toBe(0b1001);
		expect(result.sequence).toBe(42);
		expect(result.isLast).toBe(false);
		expect(result.payload).toEqual(payload);
	});

	test("parses a full server response with isLast flag", () => {
		const payload = { result: { text: "final text" } };
		// FLAG_NEG_SEQUENCE = 0b0011, which has the 0b0010 bit set (isLast detection)
		const frame = buildServerFrame(0b0011, 0b0001, 0b0001, -1, payload);
		const result = parseServerFrame(frame);

		expect(result.isLast).toBe(true);
	});

	test("parses a frame with no sequence (FLAG_NO_SEQUENCE)", () => {
		const payload = { result: { text: "test" } };
		const frame = buildServerFrame(0b0000, 0b0001, 0b0001, null, payload);
		const result = parseServerFrame(frame);

		expect(result.sequence).toBeNull();
	});

	test("throws on truncated payload", () => {
		const payload = { result: { text: "test" } };
		const fullFrame = buildServerFrame(0b0001, 0b0001, 0b0001, 1, payload);
		// Truncate by removing last 10 bytes
		const truncated = fullFrame.subarray(0, fullFrame.length - 10);
		expect(() => parseServerFrame(truncated)).toThrow(/payload truncated/);
	});

	test("throws on frame too short (< 4 bytes)", () => {
		expect(() => parseServerFrame(Buffer.from([0x11, 0x11]))).toThrow(/header too short/);
	});

	test("throws on error frames with error code and detail", () => {
		const errorPayload = { message: "auth failed" };
		const frame = buildServerFrame(0b0001, 0b0001, 0b0001, 1, errorPayload, true, 4001);
		expect(() => parseServerFrame(frame)).toThrow(/VolcEngine ASR error 4001/);
		expect(() => parseServerFrame(frame)).toThrow(/auth failed/);
	});

	test("throws on truncated error payload", () => {
		const errorPayload = { message: "something went wrong" };
		const fullFrame = buildServerFrame(0b0001, 0b0001, 0b0001, 1, errorPayload, true, 5000);
		const truncated = fullFrame.subarray(0, fullFrame.length - 10);
		expect(() => parseServerFrame(truncated)).toThrow(/error payload truncated/);
	});

	test("returns null payload for unknown message types", () => {
		// Build a frame with an unknown message type (0b0100)
		const header = Buffer.from([0x11, (0b0100 << 4) | 0b0000, 0x00, 0x00]);
		const result = parseServerFrame(header);
		expect(result.payload).toBeNull();
	});
});

// ─── extractTranscript ──────────────────────────────────────────────────────

describe("extractTranscript", () => {
	test("extracts definite utterances as finals and indefinite as interim", () => {
		const payload = {
			result: {
				utterances: [
					{ text: "你好", definite: true },
					{ text: "世界", definite: true },
					{ text: "今天", definite: false },
				],
			},
		};
		const { interim, finals } = extractTranscript(payload);
		expect(finals).toEqual(["你好", "世界"]);
		expect(interim).toBe("今天");
	});

	test("skips utterances with empty text", () => {
		const payload = {
			result: {
				utterances: [
					{ text: "", definite: true },
					{ text: "有效文本", definite: true },
					{ text: "  ", definite: false },
				],
			},
		};
		const { interim, finals } = extractTranscript(payload);
		expect(finals).toEqual(["有效文本"]);
		expect(interim).toBe("");
	});

	test("falls back to top-level result.text when no utterances", () => {
		const payload = {
			result: {
				text: "完整识别结果",
			},
		};
		const { interim, finals } = extractTranscript(payload);
		expect(finals).toEqual(["完整识别结果"]);
		expect(interim).toBe("");
	});

	test("falls back to top-level result.text when utterances array is empty", () => {
		const payload = {
			result: {
				text: "回退文本",
				utterances: [],
			},
		};
		const { interim, finals } = extractTranscript(payload);
		expect(finals).toEqual(["回退文本"]);
	});

	test("returns empty when payload has no result", () => {
		const payload = { other: "field" };
		const { interim, finals } = extractTranscript(payload);
		expect(finals).toEqual([]);
		expect(interim).toBe("");
	});

	test("returns empty when payload is null", () => {
		const { interim, finals } = extractTranscript(null);
		expect(finals).toEqual([]);
		expect(interim).toBe("");
	});

	test("returns empty when payload is not an object", () => {
		const { interim, finals } = extractTranscript("string");
		expect(finals).toEqual([]);
		expect(interim).toBe("");
	});

	test("returns empty when result.text and utterances are both absent", () => {
		const payload = { result: {} };
		const { interim, finals } = extractTranscript(payload);
		expect(finals).toEqual([]);
		expect(interim).toBe("");
	});

	test("handles non-string text fields gracefully", () => {
		const payload = {
			result: {
				utterances: [
					{ text: 123, definite: true },
					{ text: "valid", definite: true },
				],
			},
		};
		const { finals } = extractTranscript(payload);
		expect(finals).toEqual(["valid"]);
	});

	test("handles mixed Chinese and English utterances", () => {
		const payload = {
			result: {
				utterances: [
					{ text: "使用 React", definite: true },
					{ text: "和 TypeScript", definite: true },
					{ text: "开发", definite: false },
				],
			},
		};
		const { interim, finals } = extractTranscript(payload);
		expect(finals).toEqual(["使用 React", "和 TypeScript"]);
		expect(interim).toBe("开发");
	});
});

// ─── Round-trip: build + parse (symmetric test for client frames) ───────────

describe("buildAudioRequest frame structure", () => {
	test("frame header fields match VolcEngine protocol spec", () => {
		const audio = Buffer.alloc(6400); // 200ms of 16kHz 16bit mono
		const frame = buildAudioRequest(1, audio, false);

		// Byte 0: protocol=1, headerSize=1 → 0x11
		expect(frame[0]).toBe(0x11);
		// Byte 1: msgType=2 (audio), flags=1 (POS_SEQUENCE) → 0x21
		expect(frame[1]).toBe(0x21);
		// Byte 2: serialization=0 (NONE), compression=1 (GZIP) → 0x01
		expect(frame[2]).toBe(0x01);
		// Byte 3: reserved → 0x00
		expect(frame[3]).toBe(0x00);
	});
});
