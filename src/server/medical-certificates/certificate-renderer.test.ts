// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderMedicalCertificate, type CertificateRenderSnapshot } from "./certificate-renderer";

async function snapshot(): Promise<CertificateRenderSnapshot> {
  return {
    certificateNumber: "MC-2026-000001",
    studentName: "María Ñ. Dela Cruz Jr.",
    studentNumber: "2026-0001",
    collegeName: "College of Arts and Sciences",
    programName: "Bachelor of Science in Biology",
    yearLevel: 4,
    age: 21,
    sex: "Female",
    examinationDate: "2026-09-22",
    classification: "B",
    remarks: "Correctible vision limitation.\nFollow-up in three months.",
    physicianName: "Dr. Ada Reyes",
    physicianLicense: "PRC 1234",
    physicianSpecialty: "General Medicine",
    signatureBytes: await sharp({ create: { width: 200, height: 80, channels: 4, background: "#ffffff" } }).png().toBuffer(),
  };
}

describe("medical certificate renderer", () => {
  it("produces immutable-size landscape A4 JPEG with 300 DPI metadata", async () => {
    const bytes = await renderMedicalCertificate(await snapshot(), "issued");
    const metadata = await sharp(bytes).metadata();
    expect(metadata.format).toBe("jpeg");
    expect([metadata.width, metadata.height]).toEqual([3508, 2480]);
    expect(metadata.density).toBe(300);
    expect(bytes.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("renders preview separately without an issued number", async () => {
    const data = await snapshot();
    const preview = await renderMedicalCertificate(data, "preview");
    const issued = await renderMedicalCertificate(data, "issued");
    expect(preview.equals(issued)).toBe(false);
  });

  it("rejects text that cannot fit the fixed layout", async () => {
    const data = await snapshot();
    data.remarks = "long word ".repeat(400);
    await expect(renderMedicalCertificate(data, "issued")).rejects.toMatchObject({ code: "CERTIFICATE_LAYOUT_OVERFLOW" });
  });

  it("rejects a visually wide student name even when its character count fits", async () => {
    const data = await snapshot();
    data.studentName = "W".repeat(50);
    await expect(renderMedicalCertificate(data, "issued")).rejects.toMatchObject({ code: "CERTIFICATE_LAYOUT_OVERFLOW" });
  });

  it("rejects remarks that would flow into the signature area after width-based wrapping", async () => {
    const data = await snapshot();
    data.remarks = "W ".repeat(220);
    await expect(renderMedicalCertificate(data, "issued")).rejects.toMatchObject({ code: "CERTIFICATE_LAYOUT_OVERFLOW" });
  });

  it("rejects wide physician text that extends past the signature region", async () => {
    const physician = await snapshot();
    physician.physicianName = "W".repeat(30);
    await expect(renderMedicalCertificate(physician, "issued")).rejects.toMatchObject({ code: "CERTIFICATE_LAYOUT_OVERFLOW" });
  });

  it("rejects inline details that extend beyond the right margin", async () => {
    const details = await snapshot();
    details.sex = "Ж".repeat(80);
    await expect(renderMedicalCertificate(details, "issued")).rejects.toMatchObject({ code: "CERTIFICATE_LAYOUT_OVERFLOW" });
  });

  it("renders Unicode clinical text that fits the measured space", async () => {
    const data = await snapshot();
    data.studentName = "María Ñ. Dela Cruz";
    data.remarks = "Visión estable — revisión en tres meses. Ελληνικά.";
    const bytes = await renderMedicalCertificate(data, "issued");
    expect((await sharp(bytes).metadata()).density).toBe(300);
  });
});
