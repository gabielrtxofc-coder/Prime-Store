/**
 * Leitura e validação do CSV de importação de estoque.
 * Formato aceito: `email,senha[,observacao]`, com ou sem cabeçalho.
 * Delimitador `,` ou `;` (compatível com exportações do Excel em pt-BR).
 */

export interface CsvRecord {
  /** Número da linha no arquivo original (1-based). */
  rowNumber: number;
  values: string[];
}

export interface ParsedCsv {
  delimiter: string;
  hasHeader: boolean;
  records: CsvRecord[];
}

export interface ParsedStockRow {
  rowNumber: number;
  email: string;
  password: string;
  notes: string;
}

export interface RejectedRow {
  rowNumber: number;
  reason: string;
}

export interface ValidatedStock {
  valid: ParsedStockRow[];
  rejected: RejectedRow[];
  duplicatedInFile: number;
}

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 200;
const MAX_NOTES_LENGTH = 500;

function detectDelimiter(line: string): string {
  const semicolons = (line.match(/;/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

/** Parser de CSV com suporte a campos entre aspas e quebras escapadas. */
export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);

  const records: CsvRecord[] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let started = false;

  const beginRecord = () => {
    if (!started) {
      started = true;
      recordStartLine = line;
    }
  };

  const pushField = () => {
    current.push(field.trim());
    field = '';
  };

  const pushRecord = () => {
    // Linhas totalmente vazias são ignoradas (quebras de linha extras).
    const filled = current.filter((value) => value !== '');
    if (filled.length > 0) {
      records.push({ rowNumber: recordStartLine, values: current });
    }
    current = [];
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      beginRecord();
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      beginRecord();
      pushField();
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      pushField();
      pushRecord();
      line += 1;
      continue;
    }
    beginRecord();
    field += char;
  }

  if (started || field !== '' || current.length > 0) {
    pushField();
    pushRecord();
  }

  // Cabeçalho só quando a primeira célula é um rótulo conhecido de e-mail/login
  // ou a segunda é claramente "senha/password" — evita confundir dados reais
  // (ex.: "senha1") com cabeçalho.
  const firstCell = (records[0]?.values[0] ?? '').toLowerCase();
  const secondCell = (records[0]?.values[1] ?? '').toLowerCase();
  const hasHeader =
    records.length > 0 &&
    (/^(e-?mail|login|conta|usu[aá]rio|email da conta|e-mail da conta)$/.test(firstCell) ||
      /^(senha|password|pass)$/.test(secondCell));

  return {
    delimiter,
    hasHeader,
    records: hasHeader ? records.slice(1) : records,
  };
}

/** Extrai as linhas de estoque (já sem cabeçalho) preservando o número da linha. */
export function extractStockRows(csv: ParsedCsv): Array<{ rowNumber: number; email: string; password: string; notes: string }> {
  return csv.records.map((record) => ({
    rowNumber: record.rowNumber,
    email: record.values[0] ?? '',
    password: record.values[1] ?? '',
    notes: record.values[2] ?? '',
  }));
}

/**
 * Valida linhas individualmente, detecta duplicados no próprio arquivo e
 * (opcionalmente) contra fingerprints já existentes no banco.
 */
export function validateStockRows(
  rows: Array<{ rowNumber: number; email: string; password: string; notes: string }>,
  existingFingerprints: Set<string> = new Set(),
  fingerprintOf: (email: string, password: string) => string = defaultFingerprint,
): ValidatedStock {
  const seen = new Set<string>();
  const valid: ParsedStockRow[] = [];
  const rejected: RejectedRow[] = [];
  let duplicatedInFile = 0;

  for (const row of rows) {
    const email = row.email.trim();
    const password = row.password;
    const notes = row.notes.trim().slice(0, MAX_NOTES_LENGTH);

    if (!email && !password) {
      rejected.push({ rowNumber: row.rowNumber, reason: 'linha_vazia' });
      continue;
    }
    if (!email) {
      rejected.push({ rowNumber: row.rowNumber, reason: 'email_ausente' });
      continue;
    }
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      rejected.push({ rowNumber: row.rowNumber, reason: 'email_invalido' });
      continue;
    }
    if (!password) {
      rejected.push({ rowNumber: row.rowNumber, reason: 'senha_ausente' });
      continue;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      rejected.push({ rowNumber: row.rowNumber, reason: 'senha_muito_longa' });
      continue;
    }

    const fingerprint = fingerprintOf(email, password);
    if (seen.has(fingerprint)) {
      duplicatedInFile += 1;
      rejected.push({ rowNumber: row.rowNumber, reason: 'duplicado_no_arquivo' });
      continue;
    }
    if (existingFingerprints.has(fingerprint)) {
      rejected.push({ rowNumber: row.rowNumber, reason: 'duplicado_no_estoque' });
      continue;
    }

    seen.add(fingerprint);
    valid.push({ rowNumber: row.rowNumber, email, password, notes });
  }

  return { valid, rejected, duplicatedInFile };
}

/** Fingerprint determinístico usado apenas para detecção local no arquivo. */
function defaultFingerprint(email: string, password: string): string {
  return `${email.toLowerCase()}\u0000${password}`;
}

/** Mascaramento usado em prévias e relatórios (nunca expõe a credencial). */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const visible = user.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, Math.min(user.length - visible.length, 6)))}@${domain}`;
}

export function maskSecret(secret: string): string {
  return `${'•'.repeat(Math.min(secret.length, 8))} (${secret.length} caracteres)`;
}
