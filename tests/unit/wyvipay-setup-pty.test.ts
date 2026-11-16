/**
 * Testes de PTY real (A4): alocamos um terminal com `script` (util-linux) e
 * rodamos um harness que chama `readHidden()` do script de configuração.
 *
 * Garantias verificadas em TTY de verdade:
 *  1. a chave digitada NUNCA aparece no eco do terminal (modo raw/sem eco);
 *  2. o terminal é RESTAURADO após o Enter (isRaw volta a false);
 *  3. Ctrl+C cancela com exit 130 e restaura o terminal;
 *  4. sem eco do prompt parcial (nem o valor inicial é reexibido).
 *
 * Se `script` não existir (ambiente sem util-linux), a suíte é pulada — os
 * testes unitários com FakeTty continuam cobrindo a lógica.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT_BIN = '/usr/bin/script';
const SETUP = path.resolve(__dirname, '../../scripts/wyvipay-setup.mjs');
const ptyDisponivel = existsSync(SCRIPT_BIN);

const KEY = `wy_test_${'a'.repeat(42)}`;

interface PtyResult {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Roda `harness` dentro de um PTY alocado por `script`, enviando `input` após ver `prompt`. */
function runInPty(harness: string, { input, waitFor }: { input: string; waitFor: string }): Promise<PtyResult> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wyvi-pty-'));
    const file = path.join(dir, 'harness.mjs');
    writeFileSync(file, harness);

    const child = spawn(SCRIPT_BIN, ['-qefc', `node ${JSON.stringify(file)}`, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let sent = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new timeoutError(output));
    }, 10_000);

    const maybeSend = () => {
      if (!sent && output.includes(waitFor)) {
        sent = true;
        child.stdin.write(input);
      }
    };

    child.stdout.on('data', (d) => {
      output += String(d);
      maybeSend();
    });
    child.stderr.on('data', (d) => {
      output += String(d);
      maybeSend();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ output, code, signal });
    });
  });
}

function timeoutError(output: string): Error {
  return new Error(`PTY não terminou; saída parcial: ${output.slice(0, 400)}`);
}

describe.skipIf(!ptyDisponivel)('setup — readHidden em PTY real (sem eco, com restauração)', () => {
  it('lê a chave SEM ecoar no terminal e restaura o modo raw no Enter', async () => {
    const harness = `
      import { readHidden } from ${JSON.stringify(SETUP)};
      const key = await readHidden('chave: ');
      console.log('RAW_APOS=' + process.stdin.isRaw);
      console.log('LEN=' + key.length);
      console.log('IGUAL=' + (key === ${JSON.stringify(KEY)}));
      process.exit(0);
    `;
    const { output, code } = await runInPty(harness, { input: `${KEY}\n`, waitFor: 'chave: ' });

    // 1) a chave digitada NUNCA aparece em nenhuma parte do eco do TTY
    expect(output).not.toContain(KEY);
    // 2) leu corretamente dentro do TTY
    expect(output).toContain('LEN=50');
    expect(output).toContain('IGUAL=true');
    // 3) terminal restaurado após o Enter
    expect(output).toContain('RAW_APOS=false');
    expect(code).toBe(0);
  });

  it('Ctrl+C cancela com exit 130 e RESTAURA o terminal', async () => {
    const harness = `
      import { readHidden } from ${JSON.stringify(SETUP)};
      try {
        await readHidden('chave: ');
        console.log('NAO_DEVERIA_CHEGAR');
        process.exit(99);
      } catch (e) {
        console.log('CANCELLED=' + !!e.cancelled);
        console.log('EXITCODE=' + e.exitCode);
        console.log('RAW_APOS=' + process.stdin.isRaw);
        process.exit(e.exitCode ?? 1);
      }
    `;
    // digita parte da chave e depois Ctrl+C (0x03) — raw mode desliga ISIG,
    // então o 0x03 chega como dado e readHidden trata como cancelamento
    const { output, code } = await runInPty(harness, { input: `wy_test_parcial\u0003`, waitFor: 'chave: ' });

    expect(output).not.toContain('wy_test_parcial');
    expect(output).toContain('CANCELLED=true');
    expect(output).toContain('EXITCODE=130');
    expect(output).toContain('RAW_APOS=false');
    expect(code).toBe(130);
  });

  it('backspace funciona no TTY real e nada do que foi digitado é ecoado', async () => {
    const harness = `
      import { readHidden } from ${JSON.stringify(SETUP)};
      const key = await readHidden('chave: ');
      console.log('VALOR=' + key);
      process.exit(0);
    `;
    // digita "wy_test_ABC" com backspace apagando os 3 últimos → "wy_test_AB"… na
    // verdade: digita KEY completo e apaga os 4 últimos caracteres com backspace
    const parcial = `${KEY}\u007f\u007f\u007f\u007f`;
    const { output, code } = await runInPty(harness, { input: `${parcial}\n`, waitFor: 'chave: ' });

    // eco = tudo antes do resultado final impresso pelo harness
    const eco = output.slice(0, output.indexOf('VALOR='));
    expect(eco).not.toContain(KEY); // nem a forma completa…
    expect(eco).not.toContain(KEY.slice(0, -4)); // …nem a parcial digitada
    expect(output).toContain(`VALOR=${KEY.slice(0, -4)}`); // backspace apagou de verdade
    expect(code).toBe(0);
  });
});
