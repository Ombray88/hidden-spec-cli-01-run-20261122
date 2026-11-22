import * as fs from 'node:fs';
import * as path from 'node:path';

type FormatType = 'auto' | 'unified' | 'search-replace' | 'v4a' | 'json';

function isSafePath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (p.startsWith('/') || p.includes('\\')) return false;
  const segments = p.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return false;
  }
  return true;
}

function parseFileContent(content: string): { lines: string[]; hasEol: boolean; isCrlf: boolean } {
  if (content === '') {
    return { lines: [], hasEol: false, isCrlf: false };
  }
  const firstLf = content.indexOf('\n');
  const actualCrlf = firstLf !== -1 && firstLf > 0 && content[firstLf - 1] === '\r';

  const breakStr = actualCrlf ? '\r\n' : '\n';
  const hasEol = content.endsWith(breakStr) || (actualCrlf ? content.endsWith('\r\n') : content.endsWith('\n'));
  
  const rawLines = content.split(breakStr);
  let lines = rawLines;
  if (hasEol && lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  return { lines, hasEol, isCrlf: actualCrlf };
}

function writeFileContent(lines: string[], hasEol: boolean, isCrlf: boolean): string {
  const breakStr = isCrlf ? '\r\n' : '\n';
  let res = lines.join(breakStr);
  if (hasEol || (lines.length > 0 && res !== '')) {
    if (lines.length === 0 && !hasEol) return '';
    if (hasEol) res += breakStr;
  } else if (lines.length === 0) {
    return '';
  }
  return res;
}

function getPatchLines(text: string): { lines: string[]; rawText: string } {
  const rawText = text;
  const split = text.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < split.length; i++) {
    if (i === split.length - 1 && split[i] === '' && text.endsWith('\n')) {
      continue;
    }
    let l = split[i];
    if (l.endsWith('\r')) {
      l = l.slice(0, -1);
    }
    lines.push(l);
  }
  return { lines, rawText };
}

function matchTier0(fileLines: string[], targetLines: string[], start: number): boolean {
  if (start + targetLines.length > fileLines.length) return false;
  for (let i = 0; i < targetLines.length; i++) {
    if (fileLines[start + i] !== targetLines[i]) return false;
  }
  return true;
}

function matchTier1(fileLines: string[], targetLines: string[], start: number): boolean {
  if (start + targetLines.length > fileLines.length) return false;
  for (let i = 0; i < targetLines.length; i++) {
    const f = fileLines[start + i].replace(/[ \t]+$/, '');
    const t = targetLines[i].replace(/[ \t]+$/, '');
    if (f !== t) return false;
  }
  return true;
}

function matchTier2(fileLines: string[], targetLines: string[], start: number): boolean {
  if (start + targetLines.length > fileLines.length) return false;
  for (let i = 0; i < targetLines.length; i++) {
    const f = fileLines[start + i].replace(/^[ \t]+|[ \t]+$/g, '');
    const t = targetLines[i].replace(/^[ \t]+|[ \t]+$/g, '');
    if (f !== t) return false;
  }
  return true;
}

function findOccurrences(fileLines: string[], targetLines: string[], strict: boolean): { matches: number[]; tier: number } {
  if (targetLines.length === 0) return { matches: [], tier: -1 };

  let matches: number[] = [];
  for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
    if (matchTier0(fileLines, targetLines, i)) matches.push(i);
  }
  if (matches.length > 0) return { matches, tier: 0 };

  if (strict) return { matches: [], tier: -1 };

  matches = [];
  for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
    if (matchTier1(fileLines, targetLines, i)) matches.push(i);
  }
  if (matches.length > 0) return { matches, tier: 1 };

  matches = [];
  for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
    if (matchTier2(fileLines, targetLines, i)) matches.push(i);
  }
  if (matches.length > 0) return { matches, tier: 2 };

  return { matches: [], tier: -1 };
}

function detectFormat(patchLines: string[]): FormatType {
  let firstNonBlank: { line: string; idx: number } | null = null;
  for (let i = 0; i < patchLines.length; i++) {
    if (patchLines[i].trim() !== '') {
      firstNonBlank = { line: patchLines[i].trim(), idx: i };
      break;
    }
  }

  if (firstNonBlank && firstNonBlank.line === '*** Begin Patch') {
    return 'v4a';
  }

  if (firstNonBlank) {
    const firstChar = firstNonBlank.line[0];
    if (firstChar === '[' || firstChar === '{') {
      return 'json';
    }
  }

  for (let i = 0; i < patchLines.length; i++) {
    if (patchLines[i].replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') {
      return 'search-replace';
    }
  }

  for (let i = 0; i < patchLines.length; i++) {
    const l = patchLines[i];
    if (l.startsWith('diff --git ')) {
      return 'unified';
    }
    if (l.startsWith('--- ')) {
      if (i + 1 < patchLines.length && patchLines[i + 1].startsWith('+++ ')) {
        return 'unified';
      }
    }
  }

  return 'auto';
}

interface UnifiedHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  body: { type: ' ' | '-' | '+' | '\\'; text: string }[];
  startLineNum: number;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  isRename: boolean;
  hunks: UnifiedHunk[];
  headerLineNum: number;
}

