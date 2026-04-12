// ============================================================================
// WMS GLOBAL EXPORT ENGINE
// ============================================================================
// Shared Excel + PDF export infrastructure.  Every module calls these two
// functions with a declarative config — formatting, print-setup, page-breaks
// and styling are handled centrally so the look is identical across the app.
//
// Dependencies:
//   - ExcelJS  (loaded via CDN in app.html)
//   - jsPDF    (loaded via CDN in app.html — used only by wmsExportPdf)
//   - utils.js (getDisplayUnit, getUnitConfig, formatWithCommas)
//
// Namespace: all public symbols start with "wmsExport" or "WMS_EXPORT_".
// ============================================================================

// ============================================================================
// 1. COLUMN TYPE PRESETS
// ============================================================================
// Each preset defines: excelFmt (Excel number-format string), align, width,
// and jsFmt (a JS function that returns a display string for PDF rendering).
//
// Module column definitions look like:
//   { header:'Date', type:'date' }                       → uses preset as-is
//   { header:'Date', type:'date', format:'ddd, dd-mmm' } → overrides excelFmt
//   { header:'Amount', type:'amount', width:14 }         → overrides width
// Any property in the column def wins over the preset default.
// ============================================================================

var WMS_EXPORT_PRESETS = {
    date: {
        excelFmt: 'dd-mmm-yy',
        align: 'right',
        width: 12,
        jsFmt: function(v) {
            if (!v) return '';
            var d = (v instanceof Date) ? v : new Date(v);
            if (isNaN(d.getTime())) return String(v);
            var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            var dd = String(d.getDate()).padStart(2, '0');
            return dd + '-' + months[d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
        }
    },
    text: {
        excelFmt: '@',
        align: 'left',
        width: 15,
        jsFmt: function(v) { return (v === null || v === undefined) ? '' : String(v); }
    },
    qty: {
        excelFmt: '#,##0;(#,##0);"-"',
        align: 'right',
        width: 9,
        jsFmt: function(v) {
            if (v === 0 || v === null || v === undefined || isNaN(v)) return '-';
            var abs = Math.abs(Math.round(v));
            var s = abs.toLocaleString('en-US');
            return v < 0 ? '(' + s + ')' : s;
        }
    },
    price: {
        excelFmt: '#,##0.00;(#,##0.00);"-"',
        align: 'right',
        width: 10,
        jsFmt: function(v) {
            if (v === 0 || v === null || v === undefined || isNaN(v)) return '-';
            var abs = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            return v < 0 ? '(' + abs + ')' : abs;
        }
    },
    amount: {
        excelFmt: '#,##0;(#,##0);"-"',
        align: 'right',
        width: 12,
        jsFmt: function(v) {
            if (v === 0 || v === null || v === undefined || isNaN(v)) return '-';
            var abs = Math.abs(Math.round(v)).toLocaleString('en-US');
            return v < 0 ? '(' + abs + ')' : abs;
        }
    },
    amount2: {
        excelFmt: '#,##0.00;(#,##0.00);"-"',
        align: 'right',
        width: 12,
        jsFmt: function(v) {
            if (v === 0 || v === null || v === undefined || isNaN(v)) return '-';
            var abs = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            return v < 0 ? '(' + abs + ')' : abs;
        }
    },
    pct: {
        excelFmt: '0.00%;(0.00%);"-"',
        align: 'right',
        width: 8,
        jsFmt: function(v) {
            if (v === 0 || v === null || v === undefined || isNaN(v)) return '-';
            var abs = (Math.abs(v) * 100).toFixed(2) + '%';
            return v < 0 ? '(' + abs + ')' : abs;
        }
    },
    type: {
        excelFmt: '@',
        align: 'center',
        width: 6,
        jsFmt: function(v) { return (v === null || v === undefined) ? '' : String(v); }
    }
};

// ============================================================================
// 2. STYLING CONSTANTS
// ============================================================================

var WMS_EXPORT_FONT = 'Arial Narrow';
var WMS_EXPORT_FONT_SIZE = 10;
var WMS_EXPORT_HEADER_FILL = 'F7FAFC';
var WMS_EXPORT_TOTAL_FILL  = 'F0F4F8';
var WMS_EXPORT_SECTION_FILL = 'EEF2FF';
var WMS_EXPORT_RED = 'DC2626';
var WMS_EXPORT_BLUE = '0000FF';   // Hardcoded input values — industry standard
var WMS_EXPORT_BLACK = '2D3748';
var WMS_EXPORT_GREY = '718096';
var WMS_EXPORT_BORDER_COLOR = 'E2E8F0';
var WMS_EXPORT_BORDER_DARK  = '9CA3AF';

// Thin border style for reuse
var _wmsExBorderThin = { style: 'thin', color: { argb: WMS_EXPORT_BORDER_COLOR } };
var _wmsExBorderMed  = { style: 'medium', color: { argb: WMS_EXPORT_BORDER_DARK } };

// ============================================================================
// 3. HELPER — resolve column definition (merge preset + overrides)
// ============================================================================

function _wmsExResolveCol(colDef) {
    var preset = WMS_EXPORT_PRESETS[colDef.type] || WMS_EXPORT_PRESETS.text;
    return {
        header:   colDef.header || '',
        excelFmt: colDef.format   || colDef.excelFmt || preset.excelFmt,
        align:    colDef.align    || preset.align,
        width:    colDef.width    || preset.width,
        jsFmt:    colDef.jsFmt    || preset.jsFmt,
        type:     colDef.type     || 'text',
        bold:     colDef.bold     || false
    };
}

// ============================================================================
// 4. HELPER — apply cell styling
// ============================================================================

function _wmsExStyleCell(cell, resolved, isHeader, isTotal, isSectionTitle) {
    // Font
    var font = {
        name: WMS_EXPORT_FONT,
        size: WMS_EXPORT_FONT_SIZE,
        color: { argb: WMS_EXPORT_BLACK }
    };
    if (isHeader || isTotal || isSectionTitle || resolved.bold) font.bold = true;

    // Determine if this is a formula cell (ExcelJS stores formula as cell.value.formula)
    var isFormula = (cell.value !== null && typeof cell.value === 'object' && cell.value.formula);

    // Data cells: blue text for hardcoded inputs, black for formulas.
    // Negative values → red (overrides blue/black).
    if (!isHeader && !isSectionTitle && !isTotal) {
        var numVal;
        if (isFormula) {
            numVal = (typeof cell.value.result === 'number') ? cell.value.result : NaN;
        } else {
            numVal = (typeof cell.value === 'number') ? cell.value : NaN;
        }

        if (!isNaN(numVal) && numVal < 0) {
            font.color = { argb: WMS_EXPORT_RED };
        } else if (!isFormula && cell.value !== null && cell.value !== undefined && cell.value !== '') {
            // Hardcoded input value → blue text (industry standard)
            font.color = { argb: WMS_EXPORT_BLUE };
        }
    }
    cell.font = font;

    // Alignment
    cell.alignment = {
        horizontal: isHeader ? resolved.align : resolved.align,
        vertical: 'middle',
        wrapText: false
    };

    // Number format (skip for headers / section titles)
    if (!isHeader && !isSectionTitle && resolved.excelFmt !== '@') {
        cell.numFmt = resolved.excelFmt;
    }

    // Fill
    if (isHeader) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WMS_EXPORT_HEADER_FILL } };
    } else if (isTotal) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WMS_EXPORT_TOTAL_FILL } };
    } else if (isSectionTitle) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WMS_EXPORT_SECTION_FILL } };
    }

    // Borders
    if (isHeader) {
        cell.border = { bottom: _wmsExBorderMed };
    } else if (isTotal) {
        cell.border = { top: _wmsExBorderMed, bottom: _wmsExBorderMed };
    } else {
        cell.border = { bottom: _wmsExBorderThin };
    }
}

