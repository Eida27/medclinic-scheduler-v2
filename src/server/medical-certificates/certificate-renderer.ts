import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { AppError } from "@/lib/errors";

const WIDTH = 3508;
const HEIGHT = 2480;
export const CERTIFICATE_TEMPLATE_VERSION = "MEDCLINIC-PE-CERT-v1";

export type CertificateRenderSnapshot = {
  certificateNumber: string;
  studentName: string;
  studentNumber: string;
  collegeName: string;
  programName: string;
  yearLevel: number;
  age: number | null;
  sex: string;
  examinationDate: string;
  classification: "A" | "B" | "C" | "D";
  remarks: string | null;
  physicianName: string;
  physicianLicense: string;
  physicianSpecialty: string | null;
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

function textLines(lines: string[], x: number, y: number, lineHeight: number, size: number, weight = 400) {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" font-family="CertificateSans" font-size="${size}" font-weight="${weight}" fill="#132946">${escapeXml(line)}</text>`).join("");
}

export async function renderMedicalCertificate(snapshot: CertificateRenderSnapshot, mode: "preview" | "issued"): Promise<Buffer> {
  if (!Number.isInteger(snapshot.age) && snapshot.age !== null) failOverflow();
  if (!Number.isInteger(snapshot.yearLevel) || snapshot.yearLevel < 1) failOverflow();
  const fontDirectory = join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
  const font = await readFile(join(fontDirectory, "DejaVuSans.ttf"));
  const bold = await readFile(join(fontDirectory, "DejaVuSans-Bold.ttf"));
  // PDFKit measures the same embedded DejaVu faces and font sizes used by the SVG.
  const metrics = new PDFDocument({ autoFirstPage: false });
  metrics.registerFont("CertificateRegular", font);
  metrics.registerFont("CertificateBold", bold);
  const measure = (value: string, size: number, weight = 400) =>
    metrics.font(weight === 700 ? "CertificateBold" : "CertificateRegular").fontSize(size).widthOfString(value);
  const fit = (value: string, maxWidth: number, size: number, weight = 400) => {
    if (measure(value, size, weight) > maxWidth) failOverflow();
  };
  const name = wrap(snapshot.studentName, 3000, 1, (value) => measure(value, 70, 700));
  const college = wrap(snapshot.collegeName, 3000, 1, (value) => measure(value, 40));
  const program = wrap(snapshot.programName, 3000, 1, (value) => measure(value, 40));
  const remarks = wrap(snapshot.remarks?.trim() || "None recorded.", 1900, 5, (value) => measure(value, 43));
  const physicianName = wrap(snapshot.physicianName, 1100, 1, (value) => measure(value, 44, 700));
  const physicianLicense = wrap(snapshot.physicianLicense, 1100, 1, (value) => measure(value, 35));
  const specialty = snapshot.physicianSpecialty
    ? wrap(snapshot.physicianSpecialty, 1100, 1, (value) => measure(value, 33)) : [];
  const certificateNumber = mode === "issued" ? snapshot.certificateNumber : "PREVIEW ONLY";
  const studentDetails = `Student number: ${snapshot.studentNumber}   •   Age: ${snapshot.age ?? "Not recorded"}   •   Sex: ${snapshot.sex}`;
  const programLine = `Academic program: ${program[0]}`;
  const collegeLine = `College: ${college[0]}   •   Year level: ${snapshot.yearLevel}`;
  const examinationLine = `Examination date: ${snapshot.examinationDate}`;
  fit(certificateNumber, 1250, 38);
  fit(studentDetails, 3000, 42);
  fit(programLine, 3000, 40);
  fit(collegeLine, 3000, 40);
  fit(examinationLine, 3000, 42);
  const signature = await sharp(snapshot.signatureBytes).rotate().resize({ width: 620, height: 230, fit: "inside" })
    .png().toBuffer();
  const classLabels: Array<["A" | "B" | "C" | "D", string]> = [
    ["A", "Unrestricted school activities"],
    ["B", "Correctible limitations"],
    ["C", "Restricted activities / follow-up"],
    ["D", "Unfit for school activities"],
  ];
  const classSvg = classLabels.map(([code, label], index) => {
    const y = 1170 + index * 112;
    return `<rect x="245" y="${y - 49}" width="55" height="55" rx="6" fill="white" stroke="#16365b" stroke-width="5"/>`
      + (snapshot.classification === code ? `<path d="M257 ${y - 22} l12 13 25 -30" fill="none" stroke="#167050" stroke-width="7"/>` : "")
      + `<text x="335" y="${y}" font-family="CertificateSans" font-size="50" fill="#132946">Class ${code} — ${escapeXml(label)}</text>`;
  }).join("");
  const watermark = mode === "preview"
    ? `<g transform="translate(1754 1270) rotate(-25)"><text x="0" y="0" text-anchor="middle" font-family="CertificateSans" font-size="130" font-weight="700" fill="#b42333" opacity="0.24">PREVIEW — NOT ISSUED</text></g>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs><style>
      @font-face { font-family: CertificateSans; src: url(data:font/ttf;base64,${font.toString("base64")}); font-weight: 400; }
      @font-face { font-family: CertificateSans; src: url(data:font/ttf;base64,${bold.toString("base64")}); font-weight: 700; }
    </style></defs>
    <rect width="3508" height="2480" fill="#ffffff"/>
    <rect x="122" y="120" width="3264" height="2240" fill="none" stroke="#17365c" stroke-width="6"/>
    <text x="245" y="255" font-family="CertificateSans" font-size="60" font-weight="700" fill="#17365c">CENTRAL PHILIPPINE UNIVERSITY</text>
    <text x="245" y="330" font-family="CertificateSans" font-size="45" fill="#17365c">Health Services</text>
    <text x="3260" y="260" text-anchor="end" font-family="CertificateSans" font-size="38" fill="#17365c">${escapeXml(certificateNumber)}</text>
    <line x1="245" y1="380" x2="3260" y2="380" stroke="#17365c" stroke-width="5"/>
    <text x="1754" y="515" text-anchor="middle" font-family="CertificateSans" font-size="104" font-weight="700" fill="#132946">MEDICAL CERTIFICATE</text>
    <text x="245" y="670" font-family="CertificateSans" font-size="42" fill="#566579">Student name</text>
    ${textLines(name, 245, 745, 64, 70, 700)}
    <text x="245" y="845" font-family="CertificateSans" font-size="42" fill="#566579">${escapeXml(studentDetails)}</text>
    <text x="245" y="920" font-family="CertificateSans" font-size="40" fill="#566579">${escapeXml(programLine)}</text>
    <text x="245" y="985" font-family="CertificateSans" font-size="40" fill="#566579">${escapeXml(collegeLine)}</text>
    <text x="245" y="1050" font-family="CertificateSans" font-size="42" fill="#132946">${escapeXml(examinationLine)}</text>
    ${classSvg}
    <text x="245" y="1690" font-family="CertificateSans" font-size="44" font-weight="700" fill="#132946">Remarks</text>
    ${textLines(remarks, 245, 1760, 63, 43)}
    <image x="2430" y="1850" width="620" height="230" href="data:image/png;base64,${signature.toString("base64")}"/>
    <line x1="2200" y1="2100" x2="3220" y2="2100" stroke="#17365c" stroke-width="3"/>
    ${textLines(physicianName, 2200, 2155, 50, 44, 700)}
    ${textLines(physicianLicense, 2200, 2212, 50, 35)}
    ${textLines(specialty, 2200, 2260, 50, 33)}
    <text x="245" y="2230" font-family="CertificateSans" font-size="31" fill="#566579">For school use. Clinical findings are recorded by the attending physician.</text>
    <text x="245" y="2290" font-family="CertificateSans" font-size="28" fill="#566579">${CERTIFICATE_TEMPLATE_VERSION}</text>
    ${watermark}
  </svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true })
    .withMetadata({ density: 300 }).toBuffer();
  if (bytes.length > 8 * 1024 * 1024) {
    throw new AppError("CERTIFICATE_TOO_LARGE", "The certificate image is too large to issue.", 422);
  }
  return bytes;
}