function parseUnified(patchLines: string[]): { sections: UnifiedSection[]; parseError?: { msg: string; lineNum: number } } {
  const sections: UnifiedSection[] = [];
  let i = 0;
  
  while (i < patchLines.length) {
    const line = patchLines[i];
    const lineNum = i + 1;

    if (line.startsWith('diff --git ') || (line.startsWith('--- ') && i + 1 < patchLines.length && patchLines[i + 1].startsWith('+++ '))) {
      const section: UnifiedSection = {
        oldPath: null,
        newPath: null,
        isCreate: false,
        isDelete: false,
        isRename: false,
        hunks: [],
        headerLineNum: lineNum,
      };

      if (line.startsWith('diff --git ')) {
        const tokens = line.slice(11).trim().split(' ');
        if (tokens.length >= 2) {
          let p1 = tokens[0];
          let p2 = tokens[tokens.length - 1];
          if (p1.startsWith('a/')) p1 = p1.slice(2);
          if (p2.startsWith('b/')) p2 = p2.slice(2);
          section.oldPath = p1;
          section.newPath = p2;
        }
        i++;
      }

      while (i < patchLines.length) {
        const hLine = patchLines[i];
        const hLineNum = i + 1;
        if (hLine.startsWith('@@ ')) {
          break;
        }
        if (hLine.startsWith('diff --git ')) {
          break;
        }
        if (hLine.startsWith('--- ')) {
          if (i + 1 >= patchLines.length || !patchLines[i + 1].startsWith('+++ ')) {
            return { sections: [], parseError: { msg: `error: parse ${i + 2}`, lineNum: i + 2 } };
          }
          const oldPart = hLine.slice(4).trim().split('\t')[0].trim();
          const newPart = patchLines[i + 1].slice(4).trim().split('\t')[0].trim();
          
          let op = oldPart;
          if (op.startsWith('a/')) op = op.slice(2);
          if (op === '/dev/null') {
            section.isCreate = true;
            section.oldPath = null;
          } else {
            section.oldPath = op;
          }

          let np = newPart;
          if (np.startsWith('b/')) np = np.slice(2);
          if (np === '/dev/null') {
            section.isDelete = true;
            section.newPath = null;
          } else {
            section.newPath = np;
          }
          i += 2;
          continue;
        }
        if (hLine.startsWith('+++ ')) {
          i++;
          continue;
        }
        if (hLine.startsWith('rename from ')) {
          section.oldPath = hLine.slice('rename from '.length).trim();
          section.isRename = true;
          i++;
          continue;
        }
        if (hLine.startsWith('rename to ')) {
          section.newPath = hLine.slice('rename to '.length).trim();
          section.isRename = true;
          i++;
          continue;
        }
        if (hLine.startsWith('new file mode')) {
          section.isCreate = true;
          i++;
          continue;
        }
        if (hLine.startsWith('deleted file mode')) {
          section.isDelete = true;
          i++;
          continue;
        }
        i++;
      }

      while (i < patchLines.length) {
        const hunkLine = patchLines[i];
        const hunkLineNum = i + 1;
        if (hunkLine.startsWith('diff --git ') || (hunkLine.startsWith('--- ') && i + 1 < patchLines.length && patchLines[i + 1].startsWith('+++ '))) {
          break;
        }
        if (hunkLine.startsWith('@@ ')) {
          const m = hunkLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
          if (!m) {
            return { sections: [], parseError: { msg: `error: parse ${hunkLineNum}`, lineNum: hunkLineNum } };
          }
          const oldStart = parseInt(m[1], 10);
          const newStart = parseInt(m[2], 10);
          i++;

          const body: { type: ' ' | '-' | '+' | '\\'; text: string }[] = [];
          while (i < patchLines.length) {
            const bLine = patchLines[i];
            const bLineNum = i + 1;
            if (bLine.startsWith('@@ ') || bLine.startsWith('diff --git ') || (bLine.startsWith('--- ') && i + 1 < patchLines.length && patchLines[i + 1].startsWith('+++ '))) {
              break;
            }
            if (bLine === '' || bLine.startsWith(' ') || bLine.startsWith('-') || bLine.startsWith('+') || bLine.startsWith('\\')) {
              const type = bLine === '' ? ' ' : (bLine[0] as any);
              const text = bLine === '' ? '' : bLine.slice(1);
              body.push({ type, text });
              i++;
            } else {
              break;
            }
          }
          while (body.length > 0 && body[body.length - 1].type === ' ' && body[body.length - 1].text === '') {
            body.pop();
          }

          section.hunks.push({
            oldStart,
            oldLen: 0,
            newStart,
            newLen: 0,
            body,
            startLineNum: hunkLineNum,
          });
        } else if (hunkLine.startsWith('@@')) {
          return { sections: [], parseError: { msg: `error: parse ${hunkLineNum}`, lineNum: hunkLineNum } };
        } else {
          i++;
        }
      }

      sections.push(section);
    } else {
      i++;
    }
  }

  return { sections };
}

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLineNum: number;
}

