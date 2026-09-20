import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'agentling-servo-test-'));
try {
  const executable = join(directory, 'servo-safety');
  for (const [command, args] of [
    [process.env.CXX || 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-I', 'firmware/include',
      'firmware/test/servo-safety.cpp', '-o', executable]],
    [executable, []],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
  }
  console.log('Servo feedback and fault-injection tests passed (no hardware accessed).');
} finally {
  await rm(directory, { recursive: true, force: true });
}
