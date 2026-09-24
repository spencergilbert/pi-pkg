/**
 * Model-facing output guard for MCP tool results.
 *
 * Text output is capped at Pi's standard 50 KiB / 2000-line limits. When the
 * cap is hit, the complete text is spilled to a 0600 temp file and the path is
 * reported so the model can `read`/`grep` it. Image blocks pass through
 * untouched — they are delivered as native image content, not text context.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type { ContentBlock } from "@modelcontextprotocol/client";

export type GuardedBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface OutputGuardOptions {
  enabled?: boolean;
  maxBytes?: number;
  maxLines?: number;
}

export interface OutputGuardDetails {
  truncated: true;
  truncatedBy: TruncationResult["truncatedBy"];
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
  maxBytes: number;
  maxLines: number;
  fullOutputPath?: string;
  writeError?: string;
  imagesPassedThrough?: number;
}

export interface GuardedResult {
  content: GuardedBlock[];
  outputGuard?: OutputGuardDetails;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringifyUnknown(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Convert one MCP content block into text (or an image pass-through). */
function convertBlock(block: ContentBlock): { text?: string; image?: GuardedBlock } {
  const record = asRecord(block);
  if (!record) return { text: stringifyUnknown(block) };
  switch (record.type) {
    case "text":
      return { text: typeof record.text === "string" ? record.text : "" };
    case "image": {
      if (typeof record.data === "string") {
        const mimeType = typeof record.mimeType === "string" && record.mimeType.trim() ? record.mimeType.trim() : "image/png";
        return { image: { type: "image", data: record.data, mimeType } };
      }
      return { text: "[image content omitted: missing data]" };
    }
    case "audio":
      return { text: `[audio content omitted: ${typeof record.mimeType === "string" ? record.mimeType : "unknown type"}]` };
    case "resource": {
      const resource = asRecord(record.resource);
      if (resource && typeof resource.text === "string") return { text: resource.text };
      return { text: stringifyUnknown(record.resource ?? record) };
    }
    default:
      return { text: stringifyUnknown(block) };
  }
}

export function convertMcpContent(content: ContentBlock[] | undefined): { blocks: GuardedBlock[]; text: string } {
  const blocks: GuardedBlock[] = [];
  const texts: string[] = [];
  for (const block of content ?? []) {
    const converted = convertBlock(block);
    if (converted.image) blocks.push(converted.image);
    if (converted.text !== undefined) texts.push(converted.text);
  }
  return { blocks, text: texts.join("\n") };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

async function spill(text: string): Promise<{ path?: string; error?: string }> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
    const path = join(dir, `output-${randomBytes(4).toString("hex")}.txt`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function truncationNotice(truncation: TruncationResult, fullOutputPath: string | undefined, writeError: string | undefined): string {
  let reason: string;
  if (truncation.firstLineExceedsLimit) {
    reason = `first line exceeds the ${formatSize(truncation.maxBytes)} limit`;
  } else if (truncation.truncatedBy === "lines") {
    reason = `showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines}-line limit)`;
  } else {
    reason = `showing ${truncation.outputLines} lines (${formatSize(truncation.maxBytes)} limit)`;
  }
  const base = `[MCP output truncated: ${reason}; original ${truncation.totalLines.toLocaleString()} lines / ${formatSize(truncation.totalBytes)}.`;
  if (fullOutputPath) return `${base} Full text: ${fullOutputPath} — use read with offset/limit or grep.]`;
  return `${base} Full text could not be saved: ${writeError ?? "unknown error"}]`;
}

/**
 * Bound an MCP tool result for the model. `rawText` is optional text that
 * accompanies `content` (for example a status header); it participates in
 * truncation and spill.
 */
export async function guardMcpResult(
  content: ContentBlock[] | undefined,
  options: OutputGuardOptions & { rawText?: string } = {},
): Promise<GuardedResult> {
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const converted = convertMcpContent(content);
  const composed = options.rawText ? `${options.rawText}\n${converted.text}` : converted.text;

  if (options.enabled === false) {
    const blocks: GuardedBlock[] = composed ? [{ type: "text", text: composed }, ...converted.blocks] : converted.blocks;
    return { content: blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }] };
  }

  const truncation = truncateHead(composed, { maxBytes, maxLines });
  if (!truncation.truncated) {
    const blocks: GuardedBlock[] = composed ? [{ type: "text", text: composed }, ...converted.blocks] : converted.blocks;
    return { content: blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }] };
  }

  const spilled = await spill(composed);
  const initialNotice = truncationNotice(truncation, spilled.path, spilled.error);
  const noticeBytes = byteLength(`\n\n${initialNotice}`);
  const noticeLines = lineCount(`\n\n${initialNotice}`);
  const preview = truncateHead(composed, {
    maxBytes: Math.max(0, maxBytes - noticeBytes),
    maxLines: Math.max(0, maxLines - noticeLines),
  });
  const notice = truncationNotice(
    { ...truncation, outputLines: preview.outputLines, outputBytes: preview.outputBytes },
    spilled.path,
    spilled.error,
  );
  const text = `${preview.content}\n\n${notice}`;
  const details: OutputGuardDetails = {
    truncated: true,
    truncatedBy: truncation.truncatedBy,
    totalBytes: truncation.totalBytes,
    totalLines: truncation.totalLines,
    outputBytes: preview.outputBytes,
    outputLines: preview.outputLines,
    maxBytes,
    maxLines,
    ...(spilled.path !== undefined ? { fullOutputPath: spilled.path } : {}),
    ...(spilled.error !== undefined ? { writeError: spilled.error } : {}),
    ...(converted.blocks.length > 0 ? { imagesPassedThrough: converted.blocks.length } : {}),
  };
  return { content: [{ type: "text", text }, ...converted.blocks], outputGuard: details };
}
