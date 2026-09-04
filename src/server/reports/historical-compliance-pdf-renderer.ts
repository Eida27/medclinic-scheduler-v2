import "server-only";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import {
  pdfAsciiSafe,
  type HistoricalCompliancePdfModel,
} from "@/lib/historical-compliance-pdf";

const NAVY = "#102A43";
const GOLD = "#D4A72C";
const INK = "#1F2933";
const MUTED = "#52616B";
const PALE = "#F3F6F8";
const WHITE = "#FFFFFF";
const PAGE = { width: 792, height: 612, left: 34, right: 34, top: 34, footerTop: 575 };
const REGULAR_FONT = "DejaVuSans";
const BOLD_FONT = "DejaVuSansBold";
const FONT_PACKAGE_DIRECTORY = join(
  process.cwd(),
  "node_modules",
  "dejavu-fonts-ttf",
);
const REGULAR_FONT_PATH = join(
  FONT_PACKAGE_DIRECTORY,
  "ttf",
  "DejaVuSans.ttf",
);
const BOLD_FONT_PATH = join(
  FONT_PACKAGE_DIRECTORY,
  "ttf",
  "DejaVuSans-Bold.ttf",
);

type PdfDocument = InstanceType<typeof PDFDocument>;

export type HistoricalCompliancePdfDrawEvent = {
  kind:
    | "provenance"
    | "section-title"
    | "generated-by"
    | "filter-value"
    | "breakdown-group"
    | "detail-header"
    | "detail-student"
    | "footer";
  text: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type DrawObserver = (event: HistoricalCompliancePdfDrawEvent) => void;

function currentPage(doc: PdfDocument) {
  return doc.bufferedPageRange().count;
}

function drawObservedText(
  doc: PdfDocument,
  observer: DrawObserver | undefined,
  event: Omit<HistoricalCompliancePdfDrawEvent, "page"> & { page?: number },
  options: PDFKit.Mixins.TextOptions,
) {
  doc.text(event.text, event.x, event.y, options);
  observer?.({
    ...event,
    page: event.page ?? currentPage(doc),
  });
}

function pageWidth() {
  return PAGE.width - PAGE.left - PAGE.right;
}

function sectionTitle(
  doc: PdfDocument,
  title: string,
  subtitle?: string,
  observer?: DrawObserver,
) {
  doc.x = PAGE.left;
  const y = doc.y;
  doc.fillColor(NAVY).font(BOLD_FONT).fontSize(13);
  drawObservedText(doc, observer, {
    kind: "section-title",
    text: title,
    x: PAGE.left,
    y,
    width: pageWidth(),
    height: doc.heightOfString(title, { width: pageWidth() }),
  }, { width: pageWidth() });
  if (subtitle) {
    doc.moveDown(0.15).fillColor(MUTED).font(REGULAR_FONT).fontSize(7.5).text(subtitle);
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

function drawHeader(
  doc: PdfDocument,
  model: HistoricalCompliancePdfModel,
  observer?: DrawObserver,
) {
  doc.fillColor(NAVY).font(BOLD_FONT).fontSize(17);
  drawObservedText(doc, observer, {
    kind: "provenance",
    text: model.provenance,
    x: PAGE.left,
    y: PAGE.top,
    width: pageWidth(),
    height: doc.heightOfString(model.provenance, { width: pageWidth() }),
  }, { width: pageWidth() });
  doc.fillColor(GOLD).fontSize(11).text(model.title, { width: pageWidth() });
  doc.moveTo(PAGE.left, doc.y + 5).lineTo(PAGE.width - PAGE.right, doc.y + 5)
    .lineWidth(2).strokeColor(GOLD).stroke();
  doc.moveDown(0.9);
}

function drawReportContext(
  doc: PdfDocument,
  model: HistoricalCompliancePdfModel,
  observer?: DrawObserver,
) {
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
    doc.fillColor(MUTED).font(BOLD_FONT).fontSize(6.5)
      .text(label.toUpperCase(), x + 8, y + 7, { width: columnWidth - 24 });
    doc.fillColor(NAVY).fontSize(10).text(value, x + 8, y + 18, {
      width: columnWidth - 24, ellipsis: true,
    });
    doc.fillColor(MUTED).font(REGULAR_FONT).fontSize(6.5);
    if (index === 2) {
      drawObservedText(doc, observer, {
        kind: "generated-by",
        text: note,
        x: x + 8,
        y: y + 33,
        width: columnWidth - 24,
        height: 9,
      }, { width: columnWidth - 24, ellipsis: true });
    } else {
      doc.text(note, x + 8, y + 33, { width: columnWidth - 24, ellipsis: true });
    }
  });
  doc.y = y + 58;
}

function drawFilters(
  doc: PdfDocument,
  model: HistoricalCompliancePdfModel,
  observer?: DrawObserver,
) {
  sectionTitle(
    doc,
    "Applied filters",
    "The same normalized filters and sort used for the on-screen report.",
    observer,
  );
  const gap = 6;
  const columns = 3;
  const width = (pageWidth() - gap * (columns - 1)) / columns;
  const labelWidth = 74;
  const valueWidth = width - labelWidth - 15;
  for (let offset = 0; offset < model.appliedFilters.length; offset += columns) {
    const filters = model.appliedFilters.slice(offset, offset + columns);
    const heights = filters.map((filter) => {
      doc.font(BOLD_FONT).fontSize(6.3);
      const labelHeight = doc.heightOfString(`${filter.label}:`, {
        width: labelWidth,
        lineGap: 0.5,
      });
      doc.font(REGULAR_FONT).fontSize(6.3);
      const valueHeight = doc.heightOfString(filter.value, {
        width: valueWidth,
        lineGap: 0.5,
      });
      return Math.max(18, labelHeight + 10, valueHeight + 10);
    });
    const rowHeight = Math.max(...heights);
    ensureSpace(doc, rowHeight, () => sectionTitle(
      doc,
      "Applied filters (continued)",
      undefined,
      observer,
    ));
    const y = doc.y;
    filters.forEach((filter, column) => {
      const x = PAGE.left + column * (width + gap);
      doc.fillColor(PALE).rect(x, y, width, rowHeight).fill();
      doc.fillColor(MUTED).font(BOLD_FONT).fontSize(6.3).text(
        `${filter.label}:`,
        x + 5,
        y + 5,
        { width: labelWidth, height: rowHeight - 10, lineGap: 0.5 },
      );
      doc.fillColor(INK).font(REGULAR_FONT).fontSize(6.3);
      drawObservedText(doc, observer, {
        kind: "filter-value",
        text: filter.value,
        x: x + labelWidth + 10,
        y: y + 5,
        width: valueWidth,
        height: rowHeight,
      }, { width: valueWidth, height: rowHeight - 10, lineGap: 0.5 });
    });
    doc.y = y + rowHeight + 4;
  }
  doc.y += 2;
}

function drawSummary(
  doc: PdfDocument,
  model: HistoricalCompliancePdfModel,
  observer?: DrawObserver,
) {
  sectionTitle(doc, "Executive summary", undefined, observer);
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
    doc.fillColor(NAVY).font(BOLD_FONT).fontSize(14).text(value, x + 8, y + 7, {
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
  ];
  doc.fillColor(MUTED).font(REGULAR_FONT).fontSize(7)
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
    doc.fillColor(WHITE).font(BOLD_FONT).fontSize(6.5).text(column.label, x + 4, y + 6, {
      width: column.width - 8,
      align: column.align,
      lineBreak: false,
    });
    x += column.width;
  }
  doc.y = y + 19;
}

function drawBreakdowns(
  doc: PdfDocument,
  model: HistoricalCompliancePdfModel,
  observer?: DrawObserver,
) {
  ensureSpace(doc, 90);
  sectionTitle(
    doc,
    "Academic breakdowns",
    "College, program, and year-level figures reconcile with the filtered details.",
    observer,
  );
  const continuation = () => {
    sectionTitle(doc, "Academic breakdowns (continued)", undefined, observer);
    drawTableHeader(doc, breakdownColumns, doc.y);
  };
  drawTableHeader(doc, breakdownColumns, doc.y);
  model.breakdowns.forEach((row, index) => {
    const values = [row.level, row.group, row.totalStudents.toLocaleString(), row.fullyComplied.toLocaleString(), row.attentionStudents.toLocaleString(), `${row.complianceRate}%`];
    doc.font(REGULAR_FONT).fontSize(6.5);
    const height = Math.max(18, ...breakdownColumns.map((column, columnIndex) => (
      doc.heightOfString(values[columnIndex], {
        width: column.width - 8,
        lineGap: 0.5,
      }) + 10
    )));
    ensureSpace(doc, height, continuation);
    const y = doc.y;
    if (index % 2 === 0) doc.fillColor(PALE).rect(PAGE.left, y, pageWidth(), height).fill();
    let x = PAGE.left;
    breakdownColumns.forEach((column, columnIndex) => {
      doc.fillColor(INK).font(REGULAR_FONT).fontSize(6.5);
      const textOptions = {
        width: column.width - 8,
        height: height - 10,
        align: column.align,
        lineGap: 0.5,
      } satisfies PDFKit.Mixins.TextOptions;
      if (columnIndex === 1) {
        drawObservedText(doc, observer, {
          kind: "breakdown-group",
          text: values[columnIndex],
          x: x + 4,
          y: y + 5,
          width: column.width - 8,
          height,
        }, textOptions);
      } else {
        doc.text(values[columnIndex], x + 4, y + 5, textOptions);
      }
      x += column.width;
    });
    doc.strokeColor("#D8E0E5").lineWidth(0.35)
      .moveTo(PAGE.left, y + height).lineTo(PAGE.width - PAGE.right, y + height).stroke();
    doc.y = y + height;
  });
  doc.moveDown(0.8);
}

const detailColumns = [
  { key: "student", label: "Student", width: 132 },
  { key: "college", label: "College", width: 98 },
  { key: "program", label: "Program", width: 154 },
  { key: "yearLevel", label: "Year", width: 40 },
  { key: "laboratory", label: "Laboratory", width: 92 },
  { key: "physicalExam", label: "Physical Examination", width: 92 },
  { key: "overall", label: "Overall", width: 116 },
] as const;

function drawDetailHeading(
  doc: PdfDocument,
  continued: boolean,
  observer?: DrawObserver,
) {
  sectionTitle(
    doc,
    continued ? "Detailed records (continued)" : "Detailed records",
    continued
      ? "Table headers repeat on every continuation page."
      : "Every matching historical record is included; this export is not limited to the visible report page.",
    observer,
  );
  const y = doc.y;
  doc.fillColor(NAVY).rect(PAGE.left, y, pageWidth(), 22).fill();
  let x = PAGE.left;
  for (const column of detailColumns) {
    doc.fillColor(WHITE).font(BOLD_FONT).fontSize(6.1);
    const textOptions = {
      width: column.width - 6,
      align: column.key === "yearLevel" ? "center" : "left",
      lineBreak: false,
      ellipsis: true,
    } satisfies PDFKit.Mixins.TextOptions;
    drawObservedText(doc, observer, {
      kind: "detail-header",
      text: column.label,
      x: x + 3,
      y: y + 6,
      width: column.width - 6,
      height: 22,
    }, textOptions);
    x += column.width;
  }
  doc.y = y + 22;
}

function detailRowHeight(doc: PdfDocument, row: HistoricalCompliancePdfModel["details"][number]) {
  doc.font(REGULAR_FONT).fontSize(5.8);
  return Math.max(27, ...detailColumns.map((column) => (
    doc.heightOfString(row[column.key], { width: column.width - 6, lineGap: 0.5 }) + 8
  )));
}

function drawDetails(
  doc: PdfDocument,
  model: HistoricalCompliancePdfModel,
  observer?: DrawObserver,
) {
  addPage(doc);
  drawDetailHeading(doc, false, observer);
  model.details.forEach((row, index) => {
    let height = detailRowHeight(doc, row);
    if (doc.y + height > PAGE.footerTop - 8) {
      addPage(doc);
      drawDetailHeading(doc, true, observer);
      height = detailRowHeight(doc, row);
    }
    const y = doc.y;
    if (index % 2 === 0) doc.fillColor(PALE).rect(PAGE.left, y, pageWidth(), height).fill();
    let x = PAGE.left;
    for (const column of detailColumns) {
      doc.fillColor(INK).font(REGULAR_FONT).fontSize(5.8);
      const textOptions = {
        width: column.width - 6,
        height: height - 8,
        lineGap: 0.5,
        ellipsis: true,
        align: column.key === "yearLevel" ? "center" : "left",
      } satisfies PDFKit.Mixins.TextOptions;
      if (column.key === "student") {
        drawObservedText(doc, observer, {
          kind: "detail-student",
          text: row[column.key],
          x: x + 3,
          y: y + 4,
          width: column.width - 6,
          height,
        }, textOptions);
      } else {
        doc.text(row[column.key], x + 3, y + 4, textOptions);
      }
      x += column.width;
    }
    doc.strokeColor("#D8E0E5").lineWidth(0.4)
      .moveTo(PAGE.left, y + height).lineTo(PAGE.width - PAGE.right, y + height).stroke();
    doc.y = y + height;
  });
}

function drawFooters(
  doc: PdfDocument,
  academicYearLabel: string,
  observer?: DrawObserver,
) {
  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(pages.start + index);
    const footer = `Academic Year ${pdfAsciiSafe(academicYearLabel)} | Page ${index + 1} of ${pages.count}`;
    doc.strokeColor("#D8E0E5").lineWidth(0.5)
      .moveTo(PAGE.left, PAGE.footerTop).lineTo(PAGE.width - PAGE.right, PAGE.footerTop).stroke();
    // Footer text intentionally lives inside the reserved bottom margin. Temporarily
    // disabling that margin prevents PDFKit from treating the footer as overflow and
    // recursively creating footer-only pages while buffered pages are being numbered.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    try {
      doc.fillColor(MUTED).font(REGULAR_FONT).fontSize(7);
      drawObservedText(doc, observer, {
        kind: "footer",
        text: footer,
        page: index + 1,
        x: PAGE.left,
        y: PAGE.footerTop + 8,
        width: pageWidth(),
        height: 10,
      }, { width: pageWidth(), align: "center", lineBreak: false });
    } finally {
      doc.page.margins.bottom = bottomMargin;
    }
  }
}

export function renderHistoricalCompliancePdf(
  model: HistoricalCompliancePdfModel,
  options: {
    compress?: boolean;
    onDraw?: DrawObserver;
  } = {},
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
  doc.registerFont(REGULAR_FONT, REGULAR_FONT_PATH);
  doc.registerFont(BOLD_FONT, BOLD_FONT_PATH);

  drawHeader(doc, model, options.onDraw);
  drawReportContext(doc, model, options.onDraw);
  drawFilters(doc, model, options.onDraw);
  drawSummary(doc, model, options.onDraw);
  drawBreakdowns(doc, model, options.onDraw);
  drawDetails(doc, model, options.onDraw);
  drawFooters(doc, model.academicYear.label, options.onDraw);
  doc.end();
  return doc;
}
