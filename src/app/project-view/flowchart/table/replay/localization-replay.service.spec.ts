import { describe, expect, it } from 'vitest';
import { parseJsonlStream } from './localization-replay.service';

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split into a few chunks to exercise the buffer logic.
      const chunkSize = Math.max(1, Math.ceil(bytes.length / 3));
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

const HEADER_LINE = JSON.stringify({
  kind: 'header',
  format_version: 1,
  started_at_unix_ns: 1,
  tick_hz: 100,
  record_hz: 20,
  particle_count: 4,
  units: { position: 'm', heading: 'rad', sensor_offset: 'cm' },
  robot: { width_cm: 22, length_cm: 18 },
});

function frameLine(t_ns: number, x: number): string {
  return JSON.stringify({
    kind: 'frame',
    t_ns,
    pose: [x, 0, 0],
    particles: [[x, 0, 0, 0.25]],
    observations: [],
    resampled: false,
  });
}

describe('parseJsonlStream', () => {
  it('parses the header and all frame lines', async () => {
    const content = [HEADER_LINE, frameLine(1, 0.1), frameLine(2, 0.2), frameLine(3, 0.3), ''].join('\n');
    const { header, frames } = await parseJsonlStream(streamOf(content));
    expect(header).not.toBeNull();
    expect(header?.particle_count).toBe(4);
    expect(frames).toHaveLength(3);
    expect(frames[0].pose[0]).toBeCloseTo(0.1);
    expect(frames[2].t_ns).toBe(3);
  });

  it('silently drops a malformed (truncated) last line', async () => {
    const truncated = HEADER_LINE + '\n' + frameLine(1, 0.1) + '\n{"kind":"frame","t_ns":2,';
    const { header, frames } = await parseJsonlStream(streamOf(truncated));
    expect(header).not.toBeNull();
    expect(frames).toHaveLength(1);
  });

  it('ignores leading or interior blank lines', async () => {
    const content = ['', HEADER_LINE, '', frameLine(1, 0.5), ''].join('\n');
    const { header, frames } = await parseJsonlStream(streamOf(content));
    expect(header).not.toBeNull();
    expect(frames).toHaveLength(1);
  });

  it('keeps only the first header even if a duplicate appears later', async () => {
    const content = [HEADER_LINE, frameLine(1, 0.1), HEADER_LINE].join('\n');
    const { header, frames } = await parseJsonlStream(streamOf(content));
    expect(header?.tick_hz).toBe(100);
    // The second "header" line should be dropped, not appended as a frame.
    expect(frames).toHaveLength(1);
  });
});