function parseSearchReplace(patchLines: string[]): { blocks: SearchReplaceBlock[]; parseError?: { msg: string; lineNum: number } } {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  let currentPath: string | null = null;

  while (i < patchLines.length) {
    const line = patchLines[i];
    const lineNum = i + 1;
    const trimmed = line.replace(/[ \t]+$/, '');

    if (trimmed === '<<<<<<< SEARCH') {
      const searchLineNum = lineNum;
      let prevReplaceIdx = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (patchLines[j].replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') {
          prevReplaceIdx = j;
          break;
        }
      }
      
      let foundPathLine: string | null = null;
      for (let j = i - 1; j > prevReplaceIdx; j--) {
        const c = patchLines[j];
        const cTrim = c.trim();
        if (cTrim !== '' && !cTrim.startsWith('```')) {
          foundPathLine = cTrim;
          break;
        }
      }

      if (!foundPathLine) {
        if (currentPath !== null) {
          foundPathLine = currentPath;
        } else {
          return { blocks: [], parseError: { msg: `error: parse ${searchLineNum}`, lineNum: searchLineNum } };
        }
      } else {
        currentPath = foundPathLine;
      }

      i++;
      const oldLines: string[] = [];
      let foundEq = false;
      while (i < patchLines.length) {
        const eqLine = patchLines[i];
        if (eqLine.replace(/[ \t]+$/, '') === '=======') {
          foundEq = true;
          i++;
          break;
        }
        oldLines.push(eqLine);
        i++;
      }

      if (!foundEq) {
        return { blocks: [], parseError: { msg: `error: parse ${searchLineNum}`, lineNum: searchLineNum } };
      }

      const newLines: string[] = [];
      let foundReplace = false;
      while (i < patchLines.length) {
        const repLine = patchLines[i];
        if (repLine.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') {
          foundReplace = true;
          i++;
          break;
        }
        newLines.push(repLine);
        i++;
      }

      if (!foundReplace) {
        return { blocks: [], parseError: { msg: `error: parse ${searchLineNum}`, lineNum: searchLineNum } };
      }

      blocks.push({
        path: currentPath,
        oldLines,
        newLines,
        searchLineNum,
      });
    } else {
      i++;
    }
  }

  return { blocks };
}

interface V4AChunk {
  anchor?: string;
  body: { type: ' ' | '-' | '+'; text: string }[];
  isEof: boolean;
}

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  moveToPath?: string;
  lines?: string[];
  chunks?: V4AChunk[];
}

function parseV4A(patchLines: string[]): { sections: V4ASection[]; parseError?: { msg: string; lineNum: number } } {
  let firstNonBlankIdx = -1;
  let firstNonBlankLine = '';
  for (let i = 0; i < patchLines.length; i++) {
    if (patchLines[i].trim() !== '') {
      firstNonBlankIdx = i;
      firstNonBlankLine = patchLines[i].trim();
      break;
    }
  }

  if (firstNonBlankIdx === -1 || firstNonBlankLine !== '*** Begin Patch') {
    return { sections: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
  }

  let lastNonBlankIdx = -1;
  let lastNonBlankLine = '';
  for (let i = patchLines.length - 1; i >= 0; i--) {
    if (patchLines[i].trim() !== '') {
      lastNonBlankIdx = i;
      lastNonBlankLine = patchLines[i].trim();
      break;
    }
  }

  if (lastNonBlankIdx === -1 || lastNonBlankLine !== '*** End Patch') {
    return { sections: [], parseError: { msg: `error: parse ${patchLines.length + 1}`, lineNum: patchLines.length + 1 } };
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlankIdx + 1;
  const endIndex = lastNonBlankIdx;

  while (i < endIndex) {
    const line = patchLines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }

    if (trimmed.startsWith('*** Add File: ')) {
      const path = trimmed.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < endIndex) {
        const l = patchLines[i];
        const lNum = i + 1;
        const lTrim = l.trim();
        if (lTrim.startsWith('*** Add File: ') || lTrim.startsWith('*** Delete File: ') || lTrim.startsWith('*** Update File: ')) {
          break;
        }
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          fileLines.push('');
          i++;
        } else {
          return { sections: [], parseError: { msg: `error: parse ${lNum}`, lineNum: lNum } };
        }
      }
      sections.push({ type: 'add', path, lines: fileLines });
    } else if (trimmed.startsWith('*** Delete File: ')) {
      const path = trimmed.slice('*** Delete File: '.length).trim();
      i++;
      sections.push({ type: 'delete', path });
    } else if (trimmed.startsWith('*** Update File: ')) {
      const path = trimmed.slice('*** Update File: '.length).trim();
      const updateLineNum = lineNum;
      i++;
      let moveToPath: string | undefined;
      const chunks: V4AChunk[] = [];
      
      if (i < endIndex && patchLines[i].trim().startsWith('*** Move to: ')) {
        moveToPath = patchLines[i].trim().slice('*** Move to: '.length).trim();
        i++;
      }

      while (i < endIndex) {
        const cLine = patchLines[i];
        const cNum = i + 1;
        const cTrim = cLine.trim();
        if (cTrim.startsWith('*** Add File: ') || cTrim.startsWith('*** Delete File: ') || cTrim.startsWith('*** Update File: ')) {
          break;
        }
        if (cTrim === '') {
          i++;
          continue;
        }

        let anchor: string | undefined;
        let isEof = false;

        if (cLine.startsWith('@@')) {
          anchor = cLine.slice(2).trim();
          i++;
        }

        const body: { type: ' ' | '-' | '+'; text: string }[] = [];
        while (i < endIndex) {
          const bLine = patchLines[i];
          const bNum = i + 1;
          const bTrim = bLine.trim();
          if (bTrim.startsWith('*** Add File: ') || bTrim.startsWith('*** Delete File: ') || bTrim.startsWith('*** Update File: ') || bTrim.startsWith('@@') || bTrim === '*** End of File') {
            if (bTrim === '*** End of File') {
              isEof = true;
              i++;
            }
            break;
          }
          if (bLine.startsWith(' ') || bLine.startsWith('-') || bLine.startsWith('+')) {
            body.push({ type: bLine[0] as any, text: bLine.slice(1) });
            i++;
          } else if (bLine === '') {
            body.push({ type: ' ', text: '' });
            i++;
          } else {
            return { sections: [], parseError: { msg: `error: parse ${bNum}`, lineNum: bNum } };
          }
        }

        chunks.push({ anchor, body, isEof });
      }

      if (chunks.length > 0) {
        const lastBody = chunks[chunks.length - 1].body;
        while (lastBody.length > 0 && lastBody[lastBody.length - 1].type === ' ' && lastBody[lastBody.length - 1].text.trim() === '') {
          lastBody.pop();
        }
      }

      if (chunks.length === 0 && !moveToPath) {
        return { sections: [], parseError: { msg: `error: parse ${updateLineNum}`, lineNum: updateLineNum } };
      }

      sections.push({ type: 'update', path, moveToPath, chunks });
    } else {
      return { sections: [], parseError: { msg: `error: parse ${lineNum}`, lineNum: lineNum } };
    }
  }

  return { sections };
}

