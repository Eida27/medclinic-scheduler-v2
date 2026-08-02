import "server-only";
import PDFDocument from "pdfkit";
import type { HistoricalCompliancePdfModel } from "@/lib/historical-compliance-pdf";

const NAVY = "#102A43";
const GOLD = "#D4A72C";
const INK = "#1F2933";
const MUTED = "#52616B";
const PALE = "#F3F6F8";
const WHITE = "#FFFFFF";
const PAGE = { width: 792, height: 612, left: 34, right: 34, top: 34, footerTop: 575 };

type PdfDocument = InstanceType<typeof PDFDocument>;

function pageWidth() {
  return PAGE.width - PAGE.left - PAGE.right;
}

function sectionTitle(doc: PdfDocument, title: string, subtitle?: string) {
  doc.x = PAGE.left;
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(title);
  if (subtitle) {
    doc.moveDown(0.15).fillColor(MUTED).font("Helvetica").fontSize(7.5).text(subtitle);
  }
  doc.moveDown(0.5);
}

function addPage(doc: PdfDocument) {
  doc.addPage({ size: "LETTER", layout: "landscape", margins: {
    top: PAGE.top, right: PAGE.right, bottom: 38, left: PAGE.left,
  } });
}

function ensureSpace(doc: PdfDocument, height: number, continuation?: () => void) {
  if (doc.y + height <= PAGE.footerTop - 8) return;
  addPage(doc);
  continuation?.();
}

function drawHeader(doc: PdfDocument, model: HistoricalCompliancePdfModel) {
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(17)
    .text(model.provenance, PAGE.left, PAGE.top, { width: pageWidth() });
  doc.fillColor(GOLD).fontSize(11).text(model.title, { width: pageWidth() });
  doc.moveTo(PAGE.left, doc.y + 5).lineTo(PAGE.width - PAGE.right, doc.y + 5)
    .lineWidth(2).strokeColor(GOLD).stroke();
  doc.moveDown(0.9);
}

function drawReportContext(doc: PdfDocument, model: HistoricalCompliancePdfModel) {
  const y = doc.y;
  const columnWidth = pageWidth() / 3;
  const contexts = [
    ["Academic year", model.academicYear.label, `Closing: ${model.academicYear.closingDate}`],
    ["Year state", model.academicYear.state, "Compliance is classified using this state"],
    ["Generated", model.generated.at, `By ${model.generated.by}`],
  ];
  contexts.forEach(([label, value, note], index) => {
    const x = PAGE.left + index * columnWidth;
    doc.fillColor(PALE).roundedRect(x, y, columnWidth - 8, 48, 4).fill();
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.5)
      .text(label.toUpperCase(), x + 8, y + 7, { width: columnWidth - 24 });
    doc.fillColor(NAVY).fontSize(10).text(value, x + 8, y + 18, {
      width: columnWidth - 24, ellipsis: true,
    });
    doc.fillColor(MUTED).font("Helvetica").fontSize(6.5).text(note, x + 8, y + 33, {
      width: columnWidth - 24, ellipsis: true,
    });
  });
  doc.y = y + 58;
}

function drawFilters(doc: PdfDocument, model: HistoricalCompliancePdfModel) {
  sectionTitle(doc, "Applied filters", "The same normalized filters and sort used for the on-screen report.");
  const gap = 6;
  const columns = 3;
  const width = (pageWidth() - gap * (columns - 1)) / columns;
  const startY = doc.y;
  model.appliedFilters.forEach((filter, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = PAGE.left + column * (width + gap);
    const y = startY + row * 22;
    doc.fillColor(PALE).rect(x, y, width, 18).fill();
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.3)
      .text(`${filter.label}:`, x + 5, y + 5, { width: 66, lineBreak: false });
    doc.fillColor(INK).font("Helvetica").text(filter.value, x + 73, y + 5, {
      width: width - 78, ellipsis: true, lineBreak: false,
    });
  });
  doc.y = startY + Math.ceil(model.appliedFilters.length / columns) * 22 + 6;
}

