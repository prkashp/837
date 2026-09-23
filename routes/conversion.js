/**
 * routes/conversion.js
 * ---------------------------------------------------------------------------
 * Express endpoints for bi-directional conversion.
 *
 *   POST /api/convert/csv-to-837
 *     multipart/form-data: file=<.csv>, claimType=<professional|institutional|dental>
 *     -> returns the generated .edi as a downloadable attachment, with a
 *        JSON sidecar of validation issues in the `X-Conversion-Summary` header.
 *
 *   POST /api/convert/837-to-csv
 *     multipart/form-data: file=<.edi|.txt|.837>
 *     -> returns the generated .csv as a downloadable attachment. claimType is
 *        auto-detected from the file's GS08/ST03 version code.
 *
 * Files are parsed entirely IN MEMORY (multer memoryStorage) — nothing touches
 * disk, which matters for PHI. A 25 MB per-file limit guards the server while
 * still allowing large claim batches.
 * ---------------------------------------------------------------------------
 */

'use strict';

const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const csvParser = require('csv-parser');
const { Parser: Json2csvParser } = require('json2csv');

const converter = require('../services/edi837Converter');
const { getSchema } = require('../services/schemas');

const router = express.Router();

// In-memory upload handling with a generous size limit for batch files.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

/**
 * Parse a CSV buffer into an array of row objects using csv-parser (streamed
 * from an in-memory buffer). Header row drives the keys.
 */
function parseCsvBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    Readable.from(buffer)
      .pipe(
        csvParser({
          // Trim whitespace + strip BOM from header names.
          mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim(),
          mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value),
        })
      )
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// CSV  ->  837
// ---------------------------------------------------------------------------
router.post('/csv-to-837', upload.single('file'), async (req, res, next) => {
  try {
    const claimType = req.body.claimType || req.query.claimType;
    const schema = getSchema(claimType); // throws -> 400 via handler below

    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded (field name "file").' });
    }

    const rows = await parseCsvBuffer(req.file.buffer);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV is empty or has no data rows.' });
    }

    // strict=false lets the client request a "best-effort" build with warnings.
    const strict = String(req.body.strict ?? 'true') !== 'false';

    const result = converter.convertCsvTo837(rows, schema.key, { strict });

    // Surface the summary + issues in a header so the UI can render a checklist
    // without a second request, while still streaming the file as the body.
    res.setHeader(
      'X-Conversion-Summary',
      Buffer.from(JSON.stringify({ summary: result.summary, issues: result.issues })).toString('base64')
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Conversion-Summary');

    const filename = `claim_${schema.key}_${Date.now()}.edi`;
    res.setHeader('Content-Type', 'application/edi-x12');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(result.edi);
  } catch (err) {
    // Validation failures carry structured issues; return them as JSON 422.
    if (err.statusCode === 422 && err.issues) {
      return res.status(422).json({ error: err.message, issues: err.issues });
    }
    if (/Unknown claimType|claimType is required/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// 837  ->  CSV
// ---------------------------------------------------------------------------
router.post('/837-to-csv', upload.single('file'), async (req, res, next) => {
  try {
    let ediString;
    if (req.file) {
      ediString = req.file.buffer.toString('utf8');
    } else if (req.body.edi) {
      // Allow raw EDI text posted in a JSON/form field as a convenience.
      ediString = req.body.edi;
    } else {
      return res.status(400).json({ error: 'No 837 file uploaded (field name "file").' });
    }

    const result = converter.convert837ToCsv(ediString);
    if (result.rows.length === 0) {
      return res.status(422).json({ error: 'No claims/service lines could be parsed from the 837.' });
    }

    // Emit CSV using the canonical column order so round-trips are stable.
    const parser = new Json2csvParser({ fields: converter.COLUMNS });
    const csv = parser.parse(result.rows);

    res.setHeader(
      'X-Conversion-Summary',
      Buffer.from(JSON.stringify({ summary: result.summary })).toString('base64')
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Conversion-Summary');

    const filename = `claim_${result.claimType}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    if (/detect claim type|valid X12|ISA|delimiters/.test(err.message)) {
      return res.status(422).json({ error: err.message });
    }
    return next(err);
  }
});

module.exports = router;