// ============================================================================
// 4b. HELPER — set cell value (handles plain values, formulas, dates)
// ============================================================================
// A value can be:
//   - A plain scalar (string, number, null)
//   - A Date object
//   - A formula object: { formula: 'SUM(A1:A10)', result: 123 }
//     ExcelJS stores the formula string and the cached result so the file
//     opens correctly in Excel without requiring a manual recalc.
// ============================================================================

function _wmsExSetCellValue(cell, val, colType) {
    if (val === undefined) val = null;
    if (val !== null && typeof val === 'object' && val.formula) {
        // Formula object — ExcelJS uses { formula, result } directly on cell.value
        cell.value = { formula: val.formula, result: val.result };
        return;
    }
    // Dates: convert string → JS Date for Excel
    if (colType === 'date' && val && !(val instanceof Date)) {
        var parsed = new Date(val);
        if (!isNaN(parsed.getTime())) { cell.value = parsed; return; }
    }
    cell.value = val;
}

// ============================================================================
// 4c. HELPER — Excel column letter from 0-based index (0→A, 1→B, 25→Z, 26→AA)
// ============================================================================

function wmsExColLetter(idx) {
    var s = '';
    var n = idx;
    while (n >= 0) {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
    }
    return s;
}

// ============================================================================
// 5. wmsExportExcel(config)
// ============================================================================
//
// config = {
//   filename: 'Statement_T3_FY26.xlsx',
//   sheets: [{
//     name: 'T3',
//     columns: [{ header, type, format?, width?, align? }, ...],
//     sections: [
//       { type: 'header' }                              — writes column headers
//       { type: 'data', rows: [[val, val, ...], ...] }  — data rows
//       { type: 'total', values: [null, null, ..., 123] } — total row
//       { type: 'title', text: 'Open Positions' }       — section title row
//       { type: 'blank' }                               — empty row
//       { type: 'pageBreak' }                           — insert page break
//       { type: 'summary', rows: [[label, val], ...] }  — label-value pairs
//       { type: 'columns', columns: [...] }             — switch column defs
//     ],
//     printSetup: { orientation, paperSize, margins, fitToPage }
//   }]
// }
//
// Returns: triggers browser download of the .xlsx file.
// ============================================================================