function drawSummary(doc: PdfDocument, model: HistoricalCompliancePdfModel) {
  sectionTitle(doc, "Executive summary");
  const primary = [
    ["Total students", model.summary.totalStudents.toLocaleString()],
    ["Fully complied", model.summary.fullyComplied.toLocaleString()],
    [model.academicYear.state === "Closed" ? "Did not comply" : "Pending compliance",
      (model.academicYear.state === "Closed" ? model.summary.didNotComply : model.summary.pendingCompliance).toLocaleString()],
    ["Compliance rate", `${model.summary.complianceRate}%`],
  ];
  const width = (pageWidth() - 18) / 4;
  const y = doc.y;
  primary.forEach(([label, value], index) => {
    const x = PAGE.left + index * (width + 6);
    doc.fillColor(index === 1 ? "#E8F5EE" : PALE).roundedRect(x, y, width, 40, 4).fill();
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(14).text(value, x + 8, y + 7, {
      width: width - 16, align: "center",
    });
    doc.fillColor(MUTED).fontSize(6.5).text(label.toUpperCase(), x + 8, y + 25, {
      width: width - 16, align: "center",
    });
  });
  const secondary = [
    `Laboratory incomplete: ${model.summary.laboratoryIncomplete}`,
    `Physical Examination incomplete: ${model.summary.physicalExamIncomplete}`,
    `Both incomplete: ${model.summary.bothIncomplete}`,
    `Migrated/incomplete history: ${model.summary.migratedIncomplete}`,
  ];
  doc.fillColor(MUTED).font("Helvetica").fontSize(7)
    .text(secondary.join("   |   "), PAGE.left, y + 47, { width: pageWidth(), align: "center" });
  doc.y = y + 66;
}

const breakdownColumns = [
  { label: "Level", width: 62, align: "left" as const },
  { label: "Academic group", width: 382, align: "left" as const },
  { label: "Total", width: 60, align: "right" as const },
  { label: "Complied", width: 70, align: "right" as const },
  { label: "Attention", width: 70, align: "right" as const },
  { label: "Rate", width: 80, align: "right" as const },
];

function drawTableHeader(doc: PdfDocument, columns: typeof breakdownColumns, y: number) {
  doc.fillColor(NAVY).rect(PAGE.left, y, pageWidth(), 19).fill();
  let x = PAGE.left;
  for (const column of columns) {
    doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(6.5).text(column.label, x + 4, y + 6, {
      width: column.width - 8,
      align: column.align,
      lineBreak: false,
    });
    x += column.width;
  }
  doc.y = y + 19;
}

function drawBreakdowns(doc: PdfDocument, model: HistoricalCompliancePdfModel) {
  ensureSpace(doc, 90);
  sectionTitle(doc, "Academic breakdowns", "College, program, and year-level figures reconcile with the filtered details.");
  const continuation = () => {
    sectionTitle(doc, "Academic breakdowns (continued)");
    drawTableHeader(doc, breakdownColumns, doc.y);
  };
  drawTableHeader(doc, breakdownColumns, doc.y);
  model.breakdowns.forEach((row, index) => {
    ensureSpace(doc, 20, continuation);
    const y = doc.y;
    if (index % 2 === 0) doc.fillColor(PALE).rect(PAGE.left, y, pageWidth(), 18).fill();
    const values = [row.level, row.group, row.totalStudents.toLocaleString(), row.fullyComplied.toLocaleString(), row.attentionStudents.toLocaleString(), `${row.complianceRate}%`];
    let x = PAGE.left;
    breakdownColumns.forEach((column, columnIndex) => {
      doc.fillColor(INK).font("Helvetica").fontSize(6.5).text(values[columnIndex], x + 4, y + 5, {
        width: column.width - 8,
        align: column.align,
        ellipsis: true,
        lineBreak: false,
      });
      x += column.width;
    });
    doc.y = y + 18;
  });
  doc.moveDown(0.8);
}

const detailColumns = [
  { key: "student", label: "Student", width: 104 },
  { key: "college", label: "College", width: 87 },
  { key: "program", label: "Program", width: 111 },
  { key: "yearLevel", label: "Year", width: 34 },
  { key: "laboratory", label: "Laboratory", width: 82 },
  { key: "physicalExam", label: "Physical Examination", width: 82 },
  { key: "overall", label: "Overall", width: 104 },
  { key: "dataQuality", label: "Data Quality", width: 120 },
] as const;

