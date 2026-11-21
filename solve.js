// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly the answer csv-reader's readCsv
// returns for every input {text, header} — {columns, rows, errors} — and is built to use less CPU.
// The reading policy is csv-reader's own, followed exactly:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it is one
//     quote, and each CRLF or lone CR inside it is read as LF; what follows the closing quote, up to
//     the next comma or line break, is appended as it stands (quote_junk, when the field ends with
//     characters appended); a quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows are padded with "" (short_row,
//     with fields: the count) or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on, row its record's
//     index in rows (null for the header), in the order met.
// Where the reference builds each field a character at a time, this reader slices whole runs of
// ordinary characters out of the text at once and only slows down for the characters that matter
// (comma, quote, CR, LF). Pure: nothing is kept from one call to the next.

const ENDED_COMMA = 0;
const ENDED_LINE_BREAK = 1;
const ENDED_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters the unquoted reader kept.
  let fVal = '';
  let fEnded = ENDED_END;
  let fAdded = 0;

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by
  // LF is dropped (stray_cr). Sets fVal, fEnded and fAdded (the characters kept past `init`).
  function readUnquoted(init) {
    let head = init;
    let added = 0;
    let segStart = pos;
    let i = pos;
    for (;;) {
      let j = i;
      while (j < len) {
        const c = text.charCodeAt(j);
        if (c === 44 || c === 10 || c === 13) break;
        j++;
      }
      if (j >= len) {
        const tail = text.slice(segStart, len);
        fVal = head + tail;
        fAdded = added + (len - segStart);
        fEnded = ENDED_END;
        pos = len;
        return;
      }
      const c = text.charCodeAt(j);
      if (c === 44) {
        const tail = text.slice(segStart, j);
        fVal = head + tail;
        fAdded = added + (j - segStart);
        fEnded = ENDED_COMMA;
        pos = j + 1;
        return;
      }
      if (c === 10) {
        const tail = text.slice(segStart, j);
        fVal = head + tail;
        fAdded = added + (j - segStart);
        fEnded = ENDED_LINE_BREAK;
        pos = j + 1;
        line += 1;
        return;
      }
      // c === 13: a CR. Followed by LF it ends the record; on its own it is dropped (stray_cr).
      if (text.charCodeAt(j + 1) === 10) {
        const tail = text.slice(segStart, j);
        fVal = head + tail;
        fAdded = added + (j - segStart);
        fEnded = ENDED_LINE_BREAK;
        pos = j + 2;
        line += 1;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      head += text.slice(segStart, j);
      added += j - segStart;
      pos = j + 1;
      segStart = pos;
      i = pos;
    }
  }

  // Appends the quoted segment text[p..q) to `value`, converting each CRLF or lone CR to one LF and
  // counting every line break it holds. Short segments are scanned a character at a time, which is
  // cheaper than searching them; long ones are searched and replaced natively.
  function appendSegment(value, p, q) {
    if (q - p <= 48) {
      let breaks = 0;
      for (let j = p; j < q; j++) {
        const c = text.charCodeAt(j);
        if (c === 13) {
          // A CR is in the segment: take the native path for the whole segment, counting afresh.
          const seg = text.slice(p, q);
          const found = seg.match(/\r\n|\r|\n/g);
          line += found === null ? 0 : found.length;
          return value + seg.replace(/\r\n|\r/g, '\n');
        }
        if (c === 10) breaks += 1;
      }
      line += breaks;
      return value + text.slice(p, q);
    }
    const seg = text.slice(p, q);
    if (seg.indexOf('\r') === -1) {
      let k = seg.indexOf('\n');
      while (k !== -1) {
        line += 1;
        k = seg.indexOf('\n', k + 1);
      }
      return value + seg;
    }
    const found = seg.match(/\r\n|\r|\n/g);
    line += found === null ? 0 : found.length;
    return value + seg.replace(/\r\n|\r/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again
        // as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (q > p) value = appendSegment(value, p, q);
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote in the value; the field goes on.
        value += '"';
        p = q + 2;
        continue;
      }
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      fVal = value;
      fEnded = ENDED_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fVal = value;
      fEnded = ENDED_COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fVal = value;
      fEnded = ENDED_LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fVal = value;
      fEnded = ENDED_LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fVal);
    } while (fEnded === ENDED_COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