function wmsExportExcel(config) {
    if (typeof ExcelJS === 'undefined') {
        if (typeof showAlert === 'function') showAlert('ExcelJS library not loaded', 'error', 3000);
        console.error('wmsExportExcel: ExcelJS not available');
        return;
    }

    var wb = new ExcelJS.Workbook();
    wb.creator = 'WMS';
    wb.created = new Date();

    for (var si = 0; si < config.sheets.length; si++) {
        var sheetCfg = config.sheets[si];
        var ws = wb.addWorksheet(sheetCfg.name || ('Sheet' + (si + 1)));

        // Track current active columns (can change mid-sheet via 'columns' section)
        var activeCols = (sheetCfg.columns || []).map(_wmsExResolveCol);
        var colCount = activeCols.length;

        // Set initial column widths
        _wmsExApplyColWidths(ws, activeCols);

        var curRow = 1;

        for (var secIdx = 0; secIdx < sheetCfg.sections.length; secIdx++) {
            var sec = sheetCfg.sections[secIdx];

            switch (sec.type) {

                case 'header':
                    var headerRow = ws.getRow(curRow);
                    for (var ci = 0; ci < activeCols.length; ci++) {
                        var hCell = headerRow.getCell(ci + 1);
                        hCell.value = activeCols[ci].header;
                        _wmsExStyleCell(hCell, activeCols[ci], true, false, false);
                    }
                    headerRow.height = 18;
                    curRow++;
                    break;

                case 'data':
                    var dataRows = sec.rows || [];
                    for (var ri = 0; ri < dataRows.length; ri++) {
                        var row = dataRows[ri];
                        var xlRow = ws.getRow(curRow);
                        var rowBold = (row._bold === true);
                        var rowFill = row._fill || null;
                        for (var ci2 = 0; ci2 < activeCols.length; ci2++) {
                            var dCell = xlRow.getCell(ci2 + 1);
                            _wmsExSetCellValue(dCell, row[ci2], activeCols[ci2].type);

                            var resolvedForRow = activeCols[ci2];
                            if (rowBold) {
                                resolvedForRow = Object.assign({}, resolvedForRow, { bold: true });
                            }
                            _wmsExStyleCell(dCell, resolvedForRow, false, false, false);
                            // For formulas, red-coloring must use the cached result
                            if (row[ci2] && typeof row[ci2] === 'object' && row[ci2].formula) {
                                var fResult = row[ci2].result;
                                if (typeof fResult === 'number' && fResult < 0) {
                                    dCell.font = Object.assign({}, dCell.font, { color: { argb: WMS_EXPORT_RED } });
                                }
                            }
                            if (rowFill) {
                                dCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowFill } };
                            }
                        }
                        curRow++;
                    }
                    break;

                case 'total':
                    var totRow = ws.getRow(curRow);
                    var totVals = sec.values || [];
                    for (var ti = 0; ti < activeCols.length; ti++) {
                        var tCell = totRow.getCell(ti + 1);
                        _wmsExSetCellValue(tCell, totVals[ti], activeCols[ti].type);
                        _wmsExStyleCell(tCell, activeCols[ti], false, true, false);
                        if (totVals[ti] && typeof totVals[ti] === 'object' && totVals[ti].formula) {
                            var tResult = totVals[ti].result;
                            if (typeof tResult === 'number' && tResult < 0) {
                                tCell.font = Object.assign({}, tCell.font, { color: { argb: WMS_EXPORT_RED } });
                            }
                        }
                    }
                    curRow++;
                    break;

                case 'title':
                    var titleRow = ws.getRow(curRow);
                    // Apply section title fill across all columns (no merge — keeps navigation easy)
                    var titleCell = titleRow.getCell(1);
                    titleCell.value = sec.text || '';
                    _wmsExStyleCell(titleCell, { align: 'left', bold: true, excelFmt: '@' }, false, false, true);
                    for (var tci = 1; tci < colCount; tci++) {
                        var emptyCell = titleRow.getCell(tci + 1);
                        emptyCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WMS_EXPORT_SECTION_FILL } };
                    }
                    titleRow.height = 20;
                    curRow++;
                    break;

                case 'blank':
                    var blankCount = sec.count || 1;
                    curRow += blankCount;
                    break;

                case 'pageBreak':
                    // Insert horizontal page break BEFORE current row
                    // ExcelJS uses addHorizontalPageBreak or we set it via row properties
                    // The break goes after the previous row (i.e. before curRow)
                    if (curRow > 1) {
                        ws.getRow(curRow - 1).addPageBreak();
                    }
                    break;

                case 'summary':
                    // Label-value pairs, label in first column, value in last column
                    // Each row: { label, value, format?, bold? }
                    var sumRows = sec.rows || [];
                    for (var sri = 0; sri < sumRows.length; sri++) {
                        var sr = sumRows[sri];
                        var sRow = ws.getRow(curRow);

                        // Label in column 1
                        var labelCell = sRow.getCell(1);
                        labelCell.value = sr.label || '';
                        var labelResolved = { align: 'left', excelFmt: '@', bold: sr.bold || false };
                        _wmsExStyleCell(labelCell, labelResolved, false, false, false);

                        // Value in last column (or specified column)
                        var valColIdx = sr.valueCol || colCount;
                        var valCell = sRow.getCell(valColIdx);
                        _wmsExSetCellValue(valCell, sr.value, null);
                        var valFmt = sr.format || (typeof sr.value === 'number' ? 'amount' : 'text');
                        var valPreset = WMS_EXPORT_PRESETS[valFmt] || WMS_EXPORT_PRESETS.text;
                        var valResolved = {
                            align: valPreset.align,
                            excelFmt: sr.excelFormat || valPreset.excelFmt,
                            bold: sr.bold || false
                        };
                        _wmsExStyleCell(valCell, valResolved, false, false, false);

                        // Optional: extra value in a different column
                        if (sr.extraCol && sr.extraValue !== undefined) {
                            var eCell = sRow.getCell(sr.extraCol);
                            _wmsExSetCellValue(eCell, sr.extraValue, null);
                            var eFmt = sr.extraFormat || 'amount';
                            var ePreset = WMS_EXPORT_PRESETS[eFmt] || WMS_EXPORT_PRESETS.text;
                            _wmsExStyleCell(eCell, { align: ePreset.align, excelFmt: ePreset.excelFmt, bold: sr.bold || false }, false, false, false);
                        }

                        // labelSpan is ignored — no column merging (makes navigation hard).
                        // The label simply sits in column 1 and the value in the last column.

                        curRow++;
                    }
                    break;

                case 'columns':
                    // Switch active column definitions mid-sheet
                    activeCols = (sec.columns || []).map(_wmsExResolveCol);
                    colCount = activeCols.length;
                    _wmsExApplyColWidths(ws, activeCols);
                    break;

                default:
                    console.warn('wmsExportExcel: unknown section type "' + sec.type + '"');
                    break;
            }
        }

        // ── Print Setup ────────────────────────────────────────────
        var ps = sheetCfg.printSetup || {};
        ws.pageSetup = {
            orientation: ps.orientation || 'portrait',
            paperSize: ps.paperSize || 9,    // 9 = A4
            fitToPage: ps.fitToPage !== undefined ? ps.fitToPage : true,
            fitToWidth: ps.fitToWidth || 1,
            fitToHeight: ps.fitToHeight || 0, // 0 = as many pages as needed
            horizontalCentered: true
        };

        var margins = ps.margins || {};
        ws.pageSetup.margins = {
            left:   margins.left   || 0.25,
            right:  margins.right  || 0.25,
            top:    margins.top    || 0.75,
            bottom: margins.bottom || 0.75,
            header: margins.header || 0.3,
            footer: margins.footer || 0.3
        };

        // Freeze top row (header) if requested
        if (sheetCfg.freezeRow) {
            ws.views = [{ state: 'frozen', ySplit: sheetCfg.freezeRow }];
        }

        // Print area
        if (sheetCfg.printArea) {
            ws.pageSetup.printArea = sheetCfg.printArea;
        }
    }

    // ── Generate & Download ────────────────────────────────────
    var filename = config.filename || 'WMS_Export.xlsx';
    wb.xlsx.writeBuffer().then(function(buffer) {
        var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
        if (typeof showAlert === 'function') showAlert('Exported ' + filename, 'success', 2000);
    }).catch(function(err) {
        console.error('wmsExportExcel failed:', err);
        if (typeof showAlert === 'function') showAlert('Export failed: ' + err.message, 'error', 3000);
    });
}