function drawDetailHeading(doc: PdfDocument, continued: boolean) {
  sectionTitle(doc, continued ? "Detailed records (continued)" : "Detailed records", continued
    ? "Table headers repeat on every continuation page."
    : "Every matching historical record is included; this export is not limited to the visible report page.");
  const y = doc.y;
  doc.fillColor(NAVY).rect(PAGE.left, y, pageWidth(), 22).fill();
  let x = PAGE.left;
  for (const column of detailColumns) {
    doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(6.1).text(column.label, x + 3, y + 6, {
      width: column.width - 6,
      align: column.key === "yearLevel" ? "center" : "left",
      lineBreak: false,
      ellipsis: true,
    });
    x += column.width;
  }
  doc.y = y + 22;
}

function detailRowHeight(doc: PdfDocument, row: HistoricalCompliancePdfModel["details"][number]) {
  doc.font("Helvetica").fontSize(5.8);
  return Math.max(27, ...detailColumns.map((column) => (
    doc.heightOfString(row[column.key], { width: column.width - 6, lineGap: 0.5 }) + 8
  )));
}

function drawDetails(doc: PdfDocument, model: HistoricalCompliancePdfModel) {
  addPage(doc);
  drawDetailHeading(doc, false);
  model.details.forEach((row, index) => {
    let height = detailRowHeight(doc, row);
    if (doc.y + height > PAGE.footerTop - 8) {
      addPage(doc);
      drawDetailHeading(doc, true);
      height = detailRowHeight(doc, row);
    }
    const y = doc.y;
    if (index % 2 === 0) doc.fillColor(PALE).rect(PAGE.left, y, pageWidth(), height).fill();
    let x = PAGE.left;
    for (const column of detailColumns) {
      doc.fillColor(INK).font("Helvetica").fontSize(5.8).text(row[column.key], x + 3, y + 4, {
        width: column.width - 6,
        height: height - 8,
        lineGap: 0.5,
        ellipsis: true,
        align: column.key === "yearLevel" ? "center" : "left",
      });
      x += column.width;
    }
    doc.strokeColor("#D8E0E5").lineWidth(0.4)
      .moveTo(PAGE.left, y + height).lineTo(PAGE.width - PAGE.right, y + height).stroke();
    doc.y = y + height;
  });
}

function drawFooters(doc: PdfDocument, academicYearLabel: string) {
  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(pages.start + index);
    const footer = `Academic Year ${academicYearLabel} | Page ${index + 1} of ${pages.count}`;
    doc.strokeColor("#D8E0E5").lineWidth(0.5)
      .moveTo(PAGE.left, PAGE.footerTop).lineTo(PAGE.width - PAGE.right, PAGE.footerTop).stroke();
    // Footer text intentionally lives inside the reserved bottom margin. Temporarily
    // disabling that margin prevents PDFKit from treating the footer as overflow and
    // recursively creating footer-only pages while buffered pages are being numbered.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    try {
      doc.fillColor(MUTED).font("Helvetica").fontSize(7).text(
        footer,
        PAGE.left,
        PAGE.footerTop + 8,
        { width: pageWidth(), align: "center", lineBreak: false },
      );
    } finally {
      doc.page.margins.bottom = bottomMargin;
    }
  }
}

export function renderHistoricalCompliancePdf(
  model: HistoricalCompliancePdfModel,
  options: { compress?: boolean } = {},
) {
  const doc = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margins: { top: PAGE.top, right: PAGE.right, bottom: 38, left: PAGE.left },
    bufferPages: true,
    compress: options.compress ?? true,
    autoFirstPage: true,
    info: {
      Title: `${model.provenance} - ${model.title} - ${model.academicYear.label}`,
      Author: model.generated.by,
      Subject: `Historical compliance report for academic year ${model.academicYear.label}`,
      Creator: "CPU MedClinic Scheduler",
      CreationDate: new Date(model.generated.iso),
    },
  });

  drawHeader(doc, model);
  drawReportContext(doc, model);
  drawFilters(doc, model);
  drawSummary(doc, model);
  drawBreakdowns(doc, model);
  drawDetails(doc, model);
  drawFooters(doc, model.academicYear.label);
  doc.end();
  return doc;
}