interface JsonEdit {
  command: 'create' | 'str_replace' | 'insert';
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

function parseJson(patchLines: string[], rawPatchText: string): { edits: JsonEdit[]; parseError?: { msg: string; lineNum: number } } {
  let edits: JsonEdit[] = [];
  const trimmedText = rawPatchText.trim();
  
  try {
    if (trimmedText.startsWith('[')) {
      const parsed = JSON.parse(rawPatchText);
      if (!Array.isArray(parsed)) {
        return { edits: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
      }
      for (let idx = 0; idx < parsed.length; idx++) {
        const item = parsed[idx];
        if (!item || typeof item !== 'object' || typeof item.path !== 'string' || typeof item.command !== 'string') {
          return { edits: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
        }
        if (item.command === 'create') {
          if (typeof item.file_text !== 'string') {
            return { edits: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
          }
          edits.push({ command: 'create', path: item.path, file_text: item.file_text });
        } else if (item.command === 'str_replace') {
          if (typeof item.old_str !== 'string' || item.old_str === '' || (item.new_str !== undefined && typeof item.new_str !== 'string')) {
            return { edits: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
          }
          edits.push({ command: 'str_replace', path: item.path, old_str: item.old_str, new_str: item.new_str || '' });
        } else if (item.command === 'insert') {
          if (typeof item.insert_line !== 'number' || !Number.isInteger(item.insert_line) || typeof item.new_str !== 'string') {
            return { edits: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
          }
          edits.push({ command: 'insert', path: item.path, insert_line: item.insert_line, new_str: item.new_str });
        } else {
          return { edits: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
        }
      }
    } else {
      for (let i = 0; i < patchLines.length; i++) {
        const l = patchLines[i].trim();
        const lineNum = i + 1;
        if (l === '') continue;
        let item: any;
        try {
          item = JSON.parse(l);
        } catch {
          return { edits: [], parseError: { msg: `error: parse ${lineNum}`, lineNum } };
        }
        if (!item || typeof item !== 'object' || typeof item.path !== 'string' || typeof item.command !== 'string') {
          return { edits: [], parseError: { msg: `error: parse ${lineNum}`, lineNum } };
        }
        if (item.command === 'create') {
          if (typeof item.file_text !== 'string') {
            return { edits: [], parseError: { msg: `error: parse ${lineNum}`, lineNum } };
          }
          edits.push({ command: 'create', path: item.path, file_text: item.file_text });
        } else if (item.command === 'str_replace') {
          if (typeof item.old_str !== 'string' || item.old_str === '' || (item.new_str !== undefined && typeof item.new_str !== 'string')) {
            return { edits: [], parseError: { msg: `error: parse ${lineNum}`, lineNum } };
          }
          edits.push({ command: 'str_replace', path: item.path, old_str: item.old_str, new_str: item.new_str || '' });
        } else if (item.command === 'insert') {
          if (typeof item.insert_line !== 'number' || !Number.isInteger(item.insert_line) || typeof item.new_str !== 'string') {
            return { edits: [], parseError: { msg: `error: parse ${lineNum}`, lineNum } };
          }
          edits.push({ command: 'insert', path: item.path, insert_line: item.insert_line, new_str: item.new_str });
        } else {
          return { edits: [], parseError: { msg: `error: parse ${lineNum}`, lineNum } };
        }
      }
    }
  } catch {
    return { edits: [], parseError: { msg: `error: parse 1`, lineNum: 1 } };
  }

  return { edits };
}

function main() {
  const argv = process.argv.slice(2);
  let format: FormatType = 'auto';
  let check = false;
  let strict = false;
  let patchArg: string | null = null;

  let parsingOptions = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (parsingOptions) {
      if (arg === '--') {
        parsingOptions = false;
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') {
        if (arg === '--check') {
          if (check) {
            console.log('error: usage');
            process.exit(2);
          }
          check = true;
          continue;
        }
        if (arg === '--strict') {
          if (strict) {
            console.log('error: usage');
            process.exit(2);
          }
          strict = true;
          continue;
        }
        if (arg.startsWith('--format=')) {
          if (format !== 'auto') {
            console.log('error: usage');
            process.exit(2);
          }
          const fName = arg.slice('--format='.length);
          if (!['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(fName)) {
            console.log('error: usage');
            process.exit(2);
          }
          format = fName as FormatType;
          continue;
        }
        console.log('error: usage');
        process.exit(2);
      }
    }

    if (patchArg !== null) {
      console.log('error: usage');
      process.exit(2);
    }
    patchArg = arg;
  }

  let rawPatch = '';
  try {
    if (patchArg === null || patchArg === '-') {
      rawPatch = fs.readFileSync(0, 'utf8');
    } else {
      if (!fs.existsSync(patchArg)) {
        console.log('error: no-patch');
        process.exit(2);
      }
      rawPatch = fs.readFileSync(patchArg, 'utf8');
    }
  } catch {
    console.log('error: no-patch');
    process.exit(2);
  }

  const { lines: patchLines, rawText } = getPatchLines(rawPatch);

  let detectedFormat = format;
  if (detectedFormat === 'auto') {
    detectedFormat = detectFormat(patchLines);
    if (detectedFormat === 'auto') {
      console.log('error: format');
      process.exit(2);
    }
  }

  let parsedUnified: UnifiedSection[] | undefined;
  let parsedSearchReplace: SearchReplaceBlock[] | undefined;
  let parsedV4A: V4ASection[] | undefined;
  let parsedJson: JsonEdit[] | undefined;

  if (detectedFormat === 'unified') {
    const res = parseUnified(patchLines);
    if (res.parseError) {
      console.log(res.parseError.msg);
      process.exit(2);
    }
    parsedUnified = res.sections;
    if (parsedUnified.length === 0) {
      console.log('error: parse 1');
      process.exit(2);
    }
  } else if (detectedFormat === 'search-replace') {
    const res = parseSearchReplace(patchLines);
    if (res.parseError) {
      console.log(res.parseError.msg);
      process.exit(2);
    }
    parsedSearchReplace = res.blocks;
    if (parsedSearchReplace.length === 0) {
      console.log('error: parse 1');
      process.exit(2);
    }
  } else if (detectedFormat === 'v4a') {
    const res = parseV4A(patchLines);
    if (res.parseError) {
      console.log(res.parseError.msg);
      process.exit(2);
    }
    parsedV4A = res.sections;
    if (parsedV4A.length === 0) {
      console.log('error: parse 1');
      process.exit(2);
    }
  } else if (detectedFormat === 'json') {
    const res = parseJson(patchLines, rawText);
    if (res.parseError) {
      console.log(res.parseError.msg);
      process.exit(2);
    }
    parsedJson = res.edits;
    if (parsedJson.length === 0) {
      console.log('error: parse 1');
      process.exit(2);
    }
  }

  interface VirtualFile {
    lines: string[];
    hasEol: boolean;
    isCrlf: boolean;
    exists: boolean;
  }

  const fileMap = new Map<string, VirtualFile>();

  let loadFile = (p: string): VirtualFile => {
    if (fileMap.has(p)) {
      return fileMap.get(p)!;
    }
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      const pf = parseFileContent(content);
      const vf: VirtualFile = { lines: pf.lines, hasEol: pf.hasEol, isCrlf: pf.isCrlf, exists: true };
      fileMap.set(p, vf);
      return vf;
    } else {
      const vf: VirtualFile = { lines: [], hasEol: false, isCrlf: false, exists: false };
      fileMap.set(p, vf);
      return vf;
    }
  }

  interface GenericEdit {
    description: string;
    pathsToCheck: string[];
    execute: () => { success: boolean; errorCode?: 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe'; errorPath?: string };
    resultType: 'A' | 'D' | 'M' | 'R';
    oldPath?: string;
    newPath?: string;
    targetPath?: string;
  }

  const genericEdits: GenericEdit[] = [];

  if (detectedFormat === 'unified') {
    for (const sec of parsedUnified!) {
      const pathsToCheck: string[] = [];
      if (sec.oldPath) pathsToCheck.push(sec.oldPath);
      if (sec.newPath && sec.newPath !== sec.oldPath) pathsToCheck.push(sec.newPath);

      genericEdits.push({
        description: `unified section ${sec.oldPath} -> ${sec.newPath}`,
        pathsToCheck,
        resultType: sec.isCreate ? 'A' : (sec.isDelete ? 'D' : (sec.oldPath !== sec.newPath && sec.oldPath && sec.newPath ? 'R' : 'M')),
        oldPath: sec.oldPath || undefined,
        newPath: sec.newPath || undefined,
        targetPath: sec.newPath || sec.oldPath || undefined,
        execute: () => {
          for (const p of pathsToCheck) {
            if (!isSafePath(p)) return { success: false, errorCode: 'unsafe', errorPath: p };
          }

          if (sec.isCreate) {
            const target = sec.newPath!;
            const vf = loadFile(target);
            if (vf.exists) return { success: false, errorCode: 'exists', errorPath: target };

            let newLines: string[] = [];
            let endsWithEol = true;
            for (const hunk of sec.hunks) {
              for (let idx = 0; idx < hunk.body.length; idx++) {
                const b = hunk.body[idx];
                if (b.type === '+') {
                  newLines.push(b.text);
                } else if (b.type === '\\') {
                  if (idx > 0 && hunk.body[idx - 1].type === '+') {
                    endsWithEol = false;
                  }
                }
              }
            }
            vf.lines = newLines;
            vf.exists = true;
            vf.hasEol = endsWithEol;
            vf.isCrlf = false;
            return { success: true };
          }

          if (sec.isDelete) {
            const target = sec.oldPath!;
            const vf = loadFile(target);
            if (!vf.exists) return { success: false, errorCode: 'missing', errorPath: target };
            vf.exists = false;
            vf.lines = [];
            return { success: true };
          }

          const oldP = sec.oldPath!;
          const newP = sec.newPath || oldP;
          const oldVf = loadFile(oldP);
          if (!oldVf.exists) return { success: false, errorCode: 'missing', errorPath: oldP };

          let targetVf = oldVf;
          if (oldP !== newP) {
            targetVf = loadFile(newP);
            if (targetVf.exists) return { success: false, errorCode: 'exists', errorPath: newP };
          }

          let currentLines = [...oldVf.lines];
          let currentHasEol = oldVf.hasEol;
          const isCrlf = oldVf.isCrlf;

          let d = 0;
          for (const hunk of sec.hunks) {
            const oLines: string[] = [];
            const nLines: string[] = [];
            let oEolOverride: boolean | undefined = undefined;
            let nEolOverride: boolean | undefined = undefined;

            for (let idx = 0; idx < hunk.body.length; idx++) {
              const b = hunk.body[idx];
              if (b.type === ' ' || b.type === '-') {
                oLines.push(b.text);
              }
              if (b.type === ' ' || b.type === '+') {
                nLines.push(b.text);
              }
              if (b.type === '\\') {
                if (idx > 0) {
                  const prev = hunk.body[idx - 1];
                  if (prev.type === '-') oEolOverride = false;
                  if (prev.type === '+') nEolOverride = false;
                }
              }
            }

            const targetA = hunk.oldStart;
            const idealPos = targetA - 1 + d;

            let foundPos = -1;
            let matchedTier = -1;

            if (oLines.length === 0) {
              foundPos = Math.max(0, Math.min(currentLines.length, targetA + d));
              matchedTier = 0;
            } else {
              const { matches, tier } = findOccurrences(currentLines, oLines, strict);
              if (matches.length === 0) {
                return { success: false, errorCode: 'no-match', errorPath: oldP };
              }
              matchedTier = tier;
              let best = matches[0];
              let bestDist = Math.abs(best - idealPos);
              for (let mIdx = 1; mIdx < matches.length; mIdx++) {
                const pos = matches[mIdx];
                const dist = Math.abs(pos - idealPos);
                if (dist < bestDist) {
                  bestDist = dist;
                  best = pos;
                }
              }
              foundPos = best;
            }

            const finalBlock: string[] = [];
            let matchIdx = foundPos;
            for (const b of hunk.body) {
              if (b.type === ' ') {
                finalBlock.push(matchIdx < currentLines.length ? currentLines[matchIdx] : b.text);
                matchIdx++;
              } else if (b.type === '-') {
                matchIdx++;
              } else if (b.type === '+') {
                let t = b.text;
                if (matchedTier === 2 && currentLines.length > foundPos) {
                  const F = currentLines[foundPos].match(/^[ \t]*/)?.[0] || '';
                  const P = oLines.length > 0 ? (oLines[0].match(/^[ \t]*/)?.[0] || '') : '';
                  if (t.trim() !== '' && t.startsWith(P)) {
                    t = F + t.slice(P.length);
                  }
                }
                finalBlock.push(t);
              }
            }

            currentLines.splice(foundPos, oLines.length, ...finalBlock);
            d += (finalBlock.length - oLines.length);

            if (nEolOverride !== undefined) {
              currentHasEol = nEolOverride;
            } else if (oEolOverride !== undefined) {
              currentHasEol = oEolOverride;
            }
          }

          if (oldP !== newP) {
            oldVf.exists = false;
            oldVf.lines = [];
            targetVf.exists = true;
            targetVf.lines = currentLines;
            targetVf.hasEol = currentHasEol;
            targetVf.isCrlf = isCrlf;
          } else {
            oldVf.lines = currentLines;
            oldVf.hasEol = currentHasEol;
          }

          return { success: true };
        }
      });
    }
  } else if (detectedFormat === 'search-replace') {
    for (const block of parsedSearchReplace!) {
      const pathsToCheck = [block.path];
      const isCreate = block.oldLines.length === 0;

      genericEdits.push({
        description: `search-replace ${block.path}`,
        pathsToCheck,
        resultType: isCreate ? 'A' : 'M',
        targetPath: block.path,
        execute: () => {
          for (const p of pathsToCheck) {
            if (!isSafePath(p)) return { success: false, errorCode: 'unsafe', errorPath: p };
          }

          const vf = loadFile(block.path);
          if (isCreate) {
            if (vf.exists) return { success: false, errorCode: 'exists', errorPath: block.path };
            vf.exists = true;
            vf.lines = [...block.newLines];
            vf.hasEol = true;
            vf.isCrlf = false;
            return { success: true };
          } else {
            if (!vf.exists) return { success: false, errorCode: 'missing', errorPath: block.path };
            const { matches, tier } = findOccurrences(vf.lines, block.oldLines, strict);
            if (matches.length === 0) {
              return { success: false, errorCode: 'no-match', errorPath: block.path };
            }
            if (matches.length > 1) {
              return { success: false, errorCode: 'ambiguous', errorPath: block.path };
            }

            const foundPos = matches[0];
            let processedNew = [...block.newLines];
            if (tier === 2 && vf.lines.length > foundPos && block.oldLines.length > 0 && block.newLines.length > 0) {
              const F = vf.lines[foundPos].match(/^[ \t]*/)?.[0] || '';
              const P = block.oldLines[0].match(/^[ \t]*/)?.[0] || '';
              processedNew = block.newLines.map(nl => {
                if (nl.trim() !== '' && nl.startsWith(P)) {
                  return F + nl.slice(P.length);
                }
                return nl;
              });
            }

            vf.lines.splice(foundPos, block.oldLines.length, ...processedNew);
            return { success: true };
          }
        }
      });
    }
  } else if (detectedFormat === 'v4a') {
    for (const sec of parsedV4A!) {
      const pathsToCheck: string[] = [sec.path];
      if (sec.moveToPath && sec.moveToPath !== sec.path) pathsToCheck.push(sec.moveToPath);

      genericEdits.push({
        description: `v4a ${sec.type} ${sec.path}`,
        pathsToCheck,
        resultType: sec.type === 'add' ? 'A' : (sec.type === 'delete' ? 'D' : (sec.moveToPath ? 'R' : 'M')),
        oldPath: sec.type === 'update' && sec.moveToPath ? sec.path : undefined,
        newPath: sec.moveToPath,
        targetPath: sec.moveToPath || sec.path,
        execute: () => {
          for (const p of pathsToCheck) {
            if (!isSafePath(p)) return { success: false, errorCode: 'unsafe', errorPath: p };
          }

          if (sec.type === 'add') {
            const vf = loadFile(sec.path);
            if (vf.exists) return { success: false, errorCode: 'exists', errorPath: sec.path };
            vf.exists = true;
            vf.lines = sec.lines || [];
            vf.hasEol = true;
            vf.isCrlf = false;
            return { success: true };
          }

          if (sec.type === 'delete') {
            const vf = loadFile(sec.path);
            if (!vf.exists) return { success: false, errorCode: 'missing', errorPath: sec.path };
            vf.exists = false;
            vf.lines = [];
            return { success: true };
          }

          const oldP = sec.path;
          const newP = sec.moveToPath || oldP;
          const oldVf = loadFile(oldP);
          if (!oldVf.exists) return { success: false, errorCode: 'missing', errorPath: oldP };

          let targetVf = oldVf;
          if (oldP !== newP) {
            targetVf = loadFile(newP);
            if (targetVf.exists) return { success: false, errorCode: 'exists', errorPath: newP };
          }

          let currentLines = [...oldVf.lines];
          let cursor = 0;

          for (const chunk of sec.chunks || []) {
            if (chunk.anchor !== undefined) {
              let foundAnchorIdx = -1;
              let foundTier = -1;
              const anchorTarget = [chunk.anchor];
              for (let cIdx = cursor; cIdx < currentLines.length; cIdx++) {
                const { matches, tier } = findOccurrences([currentLines[cIdx]], anchorTarget, strict);
                if (matches.length > 0) {
                  foundAnchorIdx = cIdx;
                  foundTier = tier;
                  break;
                }
              }
              if (foundAnchorIdx === -1) {
                return { success: false, errorCode: 'no-match', errorPath: oldP };
              }
              cursor = foundAnchorIdx + 1;
            }

            const oLines: string[] = [];
            const nLines: string[] = [];
            for (const b of chunk.body) {
              if (b.type === ' ' || b.type === '-') oLines.push(b.text);
              if (b.type === ' ' || b.type === '+') nLines.push(b.text);
            }

            let foundPos = -1;
            let matchedTier = -1;

            if (chunk.isEof) {
              if (oLines.length === 0) {
                foundPos = currentLines.length;
                matchedTier = 0;
              } else {
                const targetPos = currentLines.length - oLines.length;
                if (targetPos >= cursor && targetPos >= 0) {
                  const sub = currentLines.slice(targetPos);
                  const { matches, tier } = findOccurrences(sub, oLines, strict);
                  if (matches.length > 0) {
                    foundPos = targetPos + matches[0];
                    matchedTier = tier;
                  }
                }
              }
            } else if (oLines.length === 0) {
              foundPos = cursor;
              matchedTier = 0;
            } else {
              for (let cIdx = cursor; cIdx <= currentLines.length - oLines.length; cIdx++) {
                const sub = currentLines.slice(cIdx);
                const { matches, tier } = findOccurrences(sub, oLines, strict);
                if (matches.length > 0) {
                  foundPos = cIdx + matches[0];
                  matchedTier = tier;
                  break;
                }
              }
            }

            if (foundPos === -1) {
              return { success: false, errorCode: 'no-match', errorPath: oldP };
            }

            const finalBlock: string[] = [];
            let matchIdx = foundPos;
            for (const b of chunk.body) {
              if (b.type === ' ') {
                finalBlock.push(matchIdx < currentLines.length ? currentLines[matchIdx] : b.text);
                matchIdx++;
              } else if (b.type === '-') {
                matchIdx++;
              } else if (b.type === '+') {
                let t = b.text;
                if (matchedTier === 2 && currentLines.length > foundPos) {
                  const F = currentLines[foundPos].match(/^[ \t]*/)?.[0] || '';
                  const P = oLines.length > 0 ? (oLines[0].match(/^[ \t]*/)?.[0] || '') : '';
                  if (t.trim() !== '' && t.startsWith(P)) {
                    t = F + t.slice(P.length);
                  }
                }
                finalBlock.push(t);
              }
            }

            currentLines.splice(foundPos, oLines.length, ...finalBlock);
            cursor = foundPos + finalBlock.length;
          }

          if (oldP !== newP) {
            oldVf.exists = false;
            oldVf.lines = [];
            targetVf.exists = true;
            targetVf.lines = currentLines;
            targetVf.hasEol = true;
            targetVf.isCrlf = oldVf.isCrlf;
          } else {
            oldVf.lines = currentLines;
          }

          return { success: true };
        }
      });
    }
  } else if (detectedFormat === 'json') {
    for (const edit of parsedJson!) {
      const pathsToCheck = [edit.path];

      genericEdits.push({
        description: `json ${edit.command} ${edit.path}`,
        pathsToCheck,
        resultType: edit.command === 'create' ? 'A' : 'M',
        targetPath: edit.path,
        execute: () => {
          for (const p of pathsToCheck) {
            if (!isSafePath(p)) return { success: false, errorCode: 'unsafe', errorPath: p };
          }

          const vf = loadFile(edit.path);

          if (edit.command === 'create') {
            if (vf.exists) return { success: false, errorCode: 'exists', errorPath: edit.path };
            vf.exists = true;
            const pf = parseFileContent(edit.file_text!);
            vf.lines = pf.lines;
            vf.hasEol = pf.hasEol;
            vf.isCrlf = pf.isCrlf;
            return { success: true };
          }

          if (edit.command === 'str_replace') {
            if (!vf.exists) return { success: false, errorCode: 'missing', errorPath: edit.path };
            const originalText = writeFileContent(vf.lines, vf.hasEol, vf.isCrlf);
            
            let textToSearch = originalText;
            let searchOld = edit.old_str!;
            let searchNew = edit.new_str!;
            if (vf.isCrlf) {
              textToSearch = originalText.replace(/\r\n/g, '\n');
              searchOld = searchOld.replace(/\r\n/g, '\n');
              searchNew = searchNew.replace(/\r\n/g, '\n');
            }

            const occurrences: number[] = [];
            let pos = textToSearch.indexOf(searchOld);
            while (pos !== -1) {
              occurrences.push(pos);
              pos = textToSearch.indexOf(searchOld, pos + 1);
            }

            if (occurrences.length === 0) {
              return { success: false, errorCode: 'no-match', errorPath: edit.path };
            }
            if (occurrences.length > 1) {
              return { success: false, errorCode: 'ambiguous', errorPath: edit.path };
            }

            const matchPos = occurrences[0];
            let modifiedText = textToSearch.slice(0, matchPos) + searchNew + textToSearch.slice(matchPos + searchOld.length);

            if (vf.isCrlf) {
              modifiedText = modifiedText.replace(/\n/g, '\r\n');
            }

            const pf = parseFileContent(modifiedText);
            vf.lines = pf.lines;
            vf.hasEol = pf.hasEol;
            vf.isCrlf = pf.isCrlf;
            return { success: true };
          }

          if (edit.command === 'insert') {
            if (!vf.exists) return { success: false, errorCode: 'missing', errorPath: edit.path };
            const insertLine = edit.insert_line!;
            if (insertLine < 0 || insertLine > vf.lines.length) {
              return { success: false, errorCode: 'no-match', errorPath: edit.path };
            }

            const newStrLines: string[] = [];
            const splitNew = edit.new_str!.split('\n');
            for (let sIdx = 0; sIdx < splitNew.length; sIdx++) {
              if (sIdx === splitNew.length - 1 && splitNew[sIdx] === '' && edit.new_str!.endsWith('\n')) {
                continue;
              }
              let l = splitNew[sIdx];
              if (l.endsWith('\r')) l = l.slice(0, -1);
              newStrLines.push(l);
            }

            vf.lines.splice(insertLine, 0, ...newStrLines);
            return { success: true };
          }

          return { success: false, errorCode: 'no-match', errorPath: edit.path };
        }
      });
    }
  }

  // Atomicity & Execution check:
  // Pre-load all paths checked by any edit
  for (const edit of genericEdits) {
    for (const p of edit.pathsToCheck) {
      loadFile(p);
    }
    if (edit.oldPath) loadFile(edit.oldPath);
    if (edit.newPath) loadFile(edit.newPath);
  }

  const beforeState = new Map<string, string | null>();
  for (const [p, v] of fileMap.entries()) {
    beforeState.set(p, v.exists ? writeFileContent(v.lines, v.hasEol, v.isCrlf) : null);
  }

  const failures: Array<{ code: string; path: string }> = [];
  for (const edit of genericEdits) {
    const res = edit.execute();
    if (!res.success) {
      failures.push({
        code: res.errorCode || 'no-match',
        path: res.errorPath || edit.pathsToCheck[0] || ''
      });
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      fs.writeSync(1, `error: ${f.code} ${f.path}\n`);
    }
    fs.writeSync(1, `failed: ${failures.length} of ${genericEdits.length} edits\n`);
    process.exitCode = 1;
    return;
  }

  const afterState = new Map<string, string | null>();
  for (const [p, v] of fileMap.entries()) {
    afterState.set(p, v.exists ? writeFileContent(v.lines, v.hasEol, v.isCrlf) : null);
  }

  const handledPaths = new Set<string>();
  const changeLines: Array<{ line: string; sortPath: string }> = [];

  for (const edit of genericEdits) {
    if (edit.resultType === 'R' && edit.oldPath && edit.newPath) {
      const oldP = edit.oldPath;
      const newP = edit.newPath;
      const bOld = beforeState.get(oldP) ?? null;
      const aOld = afterState.get(oldP) ?? null;
      const bNew = beforeState.get(newP) ?? null;
      const aNew = afterState.get(newP) ?? null;

      if (bOld !== null && aOld === null && bNew === null && aNew !== null) {
        changeLines.push({
          line: `R ${oldP} -> ${newP}`,
          sortPath: newP
        });
        handledPaths.add(oldP);
        handledPaths.add(newP);
      }
    }
  }

  for (const [p, afterVal] of afterState.entries()) {
    if (handledPaths.has(p)) continue;
    const beforeVal = beforeState.get(p) ?? null;
    if (beforeVal !== afterVal) {
      if (beforeVal === null && afterVal !== null) {
        changeLines.push({
          line: `A ${p}`,
          sortPath: p
        });
      } else if (beforeVal !== null && afterVal === null) {
        changeLines.push({
          line: `D ${p}`,
          sortPath: p
        });
      } else if (beforeVal !== null && afterVal !== null && beforeVal !== afterVal) {
        changeLines.push({
          line: `M ${p}`,
          sortPath: p
        });
      }
    }
  }

  changeLines.sort((a, b) => Buffer.compare(Buffer.from(a.sortPath), Buffer.from(b.sortPath)));

  for (const cl of changeLines) {
    fs.writeSync(1, cl.line + '\n');
  }

  const n = changeLines.length;
  if (n === 1) {
    fs.writeSync(1, `ok: 1 file\n`);
  } else {
    fs.writeSync(1, `ok: ${n} files\n`);
  }

  if (!check) {
    for (const [p, afterVal] of afterState.entries()) {
      const beforeVal = beforeState.get(p) ?? null;
      if (beforeVal !== afterVal) {
        if (afterVal === null) {
          try {
            fs.rmSync(p, { force: true });
          } catch {}
        } else {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, afterVal, 'utf8');
        }
      }
    }
  }

  process.exitCode = 0;
}

main();