// Helper: set column widths on worksheet from resolved column defs
function _wmsExApplyColWidths(ws, resolvedCols) {
    for (var i = 0; i < resolvedCols.length; i++) {
        ws.getColumn(i + 1).width = resolvedCols[i].width;
    }
}

// ============================================================================
// 6. wmsExportPdf(config)
// ============================================================================
//
// Canvas-based PDF generator.  Draws tables directly onto <canvas> elements,
// then packs each page-canvas into a jsPDF document.  This gives pixel-perfect
// control (no html2canvas, no DOM dependencies, works with any data shape).
//
// config = {
//   filename: 'Statement_T3_FY26.pdf',
//   title: 'Statement — T3 — FY 2025-26',
//   pages: [{
//     columns: [{ header, type, width(px), format?, align? }, ...],
//     sections: [
//       { type:'header' },
//       { type:'data', rows:[[...], ...] },
//       { type:'total', values:[...] },
//       { type:'title', text:'...' },
//       { type:'blank' },
//       { type:'summary', rows:[{ label, value, format? }, ...] }
//     ]
//   }]
// }
// ============================================================================

var WMS_PDF_FONT_FAMILY = 'Arial Narrow, Arial, Helvetica, sans-serif';
var WMS_PDF_FONT_SIZE   = 9;
var WMS_PDF_HEADER_SIZE = 9;
var WMS_PDF_TITLE_SIZE  = 11;
var WMS_PDF_ROW_HEIGHT  = 18;
var WMS_PDF_HEADER_H    = 22;
var WMS_PDF_TITLE_H     = 24;
var WMS_PDF_PAD         = 5;

