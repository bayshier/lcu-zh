// The contract fixture, preceded by the stderr lines LCU's macOS host and service write.
// writeSync blocks on a full pipe, so a reader that stops draining stalls this process.
import { writeSync } from 'node:fs';

const marker = process.env.LCU_STDERR_MARKER ?? 'marker';
const lines = [
  'LCU macOS turn-ended command: exit=0 elapsed=5382 ms',
  `LCU macOS turn-ended command: exit=1 elapsed=812 ms stderr='${marker}'`,
  'LCU macOS turn-ended command: exit=timeout elapsed=10004 ms',
  `LCU macOS turn cleanup failed: ${marker} timed out after 3 seconds`,
  `LCU macOS user control unavailable: ${marker}`,
  `LCU macOS sent SIGTERM to stale Computer Use service pid 4242 (/Applications/${marker}); it exited after 37 ms`,
  `LCU macOS turn cleanup step "CLI turn-ended" took 5120 ms`,
  `something else entirely: ${marker}`,
];
writeSync(2, `${lines.join('\n')}\n`);
const flood = Number(process.env.LCU_STDERR_FLOOD_BYTES ?? 0);
if (flood > 0) {
  const line = `${marker} ${'x'.repeat(200)}\n`;
  const chunk = line.repeat(Math.ceil(65536 / line.length));
  for (let written = 0; written < flood; written += chunk.length) writeSync(2, chunk);
  // One endless line, longer than the reader keeps.
  writeSync(2, `${marker}${'y'.repeat(100_000)}\n`);
}
await import('./mcp-fixture.mjs');
