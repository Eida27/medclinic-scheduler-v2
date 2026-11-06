import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { AppError } from "@/lib/errors";

const WIDTH = 3508;
const HEIGHT = 2480;
// Static artwork from the supplied reference, with all sample values and the signature removed.
const TEMPLATE_PATH = join(process.cwd(), "src", "server", "medical-certificates", "certificate-template-v2.png");
const FONT_DIRECTORY = join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
const REGULAR_FONT = join(FONT_DIRECTORY, "DejaVuSans.ttf");
const BOLD_FONT = join(FONT_DIRECTORY, "DejaVuSans-Bold.ttf");
const examinationDateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
export const CERTIFICATE_TEMPLATE_VERSION = "MEDCLINIC-PE-CERT-v2";

export type CertificateRenderSnapshot = {
  certificateNumber: string;
  studentName: string;
  age: number | null;
  sex: string;
  examinationDate: string;
  classification: "A" | "B" | "C" | "D";
  remarks: string | null;
  physicianName: string;
  signatureBytes: Buffer;
};

function escapeXml(value: string) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function failOverflow() {
  throw new AppError("CERTIFICATE_LAYOUT_OVERFLOW", "Certificate text does not fit the page. Shorten the entry and preview again.", 422);
}

function wrap(value: string, maxWidth: number, maxLines: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.replace(/\r\n?/gu, "\n").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      if (measure(word) > maxWidth) failOverflow();
      const next = line ? `${line} ${word}` : word;
      if (measure(next) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  if (lines.length > maxLines) failOverflow();
  return lines;
}

function text(value: string, x: number, y: number, size: number, attributes = "") {
  return `<text x="${x}" y="${y}" font-size="${size}" ${attributes}>${escapeXml(value)}</text>`;
}

export async function renderMedicalCertificate(snapshot: CertificateRenderSnapshot, mode: "preview" | "issued"): Promise<Buffer> {
  if (!Number.isInteger(snapshot.age) && snapshot.age !== null) failOverflow();
  const font = await readFile(REGULAR_FONT);
  const metrics = new PDFDocument({ autoFirstPage: false });
  metrics.registerFont("CertificateRegular", font);
  const measure = (value: string, size: number) =>
    metrics.font("CertificateRegular").fontSize(size).widthOfString(value);
  const singleLine = (value: string, maxWidth: number, size: number) =>
    wrap(value, maxWidth, 1, (line) => measure(line, size))[0];
  const name = singleLine(snapshot.studentName, 524, 24);
  const physicianName = singleLine(snapshot.physicianName, 448, 22);
  const remarks = wrap(snapshot.remarks?.trim() || "None recorded.", 610, 5, (line) => measure(line, 22));
  const certificateNumber = singleLine(mode === "issued" ? snapshot.certificateNumber : "PREVIEW ONLY", 326, 19);
  const age = snapshot.age?.toString() ?? "N/A";
  const recordedSex = snapshot.sex.trim();
  const sex = /^(female|male)$/iu.test(recordedSex) ? recordedSex[0].toUpperCase() : recordedSex;
  const sexSize = Math.min(24, Math.floor(66 / measure(sex, 1)));
  if (sexSize < 10) failOverflow();
  const examinationDate = examinationDateFormat.format(new Date(`${snapshot.examinationDate}T00:00:00Z`));
  const stampDate = `${snapshot.examinationDate.slice(5, 7)}/${snapshot.examinationDate.slice(8)}/${snapshot.examinationDate.slice(0, 4)}`;
  const signature = await sharp(snapshot.signatureBytes).rotate().resize({ width: 523, height: 147, fit: "inside" })
    .png().toBuffer();
  // Register the bundled faces with Fontconfig for Sharp's SVG renderer.
  // Without this, systems without DejaVu installed can fall back to monospace.
  await sharp({ text: { text: "A", font: "DejaVu Sans 12", fontfile: REGULAR_FONT } }).toBuffer();
  await sharp({ text: { text: "A", font: "DejaVu Sans Bold 12", fontfile: BOLD_FONT } }).toBuffer();

  // Overlay values in the reference's blank fields. These coordinates use a half-scale view of the artwork.
  const checkboxTop = { A: 494, B: 528.6, C: 591, D: 653.3 }[snapshot.classification];
  const watermark = mode === "preview"
    ? `<g transform="translate(657.75 472) rotate(-25)" fill="#b42333" opacity="0.28">
        ${text("PREVIEW — NOT ISSUED", 0, 0, 58, 'text-anchor="middle" font-weight="700"')}
      </g>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 1315.5 930">
    <g font-family="DejaVu Sans" fill="#000000">
      ${text(certificateNumber, 1190, 111, 19, 'text-anchor="end"')}
      <g text-anchor="middle">
        ${text(name, 689, 346, 24)}
        ${text(age, 1006, 346, 24)}
        ${text(sex, 1086, 346, sexSize)}
        ${text(examinationDate, 759, 419, 24)}
        ${text(stampDate, 1103.5, 567, 12, 'fill="#7f00ff" font-weight="700"')}
        <image x="908" y="706" width="196" height="55" href="data:image/png;base64,${signature.toString("base64")}"/>
        ${text(physicianName, 988, 779, 22)}
      </g>
      <path d="M236 ${checkboxTop + 11} l5 6 10 -12" fill="none" stroke="#000" stroke-width="2.8"/>
      ${remarks.map((line, index) => text(line, 141, 770 + index * 24, 22)).join("")}
      ${watermark}
    </g>
  </svg>`;
  const bytes = await sharp(await readFile(TEMPLATE_PATH)).composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true })
    .withMetadata({ density: 300 }).toBuffer();
  if (bytes.length > 8 * 1024 * 1024) {
    throw new AppError("CERTIFICATE_TOO_LARGE", "The certificate image is too large to issue.", 422);
  }
  return bytes;
}