function wmsExportPdf(config) {
    if (typeof jspdf === 'undefined' && typeof jsPDF === 'undefined' && typeof window.jspdf === 'undefined') {
        if (typeof showAlert === 'function') showAlert('jsPDF library not loaded', 'error', 3000);
        console.error('wmsExportPdf: jsPDF not available');
        return;
    }

    var JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    var dpr = 2; // device pixel ratio for sharp rendering
    // A4 dimensions in mm → pixels at 72 DPI
    var pageWmm = 210, pageHmm = 297;
    var pxPerMm = 3.7795; // approximate
    var marginMm = 10;
    var contentWpx = (pageWmm - 2 * marginMm) * pxPerMm * dpr;
    var contentHpx = (pageHmm - 2 * marginMm) * pxPerMm * dpr;
    var canvases = [];

    for (var pi = 0; pi < config.pages.length; pi++) {
        var page = config.pages[pi];
        var cols = (page.columns || []).map(_wmsExResolveCol);

        // Calculate total column width and scale factor
        var totalColW = 0;
        for (var ci = 0; ci < cols.length; ci++) totalColW += (cols[ci].width || 10) * 8; // approximate ch → px
        var scale = contentWpx / totalColW;
        if (scale > dpr) scale = dpr; // don't upscale beyond dpr

        // First pass: calculate total height needed
        var totalH = 0;
        if (config.title && pi === 0) totalH += WMS_PDF_TITLE_H * dpr;
        for (var si2 = 0; si2 < page.sections.length; si2++) {
            var s = page.sections[si2];
            switch (s.type) {
                case 'header': totalH += WMS_PDF_HEADER_H * dpr; break;
                case 'data':   totalH += (s.rows || []).length * WMS_PDF_ROW_HEIGHT * dpr; break;
                case 'total':  totalH += WMS_PDF_ROW_HEIGHT * dpr; break;
                case 'title':  totalH += WMS_PDF_TITLE_H * dpr; break;
                case 'blank':  totalH += (s.count || 1) * WMS_PDF_ROW_HEIGHT * dpr; break;
                case 'summary': totalH += (s.rows || []).length * WMS_PDF_ROW_HEIGHT * dpr; break;
            }
        }
        totalH += WMS_PDF_PAD * 2 * dpr;

        // Create canvas
        var cvs = document.createElement('canvas');
        cvs.width = Math.ceil(contentWpx);
        cvs.height = Math.ceil(Math.max(totalH, WMS_PDF_ROW_HEIGHT * dpr));
        var ctx = cvs.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cvs.width, cvs.height);

        var y = WMS_PDF_PAD * dpr;

        // Title
        if (config.title && pi === 0) {
            ctx.font = 'bold ' + (WMS_PDF_TITLE_SIZE * dpr) + 'px ' + WMS_PDF_FONT_FAMILY;
            ctx.fillStyle = '#' + WMS_EXPORT_BLACK;
            ctx.textAlign = 'left';
            ctx.fillText(config.title, WMS_PDF_PAD * dpr, y + WMS_PDF_TITLE_SIZE * dpr);
            y += WMS_PDF_TITLE_H * dpr;
        }

        // Resolve pixel widths
        var colPx = [];
        for (var cwi = 0; cwi < cols.length; cwi++) {
            colPx.push(((cols[cwi].width || 10) * 8) * scale);
        }

        // Draw sections
        for (var si3 = 0; si3 < page.sections.length; si3++) {
            var sec2 = page.sections[si3];
            switch (sec2.type) {
                case 'header':
                    y = _wmsExPdfDrawHeader(ctx, cols, colPx, y, dpr);
                    break;
                case 'data':
                    for (var dri = 0; dri < (sec2.rows || []).length; dri++) {
                        y = _wmsExPdfDrawRow(ctx, cols, colPx, sec2.rows[dri], y, dpr, false);
                    }
                    break;
                case 'total':
                    y = _wmsExPdfDrawRow(ctx, cols, colPx, sec2.values || [], y, dpr, true);
                    break;
                case 'title':
                    ctx.font = 'bold ' + (WMS_PDF_FONT_SIZE * dpr) + 'px ' + WMS_PDF_FONT_FAMILY;
                    ctx.fillStyle = '#' + WMS_EXPORT_BLACK;
                    ctx.textAlign = 'left';
                    var titleBg = '#' + WMS_EXPORT_SECTION_FILL.replace(/^#/, '');
                    ctx.fillStyle = titleBg;
                    ctx.fillRect(0, y, cvs.width, WMS_PDF_TITLE_H * dpr);
                    ctx.fillStyle = '#' + WMS_EXPORT_BLACK;
                    ctx.fillText(sec2.text || '', WMS_PDF_PAD * dpr, y + WMS_PDF_FONT_SIZE * dpr + 4 * dpr);
                    y += WMS_PDF_TITLE_H * dpr;
                    break;
                case 'blank':
                    y += (sec2.count || 1) * WMS_PDF_ROW_HEIGHT * dpr;
                    break;
                case 'summary':
                    for (var sri2 = 0; sri2 < (sec2.rows || []).length; sri2++) {
                        y = _wmsExPdfDrawSummaryRow(ctx, cols, colPx, sec2.rows[sri2], y, dpr);
                    }
                    break;
            }
        }

        canvases.push(cvs);
    }

    // Build PDF
    var doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    for (var pgi = 0; pgi < canvases.length; pgi++) {
        if (pgi > 0) doc.addPage();
        var imgData = canvases[pgi].toDataURL('image/png');
        var imgW = pageWmm - 2 * marginMm;
        var imgH = (canvases[pgi].height / canvases[pgi].width) * imgW;
        doc.addImage(imgData, 'PNG', marginMm, marginMm, imgW, imgH);
    }

    doc.save(config.filename || 'WMS_Export.pdf');
    if (typeof showAlert === 'function') showAlert('Exported ' + (config.filename || 'WMS_Export.pdf'), 'success', 2000);
}

// ── PDF drawing helpers ────────────────────────────────────────

function _wmsExPdfDrawHeader(ctx, cols, colPx, y, dpr) {
    var x = WMS_PDF_PAD * dpr;
    // Background
    ctx.fillStyle = '#' + WMS_EXPORT_HEADER_FILL;
    var totalW = 0; for (var i = 0; i < colPx.length; i++) totalW += colPx[i];
    ctx.fillRect(0, y, totalW + WMS_PDF_PAD * 2 * dpr, WMS_PDF_HEADER_H * dpr);
    // Text
    ctx.font = 'bold ' + (WMS_PDF_HEADER_SIZE * dpr) + 'px ' + WMS_PDF_FONT_FAMILY;
    ctx.fillStyle = '#' + WMS_EXPORT_BLACK;
    for (var hi = 0; hi < cols.length; hi++) {
        var hAlign = cols[hi].align || 'left';
        var hx = x;
        if (hAlign === 'right') hx = x + colPx[hi] - 4 * dpr;
        else if (hAlign === 'center') hx = x + colPx[hi] / 2;
        ctx.textAlign = hAlign;
        ctx.fillText((cols[hi].header || '').toUpperCase(), hx, y + WMS_PDF_HEADER_SIZE * dpr + 4 * dpr);
        x += colPx[hi];
    }
    // Bottom line
    ctx.strokeStyle = '#' + WMS_EXPORT_BORDER_DARK;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, y + WMS_PDF_HEADER_H * dpr);
    ctx.lineTo(totalW + WMS_PDF_PAD * 2 * dpr, y + WMS_PDF_HEADER_H * dpr);
    ctx.stroke();
    return y + WMS_PDF_HEADER_H * dpr;
}

function _wmsExPdfDrawRow(ctx, cols, colPx, rowData, y, dpr, isTotal) {
    var x = WMS_PDF_PAD * dpr;
    var totalW = 0; for (var i = 0; i < colPx.length; i++) totalW += colPx[i];

    if (isTotal) {
        ctx.fillStyle = '#' + WMS_EXPORT_TOTAL_FILL;
        ctx.fillRect(0, y, totalW + WMS_PDF_PAD * 2 * dpr, WMS_PDF_ROW_HEIGHT * dpr);
        ctx.strokeStyle = '#' + WMS_EXPORT_BORDER_DARK;
        ctx.lineWidth = dpr;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(totalW + WMS_PDF_PAD * 2 * dpr, y);
        ctx.stroke();
    }

    ctx.font = (isTotal ? 'bold ' : '') + (WMS_PDF_FONT_SIZE * dpr) + 'px ' + WMS_PDF_FONT_FAMILY;

    for (var ci = 0; ci < cols.length; ci++) {
        var val = rowData[ci];
        var resolved = cols[ci];
        var displayText = '';

        if (val !== null && val !== undefined && val !== '') {
            if (resolved.jsFmt && typeof val !== 'string') {
                displayText = resolved.jsFmt(val);
            } else {
                displayText = String(val);
            }
        }

        // Color
        var numVal = (typeof val === 'number') ? val : NaN;
        if (!isNaN(numVal) && numVal < 0) {
            ctx.fillStyle = '#' + WMS_EXPORT_RED;
        } else {
            ctx.fillStyle = '#' + WMS_EXPORT_BLACK;
        }

        var align = resolved.align || 'left';
        var cx = x;
        if (align === 'right') cx = x + colPx[ci] - 4 * dpr;
        else if (align === 'center') cx = x + colPx[ci] / 2;
        ctx.textAlign = align;
        ctx.fillText(displayText, cx, y + WMS_PDF_FONT_SIZE * dpr + 3 * dpr);
        x += colPx[ci];
    }

    // Bottom border
    ctx.strokeStyle = '#' + (isTotal ? WMS_EXPORT_BORDER_DARK : WMS_EXPORT_BORDER_COLOR);
    ctx.lineWidth = isTotal ? dpr : 0.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, y + WMS_PDF_ROW_HEIGHT * dpr);
    ctx.lineTo(totalW + WMS_PDF_PAD * 2 * dpr, y + WMS_PDF_ROW_HEIGHT * dpr);
    ctx.stroke();

    return y + WMS_PDF_ROW_HEIGHT * dpr;
}

function _wmsExPdfDrawSummaryRow(ctx, cols, colPx, sr, y, dpr) {
    var totalW = 0; for (var i = 0; i < colPx.length; i++) totalW += colPx[i];

    ctx.font = (sr.bold ? 'bold ' : '') + (WMS_PDF_FONT_SIZE * dpr) + 'px ' + WMS_PDF_FONT_FAMILY;
    ctx.fillStyle = '#' + WMS_EXPORT_BLACK;
    ctx.textAlign = 'left';
    ctx.fillText(sr.label || '', WMS_PDF_PAD * dpr, y + WMS_PDF_FONT_SIZE * dpr + 3 * dpr);

    // Value in last column area
    var valFmt = sr.format || 'amount';
    var preset = WMS_EXPORT_PRESETS[valFmt] || WMS_EXPORT_PRESETS.text;
    var displayVal = preset.jsFmt ? preset.jsFmt(sr.value) : String(sr.value);

    var numVal = (typeof sr.value === 'number') ? sr.value : NaN;
    ctx.fillStyle = (!isNaN(numVal) && numVal < 0) ? '#' + WMS_EXPORT_RED : '#' + WMS_EXPORT_BLACK;
    ctx.textAlign = 'right';
    ctx.fillText(displayVal, totalW + WMS_PDF_PAD * dpr, y + WMS_PDF_FONT_SIZE * dpr + 3 * dpr);

    return y + WMS_PDF_ROW_HEIGHT * dpr;
}

// ============================================================================
// 7. wmsExportFilename — Standardised filename builder
// ============================================================================
//
// wmsExportFilename('Statement', 'T3', 'FY26', 'xlsx')  → 'Statement_T3_FY26.xlsx'
// wmsExportFilename('FnO_Positions', null, null, 'pdf')  → 'FnO_Positions_2026-04-12.pdf'
// ============================================================================

function wmsExportFilename(module, viewName, dateLabel, ext) {
    var parts = [module || 'WMS_Export'];
    if (viewName) parts.push(viewName.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (dateLabel) {
        parts.push(dateLabel.replace(/[^a-zA-Z0-9_-]/g, '_'));
    } else {
        parts.push(new Date().toISOString().slice(0, 10));
    }
    return parts.join('_') + '.' + (ext || 'xlsx');
}

// ============================================================================
// 8. WINDOW EXPORTS
// ============================================================================

window.WMS_EXPORT_PRESETS    = WMS_EXPORT_PRESETS;
window.wmsExportExcel        = wmsExportExcel;
window.wmsExportPdf          = wmsExportPdf;
window.wmsExportFilename     = wmsExportFilename;
window.wmsExColLetter        = wmsExColLetter;
